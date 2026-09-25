-- VibeMail Engine — initial schema.
--
-- Multi-user, RLS-enforced isolation keyed on auth.uid(). The server mints
-- short-lived Supabase JWTs (sub = users.id, role = authenticated) for
-- user-scoped endpoints; the service role is used only by the OAuth callback
-- and the Pub/Sub webhook.
--
-- OAuth tokens are encrypted app-side (AES-256-GCM, ENCRYPTION_KEY) and stored
-- here as opaque bytea.
--
-- Idempotent: every statement is safe to re-run against an already-migrated
-- database.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Shared trigger function
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- users: one row per connected Gmail account
-- ---------------------------------------------------------------------------

create table if not exists public.users (
  id                uuid        primary key default gen_random_uuid(),
  email             text        not null unique,
  access_token_enc  bytea       not null,
  refresh_token_enc bytea       not null,
  token_expires_at  timestamptz not null,
  last_history_id   bigint,
  watch_expiration  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- messages: one row per Gmail message (CONTRACT.md §4, snake_case)
-- ---------------------------------------------------------------------------

create table if not exists public.messages (
  user_id      uuid        not null references public.users (id) on delete cascade,
  id           text        not null,
  thread_id    text        not null,
  subject      text        not null,
  from_address text        not null,
  to_address   text        not null,
  cc           text,
  snippet      text        not null,
  body_text    text,
  body_html    text,
  label_ids    text[]      not null default '{}',
  is_read      boolean     generated always as (not ('UNREAD' = any (label_ids))) stored,
  received_at  timestamptz not null,
  history_id   bigint      not null,
  synced_at    timestamptz not null default now(),
  primary key (user_id, id)
);

-- GET /messages: newest first, keyset cursor on (received_at, id).
create index if not exists messages_user_received_idx
  on public.messages (user_id, received_at desc, id desc);

-- GET /messages?unreadOnly=true
create index if not exists messages_user_unread_received_idx
  on public.messages (user_id, received_at desc, id desc)
  where not is_read;

create index if not exists messages_user_thread_idx
  on public.messages (user_id, thread_id);

-- ---------------------------------------------------------------------------
-- oauth_states: CSRF state shared across serverless instances
-- ---------------------------------------------------------------------------

create table if not exists public.oauth_states (
  state      text        primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);

create index if not exists oauth_states_expires_idx
  on public.oauth_states (expires_at);

-- ---------------------------------------------------------------------------
-- webhook_events: Pub/Sub redelivery dedupe
-- ---------------------------------------------------------------------------

create table if not exists public.webhook_events (
  message_id    text        primary key,
  email_address text        not null,
  history_id    bigint      not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.users          enable row level security;
alter table public.messages       enable row level security;
alter table public.oauth_states   enable row level security;
alter table public.webhook_events enable row level security;

-- Supabase grants all privileges on public tables to anon/authenticated by
-- default. Start from nothing and grant back only what each role needs.
revoke all on public.users, public.messages, public.oauth_states, public.webhook_events
  from anon, authenticated;

-- users: read own row; update only token/sync columns (id, email immutable).
-- Rows are created by the OAuth callback under the service role.
grant select on public.users to authenticated;
grant update (access_token_enc, refresh_token_enc, token_expires_at, last_history_id, watch_expiration)
  on public.users to authenticated;

drop policy if exists users_select_own on public.users;
create policy users_select_own on public.users
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists users_update_own on public.users;
create policy users_update_own on public.users
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- messages: full CRUD on own rows only.
grant select, insert, update, delete on public.messages to authenticated;

drop policy if exists messages_select_own on public.messages;
create policy messages_select_own on public.messages
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists messages_insert_own on public.messages;
create policy messages_insert_own on public.messages
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists messages_update_own on public.messages;
create policy messages_update_own on public.messages
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists messages_delete_own on public.messages;
create policy messages_delete_own on public.messages
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- oauth_states, webhook_events: no policies and no grants -> service role only.
