# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

VibeMail Engine is a data-liberation and synchronization engine: it extracts a user's Gmail data via OAuth2, structures it into Supabase, and exposes it through a REST API at `/api/v1`, deployed as Vercel serverless functions.

Gmail is the teaching vehicle for this build; the reusable pattern being taught is **Extract → Structure → Embed** — pull data out of a third-party provider's native shape, normalize it into your own schema, and expose it through your own contract. This is why a `ProviderInterface` abstraction is built before any Gmail-specific code (see BUILD_SEQUENCE.md unit 1) — Gmail is one implementation of it, not the architecture itself.

Build progress: units 1–6 are built (provider interface `src/types/provider.ts`; Gmail provider `src/providers/gmail/`; token encryption `src/crypto/`; stores `src/db/`; initial sync `src/sync/`; webhook `src/webhook/`; watch renewal cron `src/cron/renewWatch.ts`; send `src/send/`; read state `src/read-state/`; Vercel entry points `api/` over `src/http/handlers.ts`). Unit 6's local-preview check (`npx vercel dev` + a real Google sign-in) hasn't been run yet. Unit 7's integration suite (`tests/integration/`) runs against the live Supabase dev database. Column names follow the schema branch migrations (`supabase/migrations/` on `origin/schema`), which are live on the dev DB.

## Stack

- Node 24 (LTS, pinned via `engines` in `package.json`)
- TypeScript, strict mode
- `googleapis` — Gmail API client, including its OAuth2 client for token refresh
- Supabase JS client
- Jest + supertest for testing
- Vercel (serverless functions, `vercel dev` for local preview)

## Source of truth documents

Read these before writing any code — they are the spec, not background reading:

- **[CONTRACT.md](CONTRACT.md)** — the synchronization point between sessions. Defines the endpoint contracts (request/response shapes, typed error cases), the `users`/`messages` data model with each field's Gmail API source, the auth error semantics (`AUTH_FAILED` + `recoverable` flag), and the two-session sequencing rule.
- **[BUILD_SEQUENCE.md](BUILD_SEQUENCE.md)** — the atomic build order (7 units). Each unit has exactly one verification check; do not start unit N+1 until unit N's check passes.

## The two-session architecture

- **Server logic session** — works on `main`, owns `src/` and `api/`.
- **Schema session** — works on a `schema` branch, owns `supabase/migrations/`, `supabase/tests/`, and `types/`.
- Each session stays inside its own owned directories; see Never-do rules below for the specific boundary (schema session must not write to `src/db/`).

## Sequencing rule (critical — see CONTRACT.md §5)

**Logic ships before schema merges.** The two sessions run in parallel, not back-to-back — only the schema *merge* is gated:

- **Session 1 (server logic)** implements all endpoint handlers, the Gmail client wrapper, token encrypt/decrypt, JWT issue/verify, and Pub/Sub payload parsing, all behind a persistence *interface*. It is done when every success path and every typed error case in CONTRACT.md has a passing Jest test with zero skipped tests (`npm test` exits 0), run against a live Supabase instance (BUILD_SEQUENCE.md unit 7 — the verification gate).
- **Session 2 (schema)** designs the Supabase `users`/`messages` tables and migration on the `schema` branch in parallel, and may apply it to a real database early so Session 1 has something live to test against — but the `schema` branch cannot be merged until Session 1's tests pass.

Do not jump ahead of this ordering: build behind the persistence interface first, and treat "the schema branch is merged" as a separate, later event from "the schema exists in a dev database."

## Never-do rules

- Never use `any` as a TypeScript type.
- Never poll the Gmail API for new messages — use Pub/Sub push webhooks.
- Never store OAuth tokens in plaintext — encrypt in the application with AES-256-GCM before they reach Supabase (CONTRACT.md §4, "Token encryption").
- Never make Gmail API calls without going through the `googleapis` OAuth2 client — it handles token refresh automatically; don't hand-roll refresh logic.
- Never write to `src/db/` from the schema session.
- Never merge the schema session before `npm test` exits 0 on server logic.
- Never hardcode credentials.

## Coding conventions

- All errors use the CONTRACT.md error envelope shape: `{ "error": { "code", "message", "details" } }`.
- Cursor-based pagination on all list endpoints.
- `/api/v1` base path on all client-facing endpoints.
- JWT Bearer token authentication on all endpoints except the two OAuth endpoints (`/auth/google`, `/auth/google/callback`), the webhook and the cron.
- The Pub/Sub webhook endpoint lives at `/webhook/gmail` and the watch-renewal cron at `/api/cron/renew-watch` (scheduled in `vercel.json`), both outside `/api/v1`.

## Architecture

- **Multi-user system.** Any number of Google accounts can connect: one `users` row each, upserted on `google_id`. Every message row carries a `user_id`, and every read or write must be scoped to one user — the JWT `sub` for API requests, the `emailAddress` → user lookup for webhooks. Never query `messages` without a `user_id` filter.
- **Push, not poll.** New messages and read-state changes arrive via the Pub/Sub webhook, which processes deltas from the user's stored `users.last_history_id` watermark using `history.list`. Webhook processing must be idempotent (Pub/Sub redelivers).
- **Two-tier auth failure.** Every authenticated endpoint reports auth problems as `AUTH_FAILED` with a `recoverable` boolean (CONTRACT.md §3) — `true` means the client can redirect to `/auth/google` and retry; `false` means the stored Gmail refresh token itself is dead and the user must redo full consent. Don't collapse these into a single generic 401.
- **No attachments.** Both the `messages` data model and the send endpoint explicitly exclude attachment support — don't add attachment fields or params without a contract change.

## Commands

These map to the BUILD_SEQUENCE.md verification checks (`/verify-unit <N>` runs the gate for a unit):

```bash
# Type-check (unit 1 gate: "TypeScript compiles clean")
npx tsc --noEmit

# Run the full Jest suite (units 2-5, 7 gates). Tests compile with tsconfig.test.json via ts-jest.
# Includes tests/integration/, which runs against LIVE Supabase (SUPABASE_URL and
# SUPABASE_SERVICE_ROLE_KEY from .env). Gmail is faked; Supabase is never mocked. Each test
# file namespaces its rows (google_id "it-<file>-<run>-…") and deletes them afterwards.
npm test
npm run test:unit                    # everything except tests/integration (no database needed)
npm run test:integration             # only the live-Supabase suite
npx jest path/to/file.test.ts        # single test file
npx jest -t "test name"              # single test by name

# Local API preview (unit 6 gate: every §6 endpoint responds correctly in local preview)
npx vercel dev
```

Environment variables are listed (unset) in `.env.example`; copy to `.env` for local development. Required: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `GOOGLE_PUBSUB_TOPIC`, `GOOGLE_PUBSUB_VERIFICATION_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `ENCRYPTION_KEY`, `FRONTEND_URL`, `CRON_SECRET`.
