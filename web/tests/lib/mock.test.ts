import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/errors';
import { createMockClient, resetMockStore } from '@/lib/mock';

const client = createMockClient();

beforeEach(() => {
  resetMockStore();
  window.history.replaceState(null, '', '/?mockSlow=1');
});

describe('mock client behaves like the contract', () => {
  it('pages newest first with a cursor and honours unreadOnly', async () => {
    const first = await client.listMessages({ limit: 20 });
    expect(first.messages).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    const dates = first.messages.map((m) => m.receivedAt);
    expect([...dates].sort().reverse()).toEqual(dates);

    const second = await client.listMessages({ limit: 20, cursor: first.nextCursor });
    expect(second.messages.length).toBeGreaterThan(0);
    const seen = new Set(first.messages.map((m) => m.id));
    expect(second.messages.every((m) => !seen.has(m.id))).toBe(true);

    const unread = await client.listMessages({ limit: 100, unreadOnly: true });
    expect(unread.messages.length).toBeGreaterThan(0);
    expect(unread.messages.every((m) => !m.isRead)).toBe(true);
  });

  it('rejects a bad cursor and limit with INVALID_REQUEST', async () => {
    await expect(client.listMessages({ cursor: '%%%' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.listMessages({ limit: 101 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('marks messages read and unread, and 404s on unknown ids', async () => {
    const { messages } = await client.listMessages({ limit: 100, unreadOnly: true });
    const target = messages[0];
    expect(target).toBeDefined();
    expect(await client.setReadState(target?.id ?? '', true)).toEqual({ id: target?.id, isRead: true });
    expect(await client.setReadState(target?.id ?? '', false)).toEqual({ id: target?.id, isRead: false });
    const error = await client.setReadState('nope', true).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('NOT_FOUND');
  });

  it('stores a sent message in its thread', async () => {
    const result = await client.sendMessage({ to: ['a@x.example'], subject: 'Re: hi', bodyText: 'Hello', threadId: 't-inn' });
    expect(result).toMatchObject({ status: 'sent', threadId: 't-inn' });
    const { messages } = await client.listMessages({ limit: 100 });
    expect(messages.some((m) => m.id === result.id && m.threadId === 't-inn')).toBe(true);
  });

  it('has multi-message threads, HTML-only mail and long subjects for UI states', async () => {
    const { messages } = await client.listMessages({ limit: 100 });
    const byThread = new Map<string, number>();
    for (const m of messages) byThread.set(m.threadId, (byThread.get(m.threadId) ?? 0) + 1);
    expect(Math.max(...byThread.values())).toBeGreaterThanOrEqual(3);
    expect(messages.some((m) => m.bodyText === null && m.bodyHtml !== null)).toBe(true);
    expect(messages.some((m) => m.subject.length > 100)).toBe(true);
  });

  it('simulates failures through URL flags', async () => {
    window.history.replaceState(null, '', '/?mockSlow=1&mockFail=INTERNAL_ERROR&mockOp=list');
    await expect(client.listMessages({})).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await expect(client.setReadState('mock-001', true)).resolves.toBeDefined();

    window.history.replaceState(null, '', '/?mockSlow=1&mockFail=AUTH_FAILED_FATAL');
    await expect(client.listMessages({})).rejects.toMatchObject({ code: 'AUTH_FAILED', recoverable: false });

    window.history.replaceState(null, '', '/?mockSlow=1&mockEmpty=1');
    expect((await client.listMessages({})).messages).toEqual([]);
  });
});
