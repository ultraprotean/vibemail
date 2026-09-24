import type { ProviderMessage } from '../types/provider';

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
}
