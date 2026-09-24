/**
 * Provider abstraction: the contract every email provider implementation must satisfy.
 *
 * This file is deliberately provider-agnostic. It imports nothing, and no provider SDK
 * type or name appears here. Identifiers and change cursors are opaque strings (never
 * numbers, so large sequence ids keep full precision). Timestamps are `Date`s.
 *
 * Section references (§) point to CONTRACT.md.
 */

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** OAuth tokens as held by our system (stored encrypted in the `account` row, §4). */
export interface ProviderTokens {
  accessToken: string;
  /** Null only if the provider issued none; §6.1 forces consent so one is always requested. */
  refreshToken: string | null;
  expiresAt: Date;
}

/**
 * Emitted by a `MailboxClient` whenever it obtains new tokens (e.g. automatic refresh).
 *
 * An absent `refreshToken` means "keep the stored one": providers usually omit it on
 * refresh. Listeners must merge, never overwrite a stored refresh token with null (§3).
 */
export interface TokenUpdate {
  accessToken: string;
  expiresAt: Date;
  refreshToken?: string;
}

export type TokenListener = (update: TokenUpdate) => Promise<void>;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * A message normalized out of the provider's native shape, carrying the §4 `messages`
 * fields. `syncedAt` is absent because our sync process sets it, not the provider.
 */
export interface ProviderMessage {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc: string | null;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  labels: string[];
  isRead: boolean;
  receivedAt: Date;
  /** The provider's change-sequence marker for this message (stored as `historyId`, §4). */
  cursor: string;
}

export interface MessagePage {
  messages: ProviderMessage[];
  nextPageCursor: string | null;
}

interface SendMessageBase {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Reply support: set both to place the message in an existing thread (§6.4). */
  threadId?: string;
  inReplyTo?: string;
}

/** §6.4 request body. At least one of `bodyText` / `bodyHtml` is required; no attachments. */
export type SendMessageInput =
  | (SendMessageBase & { bodyText: string; bodyHtml?: string })
  | (SendMessageBase & { bodyText?: string; bodyHtml: string });

export interface SentMessage {
  id: string;
  threadId: string;
}

// ---------------------------------------------------------------------------
// Push sync
// ---------------------------------------------------------------------------

export interface WatchRegistration {
  /** Mailbox cursor at registration time; the initial `last_history_id` (§4, §6.2). */
  cursor: string;
  /** When push notifications stop unless renewed (`watch_expiration`, §6.7). */
  expiresAt: Date;
}

export type MailboxChange =
  | { type: 'added'; messageId: string }
  | { type: 'deleted'; messageId: string }
  | { type: 'labelsChanged'; messageId: string; added: string[]; removed: string[] };

export interface ChangeSet {
  /** All changes after the requested cursor, in order; pagination is handled internally. */
  changes: MailboxChange[];
  /** The mailbox cursor to store as the new watermark (§6.6 step 4). */
  cursor: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Failure categories every provider maps its native errors onto. Handlers map these to
 * the CONTRACT.md error envelope:
 *
 * - `AUTH_CODE_INVALID`  → 400 `AUTH_FAILED`, `recoverable: true` (code expired or reused, §6.2)
 * - `AUTH_SCOPE_MISSING` → 400 `AUTH_FAILED`, `recoverable: true` (partial consent, §6.2)
 * - `AUTH_REVOKED`       → `AUTH_FAILED`, `recoverable: false` (refresh token dead, §3)
 * - `RATE_LIMITED`       → 429 `RATE_LIMITED`
 * - `NOT_FOUND`          → 404 `NOT_FOUND`, or skipped during webhook sync (§6.6 step 3)
 * - `CURSOR_EXPIRED`     → not an error response: triggers a full resync (§6.6)
 * - `UPSTREAM`           → 502 (`AUTH_FAILED` non-recoverable during code exchange, else `PROVIDER_ERROR`)
 */
export type ProviderErrorKind =
  | 'AUTH_CODE_INVALID'
  | 'AUTH_SCOPE_MISSING'
  | 'AUTH_REVOKED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'CURSOR_EXPIRED'
  | 'UPSTREAM';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly cause?: unknown;

  constructor(kind: ProviderErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Provider interfaces
// ---------------------------------------------------------------------------

/**
 * An email provider. Handles the unauthenticated OAuth steps and creates authorized
 * mailbox clients. Provider configuration (client credentials, redirect URI, push topic)
 * is supplied to the implementation's constructor, not through this interface.
 */
export interface EmailProvider {
  /**
   * §6.1 — Build the consent URL: offline access, forced consent, required scopes,
   * and the given CSRF `state`.
   */
  buildAuthUrl(state: string): string;

  /**
   * §6.2 step 1 — Exchange an authorization code for tokens and confirm every required
   * scope was granted.
   * @throws ProviderError `AUTH_CODE_INVALID`, `AUTH_SCOPE_MISSING`, or `UPSTREAM`.
   */
  exchangeCode(code: string): Promise<ProviderTokens>;

  /**
   * Create a client authorized with stored tokens. The client refreshes access tokens
   * automatically and reports every new token set through `onTokensChanged`.
   */
  connect(tokens: ProviderTokens, onTokensChanged: TokenListener): MailboxClient;
}

/**
 * An authorized view of one mailbox. Every method may throw `ProviderError` with kind
 * `AUTH_REVOKED`, `RATE_LIMITED`, or `UPSTREAM`; other kinds are listed per method.
 */
export interface MailboxClient {
  /**
   * Force an access-token refresh. Normal calls refresh automatically; this exists to
   * check a stored refresh token is still alive. The result is also sent to the listener.
   */
  refreshAccessToken(): Promise<ProviderTokens>;

  /** §6.2 step 2 — The mailbox owner's email address. */
  getAccountEmail(): Promise<string>;

  /** §6.2 step 4 — Most recent messages first, fully populated (backfill and resync). */
  listMessages(opts: { limit: number; pageCursor?: string }): Promise<MessagePage>;

  /**
   * §6.6 step 3 — One fully populated message.
   * @throws ProviderError `NOT_FOUND` if the message no longer exists.
   */
  getMessage(id: string): Promise<ProviderMessage>;

  /** §6.4 — Send a message, optionally as a reply within a thread. */
  sendMessage(input: SendMessageInput): Promise<SentMessage>;

  /**
   * §6.5 — Mark a message read or unread in the provider.
   * @throws ProviderError `NOT_FOUND` if the message no longer exists.
   */
  setReadState(id: string, isRead: boolean): Promise<void>;

  /**
   * §6.2 step 3 and §6.7 — Register push notifications for this mailbox, or renew an
   * existing registration (the same call does both).
   */
  watchMailbox(): Promise<WatchRegistration>;

  /**
   * §6.6 steps 2–3 — Every change after `cursor`.
   * @throws ProviderError `CURSOR_EXPIRED` if the provider no longer holds history that
   * far back; the caller must then run a full resync.
   */
  listChangesSince(cursor: string): Promise<ChangeSet>;

  /** §6.6 full resync — The mailbox's current cursor. */
  getCurrentCursor(): Promise<string>;
}
