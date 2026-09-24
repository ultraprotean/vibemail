import { google, type Auth, type gmail_v1 } from 'googleapis';
import { ProviderError, type MailboxClient } from '../../types/provider';
import { toProviderError } from './auth';

/**
 * Gmail read state (CONTRACT.md §6.5). Gmail has no "read" flag: a message is unread
 * while it carries the `UNREAD` label, so marking read removes that label.
 */

const UNREAD = 'UNREAD';

export interface GmailModifyApi {
  modify(params: gmail_v1.Params$Resource$Users$Messages$Modify): Promise<{ data: gmail_v1.Schema$Message }>;
}

export function gmailModifyApi(auth: Auth.OAuth2Client): GmailModifyApi {
  const messages = google.gmail({ version: 'v1', auth }).users.messages;
  return { modify: (params) => messages.modify(params) };
}

function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('response' in err)) return undefined;
  const response = err.response;
  if (typeof response !== 'object' || response === null || !('status' in response)) return undefined;
  return typeof response.status === 'number' ? response.status : undefined;
}

export class GmailReadState implements Pick<MailboxClient, 'setReadState'> {
  constructor(private readonly api: GmailModifyApi) {}

  /**
   * `messages.modify` removing (read) or adding (unread) the `UNREAD` label.
   * @returns the labels Gmail reports after the change.
   * @throws ProviderError `NOT_FOUND` if Gmail no longer has the message, else as `toProviderError`.
   */
  async setReadState(id: string, isRead: boolean): Promise<{ labels: string[] }> {
    const requestBody: gmail_v1.Schema$ModifyMessageRequest = isRead
      ? { removeLabelIds: [UNREAD] }
      : { addLabelIds: [UNREAD] };
    let data: gmail_v1.Schema$Message;
    try {
      ({ data } = await this.api.modify({ userId: 'me', id, requestBody }));
    } catch (err) {
      if (statusOf(err) === 404) {
        throw new ProviderError('NOT_FOUND', `Message ${id} not found`, err);
      }
      throw toProviderError(err, 'api');
    }
    return { labels: data.labelIds ?? [] };
  }
}
