import { toMessageRow } from '../../src/db/supabase-message-store';
import type { ProviderMessage } from '../../src/types/provider';

describe('toMessageRow', () => {
  const message: ProviderMessage = {
    id: 'msg-1',
    threadId: 'thread-1',
    subject: 'Hi',
    from: 'a@example.com',
    to: 'b@example.com',
    cc: null,
    snippet: 'Hi…',
    bodyText: 'plain',
    bodyHtml: '<p>html</p>',
    labels: ['INBOX', 'UNREAD', 'STARRED'],
    isRead: false,
    receivedAt: new Date('2026-01-01T00:00:00Z'),
    cursor: '9007199254740993',
  };
  const syncedAt = new Date('2026-09-23T12:00:00Z');

  it('maps to the schema branch column names', () => {
    expect(toMessageRow('user-1', message, syncedAt)).toEqual({
      user_id: 'user-1',
      id: 'msg-1',
      thread_id: 'thread-1',
      subject: 'Hi',
      from_address: 'a@example.com',
      to_address: 'b@example.com',
      cc: null,
      snippet: 'Hi…',
      body_text: 'plain',
      body_html: '<p>html</p>',
      label_ids: ['INBOX', 'UNREAD', 'STARRED'],
      received_at: '2026-01-01T00:00:00.000Z',
      history_id: '9007199254740993',
      synced_at: '2026-09-23T12:00:00.000Z',
    });
  });

  it('never writes the generated is_read column', () => {
    expect(toMessageRow('user-1', message, syncedAt)).not.toHaveProperty('is_read');
  });
});
