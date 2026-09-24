import { google, type Auth, type gmail_v1 } from 'googleapis';
import {
  ProviderError,
  type ListMessagesOptions,
  type MailboxClient,
  type MessagePage,
  type ProviderMessage,
} from '../../types/provider';
import { toProviderError } from './auth';

/**
 * Gmail message reading and normalization (BUILD_SEQUENCE.md unit 3).
 *
 * Converts Gmail's native `Message` shape into the provider-agnostic `ProviderMessage`
 * following the field sources in CONTRACT.md §4.
 */

type GmailMessage = gmail_v1.Schema$Message;
type GmailMessagePart = gmail_v1.Schema$MessagePart;

/** Gmail caps `messages.list` at 500 results per page. */
const MAX_PAGE_SIZE = 500;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Header lookup by name, case-insensitive (header casing varies between senders). */
function header(part: GmailMessagePart | undefined, name: string): string | null {
  const wanted = name.toLowerCase();
  const match = part?.headers?.find((h) => h.name?.toLowerCase() === wanted);
  return match?.value ?? null;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/**
 * Depth-first search of the MIME tree for the first body of the given type. Parts nest
 * (e.g. `multipart/alternative` inside `multipart/mixed`). Attachments are skipped: a
 * part with a filename or an `attachmentId` is never a message body.
 */
function findBody(part: GmailMessagePart, mimeType: string): string | null {
  if (part.parts && part.parts.length > 0) {
    for (const child of part.parts) {
      const found = findBody(child, mimeType);
      if (found !== null) return found;
    }
    return null;
  }
  const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
  if (part.mimeType === mimeType && !isAttachment && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  return null;
}

/**
 * Single-part message with no `parts` array: the body is `payload.body.data`. It is
 * plain text unless the payload says it's HTML.
 */
function singlePartBody(payload: GmailMessagePart, mimeType: string): string | null {
  const data = payload.body?.data;
  if (!data) return null;
  const payloadType = payload.mimeType ?? 'text/plain';
  const isHtml = payloadType === 'text/html';
  const wantsHtml = mimeType === 'text/html';
  return isHtml === wantsHtml ? decodeBase64Url(data) : null;
}

function bodyOf(payload: GmailMessagePart | undefined, mimeType: string): string | null {
  if (!payload) return null;
  return payload.parts && payload.parts.length > 0
    ? findBody(payload, mimeType)
    : singlePartBody(payload, mimeType);
}

/** `internalDate` is authoritative (CONTRACT.md §4); the `Date` header is a fallback. */
function receivedAtOf(message: GmailMessage): Date {
  if (message.internalDate) {
    return new Date(Number(message.internalDate));
  }
  const dateHeader = header(message.payload, 'Date');
  const parsed = dateHeader ? new Date(dateHeader) : null;
  if (parsed && !Number.isNaN(parsed.getTime())) {
    return parsed;
  }
  throw new ProviderError('UPSTREAM', `Message ${message.id ?? '?'} has no internalDate or Date header`);
}

/**
 * Normalize a Gmail `messages.get` (`format=full`) response.
 * @throws ProviderError `UPSTREAM` if a required field (id, threadId, historyId, date) is missing.
 */
export function normalizeGmailMessage(message: GmailMessage): ProviderMessage {
  const { id, threadId, historyId } = message;
  if (!id || !threadId || !historyId) {
    throw new ProviderError('UPSTREAM', `Message ${id ?? '?'} is missing id, threadId or historyId`);
  }
  const labels = message.labelIds ?? [];
  return {
    id,
    threadId,
    subject: header(message.payload, 'Subject') ?? '',
    from: header(message.payload, 'From') ?? '',
    to: header(message.payload, 'To') ?? '',
    cc: header(message.payload, 'Cc'),
    snippet: message.snippet ?? '',
    bodyText: bodyOf(message.payload, 'text/plain'),
    bodyHtml: bodyOf(message.payload, 'text/html'),
    labels,
    isRead: !labels.includes('UNREAD'),
    receivedAt: receivedAtOf(message),
    cursor: historyId,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The two Gmail calls this module makes, narrowed so tests can supply a fake. */
export interface GmailMessagesApi {
  list(params: gmail_v1.Params$Resource$Users$Messages$List): Promise<{ data: gmail_v1.Schema$ListMessagesResponse }>;
  get(params: gmail_v1.Params$Resource$Users$Messages$Get): Promise<{ data: GmailMessage }>;
}

export function gmailMessagesApi(auth: Auth.OAuth2Client): GmailMessagesApi {
  const messages = google.gmail({ version: 'v1', auth }).users.messages;
  return {
    list: (params) => messages.list(params),
    get: (params) => messages.get(params),
  };
}

/** The read side of `MailboxClient` for Gmail. */
export class GmailMessageReader implements Pick<MailboxClient, 'listMessages' | 'getMessage'> {
  constructor(private readonly api: GmailMessagesApi) {}

  /**
   * One page of `messages.list` (newest first), then `messages.get` with `format=full`
   * for each id. Callers follow `nextPageCursor` to read further.
   */
  async listMessages(opts: ListMessagesOptions): Promise<MessagePage> {
    let data: gmail_v1.Schema$ListMessagesResponse;
    try {
      ({ data } = await this.api.list({
        userId: 'me',
        maxResults: Math.min(Math.max(opts.limit, 1), MAX_PAGE_SIZE),
        pageToken: opts.pageCursor,
        labelIds: opts.inboxOnly ? ['INBOX'] : undefined,
      }));
    } catch (err) {
      throw toProviderError(err, 'api');
    }

    const ids = (data.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => Boolean(id))
      .slice(0, opts.limit);
    const messages = await Promise.all(ids.map((id) => this.getMessage(id)));
    return { messages, nextPageCursor: data.nextPageToken ?? null };
  }

  /** @throws ProviderError `NOT_FOUND` if Gmail no longer has the message. */
  async getMessage(id: string): Promise<ProviderMessage> {
    let data: GmailMessage;
    try {
      ({ data } = await this.api.get({ userId: 'me', id, format: 'full' }));
    } catch (err) {
      const status = isRecord(err) && isRecord(err.response) ? err.response.status : undefined;
      if (status === 404) {
        throw new ProviderError('NOT_FOUND', `Message ${id} not found`, err);
      }
      throw toProviderError(err, 'api');
    }
    return normalizeGmailMessage(data);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
