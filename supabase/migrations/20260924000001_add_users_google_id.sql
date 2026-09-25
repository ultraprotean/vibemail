-- users.google_id: Google's stable account id (ID token `sub`). The OAuth
-- callback upserts users on conflict (google_id) (CONTRACT.md §4, §6.2).
--
-- Idempotent. Added as NOT NULL with no default, so this requires `users` to be
-- empty (true when written: no rows existed yet).

alter table public.users
  add column if not exists google_id text not null;

-- A plain (non-partial) unique index is what PostgREST's
-- `upsert(..., { onConflict: 'google_id' })` needs as the conflict target.
create unique index if not exists users_google_id_key
  on public.users (google_id);
