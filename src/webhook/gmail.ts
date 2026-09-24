import { createHash, timingSafeEqual } from 'node:crypto';
import type { MessageStore } from '../db/message-store';
import type { SyncUser, UserStore } from '../db/user-store';
import { runInitialSync } from '../sync';
import { ProviderError, type MailboxChange, type MailboxClient, type ProviderMessage } from '../types/provider';

/**
 * Pub/Sub push webhook for Gmail (CONTRACT.md §6.6, BUILD_SEQUENCE.md unit 4).
 *
 * Acknowledge first, then process: the handler checks the shared-secret token, parses the
 * envelope, replies, and hands the sync to `defer` (Vercel's `waitUntil` in production).
 * A failed sync isn't retried by Pub/Sub; the watermark only moves on success, so the
 * user's next notification re-reads whatever was missed.
 */

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

export interface GmailNotification {
  /** Pub/Sub message id, for logging. */
  messageId: string;
  emailAddress: string;
  historyId: string;
}

export interface WebhookRequest {
  /** The `token` query parameter. */
  token: string | undefined;
  /** The parsed JSON body. */
  body: unknown;
}

export interface WebhookResponse {
  status: 200 | 204 | 401;
  body?: { error: { code: 'UNAUTHORIZED'; message: string } };
}

export interface WebhookHandlerDeps {
  /** `GOOGLE_PUBSUB_VERIFICATION_TOKEN`. */
  verificationToken: string;
  /** Keeps background work alive after the response (Vercel: `waitUntil`). */
  defer: (work: Promise<void>) => void;
  /** Runs the sync for one notification. Its errors are caught and logged, never thrown. */
  process: (notification: GmailNotification) => Promise<SyncOutcome>;
  log?: WebhookLogger;
}

