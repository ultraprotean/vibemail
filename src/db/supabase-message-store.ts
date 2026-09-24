import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProviderMessage } from '../types/provider';
import type { MessageStore } from './message-store';

/**
 * Supabase implementation of `MessageStore`. Column names follow the schema branch
 * migration (CONTRACT.md §4).
 */

const TABLE = 'messages';

export interface MessageRow {
  user_id: string;
  id: string;
  thread_id: string;
  subject: string;
  from_address: string;
  to_address: string;
  cc: string | null;
  snippet: string;
  body_text: string | null;
  body_html: string | null;
  label_ids: string[];
  received_at: string;
  /** bigint column, sent as a string so no precision is lost (CONTRACT.md §2). */
  history_id: string;
  synced_at: string;
}

/**
 * Map a normalized message to a `messages` row. `is_read` is deliberately absent: it is a
 * generated column computed from `label_ids` and cannot be written.
 */
export function toMessageRow(userId: string, message: ProviderMessage, syncedAt: Date): MessageRow {
  return {
    user_id: userId,
    id: message.id,
    thread_id: message.threadId,
    subject: message.subject,
    from_address: message.from,
    to_address: message.to,
    cc: message.cc,
    snippet: message.snippet,
    body_text: message.bodyText,
    body_html: message.bodyHtml,
    label_ids: message.labels,
    received_at: message.receivedAt.toISOString(),
    history_id: message.cursor,
    synced_at: syncedAt.toISOString(),
  };
}

export class SupabaseMessageStore implements MessageStore {
  constructor(private readonly client: SupabaseClient) {}

  async upsertMessages(userId: string, messages: ProviderMessage[], syncedAt: Date): Promise<void> {
    if (messages.length === 0) return;
    const rows = messages.map((m) => toMessageRow(userId, m, syncedAt));
    const { error } = await this.client.from(TABLE).upsert(rows, { onConflict: 'user_id,id' });
    if (error) {
      throw new Error(`Failed to upsert messages: ${error.message}`);
    }
  }
}
