import { describe, expect, it } from 'vitest';
import { matchesQuery, mergeMessages, messagesInThread, sortNewestFirst } from '@/lib/threads';
import type { Message } from '@/lib/types';

function msg(id: string, threadId: string, receivedAt: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    threadId,
    subject: `subject ${id}`,
    from: 'Sender <s@x.example>',
    to: 'me@x.example',
    cc: null,
    snippet: 'a snippet',
    bodyText: null,
    bodyHtml: null,
    isRead: true,
    receivedAt,
    ...extra,
  };
}

describe('messagesInThread', () => {
  it('returns only the thread, oldest first', () => {
    const list = [
      msg('c', 't1', '2026-01-03T00:00:00Z'),
      msg('a', 't1', '2026-01-01T00:00:00Z'),
      msg('x', 't2', '2026-01-02T00:00:00Z'),
      msg('b', 't1', '2026-01-02T00:00:00Z'),
    ];
    expect(messagesInThread(list, 't1').map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('sortNewestFirst / mergeMessages', () => {
  it('orders newest first and replaces duplicates with the later copy', () => {
    const old = msg('a', 't', '2026-01-01T00:00:00Z', { isRead: false });
    const fresh = msg('a', 't', '2026-01-01T00:00:00Z', { isRead: true });
    const other = msg('b', 't', '2026-01-02T00:00:00Z');
    const merged = mergeMessages([old], [fresh, other]);
    expect(merged.map((m) => m.id)).toEqual(['b', 'a']);
    expect(merged[1]?.isRead).toBe(true);
    expect(sortNewestFirst([old, other]).map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('matchesQuery', () => {
  const m = msg('a', 't', '2026-01-01T00:00:00Z', {
    subject: 'Lantern parade',
    cc: 'Robo <robo@x.example>',
    bodyText: 'Bring a cushion',
  });

  it('matches case-insensitively across subject, from, to, cc, snippet and bodyText', () => {
    expect(matchesQuery(m, 'LANTERN')).toBe(true);
    expect(matchesQuery(m, 'sender')).toBe(true);
    expect(matchesQuery(m, 'me@x')).toBe(true);
    expect(matchesQuery(m, 'robo')).toBe(true);
    expect(matchesQuery(m, 'snippet')).toBe(true);
    expect(matchesQuery(m, 'cushion')).toBe(true);
    expect(matchesQuery(m, 'dragon')).toBe(false);
  });

  it('is not active for an empty or all-space query', () => {
    expect(matchesQuery(m, '')).toBe(false);
    expect(matchesQuery(m, '   ')).toBe(false);
  });

  it('ignores the HTML body', () => {
    expect(matchesQuery(msg('h', 't', '2026-01-01T00:00:00Z', { bodyHtml: '<p>secret</p>' }), 'secret')).toBe(false);
  });
});
