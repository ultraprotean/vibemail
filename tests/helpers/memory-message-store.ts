import type { MessageStore } from '../../src/db/message-store';
import type { ProviderMessage } from '../../src/types/provider';

/** In-memory `MessageStore` keyed `(user_id, id)`, like the `messages` table. */
export class MemoryMessageStore implements MessageStore {
  readonly rows = new Map<string, ProviderMessage & { userId: string; syncedAt: Date }>();

  private key(userId: string, id: string): string {
    return `${userId}/${id}`;
  }

  async upsertMessages(userId: string, messages: ProviderMessage[], syncedAt: Date): Promise<void> {
    for (const m of messages) this.rows.set(this.key(userId, m.id), { ...m, userId, syncedAt });
  }

  async deleteMessages(userId: string, ids: string[]): Promise<void> {
    for (const id of ids) this.rows.delete(this.key(userId, id));
  }

  idsFor(userId: string): string[] {
    return [...this.rows.values()].filter((r) => r.userId === userId).map((r) => r.id).sort();
  }
}
