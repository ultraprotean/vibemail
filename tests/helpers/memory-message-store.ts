import type { ListStoredMessagesOptions, MessageStore, MessageSummary } from '../../src/db/message-store';
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

  async getMessageLabels(userId: string, id: string): Promise<string[] | null> {
    return this.rows.get(this.key(userId, id))?.labels ?? null;
  }

  async setMessageLabels(userId: string, id: string, labels: string[]): Promise<void> {
    const row = this.rows.get(this.key(userId, id));
    // Mirrors the generated is_read column.
    if (row) Object.assign(row, { labels, isRead: !labels.includes('UNREAD') });
  }

  async listMessages(userId: string, opts: ListStoredMessagesOptions): Promise<MessageSummary[]> {
    const { after } = opts;
    return [...this.rows.values()]
      .filter((r) => r.userId === userId && (!opts.unreadOnly || !r.isRead))
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .filter(
        (r) =>
          !after ||
          r.receivedAt.getTime() < after.receivedAt.getTime() ||
          (r.receivedAt.getTime() === after.receivedAt.getTime() && r.id < after.id),
      )
      .slice(0, opts.limit)
      .map((r) => ({
        id: r.id,
        threadId: r.threadId,
        subject: r.subject,
        from: r.from,
        to: r.to,
        cc: r.cc,
        snippet: r.snippet,
        bodyText: r.bodyText,
        bodyHtml: r.bodyHtml,
        isRead: r.isRead,
        receivedAt: r.receivedAt,
      }));
  }

  idsFor(userId: string): string[] {
    return [...this.rows.values()].filter((r) => r.userId === userId).map((r) => r.id).sort();
  }
}
