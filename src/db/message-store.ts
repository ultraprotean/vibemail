import type { ProviderMessage } from '../types/provider';

/** A stored message as the API returns it (CONTRACT.md §6.3). */
export interface MessageSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc: string | null;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  isRead: boolean;
  receivedAt: Date;
}

/** Keyset position: the last row of the previous page, in `(received_at desc, id desc)` order. */
export interface MessageListPosition {
  receivedAt: Date;
  id: string;
}

export interface ListStoredMessagesOptions {
  limit: number;
  after?: MessageListPosition;
  unreadOnly?: boolean;
}

/**
 * Persistence interface for the `messages` table (CONTRACT.md §4).
 *
 * Every operation is scoped to one user: `messages` is keyed `(user_id, id)`.
 */
export interface MessageStore {
  /**
   * Insert or update messages for one user, on conflict `(user_id, id)`. Idempotent:
   * re-syncing the same message overwrites it with the latest provider state.
   */
  upsertMessages(userId: string, messages: ProviderMessage[], syncedAt: Date): Promise<void>;

  /** Delete one user's messages by id. Ids that aren't stored are ignored. */
  deleteMessages(userId: string, ids: string[]): Promise<void>;

  /** One user's stored labels for a message, or null if that user has no such message. */
  getMessageLabels(userId: string, id: string): Promise<string[] | null>;

  /** Replace a stored message's labels (`is_read` follows, being generated from them). */
  setMessageLabels(userId: string, id: string, labels: string[]): Promise<void>;

  /**
   * §6.3 — One user's messages, newest first (`received_at desc, id desc`), strictly after
   * `after` when given. Returns at most `limit` rows.
   */
  listMessages(userId: string, opts: ListStoredMessagesOptions): Promise<MessageSummary[]>;
}
