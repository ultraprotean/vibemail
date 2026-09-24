# VibeMail Engine — Contract

## 1. Acceptance Criteria

The project is complete when all of the following hold:

- [ ] Multiple Google accounts can connect; each user sees and acts on only their own mailbox.
- [ ] Gmail OAuth completes end-to-end and encrypted tokens persist in Supabase.
- [ ] A user's first authentication triggers an initial sync of their 50 most recent inbox messages.
- [ ] New messages and read-state changes arrive via Gmail Pub/Sub push notifications — no polling.
- [ ] The Gmail watch is renewed daily by cron (§6.7), so push notifications don't lapse after Google's 7-day limit.
- [ ] Expired history (`history.list` 404) triggers a full resync rather than a failure loop.
- [ ] An authenticated user can send a message through Gmail.
- [ ] Read state synchronizes bidirectionally: marking read locally pushes to Gmail, and Gmail-side read-state changes flow back via Pub/Sub sync.
- [ ] Authentication failures return typed, recoverable-vs-fatal errors (`AUTH_FAILED` with a `recoverable` flag — see §3).
- [ ] The full Jest test suite passes with zero skipped tests.
- [ ] The backend is deployed and live on Vercel.
- [ ] Git history shows clean, sequential, reviewable units of work, matching the sequencing rule in §5.

## 2. Conventions

