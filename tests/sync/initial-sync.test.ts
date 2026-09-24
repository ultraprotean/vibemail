import type { MessageStore } from '../../src/db/message-store';
import { INITIAL_SYNC_LIMIT, runInitialSync } from '../../src/sync';
import type { ListMessagesOptions, MessagePage, ProviderMessage } from '../../src/types/provider';

function message(id: string): ProviderMessage {
  return {
    id,
    threadId: `t-${id}`,
    subject: '',
    from: '',
    to: '',
    cc: null,
    snippet: '',
    bodyText: null,
    bodyHtml: null,
    labels: ['INBOX'],
    isRead: true,
    receivedAt: new Date(0),
    cursor: '1',
  };
}

/** A mailbox of `total` inbox messages served in pages of at most `pageSize`. */
function fakeMailbox(total: number, pageSize: number) {
  const listMessages = jest.fn(async (opts: ListMessagesOptions): Promise<MessagePage> => {
    const start = Number(opts.pageCursor ?? 0);
    const count = Math.min(pageSize, opts.limit, total - start);
    const messages = Array.from({ length: Math.max(count, 0) }, (_, i) => message(`m${start + i}`));
    const next = start + messages.length;
    return { messages, nextPageCursor: next < total ? String(next) : null };
  });
  return { listMessages };
}

function recordingStore() {
  const upserts: Array<{ userId: string; ids: string[]; syncedAt: Date }> = [];
  const store: MessageStore = {
    upsertMessages: async (userId, messages, syncedAt) => {
      upserts.push({ userId, ids: messages.map((m) => m.id), syncedAt });
    },
  };
  return { store, upserts };
}

describe('runInitialSync', () => {
  const syncedAt = new Date('2026-09-23T12:00:00Z');

  it('stops after exactly 50 messages, paging through the inbox', async () => {
    const mailbox = fakeMailbox(200, 20);
    const { store, upserts } = recordingStore();

    const result = await runInitialSync('user-1', { mailbox, store, now: () => syncedAt });

    expect(INITIAL_SYNC_LIMIT).toBe(50);
    expect(result).toEqual({ synced: 50 });
    expect(upserts.flatMap((u) => u.ids)).toHaveLength(50);
    // Pages of 20, 20, then only the 10 still needed.
    expect(mailbox.listMessages.mock.calls.map(([opts]) => opts)).toEqual([
      { limit: 50, pageCursor: undefined, inboxOnly: true },
      { limit: 30, pageCursor: '20', inboxOnly: true },
      { limit: 10, pageCursor: '40', inboxOnly: true },
    ]);
  });

  it('upserts every message under the given user id', async () => {
    const { store, upserts } = recordingStore();
    await runInitialSync('user-42', { mailbox: fakeMailbox(5, 20), store, now: () => syncedAt });
    expect(upserts).toEqual([{ userId: 'user-42', ids: ['m0', 'm1', 'm2', 'm3', 'm4'], syncedAt }]);
  });

  it('stops when the inbox runs out before the limit', async () => {
    const mailbox = fakeMailbox(12, 5);
    const { store } = recordingStore();
    const result = await runInitialSync('user-1', { mailbox, store });
    expect(result).toEqual({ synced: 12 });
    expect(mailbox.listMessages).toHaveBeenCalledTimes(3);
  });

  it('handles an empty inbox', async () => {
    const { store, upserts } = recordingStore();
    const result = await runInitialSync('user-1', { mailbox: fakeMailbox(0, 20), store });
    expect(result).toEqual({ synced: 0 });
    expect(upserts.flatMap((u) => u.ids)).toEqual([]);
  });

  it('does not loop forever on an empty page that still has a cursor', async () => {
    const listMessages = jest.fn(async (): Promise<MessagePage> => ({ messages: [], nextPageCursor: 'again' }));
    const { store } = recordingStore();
    await runInitialSync('user-1', { mailbox: { listMessages }, store });
    expect(listMessages).toHaveBeenCalledTimes(1);
  });

  it('propagates a store failure', async () => {
    const store: MessageStore = {
      upsertMessages: async () => {
        throw new Error('db down');
      },
    };
    await expect(runInitialSync('user-1', { mailbox: fakeMailbox(5, 5), store })).rejects.toThrow('db down');
  });
});
