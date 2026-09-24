import type { MailboxClient } from '../../types/provider';
import type { GmailAuth } from './auth';
import { GmailHistoryReader, gmailHistoryApi } from './history';
import { GmailMessageReader, gmailMessagesApi } from './messages';

/** The mailbox operations implemented so far (units 3–4); send and read-state come in unit 5. */
export type GmailSyncMailbox = Pick<
  MailboxClient,
  'listMessages' | 'getMessage' | 'listChangesSince' | 'getCurrentCursor'
>;

export interface ConnectedMailbox {
  mailbox: GmailSyncMailbox;
  /** Resolves once refreshed tokens have been written back; rejects if a write failed. */
  settled(): Promise<void>;
}

/**
 * A mailbox authorized as one user. Access tokens refresh automatically inside the
 * OAuth2 client, and refreshed tokens are persisted by the listener `GmailAuth` attaches.
 * @throws ProviderError `AUTH_REVOKED` if the user has no stored refresh token.
 */
export async function connectGmailMailbox(auth: GmailAuth, googleId: string): Promise<ConnectedMailbox> {
  const { client, persistence } = await auth.authorizedClient(googleId);
  const messages = new GmailMessageReader(gmailMessagesApi(client));
  const history = new GmailHistoryReader(gmailHistoryApi(client));
  return {
    mailbox: {
      listMessages: (opts) => messages.listMessages(opts),
      getMessage: (id) => messages.getMessage(id),
      listChangesSince: (cursor) => history.listChangesSince(cursor),
      getCurrentCursor: () => history.getCurrentCursor(),
    },
    settled: () => persistence.settled(),
  };
}
