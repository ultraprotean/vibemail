# VibeMail Engine — Contract

## 1. Acceptance Criteria

The project is complete when all of the following hold:

- [ ] Gmail OAuth completes end-to-end and encrypted tokens persist in Supabase.
- [ ] First authentication triggers an initial sync of the 50 most recent messages.
- [ ] New messages and read-state changes arrive via Gmail Pub/Sub push notifications — no polling.
- [ ] An authenticated user can send a message through Gmail.
- [ ] Read state synchronizes bidirectionally: marking read locally pushes to Gmail, and Gmail-side read-state changes flow back via Pub/Sub sync.
- [ ] Authentication failures return typed, recoverable-vs-fatal errors (`AUTH_FAILED` with a `recoverable` flag — see §3).
- [ ] The full Jest test suite passes with zero skipped tests.
- [ ] The backend is deployed and live on Vercel.
- [ ] Git history shows clean, sequential, reviewable units of work, matching the sequencing rule in §5.

## 2. Conventions

- Base path: `/api/v1`, except the Pub/Sub webhook, which lives at `/webhook/gmail` outside `/api/v1`.
- Content type: `application/json` for all request/response bodies except the OAuth callback and Pub/Sub webhook.
- Session: after successful OAuth, the client receives a JWT and must send it as an `Authorization: Bearer <jwt>` header on every authenticated request. It expires after 1 hour; once expired, requests fail with `AUTH_FAILED` (`recoverable: true`) and the client re-runs the OAuth flow to obtain a fresh token.
- Error envelope (all endpoints):
  ```json
  { "error": { "code": "STRING_CODE", "message": "human-readable", "details": { "...": "optional, error-specific" } } }
  ```
- Common error codes: `AUTH_FAILED` (401/400 — see §3 for the recoverable flag), `INVALID_REQUEST` (400), `NOT_FOUND` (404), `RATE_LIMITED` (429), `PROVIDER_ERROR` (502 — Gmail API itself failed), `INTERNAL_ERROR` (500).

## 3. Auth error semantics

Every endpoint that requires a valid session uses one error code for all authentication problems:

```json
{ "error": { "code": "AUTH_FAILED", "message": "...", "details": { "recoverable": true } } }
```

- `recoverable: true` — the client can resolve this by re-running the normal flow (e.g. `Authorization` header missing/expired; redirect to `/auth/google` to obtain a fresh token).
- `recoverable: false` — the stored Gmail refresh token itself is invalid/revoked; no amount of retrying will help — the user must complete the full OAuth consent screen again.

## 4. Data Model

Multi-user: each connected Gmail account is a row in `users`, and every `messages` row belongs to one user. Postgres columns are snake_case; the API layer maps them to the camelCase response shapes in §6. Row level security isolates users (see "Access model" below).

Table: `messages`. One row per Gmail message per user, populated by the sync process (initial backfill + Pub/Sub-triggered incremental sync). Primary key `(user_id, id)` — Gmail message ids are only unique within a mailbox.

| Column | API field | Type | Source in Gmail API `messages.get` response |
|---|---|---|---|
| `user_id` | — | `uuid`, FK → `users.id` (cascade delete) | owning user |
| `id` | `id` | `text` | `message.id` |
| `thread_id` | `threadId` | `text` | `message.threadId` |
| `subject` | `subject` | `text` | `payload.headers[name="Subject"].value` |
| `from_address` | `from` | `text` | `payload.headers[name="From"].value` |
| `to_address` | `to` | `text` | `payload.headers[name="To"].value` |
| `cc` | `cc` | `text`, nullable | `payload.headers[name="Cc"].value` |
| `snippet` | `snippet` | `text` | `message.snippet` |
| `body_text` | `bodyText` | `text`, nullable | decoded base64url `payload.parts[mimeType="text/plain"].body.data` (or `payload.body.data` if not multipart) |
| `body_html` | `bodyHtml` | `text`, nullable | decoded base64url `payload.parts[mimeType="text/html"].body.data` |
| `label_ids` | — | `text[]` | `message.labelIds` |
| `is_read` | `isRead` | `boolean`, generated | `NOT ('UNREAD' = ANY(label_ids))` — never written directly; change `label_ids` instead |
| `received_at` | `receivedAt` | `timestamptz` | `message.internalDate` (epoch ms, converted) |
| `history_id` | — | `bigint` | `message.historyId` |
| `synced_at` | — | `timestamptz` | set by our sync process, not from Gmail |

