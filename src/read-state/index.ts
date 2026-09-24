import type { MessageStore } from '../db/message-store';
import type { MailboxClient } from '../types/provider';

/**
 * Mark a message read or unread (CONTRACT.md §6.5).
 *
 * Provider first, local second: the local row changes only after the provider accepted
 * the change, so the two can't disagree because of a failed call. The labels stored
 * locally are the ones the provider reports back, not a local guess.
 */

/** The message isn't one of this user's stored messages. Maps to 404 `NOT_FOUND`. */
export class MessageNotFoundError extends Error {
  constructor(readonly messageId: string) {
    super(`Message ${messageId} not found`);
    this.name = 'MessageNotFoundError';
  }
}

export interface ReadStateDeps {
  mailbox: Pick<MailboxClient, 'setReadState'>;
  store: MessageStore;
}

export interface ReadStateResult {
  id: string;
  isRead: boolean;
}

/**
 * 1. Look the message up among this user's rows only; another user's message id is a
 *    404 too, so ids don't leak across users.
 * 2. Change the read state in the provider.
 * 3. Only on success, store the provider's resulting labels (`is_read` is generated from them).
 *
 * @throws MessageNotFoundError if the user has no such message.
 * @throws ProviderError from the provider call; the local row is then left unchanged.
 */
export async function setMessageReadState(
  userId: string,
  messageId: string,
  isRead: boolean,
  deps: ReadStateDeps,
): Promise<ReadStateResult> {
  const stored = await deps.store.getMessageLabels(userId, messageId);
  if (stored === null) throw new MessageNotFoundError(messageId);

  const { labels } = await deps.mailbox.setReadState(messageId, isRead);
  await deps.store.setMessageLabels(userId, messageId, labels);

  return { id: messageId, isRead: !labels.includes('UNREAD') };
}
