import type { Auth } from 'googleapis';
import type { MailboxClient } from '../../types/provider';
import type { GmailAuth } from './auth';
import { GmailHistoryReader, gmailHistoryApi, type GmailHistoryApi } from './history';
import { GmailMessageReader, gmailMessagesApi, type GmailMessagesApi } from './messages';
import { GmailReadState, gmailModifyApi, type GmailModifyApi } from './read-state';
import { GmailSender, gmailSendApi, type GmailSendApi } from './send';

/** Every mailbox operation the endpoints use (`refreshAccessToken` is `GmailAuth.refreshAccessToken`). */
export type GmailSyncMailbox = Pick<
  MailboxClient,
  | 'listMessages'
  | 'getMessage'
  | 'listChangesSince'
  | 'getCurrentCursor'
  | 'sendMessage'
  | 'setReadState'
  | 'watchMailbox'
>;

export interface ConnectedMailbox {
  mailbox: GmailSyncMailbox;
  /** Resolves once refreshed tokens have been written back; rejects if a write failed. */
  settled(): Promise<void>;
}

/** The Gmail API surfaces a mailbox uses, built from an authorized OAuth2 client. */
export interface GmailApis {
  messages: GmailMessagesApi;
  history: GmailHistoryApi;
  send: GmailSendApi;
  modify: GmailModifyApi;
}

export function realGmailApis(client: Auth.OAuth2Client): GmailApis {
  return {
    messages: gmailMessagesApi(client),
    history: gmailHistoryApi(client),
    send: gmailSendApi(client),
    modify: gmailModifyApi(client),
  };
}

/**
 * A mailbox authorized as one user. Access tokens refresh automatically inside the
 * OAuth2 client, and refreshed tokens are persisted by the listener `GmailAuth` attaches.
 * `apis` defaults to the real Gmail API; integration tests substitute a fake.
 * @throws ProviderError `AUTH_REVOKED` if the user has no stored refresh token.
 */
export async function connectGmailMailbox(
  auth: GmailAuth,
  googleId: string,
  apis: (client: Auth.OAuth2Client) => GmailApis = realGmailApis,
): Promise<ConnectedMailbox> {
  const { client, persistence } = await auth.authorizedClient(googleId);
  const api = apis(client);
  const messages = new GmailMessageReader(api.messages);
  const history = new GmailHistoryReader(api.history);
  const sender = new GmailSender(api.send);
  const readState = new GmailReadState(api.modify);
  return {
    mailbox: {
      listMessages: (opts) => messages.listMessages(opts),
      getMessage: (id) => messages.getMessage(id),
      listChangesSince: (cursor) => history.listChangesSince(cursor),
      getCurrentCursor: () => history.getCurrentCursor(),
      sendMessage: (input) => sender.sendMessage(input),
      setReadState: (id, isRead) => readState.setReadState(id, isRead),
      watchMailbox: () => auth.registerWatch(client),
    },
    settled: () => persistence.settled(),
  };
}
