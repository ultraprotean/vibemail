-- Drop support tables the contract no longer uses (CONTRACT.md on main):
--   oauth_states   -- OAuth CSRF state now lives in an `oauth_state` cookie (§6.1).
--   webhook_events -- webhook idempotency comes from upserts, deletes and a
--                     monotonic last_history_id watermark (§6.6).
--
-- Idempotent.

drop table if exists public.oauth_states;
drop table if exists public.webhook_events;
