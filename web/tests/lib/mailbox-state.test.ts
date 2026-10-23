import { describe, expect, it } from 'vitest';
import {
  EMPTY_MAILBOX,
  applyFirstPage,
  applyMorePage,
  applyPoolPage,
  applyRefreshedPage,
  listMessages,
  patchMessage,
  removeMessage,
} from '@/lib/mailbox-state';
import type { Message } from '@/lib/types';

function msg(n: number, extra: Partial<Message> = {}): Message {
  const id = `m${String(n).padStart(3, '0')}`;
  return {
    id,
    threadId: `t${n}`,
    subject: id,
    from: 'a@x.example',
    to: 'b@x.example',
    cc: null,
    snippet: '',
    bodyText: null,
    bodyHtml: null,
    isRead: false,
    // Higher n = newer.
    receivedAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    ...extra,
  };
}

const newestFirst = (from: number, to: number): Message[] => {
  const out: Message[] = [];
  for (let n = from; n >= to; n -= 1) out.push(msg(n));
  return out;
};

const ids = (data: Parameters<typeof listMessages>[0]) => listMessages(data).map((m) => m.id);

describe('paging', () => {
  it('first page then more pages append in order without duplicates', () => {
    let data = applyFirstPage(EMPTY_MAILBOX, { messages: newestFirst(10, 6), nextCursor: 'c1' });
    expect(ids(data)).toEqual(['m010', 'm009', 'm008', 'm007', 'm006']);
    expect(data.listCursor).toBe('c1');

    data = applyMorePage(data, { messages: newestFirst(6, 2), nextCursor: null });
    expect(ids(data)).toEqual(['m010', 'm009', 'm008', 'm007', 'm006', 'm005', 'm004', 'm003', 'm002']);
    expect(data.listCursor).toBeNull();
  });

  it('a fresh first page replaces the list but keeps the pool for threads and search', () => {
    let data = applyFirstPage(EMPTY_MAILBOX, { messages: newestFirst(10, 6), nextCursor: 'c1' });
    data = applyFirstPage(data, { messages: [msg(10)], nextCursor: null });
    expect(ids(data)).toEqual(['m010']);
    expect(Object.keys(data.byId)).toHaveLength(5);
  });

  it('pool pages extend the pool and cursor without touching the list', () => {
    let data = applyFirstPage(EMPTY_MAILBOX, { messages: newestFirst(10, 8), nextCursor: 'c1' });
    data = applyPoolPage(data, { messages: newestFirst(7, 3), nextCursor: 'p2' });
    expect(ids(data)).toEqual(['m010', 'm009', 'm008']);
    expect(Object.keys(data.byId)).toHaveLength(8);
    expect(data.poolCursor).toBe('p2');
  });
});

describe('applyRefreshedPage', () => {
  it('merges new mail at the top and keeps deeper pages and their cursor', () => {
    let data = applyFirstPage(EMPTY_MAILBOX, { messages: newestFirst(10, 6), nextCursor: 'c1' });
    data = applyMorePage(data, { messages: newestFirst(6, 3), nextCursor: 'c2' });

    const refreshed = applyRefreshedPage(data, { messages: newestFirst(12, 8), nextCursor: 'r1' });
    expect(ids(refreshed)).toEqual(['m012', 'm011', 'm010', 'm009', 'm008', 'm007', 'm006', 'm005', 'm004', 'm003']);
    expect(refreshed.listCursor).toBe('c2');
  });

  it('drops a message that vanished from the top of the mailbox', () => {
    const data = applyFirstPage(EMPTY_MAILBOX, { messages: newestFirst(10, 6), nextCursor: 'c1' });
    const page = { messages: [msg(10), msg(8), msg(7), msg(6), msg(5)], nextCursor: 'r1' }; // m009 deleted
    const refreshed = applyRefreshedPage(data, page);
    expect(ids(refreshed)).toEqual(['m010', 'm008', 'm007', 'm006', 'm005']);
  });

  it('replaces the list when the refreshed page does not overlap it (a gap)', () => {
    const data = applyFirstPage(EMPTY_MAILBOX, { messages: newestFirst(10, 6), nextCursor: 'c1' });
    const refreshed = applyRefreshedPage(data, { messages: newestFirst(40, 36), nextCursor: 'r1' });
    expect(ids(refreshed)).toEqual(['m040', 'm039', 'm038', 'm037', 'm036']);
    expect(refreshed.listCursor).toBe('r1');
  });

  it('replaces the list when the page already holds the whole mailbox', () => {
    const data = applyFirstPage(EMPTY_MAILBOX, { messages: newestFirst(10, 6), nextCursor: 'c1' });
    const refreshed = applyRefreshedPage(data, { messages: newestFirst(9, 7), nextCursor: null });
    expect(ids(refreshed)).toEqual(['m009', 'm008', 'm007']);
    expect(refreshed.listCursor).toBeNull();
  });

  it('keeps an in-flight optimistic value instead of the stale server copy', () => {
    let data = applyFirstPage(EMPTY_MAILBOX, { messages: newestFirst(10, 6), nextCursor: 'c1' });
    data = patchMessage(data, 'm009', { isRead: true });
    const refreshed = applyRefreshedPage(data, { messages: newestFirst(10, 6), nextCursor: 'c1' }, new Set(['m009']));
    expect(refreshed.byId.m009?.isRead).toBe(true);
    expect(refreshed.byId.m008?.isRead).toBe(false);
  });
});

describe('patch and remove', () => {
  it('patches one message and ignores unknown ids', () => {
    const data = applyFirstPage(EMPTY_MAILBOX, { messages: [msg(1)], nextCursor: null });
    expect(patchMessage(data, 'm001', { isRead: true }).byId.m001?.isRead).toBe(true);
    expect(patchMessage(data, 'nope', { isRead: true })).toBe(data);
  });

  it('removes a message from the pool and the list', () => {
    const data = applyFirstPage(EMPTY_MAILBOX, { messages: newestFirst(3, 1), nextCursor: null });
    const next = removeMessage(data, 'm002');
    expect(ids(next)).toEqual(['m003', 'm001']);
    expect(next.byId.m002).toBeUndefined();
  });
});