- Base path: every path in §6 is relative to `/api/v1` (e.g. the OAuth callback is `/api/v1/auth/google/callback`, matching `GOOGLE_REDIRECT_URI`), except the Pub/Sub webhook (`/webhook/gmail`) and the watch-renewal cron (`/cron/renew-watch`), which live outside `/api/v1`.
- Authentication: JWT Bearer on every endpoint except `GET /auth/google`, `GET /auth/google/callback`, the webhook (shared-secret token, §6.6) and the cron (cron secret, §6.7).
- Content type: `application/json` for all request/response bodies except the OAuth endpoints, the Pub/Sub webhook, and the cron.
- OAuth scopes requested: `https://www.googleapis.com/auth/gmail.modify` (covers read, label changes, send, `watch`, `history.list`) plus `openid email` (the ID token's `sub` becomes `google_id` and its `email` becomes `users.email`). No other Gmail scope is needed.
- Gmail identifiers: `id`, `threadId`, `historyId` and `internalDate` arrive from Gmail as strings. Application code keeps `historyId` as a string end to end; it is stored as `bigint` but must never pass through a JS `number` (precision loss above 2^53).
- Session: after successful OAuth, the client receives a JWT whose `sub` claim is the user's `users.id`, and must send it as an `Authorization: Bearer <jwt>` header on every authenticated request. Every authenticated endpoint acts only on that user's data. The JWT expires after 1 hour; once expired, requests fail with `AUTH_FAILED` (`recoverable: true`) and the client re-runs the OAuth flow to obtain a fresh token.
- Error envelope (all endpoints):
  ```json
  { "error": { "code": "STRING_CODE", "message": "human-readable", "details": { "...": "optional, error-specific" } } }
  ```
- Common error codes: `AUTH_FAILED` (401/400 — see §3 for the recoverable flag), `INVALID_REQUEST` (400), `NOT_FOUND` (404), `RATE_LIMITED` (429), `PROVIDER_ERROR` (502 — Gmail API itself failed), `INTERNAL_ERROR` (500). `UNAUTHORIZED` (401) is used only by the webhook and cron endpoints, which have no user session and therefore no `recoverable` semantics.

## 3. Auth error semantics

Every endpoint that requires a valid session uses one error code for all authentication problems:

```json
{ "error": { "code": "AUTH_FAILED", "message": "...", "details": { "recoverable": true } } }
```

- `recoverable: true` — the client can resolve this by re-running the normal flow (e.g. `Authorization` header missing/expired; redirect to `/auth/google` to obtain a fresh token).
- `recoverable: false` — the stored Gmail refresh token itself is invalid/revoked; no amount of retrying will help — the user must complete the full OAuth consent screen again.

**When `recoverable: false` fires.** The `googleapis` OAuth2 client refreshes access tokens automatically. If a refresh fails with Google's `invalid_grant` error, the stored refresh token is dead and the request fails with `AUTH_FAILED`, `recoverable: false`. Google kills refresh tokens when the user revokes access, changes their password (tokens with Gmail scopes), leaves the token unused for 6 months, or exceeds the per-client token limit. **While the Google Cloud app's consent screen is in "Testing" status, refresh tokens for `gmail.modify` expire after 7 days**, so weekly full re-consent is expected during development — it is not a bug.

**Token persistence rule.** Google issues a refresh token only on a consent that uses `access_type=offline`, and only reliably when `prompt=consent` forces the consent screen (§6.1). When the OAuth2 client refreshes, the `tokens` event it emits carries a new `access_token` and `expiry_date` but **no `refresh_token`**. The persistence listener must therefore merge: always update `access_token_enc` and `token_expires_at`, and update `refresh_token_enc` only when a non-empty `refresh_token` is present. It must never overwrite a stored refresh token with null.

## 4. Data Model

This is a **multi-user** system: any number of Google accounts can connect, one `users` row each, and every message belongs to exactly one user.

### Table: `messages`

One row per Gmail message per user, populated by the sync process (initial backfill + Pub/Sub-triggered incremental sync). Gmail message ids are only unique within one mailbox, so the primary key is `(user_id, id)`.

Postgres columns are snake_case (the schema branch migration is the source of truth for names); the API layer maps them to the camelCase fields in §6.

| Column | API field | Type | Source in Gmail API `messages.get` response |
|---|---|---|---|
| `user_id` | — | `uuid`, FK → `users.id` (`on delete cascade`) | the mailbox being synced, not from Gmail |
| `id` | `id` | `text` (PK with `user_id`) | `message.id` |
| `thread_id` | `threadId` | `text` | `message.threadId` |
| `subject` | `subject` | `text`, not null (`''` if absent) | header `Subject` (header names matched case-insensitively) |
| `from_address` | `from` | `text`, not null (`''` if absent) | header `From` |
| `to_address` | `to` | `text`, not null (`''` if absent) | header `To` |
| `cc` | `cc` | `text`, nullable | header `Cc` |
| `snippet` | `snippet` | `text` | `message.snippet` |
| `body_text` | `bodyText` | `text`, nullable | decoded base64url `body.data` of the first `text/plain` part found by depth-first search of the whole `payload` tree (parts nest, e.g. `multipart/alternative` inside `multipart/mixed`); `payload.body.data` if `payload` has no `parts` and is `text/plain`. Parts with a `filename` or `body.attachmentId` are skipped. |
| `body_html` | `bodyHtml` | `text`, nullable | same search rule as `body_text`, for the first `text/html` part |
| `label_ids` | — | `text[]` | `message.labelIds` |
| `is_read` | `isRead` | `boolean`, **generated** | `NOT ('UNREAD' = ANY(label_ids))` — never written directly; change `label_ids` instead |
| `received_at` | `receivedAt` | `timestamptz` | `message.internalDate` (epoch ms, converted); the `Date` header only if `internalDate` is missing |
| `history_id` | — | `bigint` | `message.historyId` |
| `synced_at` | — | `timestamptz` | set by our sync process, not from Gmail |

Starred state has no column: it is `'STARRED' = ANY(label_ids)`, derived where needed.

Attachments are explicitly **out of scope** for this model (send has no attachment support; received-attachment metadata is deferred).

Messages deleted in Gmail (`history.list` → `messagesDeleted`) are deleted from `messages`. Trashing is a label change (`TRASH`) and is handled like any other label update.

### Table: `users`

One row per connected Google account. Re-consent by the same account updates its existing row: writes upsert **on conflict `google_id`**.

| Field | Type | Notes |
|---|---|---|
| `id` | `uuid` PK, default `gen_random_uuid()` | our user id; the JWT `sub` (§2) |
| `google_id` | `text`, unique, not null | ID token `sub` claim: Google's stable account id (an email address can change, this can't). **Pending in the schema branch migration.** |
| `email` | `text`, unique, not null | ID token `email` claim at OAuth time; used to route webhook notifications (§6.6) |
| `access_token_enc` | `bytea`, not null | encrypted, see "Token encryption" below |
| `refresh_token_enc` | `bytea`, not null | encrypted; follows the §3 merge rule (never overwritten with null). Always present because §6.1 forces consent. |
| `token_expires_at` | `timestamptz`, not null | |
| `last_history_id` | `bigint`, nullable | Gmail mailbox historyId watermark; incremental sync resumes from here. Initial value: the `historyId` returned by `users.watch()`, captured **before** the backfill starts, so changes arriving during the backfill are replayed rather than missed (replays are safe because sync is idempotent). |
| `watch_expiration` | `timestamptz`, nullable | Gmail `users.watch()` expiration (epoch ms, converted). Google requires renewal at least every 7 days; the cron in §6.7 renews it daily. |
| `created_at` / `updated_at` | `timestamptz` | |

Gmail's `watch()` response has no resource or channel id (unlike Drive and Calendar watch channels), so there is nothing else to store for a watch.

### Token encryption

Tokens are encrypted **in the application** before they reach Supabase, never in SQL, so the key never enters the database:

- Algorithm: AES-256-GCM (Node `crypto`), a fresh random 12-byte IV per encryption, 16-byte auth tag.
- Stored layout in the `bytea` column: `iv (12 bytes) ‖ authTag (16 bytes) ‖ ciphertext`.
- Key: `ENCRYPTION_KEY`, exactly 32 bytes, given as 64 hex characters or as base64. The app refuses to start with a key of the wrong length.
- A failed auth-tag check on decrypt is treated as corrupt data (`INTERNAL_ERROR`), never as an auth failure.

