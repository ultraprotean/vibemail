# VibeMail Cozy — Behavioural Spec

This spec describes what the VibeMail Cozy frontend does in every state. It uses only the names defined in `CONTRACT.md`: endpoints (§6), message fields (§6.3), and error codes (§2, §3, §6). Where an idea needs something the contract does not provide, it is marked **Not in CONTRACT.md** and the frontend degrades instead of inventing a name.

## Contract names this spec relies on

- Base path `/api/v1`. Every request except the OAuth start and callback carries `Authorization: Bearer <jwt>`.
- Endpoints: `GET /api/v1/auth/google` (§6.1), `GET /api/v1/auth/google/callback` (§6.2), `GET /api/v1/messages` (§6.3), `POST /api/v1/messages/send` (§6.4), `PATCH /api/v1/messages/:id/read` (§6.5).
- Message fields returned by `GET /api/v1/messages`: `id`, `threadId`, `subject`, `from`, `to`, `cc`, `snippet`, `bodyText`, `bodyHtml`, `isRead`, `receivedAt`. The response also carries `nextCursor`. `subject`, `from` and `to` are empty strings when absent; `cc`, `bodyText`, `bodyHtml` and `nextCursor` can be `null`.
- Error envelope: `{ "error": { "code", "message", "details" } }`. Codes the frontend handles: `AUTH_FAILED` (with `details.recoverable`), `INVALID_REQUEST`, `NOT_FOUND`, `RATE_LIMITED`, `PROVIDER_ERROR`, `INTERNAL_ERROR`. A network failure has no response and therefore no code; it is described as "no response" below.
- **Not in CONTRACT.md** (so never sent, read, or relied on): `labelIds`, `status`, `isStarred`, `draftId`, `bodyPlain`, thread, draft, search and attachment endpoints, and any star, archive or trash action.

## Session handling (every view)

- The landing screen offers a pair of launch buttons, each with a one-line explanation. "Sign in with Google" ("Your real Gmail, kept in sync by VibeMail") navigates the browser to `GET /api/v1/auth/google`. After consent the API redirects to `<FRONTEND_URL>/inbox#token=<jwt>`. The inbox reads the token from the URL fragment, stores it, and removes the fragment from the address bar. "Try the sample inbox" ("Pretend mail to explore. No account, nothing leaves this browser") opens the inbox on built-in sample mail, makes no API requests, and shows a "Sample" badge beside the brand.
- The chosen mode is remembered in the browser. A remembered sample choice reopens the sample inbox on reload, and the landing screen still shows both buttons. A signed-in Gmail session skips the landing screen and goes straight to the inbox. A fresh Google sign-in always wins over a remembered sample choice. Settings shows "Sign out" for a Gmail session and "Leave sample inbox" in sample mode; either clears the stored token and the remembered mode and returns to the landing screen.
- Visiting any signed-in view with neither a stored token nor a remembered sample choice redirects to the landing screen.
- Any `AUTH_FAILED` response clears the stored token and returns to the landing screen with an explanation. With `details.recoverable: true` the message is "Your session ended. Sign in again to continue." With `details.recoverable: false` it is "Google access was revoked. Sign in again and approve access to continue." Unsent compose content is kept (see Compose drawer).
- The JWT expires after one hour (§2), so a session ending mid-use is normal and not an error state to alarm the user about.

## Inbox

Endpoints: `GET /api/v1/messages` (§6.3), `PATCH /api/v1/messages/:id/read` (§6.5).

### Default state

- On entry the frontend requests the first page with `limit=20`. The server returns newest first (`receivedAt` descending) and the frontend keeps that order.
- Each row shows the sender (the display name parsed from `from`, or the bare address when there is no name), `subject` (shown as "(no subject)" when it is an empty string), `snippet`, and `receivedAt` as a relative time (today: clock time; this week: weekday; older: short date).
- A row with `isRead: false` is unread: bold subject, a filled marker, and a slightly stronger surface. A row with `isRead: true` is plain.
- Below the list, "Load more" appears only while `nextCursor` is not `null`.
- A search field, the label filter bar, and a New message button sit above and beside the list. The New message button stays reachable at all times on mobile, above the safe-area inset.
- The list refreshes itself by re-requesting the first page when the window regains focus and every 60 seconds while visible. New messages are merged in at the top without moving the user's scroll position and without discarding pages already loaded.

