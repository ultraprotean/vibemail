import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProviderMessage } from '../types/provider';
import type { ListStoredMessagesOptions, MessageStore, MessageSummary } from './message-store';

/**
 * Supabase implementation of `MessageStore`. Column names follow the schema branch
 * migration (CONTRACT.md §4).
 */

const TABLE = 'messages';

const SUMMARY_COLUMNS =
  'id, thread_id, subject, from_address, to_address, cc, snippet, body_text, body_html, is_read, received_at';

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

  async deleteMessages(userId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const { error } = await this.client.from(TABLE).delete().eq('user_id', userId).in('id', ids);
    if (error) {
      throw new Error(`Failed to delete messages: ${error.message}`);
    }
  }

  async getMessageLabels(userId: string, id: string): Promise<string[] | null> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('label_ids')
      .eq('user_id', userId)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to read message: ${error.message}`);
    }
    const row: unknown = data;
    if (row === null) return null;
    if (typeof row !== 'object' || !('label_ids' in row)) {
      throw new Error('Unexpected messages row shape');
    }
    const labels: unknown = row.label_ids;
    if (!Array.isArray(labels) || !labels.every((l): l is string => typeof l === 'string')) {
      throw new Error('messages.label_ids is not a string array');
    }
    return labels;
  }

  async setMessageLabels(userId: string, id: string, labels: string[]): Promise<void> {
    const { error } = await this.client.from(TABLE).update({ label_ids: labels }).eq('user_id', userId).eq('id', id);
    if (error) {
      throw new Error(`Failed to update message labels: ${error.message}`);
    }
  }

  async listMessages(userId: string, opts: ListStoredMessagesOptions): Promise<MessageSummary[]> {
    let query = this.client
      .from(TABLE)
      .select(SUMMARY_COLUMNS)
      .eq('user_id', userId)
      .order('received_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(opts.limit);
    if (opts.unreadOnly) {
      query = query.eq('is_read', false);
    }
    if (opts.after) {
      // Keyset: rows strictly after the previous page's last (received_at, id).
      // Values are interpolated into a PostgREST filter, so both are validated first.
      const at = opts.after.receivedAt.toISOString();
      if (!/^[A-Za-z0-9_-]+$/.test(opts.after.id)) {
        throw new Error('Invalid cursor id');
      }
      query = query.or(`received_at.lt."${at}",and(received_at.eq."${at}",id.lt.${opts.after.id})`);
    }
    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to list messages: ${error.message}`);
    }
    const rows: unknown = data;
    if (!Array.isArray(rows)) {
      throw new Error('Unexpected messages result');
    }
    return rows.map(toSummary);
  }
}

function toSummary(row: unknown): MessageSummary {
  if (typeof row !== 'object' || row === null) {
    throw new Error('Unexpected messages row shape');
  }
  const r: Record<string, unknown> = { ...row };
  const text = (column: string): string => {
    const value = r[column];
    if (typeof value !== 'string') throw new Error(`messages.${column} is missing or not a string`);
    return value;
  };
  const nullableText = (column: string): string | null => {
    const value = r[column];
    return typeof value === 'string' ? value : null;
  };
  return {
    id: text('id'),
    threadId: text('thread_id'),
    subject: text('subject'),
    from: text('from_address'),
    to: text('to_address'),
    cc: nullableText('cc'),
    snippet: text('snippet'),
    bodyText: nullableText('body_text'),
    bodyHtml: nullableText('body_html'),
    isRead: r.is_read === true,
    receivedAt: new Date(text('received_at')),
  };
}
