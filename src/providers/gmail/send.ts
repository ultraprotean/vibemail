import { google, type Auth, type gmail_v1 } from 'googleapis';
import { buildRfc2822Message, encodeRawMessage } from '../../send/mime';
import { ProviderError, type MailboxClient, type SendMessageInput, type SentMessage } from '../../types/provider';
import { toProviderError } from './auth';

/** Gmail `messages.send` (BUILD_SEQUENCE.md unit 5). */

export interface GmailSendApi {
  send(params: gmail_v1.Params$Resource$Users$Messages$Send): Promise<{ data: gmail_v1.Schema$Message }>;
}

export function gmailSendApi(auth: Auth.OAuth2Client): GmailSendApi {
  const messages = google.gmail({ version: 'v1', auth }).users.messages;
  return { send: (params) => messages.send(params) };
}

export class GmailSender implements Pick<MailboxClient, 'sendMessage'> {
  constructor(private readonly api: GmailSendApi) {}

  /**
   * Send as the authorized user. The message goes in `requestBody.raw` as base64url, never
   * through the `media` upload parameter (CONTRACT.md §6.4).
   * @throws SendValidationError for bad input (before any Gmail call).
   * @throws ProviderError `RATE_LIMITED`, `AUTH_REVOKED`, or `UPSTREAM`.
   */
  async sendMessage(input: SendMessageInput): Promise<SentMessage> {
    const raw = encodeRawMessage(buildRfc2822Message(input));
    let data: gmail_v1.Schema$Message;
    try {
      ({ data } = await this.api.send({
        userId: 'me',
        requestBody: { raw, threadId: input.threadId },
      }));
    } catch (err) {
      throw toProviderError(err, 'api');
    }
    if (!data.id || !data.threadId) {
      throw new ProviderError('UPSTREAM', 'messages.send returned no id or threadId');
    }
    return { id: data.id, threadId: data.threadId };
  }
}