### User actions

- Open a row: shows the Thread view for that row's `threadId`. Opening marks every unread message in that thread read through `PATCH /api/v1/messages/:id/read` with no body.
- Toggle unread on a row: marks the message unread with `PATCH /api/v1/messages/:id/read` and body `{ "isRead": false }`. Marking it read again sends the request with no body. The row updates immediately and reverts if the request fails.
- Load more: requests the next page with `cursor` set to the last `nextCursor` and the same `limit` and `unreadOnly`.
- Switch the Unread chip or any chip: restarts paging from the first page.
- New message: opens the Compose drawer in default mode.
- There are no star, archive, trash or delete actions (**Not in CONTRACT.md**).

### Loading state

- First load: six placeholder rows shaped like real rows, with a slow shimmer that stops under reduced motion.
- Load more: the button is replaced by an inline "Fetching more mail…" line; existing rows stay.
- A row whose `PATCH` is in flight shows a small pending indicator on its marker and ignores further toggles until the request settles.

### Error states

- `AUTH_FAILED`: handled as described in Session handling.
- `INVALID_REQUEST` (stale or malformed `cursor`, or a bad `limit`): drop the cursor and reload the first page. If it repeats, show the error panel below.
- `INTERNAL_ERROR` on the first load or on a reload (Try again, or a filter change) with no rows to show: a panel replaces the list with "Something went wrong on our side" and a Try again button.
- No response (network failure) in the same situation: the panel reads "Can't reach VibeMail right now" with Try again.
- A failed background refresh (focus or timer) is silent: the rows already loaded stay, and the next refresh tries again.
- A failed Load more leaves the loaded rows in place and shows a toast.
- On a row action, `NOT_FOUND`: the row is removed and a toast says "That message is no longer in your mailbox."
- On a row action, `PROVIDER_ERROR`: the row reverts and a toast says "Gmail didn't accept that change. Try again."
- On a row action, `INTERNAL_ERROR`: the row reverts and a toast says "That didn't work. Try again."

### Empty state