Attachments are explicitly **out of scope** for this model (send has no attachment support; received-attachment metadata is deferred).

Table: `users` (one row per connected Gmail account):

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | generated; used as the `sub` of the per-request Supabase JWT |
| `email` | `text`, unique | from Google profile/userinfo at OAuth time; the webhook maps `emailAddress` → user with it |
| `access_token_enc` | `bytea` | encrypted app-side (AES-256-GCM, `ENCRYPTION_KEY`); opaque to the database |
| `refresh_token_enc` | `bytea` | encrypted app-side (AES-256-GCM, `ENCRYPTION_KEY`) |
| `token_expires_at` | `timestamptz` | |
| `last_history_id` | `bigint`, nullable | Gmail mailbox historyId watermark; incremental sync resumes from here |
| `watch_expiration` | `timestamptz`, nullable | Gmail `users.watch()` expiration; must be renewed before it lapses |
| `created_at` / `updated_at` | `timestamptz` | `updated_at` maintained by trigger |

Support tables (service role only):

- `oauth_states` — `state` (PK), `created_at`, `expires_at` (default now + 10 min). `/auth/google` inserts one; the callback consumes it atomically (`delete … where state = $1 and expires_at > now() returning *`). A miss is `AUTH_FAILED`, `recoverable: true`.
- `webhook_events` — `message_id` (PK, Pub/Sub `messageId`), `email_address`, `history_id`, `received_at`, `processed_at`. The webhook inserts with `on conflict do nothing`, skips already-processed deliveries, and sets `processed_at` only after successful processing.

Access model:

- User-scoped endpoints (`GET /messages`, `POST /messages/send`, `PATCH /messages/:id/read`) query with the anon key plus a short-lived JWT the server signs with `SUPABASE_JWT_SECRET` (`sub = users.id`, `role = authenticated`). RLS restricts `users` and `messages` to `auth.uid()`; users may update only their token/sync columns.
- The OAuth callback (creates users) and the Pub/Sub webhook (unauthenticated; resolves user by email) use the service role key.

## 5. Sequencing rule (two-session build)

Logic ships before schema merges. The two sessions run in parallel, not strictly back-to-back — only the schema **merge** is gated.

**Session 1 — server logic:**
Implement all 5 endpoint handlers below, the Gmail API client wrapper, token encrypt/decrypt helpers, JWT issue/verify, and Pub/Sub payload parsing, all behind a persistence *interface*. This session establishes what storage actually needs to look like. Session 1 is done only when every endpoint's success path and every typed error case in this document has a passing Jest test, and the full suite is green with zero skipped tests, run against live Supabase (the verification gate — see BUILD_SEQUENCE.md unit 7).

**Session 2 — schema:**
Design the actual Supabase schema (`users`, `messages`, and support tables above) and write the SQL migration (including RLS policies) in parallel with Session 1. The schema may be applied to a real database early — Session 1's suite needs somewhere live to run against — but it is not reviewed or merged as the accepted schema until Session 1's verification gate passes.

## 6. Endpoint Contracts

### 6.1 `GET /auth/google/callback`

OAuth redirect target from Google.

**Request** — query params:
| Param | Type | Notes |
|---|---|---|
| `code` | string | present on success |
| `state` | string | CSRF token, must match the one issued when starting the flow |
| `error` | string, optional | present if the user denied consent |

**Success response:** `302 Found`, `Location: <FRONTEND_URL>/inbox#token=<jwt>` — the JWT is delivered in the URL fragment (never sent to the server or logged) for the client to read and store; the client attaches it as `Authorization: Bearer <jwt>` on all subsequent requests.
Side effects: exchanges `code` for access/refresh tokens, fetches the account email, encrypts the tokens and upserts the `users` row by email, registers a Gmail `users.watch()` for Pub/Sub, triggers the initial 50-message backfill sync.

**Errors:**
| Status | Code | recoverable | When |
|---|---|---|---|
| 400 | `AUTH_FAILED` | `true` | missing/invalid `code`, `state` mismatch, or `error=access_denied` from Google — user can just retry the OAuth flow |
| 502 | `AUTH_FAILED` | `false` | Google's token endpoint returned an unexpected error (outage, misconfigured client) |

