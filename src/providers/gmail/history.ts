import { google, type Auth, type gmail_v1 } from 'googleapis';
import { ProviderError, type ChangeSet, type MailboxChange, type MailboxClient } from '../../types/provider';
import { toProviderError } from './auth';

/**
 * Gmail change feed (BUILD_SEQUENCE.md unit 4): `history.list` for deltas since a
 * watermark, and `users.getProfile` for the current watermark during a full resync.
 */

type HistoryRecord = gmail_v1.Schema$History;

/** Gmail's maximum `history.list` page size. */
const MAX_PAGE_SIZE = 500;

/** The Gmail calls this module makes, narrowed so tests can supply a fake. */
export interface GmailHistoryApi {
  list(params: gmail_v1.Params$Resource$Users$History$List): Promise<{ data: gmail_v1.Schema$ListHistoryResponse }>;
  getProfile(params: gmail_v1.Params$Resource$Users$Getprofile): Promise<{ data: gmail_v1.Schema$Profile }>;
}

export function gmailHistoryApi(auth: Auth.OAuth2Client): GmailHistoryApi {
  const users = google.gmail({ version: 'v1', auth }).users;
  return {
    list: (params) => users.history.list(params),
    getProfile: (params) => users.getProfile(params),
  };
}

function ids(entries: Array<{ message?: gmail_v1.Schema$Message }> | undefined): string[] {
  return (entries ?? []).map((e) => e.message?.id).filter((id): id is string => Boolean(id));
}

/** Flatten one history record into provider-agnostic changes, in Gmail's order. */
export function toChanges(record: HistoryRecord): MailboxChange[] {
  const changes: MailboxChange[] = [];
  for (const messageId of ids(record.messagesAdded)) {
    changes.push({ type: 'added', messageId });
  }
  for (const entry of record.labelsAdded ?? []) {
    if (entry.message?.id) {
      changes.push({ type: 'labelsChanged', messageId: entry.message.id, added: entry.labelIds ?? [], removed: [] });
    }
  }
  for (const entry of record.labelsRemoved ?? []) {
    if (entry.message?.id) {
      changes.push({ type: 'labelsChanged', messageId: entry.message.id, added: [], removed: entry.labelIds ?? [] });
    }
  }
  for (const messageId of ids(record.messagesDeleted)) {
    changes.push({ type: 'deleted', messageId });
  }
  return changes;
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('response' in err)) return undefined;
  const response = err.response;
  if (typeof response !== 'object' || response === null || !('status' in response)) return undefined;
  return typeof response.status === 'number' ? response.status : undefined;
}

export class GmailHistoryReader implements Pick<MailboxClient, 'listChangesSince' | 'getCurrentCursor'> {
  constructor(private readonly api: GmailHistoryApi) {}

  /**
   * Every change after `cursor`, following `nextPageToken` to the end. The returned
   * cursor is the `historyId` of the final page: exactly how far this read got.
   * @throws ProviderError `CURSOR_EXPIRED` if Gmail no longer holds history that far back (404).
   */
  async listChangesSince(cursor: string): Promise<ChangeSet> {
    const changes: MailboxChange[] = [];
    let pageToken: string | undefined;
    let latest = cursor;

    do {
      let data: gmail_v1.Schema$ListHistoryResponse;
      try {
        ({ data } = await this.api.list({
          userId: 'me',
          startHistoryId: cursor,
          pageToken,
          maxResults: MAX_PAGE_SIZE,
        }));
      } catch (err) {
        if (statusOf(err) === 404) {
          throw new ProviderError('CURSOR_EXPIRED', `History before ${cursor} is no longer available`, err);
        }
        throw toProviderError(err, 'api');
      }
      for (const record of data.history ?? []) {
        changes.push(...toChanges(record));
      }
      if (data.historyId) latest = data.historyId;
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);

    return { changes, cursor: latest };
  }

  /** The mailbox's current `historyId` (`users.getProfile`), used for a full resync. */
  async getCurrentCursor(): Promise<string> {
    let data: gmail_v1.Schema$Profile;
    try {
      ({ data } = await this.api.getProfile({ userId: 'me' }));
    } catch (err) {
      throw toProviderError(err, 'api');
    }
    if (!data.historyId) {
      throw new ProviderError('UPSTREAM', 'users.getProfile returned no historyId');
    }
    return data.historyId;
  }
}