export interface WebhookLogger {
  info(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const consoleLogger: WebhookLogger = {
  info: (message, context) => console.info(message, context ?? {}),
  error: (message, context) => console.error(message, context ?? {}),
};

/** Constant-time comparison. Hashing first gives equal-length inputs to `timingSafeEqual`. */
export function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Decode a Pub/Sub push envelope. `message.data` is base64-encoded JSON:
 * `{ "emailAddress": string, "historyId": string | number }`.
 * @returns null if the envelope or its data is malformed.
 */
export function parsePushEnvelope(body: unknown): GmailNotification | null {
  if (!isRecord(body) || !isRecord(body.message)) return null;
  const { data, messageId } = body.message;
  if (typeof data !== 'string' || data.length === 0) return null;

  let decoded: unknown;
  try {
    // Pub/Sub sends standard base64; Node's decoder also accepts the URL-safe alphabet.
    decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(decoded)) return null;

  const { emailAddress, historyId } = decoded;
  const historyText = typeof historyId === 'number' ? String(historyId) : historyId;
  if (typeof emailAddress !== 'string' || emailAddress.length === 0) return null;
  if (typeof historyText !== 'string' || !/^\d+$/.test(historyText)) return null;

  return {
    messageId: typeof messageId === 'string' ? messageId : 'unknown',
    emailAddress,
    historyId: historyText,
  };
}

/**
 * Handle one push delivery. Returns the response to send immediately; the sync itself
 * runs through `deps.defer` after that.
 */
export function handleGmailWebhook(request: WebhookRequest, deps: WebhookHandlerDeps): WebhookResponse {
  const log = deps.log ?? consoleLogger;

  if (!tokensMatch(request.token, deps.verificationToken)) {
    return { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid webhook token' } } };
  }

  const notification = parsePushEnvelope(request.body);
  if (!notification) {
    // Acknowledge: a message that can never be parsed would otherwise be redelivered forever.
    log.error('Discarding malformed Pub/Sub push', { body: request.body });
    return { status: 204 };
  }

  deps.defer(
    deps.process(notification).then(
      (outcome) => log.info('Gmail notification processed', { ...notification, outcome }),
      (err: unknown) =>
        log.error('Gmail notification failed; the next notification will retry from the same watermark', {
          ...notification,
          error: err instanceof Error ? err.message : String(err),
        }),
    ),
  );
  return { status: 200 };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export type SyncMailbox = Pick<MailboxClient, 'listMessages' | 'getMessage' | 'listChangesSince' | 'getCurrentCursor'>;

export interface ProcessDeps {
  users: UserStore;
  messages: MessageStore;
  /** Authorize a mailbox for the user; `settled` waits for refreshed-token writes. */
  connect: (user: SyncUser) => Promise<{ mailbox: SyncMailbox; settled(): Promise<void> }>;
  now?: () => Date;
}

export type SyncOutcome =
  | { result: 'unknown-user' }
  | { result: 'no-watermark' }
  | { result: 'auth-revoked' }
  | { result: 'synced'; upserted: number; deleted: number; advanced: boolean }
  | { result: 'resynced'; upserted: number; advanced: boolean };

/**
 * Fold changes into one final action per message, in order: a later record for the same
 * message wins (e.g. added then deleted → delete).
 */
export function planChanges(changes: MailboxChange[]): { refetch: string[]; remove: string[] } {
  const actions = new Map<string, 'refetch' | 'remove'>();
  for (const change of changes) {
    actions.set(change.messageId, change.type === 'deleted' ? 'remove' : 'refetch');
  }
  const refetch: string[] = [];
  const remove: string[] = [];
  for (const [id, action] of actions) {
    (action === 'refetch' ? refetch : remove).push(id);
  }
  return { refetch, remove };
}

/**
 * The sync for one notification (§6.6 steps 1–4, history expiry, dead refresh token).
 * Reads forward from the stored watermark, not from the notification's `historyId`.
 */
export async function processGmailNotification(
  notification: GmailNotification,
  deps: ProcessDeps,
): Promise<SyncOutcome> {
  const now = deps.now ?? (() => new Date());

  const user = await deps.users.findUserByEmail(notification.emailAddress);
  if (!user) return { result: 'unknown-user' };
  // No watch registered yet, so there is nothing to read forward from.
  if (!user.lastHistoryId) return { result: 'no-watermark' };

  let connected: Awaited<ReturnType<ProcessDeps['connect']>>;
  try {
    connected = await deps.connect(user);
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'AUTH_REVOKED') return { result: 'auth-revoked' };
    throw err;
  }
  const { mailbox } = connected;

  try {
    let outcome: SyncOutcome;
    try {
      outcome = await applyDelta(user, user.lastHistoryId, mailbox, deps, now);
    } catch (err) {
      if (!(err instanceof ProviderError && err.kind === 'CURSOR_EXPIRED')) throw err;
      outcome = await fullResync(user, mailbox, deps, now);
    }
    await connected.settled();
    return outcome;
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'AUTH_REVOKED') return { result: 'auth-revoked' };
    throw err;
  }
}

async function applyDelta(
  user: SyncUser,
  cursor: string,
  mailbox: SyncMailbox,
  deps: ProcessDeps,
  now: () => Date,
): Promise<SyncOutcome> {
  const changeSet = await mailbox.listChangesSince(cursor);
  const { refetch, remove } = planChanges(changeSet.changes);

  const fetched: ProviderMessage[] = [];
  for (const id of refetch) {
    try {
      fetched.push(await mailbox.getMessage(id));
    } catch (err) {
      // Deleted since the history record was written: treat as a delete.
      if (err instanceof ProviderError && err.kind === 'NOT_FOUND') {
        remove.push(id);
        continue;
      }
      throw err;
    }
  }

  await deps.messages.upsertMessages(user.userId, fetched, now());
  await deps.messages.deleteMessages(user.userId, remove);
  const advanced = await deps.users.advanceHistoryId(user.userId, changeSet.cursor);
  return { result: 'synced', upserted: fetched.length, deleted: remove.length, advanced };
}

/** History expired: take the current watermark first, then re-run the backfill. */
async function fullResync(
  user: SyncUser,
  mailbox: SyncMailbox,
  deps: ProcessDeps,
  now: () => Date,
): Promise<SyncOutcome> {
  const cursor = await mailbox.getCurrentCursor();
  const { synced } = await runInitialSync(user.userId, { mailbox, store: deps.messages, now });
  const advanced = await deps.users.advanceHistoryId(user.userId, cursor);
  return { result: 'resynced', upserted: synced, advanced };
}