### 6.2 `GET /messages`

**Request** — requires `Authorization: Bearer <jwt>` header. Query params:
| Param | Type | Default | Notes |
|---|---|---|---|
| `cursor` | string, optional | none | opaque pagination cursor from a prior response's `nextCursor` |
| `limit` | integer, optional | 20 | max 100 |
| `unreadOnly` | boolean, optional | false | filter to `isRead = false` |

**Success response:** `200 OK`
```json
{
  "messages": [
    {
      "id": "string", "threadId": "string", "subject": "string",
      "from": "string", "to": "string", "cc": "string|null",
      "snippet": "string", "bodyText": "string|null", "bodyHtml": "string|null",
      "isRead": true, "receivedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "string|null"
}
```
Sorted `receivedAt` descending (newest first).

**Errors:**
| Status | Code | Notes |
|---|---|---|
| 401 | `AUTH_FAILED` (`recoverable` per §3) | missing/expired/invalid `Authorization` header |
| 400 | `INVALID_REQUEST` | invalid `limit`/`cursor` |
| 500 | `INTERNAL_ERROR` | unexpected failure |

### 6.3 `POST /messages/send`

**Request** — requires `Authorization: Bearer <jwt>` header. Body:
```json
{
  "to": ["string", "..."],
  "cc": ["string"],
  "bcc": ["string"],
  "subject": "string",
  "bodyText": "string",
  "bodyHtml": "string",
  "threadId": "string",
  "inReplyTo": "string"
}
```
`to`, `subject`, and at least one of `bodyText`/`bodyHtml` are required; `cc`, `bcc`, `threadId`, `inReplyTo` are optional (the latter two support replying within an existing thread). No attachment support.

**Success response:** `201 Created`
```json
{ "id": "string", "threadId": "string", "status": "sent" }
```

**Errors:**
| Status | Code | Notes |
|---|---|---|
| 401 | `AUTH_FAILED` | see §3 |
| 400 | `INVALID_REQUEST` | missing `to`/`subject`/body, malformed address |
| 502 | `PROVIDER_ERROR` | Gmail's `messages.send` call failed |
| 429 | `RATE_LIMITED` | Gmail API quota hit |
| 500 | `INTERNAL_ERROR` | unexpected failure |

### 6.4 `PATCH /messages/:id/read`

**Request** — requires `Authorization: Bearer <jwt>` header. Path param `id` (Gmail message id). No body.
Behavior: calls Gmail `messages.modify` to remove the `UNREAD` label first; only on success removes `UNREAD` from the local row's `label_ids` (which updates the generated `is_read`).

**Success response:** `200 OK`
```json
{ "id": "string", "isRead": true }
```

**Errors:**
| Status | Code | Notes |
|---|---|---|
| 401 | `AUTH_FAILED` | see §3 |
| 404 | `NOT_FOUND` | message id not present in local store |
| 502 | `PROVIDER_ERROR` | Gmail's `messages.modify` call failed — local row is NOT updated |
| 500 | `INTERNAL_ERROR` | unexpected failure |

### 6.5 `POST /webhook/gmail?token=<shared-secret>`

Gmail Pub/Sub push subscription target. Not session-authenticated; verified by matching the `token` query param against an env-configured secret.

**Request** — body (Pub/Sub push envelope):
```json
{
  "message": {
    "data": "base64-encoded-json",
    "messageId": "string",
    "publishTime": "2026-01-01T00:00:00.000Z"
  },
  "subscription": "string"
}
```
Decoded `data` JSON: `{ "emailAddress": "string", "historyId": "string" }`. `emailAddress` identifies the user (`users.email`).

**Success response:** `200 OK`, empty body. Triggers an async `history.list` call from that user's stored `users.last_history_id` to the new `historyId`, applies new/changed messages and read-state to the `messages` table, and advances `users.last_history_id` (never backwards). Processing must be idempotent (Pub/Sub may redeliver).

**Errors:**
| Status | Code | Notes |
|---|---|---|
| 401 | `UNAUTHORIZED` | `token` query param missing or mismatched |
| 400 | `INVALID_REQUEST` | malformed Pub/Sub envelope / undecodable `data` |
| 500 | `INTERNAL_ERROR` | processing failed — return 500 (not 200) so Pub/Sub retries with backoff |