## 5. Sequencing rule (two-session build)

Logic ships before schema merges. The two sessions run in parallel, not strictly back-to-back — only the schema **merge** is gated.

**Session 1 — server logic:**
Implement all endpoint handlers in §6, the Gmail API client wrapper, token encrypt/decrypt helpers, JWT issue/verify, and Pub/Sub payload parsing, all behind a persistence *interface*. This session establishes what storage actually needs to look like. Session 1 is done only when every endpoint's success path and every typed error case in this document has a passing Jest test, and the full suite is green with zero skipped tests, run against live Supabase (the verification gate — see BUILD_SEQUENCE.md unit 7).

**Session 2 — schema:**
Design the actual Supabase schema (`users`, `messages` tables above) and write the SQL migration in parallel with Session 1. No database-side encryption extension is needed: tokens arrive already encrypted (§4). The schema may be applied to a real database early — Session 1's suite needs somewhere live to run against — but it is not reviewed or merged as the accepted schema until Session 1's verification gate passes.

## 6. Endpoint Contracts

### 6.1 `GET /auth/google`

Starts the OAuth flow. Not session-authenticated; this is where clients are sent on any `AUTH_FAILED`.

**Request:** no params.

**Success response:** `302 Found` to Google's consent URL, built by the OAuth2 client's `generateAuthUrl` with `access_type=offline`, `prompt=consent`, the scopes from §2, and a random `state`. The same `state` is set in an `oauth_state` cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, 10-minute max-age) so the callback can verify it without server-side storage.

**Errors:**
| Status | Code | Notes |
|---|---|---|
| 500 | `INTERNAL_ERROR` | OAuth client misconfigured (missing env vars) |

### 6.2 `GET /auth/google/callback`

OAuth redirect target from Google.

**Request** — query params:
| Param | Type | Notes |
|---|---|---|
| `code` | string | present on success |
| `state` | string | CSRF token; must equal the `oauth_state` cookie set by §6.1 |
| `error` | string, optional | present if consent failed: `access_denied` (user declined) or another Google error value such as `admin_policy_enforced` or `org_internal` |

**Success response:** `302 Found`, `Location: <FRONTEND_URL>/inbox#token=<jwt>` — the JWT is delivered in the URL fragment (never sent to the server or logged) for the client to read and store; the client attaches it as `Authorization: Bearer <jwt>` on all subsequent requests. The `oauth_state` cookie is cleared.

Side effects, in order:
1. Exchange `code` for tokens and check the granted scopes include `gmail.modify` (users can approve only some of the requested scopes).
2. Verify the returned ID token and read its `sub` (→ `google_id`) and `email`. Encrypt the tokens and upsert the `users` row on conflict `google_id` (applying the §3 merge rule to `refresh_token_enc`).
3. Register `users.watch()` on `GOOGLE_PUBSUB_TOPIC`; store its `expiration` as `watch_expiration` and its `historyId` as `last_history_id`.
4. Run the initial backfill of that user's 50 most recent **inbox** messages (`messages.list` with `labelIds=INBOX`, following `nextPageToken` until 50 are collected, then `messages.get` with `format=full` for each), upserting by `(user_id, id)`. The backfill does not touch `last_history_id` (`messages.list` returns no `historyId`; the watermark from step 3 already covers everything after the backfill began).
5. Issue a JWT with `sub` = `users.id`.

**Errors:**
| Status | Code | recoverable | When |
|---|---|---|---|
| 400 | `AUTH_FAILED` | `true` | missing `code`, missing or mismatched `state`, any `error` param from Google, `invalid_grant` on code exchange (code expired or already used), or `gmail.modify` not granted — the user can retry the flow |
| 502 | `AUTH_FAILED` | `false` | Google's token endpoint returned any other error (outage, misconfigured client) |
| 502 | `PROVIDER_ERROR` | — | tokens were saved but `watch()` or the backfill failed; retrying the flow repeats both safely |

### 6.3 `GET /messages`

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
Returns only messages whose `user_id` is the JWT's `sub`. Sorted `receivedAt` descending (newest first).

**Errors:**
| Status | Code | Notes |
|---|---|---|
| 401 | `AUTH_FAILED` (`recoverable` per §3) | missing/expired/invalid `Authorization` header |
| 400 | `INVALID_REQUEST` | invalid `limit`/`cursor` |
| 500 | `INTERNAL_ERROR` | unexpected failure |

### 6.4 `POST /messages/send`

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

The message is built as RFC 2822 and sent base64url-encoded in `requestBody.raw` (never via the `media` upload parameter). For Gmail to place a reply in the thread, `threadId` must be set, the `In-Reply-To` and `References` headers must carry `inReplyTo`, and the `Subject` must match the thread's subject.

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

