# Schema plan — Supabase schema for VibeMail

## Status

- **Implemented** in `6a6eb02`: `supabase/migrations/20260923000001_init_schema.sql`, `supabase/tests/rls_smoke.sql`, `types/database.ts`.
- **Doc changes** in `93dfe64`: CONTRACT.md, CLAUDE.md, `.env.example` (see "Out-of-directory changes" below).
- **Verification** steps 1–4 passed against the linked dev project. Step 5 (`tsc`) passed on `types/database.ts` standalone; the project `tsconfig.json` only includes `src/` and `api/`, so it doesn't cover `types/` yet.
- **Advisor note:** the Supabase advisors flag `public.rls_auto_enable()`, a platform-installed function (not from this migration) that `anon`/`authenticated` can execute via `/rest/v1/rpc`. Worth revoking in project settings.

- **Superseded in part** (reconciled with CONTRACT.md on `main`): `20260924000001` adds unique `users.google_id` (upsert key); `20260924000002` drops `oauth_states` and `webhook_events` (CSRF state moved to a cookie; webhook idempotency comes from upserts plus a monotonic watermark). The server uses the service role key only, so the minted-JWT access model below is not used; RLS remains as defense in depth.

## Context

This worktree is the **schema session** (on `schema`, tracking `origin/schema`). CONTRACT.md §4 and CLAUDE.md described a single-user system (singleton `account`, no `user_id`), but the schema was changed to **multi-user with RLS-enforced per-user isolation**. Decisions:

- Multi-user: `users` table + `messages.user_id`; RLS keyed on `auth.uid()`.
- Identity for RLS: the server mints short-lived Supabase-compatible JWTs (`sub = users.id`, `role = authenticated`) signed with the Supabase JWT secret, and queries with the anon key + that JWT. Service role only for OAuth callback and webhook.
- Token encryption is **app-side** (Node AES-256-GCM with `ENCRYPTION_KEY`); DB stores opaque `bytea`.
- snake_case columns everywhere; Session 1 maps to the camelCase API shape.
- `is_read` is a **generated column** derived from `label_ids`.
- Support tables: `oauth_states` (CSRF) and `webhook_events` (Pub/Sub dedupe).
- Migrations live in `supabase/migrations/` (Supabase CLI is linked; `npm run db:push` = `supabase db push`).
- All migrations must be idempotent.

No application code existed yet; `supabase/` contained only CLI `.temp/` link metadata. Nothing to reuse.

## Files

- **Create** `supabase/migrations/20260923000001_init_schema.sql` — all tables, indexes, triggers, grants, RLS.
- **Create** `supabase/tests/rls_smoke.sql` — RLS + idempotency verification script.
- **Generate** `types/database.ts` via `npm run db:types` (not hand-written).

## Idempotency rules (whole migration)

- `create extension if not exists pgcrypto` (for `gen_random_uuid()` only).
- `create table if not exists`; later additions via `alter table … add column if not exists`.
- `create index if not exists`.
- `create or replace function`; `drop trigger if exists … ; create trigger …`.
- Policies: `drop policy if exists … ; create policy …`.
- `alter table … enable row level security`, `grant`/`revoke` — naturally re-runnable.

## Tables

### `users` (one row per connected Gmail account)
| column | type | notes |
|---|---|---|
| `id` | `uuid` PK default `gen_random_uuid()` | JWT `sub` / `auth.uid()` |
| `email` | `text not null unique` | webhook maps `emailAddress` → user |
| `access_token_enc` | `bytea not null` | app-side AES-256-GCM ciphertext |
| `refresh_token_enc` | `bytea not null` | same |
| `token_expires_at` | `timestamptz not null` | |
| `last_history_id` | `bigint` null | null until first backfill |
| `watch_expiration` | `timestamptz` null | null until `users.watch()` succeeds |
| `created_at` / `updated_at` | `timestamptz not null default now()` | `updated_at` via `set_updated_at()` trigger |

