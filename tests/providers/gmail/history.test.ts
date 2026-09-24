import type { gmail_v1 } from 'googleapis';
import { GmailHistoryReader, toChanges, type GmailHistoryApi } from '../../../src/providers/gmail/history';

describe('toChanges', () => {
  it('maps every history record type to a provider-agnostic change', () => {
    expect(
      toChanges({
        id: '10',
        messagesAdded: [{ message: { id: 'new' } }],
        labelsAdded: [{ message: { id: 'starred' }, labelIds: ['STARRED'] }],
        labelsRemoved: [{ message: { id: 'read' }, labelIds: ['UNREAD'] }],
        messagesDeleted: [{ message: { id: 'gone' } }],
      }),
    ).toEqual([
      { type: 'added', messageId: 'new' },
      { type: 'labelsChanged', messageId: 'starred', added: ['STARRED'], removed: [] },
      { type: 'labelsChanged', messageId: 'read', added: [], removed: ['UNREAD'] },
      { type: 'deleted', messageId: 'gone' },
    ]);
  });

  it('ignores entries without a message id', () => {
    expect(toChanges({ messagesAdded: [{ message: {} }, {}] })).toEqual([]);
  });
});

describe('GmailHistoryReader.listChangesSince', () => {
  function fakeApi(pages: Record<string, gmail_v1.Schema$ListHistoryResponse>) {
    const list = jest.fn(async (params: gmail_v1.Params$Resource$Users$History$List) => ({
      data: pages[params.pageToken ?? 'first'] ?? {},
    }));
    const api: GmailHistoryApi = { list, getProfile: jest.fn() };
    return { api, list };
  }

  it('uses the stored watermark as startHistoryId and follows every page', async () => {
    const { api, list } = fakeApi({
      first: { history: [{ messagesAdded: [{ message: { id: 'a' } }] }], historyId: '150', nextPageToken: 'p2' },
      p2: { history: [{ messagesDeleted: [{ message: { id: 'b' } }] }], historyId: '160' },
    });
    const result = await new GmailHistoryReader(api).listChangesSince('100');

    expect(list).toHaveBeenNthCalledWith(1, { userId: 'me', startHistoryId: '100', pageToken: undefined, maxResults: 500 });
    expect(list).toHaveBeenNthCalledWith(2, { userId: 'me', startHistoryId: '100', pageToken: 'p2', maxResults: 500 });
    expect(result).toEqual({
      changes: [
        { type: 'added', messageId: 'a' },
        { type: 'deleted', messageId: 'b' },
      ],
      cursor: '160',
    });
  });

  it('returns the starting cursor when there are no changes and no historyId', async () => {
    const { api } = fakeApi({ first: {} });
    expect(await new GmailHistoryReader(api).listChangesSince('100')).toEqual({ changes: [], cursor: '100' });
  });

  it('maps a 404 (history expired) to CURSOR_EXPIRED', async () => {
    const api: GmailHistoryApi = {
      list: jest.fn(async () => {
        throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
      }),
      getProfile: jest.fn(),
    };
    await expect(new GmailHistoryReader(api).listChangesSince('1')).rejects.toMatchObject({ kind: 'CURSOR_EXPIRED' });
  });
});

describe('GmailHistoryReader.getCurrentCursor', () => {
  it('returns the profile historyId', async () => {
    const api: GmailHistoryApi = {
      list: jest.fn(),
      getProfile: jest.fn(async () => ({ data: { emailAddress: 'a@example.com', historyId: '999' } })),
    };
    expect(await new GmailHistoryReader(api).getCurrentCursor()).toBe('999');
  });
});
