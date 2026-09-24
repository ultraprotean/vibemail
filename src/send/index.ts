import type { MessageStore } from '../db/message-store';
import type { MailboxClient, SendMessageInput, SentMessage } from '../types/provider';
import { isValidAddress, SendValidationError } from './mime';

export { buildRfc2822Message, encodeHeaderText, encodeRawMessage, isValidAddress, SendValidationError } from './mime';

/**
 * Send layer (CONTRACT.md §6.4, BUILD_SEQUENCE.md unit 5).
 *
 * Provider-agnostic: sends through `MailboxClient`, then stores the sent message through
 * `MessageStore`. The send response carries only ids, so the stored row comes from
 * fetching the sent message back and normalizing it like any synced message.
 */

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new SendValidationError(`${field} must be a string`);
  return value;
}

/** `to` may be one address or a list; `cc`/`bcc` must be lists when present. */
function addressArray(body: Record<string, unknown>, field: string, required: boolean): string[] {
  const value = body[field];
  if (value === undefined || value === null) {
    if (required) throw new SendValidationError(`${field} is required`);
    return [];
  }
  const list = typeof value === 'string' && field === 'to' ? [value] : value;
  if (!Array.isArray(list) || !list.every((a): a is string => typeof a === 'string')) {
    throw new SendValidationError(`${field} must be an array of email addresses`);
  }
  const bad = list.find((a) => !isValidAddress(a));
  if (bad !== undefined) throw new SendValidationError(`${field} contains an invalid address: ${bad}`);
  return list;
}

/**
 * Validate a §6.4 request body. `body` is accepted as a shorthand for `bodyText`.
 * @throws SendValidationError → 400 `INVALID_REQUEST`.
 */
export function parseSendRequest(body: unknown): SendMessageInput {
  if (!isRecord(body)) throw new SendValidationError('Request body must be a JSON object');

  const to = addressArray(body, 'to', true);
  if (to.length === 0) throw new SendValidationError('to must contain at least one address');
  const subject = optionalString(body, 'subject');
  if (!subject || !subject.trim()) throw new SendValidationError('subject is required');

  const bodyText = optionalString(body, 'bodyText') ?? optionalString(body, 'body');
  const bodyHtml = optionalString(body, 'bodyHtml');
  const base = {
    to,
    cc: addressArray(body, 'cc', false),
    bcc: addressArray(body, 'bcc', false),
    subject,
    threadId: optionalString(body, 'threadId'),
    inReplyTo: optionalString(body, 'inReplyTo'),
  };

  if (bodyText) return { ...base, bodyText, bodyHtml: bodyHtml || undefined };
  if (bodyHtml) return { ...base, bodyHtml };
  throw new SendValidationError('bodyText or bodyHtml is required');
}

// ---------------------------------------------------------------------------
// Send and store
// ---------------------------------------------------------------------------

export interface SendDeps {
  mailbox: Pick<MailboxClient, 'sendMessage' | 'getMessage'>;
  store: MessageStore;
  now?: () => Date;
  /** Receives a failure to store the sent copy; the send itself already succeeded. */
  onStoreError?: (err: unknown, sent: SentMessage) => void;
}

export interface SendResult extends SentMessage {
  status: 'sent';
  /** Whether the sent copy is already in `messages` (otherwise the webhook syncs it later). */
  stored: boolean;
}

/**
 * Send a message for one user, then fetch the sent copy back, normalize it and upsert it
 * under that user.
 *
 * Once the provider accepts the message it has been sent, so a failure while storing the
 * copy is reported through `onStoreError` and `stored: false`, never thrown: throwing
 * would invite the client to retry and send a duplicate. The webhook picks the message up
 * anyway, because sending adds it to the mailbox history.
 *
 * @throws SendValidationError or ProviderError from the send itself.
 */
export async function sendAndStore(userId: string, input: SendMessageInput, deps: SendDeps): Promise<SendResult> {
  const now = deps.now ?? (() => new Date());
  const onStoreError =
    deps.onStoreError ?? ((err, sent) => console.error('Sent message could not be stored yet', { sent, err }));

  const sent = await deps.mailbox.sendMessage(input);

  let stored = false;
  try {
    const message = await deps.mailbox.getMessage(sent.id);
    await deps.store.upsertMessages(userId, [message], now());
    stored = true;
  } catch (err) {
    onStoreError(err, sent);
  }

  return { ...sent, status: 'sent', stored };
}