### `messages` (CONTRACT.md §4, snake_case)
| column | type | notes |
|---|---|---|
| `user_id` | `uuid not null` → `users(id) on delete cascade` | |
| `id` | `text not null` | Gmail message id |
| `thread_id` | `text not null` | |
| `subject`, `from_address`, `to_address` | `text not null` | `from`/`to` are reserved words |
| `cc` | `text` null | |
| `snippet` | `text not null` | |
| `body_text`, `body_html` | `text` null | |
| `label_ids` | `text[] not null default '{}'` | |
| `is_read` | `boolean generated always as (not ('UNREAD' = any(label_ids))) stored` | writes go to `label_ids` |
| `received_at` | `timestamptz not null` | |
| `history_id` | `bigint not null` | |
| `synced_at` | `timestamptz not null default now()` | |
| PK | `(user_id, id)` | Gmail ids unique per mailbox; enables `on conflict (user_id, id)` upserts |

### `oauth_states` (CSRF state across serverless instances)
`state text` PK, `created_at timestamptz default now()`, `expires_at timestamptz not null default now() + interval '10 minutes'`. Consumed atomically by Session 1: `delete … where state = $1 and expires_at > now() returning *`.

### `webhook_events` (Pub/Sub dedupe)
`message_id text` PK (Pub/Sub `messageId`), `email_address text not null`, `history_id bigint not null`, `received_at timestamptz default now()`, `processed_at timestamptz` null. Webhook inserts `on conflict do nothing`; skips if already processed; sets `processed_at` only on success so failed (500) deliveries retry.

## Indexes
- `messages (user_id, received_at desc, id desc)` — sort + keyset cursor on `(received_at, id)`.
- Partial `messages (user_id, received_at desc, id desc) where not is_read` — `unreadOnly`.
- `messages (user_id, thread_id)` — thread/reply lookups.
- `oauth_states (expires_at)` — expiry cleanup.

## RLS and grants
RLS enabled on all four tables. `revoke all … from anon` on every table.

- **`users`**
  - `select` for `authenticated` where `id = auth.uid()`.
  - `update` for `authenticated` where `id = auth.uid()`; column-level `grant update (access_token_enc, refresh_token_enc, token_expires_at, last_history_id, watch_expiration)` so `id`/`email` are immutable to users.
  - No insert/delete for `authenticated` (OAuth callback creates rows via service role).
- **`messages`** — `select`/`insert`/`update`/`delete` for `authenticated`, `using` and `with check` `user_id = auth.uid()`.
- **`oauth_states`, `webhook_events`** — no policies; `revoke all` from `anon` and `authenticated` → service-role only.

Key usage (for Session 1): service role for OAuth callback and webhook; per-request minted JWT + anon key for `GET /messages`, `POST /messages/send`, `PATCH /messages/:id/read`.

## Out-of-directory changes (separate commit, with user sign-off)
- **CONTRACT.md §4**: `account` → `users` (uuid PK, unique email); add `messages.user_id`, PK `(user_id, id)`; snake_case columns incl. `from_address`/`to_address`; `is_read` generated; encryption wording → app-side AES-256-GCM. §6.4: "updates isRead" → "removes `UNREAD` from `label_ids`".
- **CLAUDE.md**: drop single-user/no-`user_id` rule and singleton wording; schema ownership `migrations/` → `supabase/migrations/`.
- **`.env.example`**: add `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`.
- **Session 1 heads-up**: persistence interface takes a user id on every call; webhook resolves `emailAddress` → user.

## Assumptions (not explicitly confirmed)
`from_address`/`to_address` naming; composite PK; cascade delete; 10-minute state TTL; no DB flag for a dead refresh token (`recoverable: false` determined at request time).

## Verification
1. `supabase db push` against the linked dev project — succeeds.
2. Re-run the full migration file (`supabase db query -f …` or psql) — no errors (idempotency).
3. `supabase/tests/rls_smoke.sql` in a transaction (rolled back): create users A and B with one message each; `set local role authenticated` + `request.jwt.claims` = A → A sees only A's message; cannot update B's message; cannot insert with `user_id = B`; cannot update own `email`; cannot read `oauth_states`/`webhook_events`. As `anon`: sees nothing. Also confirm `is_read` flips when `'UNREAD'` is removed from `label_ids`.
4. `npm run db:types` → commit `types/database.ts`.
5. `npx tsc --noEmit` passes with the generated types.