- All: "Your inbox is empty." with a quiet illustration. (A new account's first sign-in backfills the 50 most recent inbox messages, so this is mostly seen on genuinely empty mailboxes.)
- Unread chip active: "No unread mail. You're all caught up."

### Label filter bar

- Four fixed chips always render in this order: All, Starred, Archive, Trash. Custom Gmail labels would follow them.
- Only All is functional. Starred, Archive and Trash render disabled (`aria-disabled`, not focus-skipped) with a tooltip and screen-reader hint "Needs backend support: the messages response does not include labels." The messages response has no `labelIds` (§6.3), so these cannot be filtered on the client either.
- No custom label chips render, because label names and ids are **Not in CONTRACT.md**.
- A separate Unread toggle chip sits after the fixed chips. When on, the request adds `unreadOnly=true` (a real server-side filter) and paging restarts.
- `status` and `isStarred` are **not API fields**. If a future contract exposes `labelIds`, they would be derived on the client from `labelIds` and would never be set, sent, or written back by the frontend.
- On mobile the chips scroll horizontally in a single row; the disabled chips remain visible.

## Thread view

Endpoint: `PATCH /api/v1/messages/:id/read` (§6.5) only. There is **no thread endpoint**; the thread is built on the client.

### Default state

- Opened from an inbox or search row, the thread view replaces the inbox content with a slide transition (no transition under reduced motion). The address carries the `threadId` so a refresh restores the view.
- Messages are all loaded messages whose `threadId` matches, ordered oldest first by `receivedAt`. The latest message is expanded; earlier ones are collapsed to a one-line `from`, `snippet` and `receivedAt` row that expands on activation.
- The header shows the `subject` of the first message (or "(no subject)"), a back control, a Reply button, an unread toggle, and a "View in Gmail" link to the thread on mail.google.com (a web link, not a VibeMail endpoint).
- Each expanded message shows `from`, `to`, `cc` (only when not `null`), `receivedAt`, and its body.
- Body rule: `bodyHtml` is shown by default whenever a message has it, because that is how the sender designed it; `bodyText` is the default only when `bodyHtml` is `null`. HTML is rendered inside an iframe whose `sandbox` allows no scripts. A per-message Plain / HTML toggle is always shown: Plain is disabled when `bodyText` is `null`, HTML is disabled when `bodyHtml` is `null`, and the choice resets whenever the user navigates to another thread.
- Images in HTML mail: images on the sender's servers (https) load by default. Scripts, remote stylesheets, remote fonts and every other kind of remote content are always blocked, and the page address is never sent with image requests. Settings has a "Load images in HTML mail" switch; when it is off, a message that contains remote images shows "Remote images are blocked" with a "Load images for this message" button that loads them for that message only. Images embedded in the message itself (inline data) always display. Images attached to the message and referenced by `cid:` cannot display, because attachments are out of scope (CONTRACT.md §4).
- If the thread's messages are not in the loaded set (for example after a refresh), the frontend loads pages of `limit=100` following `nextCursor`, up to five pages, until it finds the `threadId`.

### User actions

- Back: returns to the inbox at the same scroll position and filter.
- Reply: opens the Compose drawer in reply mode for the latest message.
- Unread toggle: marks the latest message unread (`PATCH` with `{ "isRead": false }`) or read again (`PATCH` with no body) and updates the header state.
- Expand or collapse an earlier message.
- Plain / HTML toggle on a message.

### Loading state

- While paging to find the thread: a header skeleton and two message skeletons with "Finding your conversation…".
- Marking messages read is silent; a small spinner replaces the unread marker until it settles.

### Error states

- `AUTH_FAILED`: as in Session handling.
- `NOT_FOUND` from the read request: that message is shown as read locally, and a toast says "That message is no longer in your mailbox."
- Thread not found after the page limit: a panel "This conversation isn't in your loaded mail" with a Back button. (This is a client condition, not an API error code.)
- `PROVIDER_ERROR` or `INTERNAL_ERROR` on a read or unread change: the toggle reverts and a toast explains it.
- No response (network failure): banner with Try again; content already shown stays.

### Empty state

None. A thread view exists only for a thread that has at least one message.

## Compose drawer

Endpoint: `POST /api/v1/messages/send` (§6.4). Request fields: `to` (array), optional `cc` and `bcc` (arrays), `subject`, `bodyText`, optional `threadId`. A successful response is `201` with `id`, `threadId` and `status: "sent"`. Attachments are out of scope (§4); there is no paperclip.

### Shared behaviour

- Fields: To (multiple addresses as chips), Cc and Bcc (hidden behind small toggles), Subject, Body (sent as `bodyText`).
- Validation runs on submit, not on blur. It mirrors the server: at least one `to` address, every address well formed, a non-blank `subject`, a non-empty body. Failures are shown inline under the field and focus moves to the first one.
- Drafts are local only. The content autosaves to the browser about one second after the last keystroke. **Drafts are not on the server:** the contract has no draft endpoints, so `draftId` does not exist, and if drafts are ever added `draftId` is server-managed and never supplied by the client.
- A successful send closes the drawer, deletes the local draft, shows a "Sent" toast, and refreshes the inbox first page.
- Loading: Send shows a spinner and every field is read-only until the response arrives; the drawer cannot be dismissed with Escape while a send is in flight.
- Error states: `INVALID_REQUEST` (the message from the response is shown above the Send button and the draft is kept); `AUTH_FAILED` (the draft is kept and the user is sent to sign in; on return, choosing New message or Reply opens the drawer in draft-restored mode); `PROVIDER_ERROR` ("Gmail couldn't send that. Your draft is safe. Try again."); `RATE_LIMITED` ("Gmail asked us to slow down." Send stays disabled for 30 seconds with a visible countdown); `INTERNAL_ERROR` ("Something went wrong on our side. Your draft is safe."); no response (network failure: "Can't reach VibeMail. Your draft is safe.").
- Mobile keyboard behaviour: the drawer is a bottom sheet whose maximum height is 58% of the visual viewport (the area left when the on-screen keyboard is open), tracked live from the `visualViewport` size, with 58vh as the fallback where it is unavailable. The header and the Send footer stay pinned and the body scrolls inside the drawer; the focused field is scrolled into view. The footer respects the bottom safe-area inset. On desktop the drawer is a docked panel at the bottom right and the 58% cap does not apply.
- Keyboard: focus moves into the drawer when it opens and returns to the control that opened it; Tab is trapped inside; Escape closes it (keeping the draft); Ctrl or Cmd with Enter sends.

### Default mode (new message)

- All fields empty and editable; focus starts in To. The title reads "New message".
- Closing a drawer that has any content keeps the draft locally; closing an empty one discards nothing.

### Reply mode

- Opened from a thread's Reply button. To is read-only and holds the address parsed from the replied message's `from`. Subject is `subject` with "Re: " prepended unless it already starts with "Re:". Cc and Bcc are available and empty.
- The drawer sends the replied message's `threadId` with the request.
- Below the body field a quoted excerpt of the replied message (from `bodyText`, or `snippet` when `bodyText` is `null`) shows at reduced opacity and is not part of what is sent unless the user copies it.
- Focus starts in Body.
- Known limitation: Gmail only threads a reply when `In-Reply-To` and `References` also carry the original RFC Message-ID, and the API does not expose that value. The reply is sent with `threadId` and a matching subject; whether Gmail keeps it in the thread must be confirmed against a real mailbox.

### Draft-restored mode

- Opened automatically when New message or Reply is chosen and a saved local draft exists for it (one draft for new messages, one per `threadId` for replies). Fields are prefilled, the title reads "Draft restored", and a Discard draft chip is shown at the top.
- Discard draft asks nothing further, clears the saved draft, and turns the drawer into an empty default-mode drawer (or a fresh reply-mode drawer when it was a reply).
- Editing continues to autosave. Sending works exactly as in the other modes.

## Label filter

This section restates the inbox filter bar as its own concern because it has no endpoint of its own.

- Client-side only; there is no dedicated endpoint.
- The four fixed chips (All, Starred, Archive, Trash) always render. Only All is functional until the contract exposes labels; the other three are disabled and explain why.
- The Unread toggle is the only filter that reaches the server, through `unreadOnly=true` on `GET /api/v1/messages`.
- `status` and `isStarred` are **not API fields**; nothing in the frontend reads, derives, or sets them today.
- Loading, error and empty behaviour are those of the Inbox.

## Search

No search endpoint exists (**Not in CONTRACT.md**), so search runs on the client over the messages already loaded.

### Activation condition

- The search field is always visible on the inbox. Matching starts only when the field holds at least one non-space character, so an empty search never produces a "missing query" state.
- Ctrl or Cmd with K focuses the field from anywhere in the inbox. Escape clears it and returns focus to the list.

### Default state

- Matching is case-insensitive and runs against `subject`, `from`, `to`, `cc`, `snippet` and `bodyText` of loaded messages, after about 150 ms of typing pause. Results use the same row as the inbox, with the matched text highlighted.
- A line under the field reads "Searching the mail loaded so far" with a "Load older mail" button while `nextCursor` is not `null`. Each press loads one more page of up to 100 messages (`limit=100`), up to five pages in total, then the button goes away and the line says how many messages were searched.
- A visible Clear button resets the field.

### Loading state

- While older mail is being fetched, the line reads "Looking through older mail…" and existing results stay; new matches appear as pages arrive.

### Error states

- `AUTH_FAILED`: as in Session handling.
- `INVALID_REQUEST` or `INTERNAL_ERROR` while loading older mail: results so far stay, with "Couldn't load older mail" and Try again.
- No response (network failure): the same inline message.

### Empty state

- No matches: "No messages match your search." with the number of messages searched.

## Visual Direction

VibeMail Cozy feels like opening a village inn's message board: warm parchment panels with chunky rounded borders and soft paper-cutout shadows, the way Paper Mario folds a world out of cardboard. Surfaces borrow the Final Fantasy VI menu window (a gentle gradient, a bright inner rim) and the Chrono Trigger sense of lamplit, lived-in warmth, with a small pointing-hand cursor that slides beside the focused row. There are three themes to choose from in Settings, Hearthside (cream, amber and brown), Moonlit Window (twilight blue with a pale rim) and Meadow Paper (soft green and rose), each paired with a selectable background pattern such as paper grain, gingham, drifting clouds or gently twinkling star-dust that glides slowly down and to the right by default (or in any compass direction, or a big circle) at a speed you set in Settings, and a new random theme, pattern and drift greet you each visit until you choose your own. Colour stays in support of reading and never competes with the mail, and motion is subtle (an idle bob on unread markers, the drawer settling into place, a tiny sparkle when a message is sent) and switches off entirely, drift included, under reduced-motion preferences or the Settings toggle. Headings use a pixel-style display face and message text uses a highly legible rounded sans-serif so the nostalgia lives in the chrome, not in the words.