### 6.5 `PATCH /messages/:id/read`

**Request** — requires `Authorization: Bearer <jwt>` header. Path param `id` (Gmail message id). No body.
Behavior: looks the message up by `(user_id = JWT sub, id)`; then calls Gmail `messages.modify` with that user's tokens to remove the `UNREAD` label; only on success updates the local `messages` row's `isRead`.

**Success response:** `200 OK`
```json
{ "id": "string", "isRead": true }
```

**Errors:**
| Status | Code | Notes |
|---|---|---|
| 401 | `AUTH_FAILED` | see §3 |
| 404 | `NOT_FOUND` | message id not present in this user's messages (another user's message id is also a 404, never a 403, so ids don't leak across users) |
| 502 | `PROVIDER_ERROR` | Gmail's `messages.modify` call failed — local row is NOT updated |
| 500 | `INTERNAL_ERROR` | unexpected failure |

### 6.6 `POST /webhook/gmail?token=<shared-secret>`

Gmail Pub/Sub push subscription target. Not session-authenticated; verified by matching the `token` query param against `GOOGLE_PUBSUB_VERIFICATION_TOKEN` using a constant-time comparison.

Pub/Sub treats `102`, `200`, `201`, `202` and `204` as acknowledged; **any other status is redelivered with exponential backoff** (up to the subscription's retention period). Status codes below are chosen with that in mind.

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
Other envelope fields (`attributes`, `message_id`, `publish_time`, `deliveryAttempt`) may be present and are ignored. Decoded `data` JSON (base64): `{ "emailAddress": "string", "historyId": "string" }`.

**Processing is synchronous.** The handler finishes all sync work *before* responding. Serverless functions don't reliably run work after the response is sent, and a failure must still be able to return 500 so Pub/Sub retries. The notification's `historyId` only signals that something changed; the sync always reads forward from the stored watermark:

1. Find the user whose `users.email` equals `emailAddress`. If there is none, acknowledge with `204` and do nothing.
2. Using that user's tokens, call `history.list` with `startHistoryId = users.last_history_id`, following `nextPageToken` until exhausted.
3. Apply records to that user's messages only: `messagesAdded` → `messages.get` (`format=full`) and upsert; `labelsAdded`/`labelsRemoved` → update `labelIds` and `isRead`; `messagesDeleted` → delete the row. If `messages.get` returns 404 (the message was deleted since the record was written), skip it.
4. Set the user's `last_history_id` to the `historyId` of the final `history.list` response, but only if it is greater than the stored value (a redelivered older notification must never move the watermark backwards).

**History expired.** If `history.list` returns `404` (Google keeps history for about a week, sometimes only hours), run a full resync for that user instead: fetch the current mailbox `historyId` via `users.getProfile`, re-run the 50-message backfill from §6.2, then store that `historyId` as `last_history_id`. This is a success path, not an error.

**Dead refresh token.** If the user's refresh token is rejected (`invalid_grant`), acknowledge with `204`: nothing can succeed until that user re-consents, and redelivery would retry forever.

Processing must be idempotent (Pub/Sub may redeliver); every write above is an upsert, a delete, or a monotonic watermark update.

**Success response:** `200 OK`, empty body (`204` for the ignored cases above).

**Errors:**
| Status | Code | Notes |
|---|---|---|
| 401 | `UNAUTHORIZED` | `token` query param missing or mismatched (redelivered until the configuration is fixed) |
| 204 | — | malformed Pub/Sub envelope or undecodable `data`: logged and **acknowledged**, because redelivering a message that can never be parsed would retry forever |
| 500 | `INTERNAL_ERROR` | processing failed (including Gmail or Supabase errors) — return 500 so Pub/Sub retries with backoff |

### 6.7 `GET /cron/renew-watch`

Invoked daily by Vercel Cron. Google stops push notifications if `users.watch()` isn't renewed at least every 7 days; Google recommends renewing daily.

**Request:** header `Authorization: Bearer <CRON_SECRET>` (Vercel Cron sends this automatically when `CRON_SECRET` is set). No params.

**Behavior:** for every user, calls `users.watch()` again with the same topic and updates that user's `watch_expiration`. `last_history_id` is not changed. Users are processed independently: one user's failure never stops the others. A user whose refresh token is dead is skipped (their watch lapses until they re-consent).

**Success response:** `200 OK`, even if some users failed (the per-user results are the signal):
```json
{ "renewed": 3, "skippedAuthRevoked": 1, "failed": 0 }
```

**Errors:**
| Status | Code | Notes |
|---|---|---|
| 401 | `UNAUTHORIZED` | missing or wrong cron secret |
| 500 | `INTERNAL_ERROR` | the user list itself couldn't be read |
