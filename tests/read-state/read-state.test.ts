import type { gmail_v1 } from 'googleapis';
import { GmailReadState, type GmailModifyApi } from '../../src/providers/gmail/read-state';
import { MessageNotFoundError, setMessageReadState } from '../../src/read-state';
import { ProviderError, type ProviderMessage } from '../../src/types/provider';
import { MemoryMessageStore } from '../helpers/memory-message-store';

function message(id: string, labels: string[]): ProviderMessage {
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
    labels,
    isRead: !labels.includes('UNREAD'),
    receivedAt: new Date(0),
    cursor: '1',
  };
}

// ---------------------------------------------------------------------------
// Gmail messages.modify
// ---------------------------------------------------------------------------

describe('GmailReadState', () => {
  function fakeApi(labelIds: string[]) {
    const modify = jest.fn(async (_params: gmail_v1.Params$Resource$Users$Messages$Modify) => ({
      data: { id: 'm1', threadId: 't1', labelIds },
    }));
    const api: GmailModifyApi = { modify };
    return { api, modify };
  }

  it('marks read by removing the UNREAD label', async () => {
    const { api, modify } = fakeApi(['INBOX']);
    const result = await new GmailReadState(api).setReadState('m1', true);
    expect(modify).toHaveBeenCalledWith({ userId: 'me', id: 'm1', requestBody: { removeLabelIds: ['UNREAD'] } });
    expect(result).toEqual({ labels: ['INBOX'] });
  });

  it('marks unread by adding the UNREAD label', async () => {
    const { api, modify } = fakeApi(['INBOX', 'UNREAD']);
    const result = await new GmailReadState(api).setReadState('m1', false);
    expect(modify).toHaveBeenCalledWith({ userId: 'me', id: 'm1', requestBody: { addLabelIds: ['UNREAD'] } });
    expect(result).toEqual({ labels: ['INBOX', 'UNREAD'] });
  });

  it('maps a 404 to NOT_FOUND', async () => {
    const api: GmailModifyApi = {
      modify: jest.fn(async () => {
        throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
      }),
    };
    await expect(new GmailReadState(api).setReadState('gone', true)).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });

  it('maps other failures to UPSTREAM', async () => {
    const api: GmailModifyApi = {
      modify: jest.fn(async () => {
        throw Object.assign(new Error('backend'), { response: { status: 500 } });
      }),
    };
    await expect(new GmailReadState(api).setReadState('m1', true)).rejects.toMatchObject({ kind: 'UPSTREAM' });
  });
});

// ---------------------------------------------------------------------------
// setMessageReadState
// ---------------------------------------------------------------------------

describe('setMessageReadState', () => {
  const now = new Date('2026-09-23T12:00:00Z');

  async function setup() {
    const store = new MemoryMessageStore();
    await store.upsertMessages('user-1', [message('m1', ['INBOX', 'UNREAD', 'STARRED'])], now);
    await store.upsertMessages('user-2', [message('other', ['INBOX', 'UNREAD'])], now);
    const mailbox = {
      setReadState: jest.fn(async (_id: string, isRead: boolean) => ({
        labels: isRead ? ['INBOX', 'STARRED'] : ['INBOX', 'UNREAD', 'STARRED'],
      })),
    };
    return { store, mailbox, deps: { store, mailbox } };
  }

  it('marks read in the provider, then stores the returned labels locally', async () => {
    const { store, mailbox, deps } = await setup();
    const result = await setMessageReadState('user-1', 'm1', true, deps);

    expect(result).toEqual({ id: 'm1', isRead: true });
    expect(mailbox.setReadState).toHaveBeenCalledWith('m1', true);
    const row = store.rows.get('user-1/m1');
    expect(row?.labels).toEqual(['INBOX', 'STARRED']);
    expect(row?.isRead).toBe(true);
  });

  it('marks unread the same way', async () => {
    const { store, deps } = await setup();
    await setMessageReadState('user-1', 'm1', true, deps);
    const result = await setMessageReadState('user-1', 'm1', false, deps);
    expect(result).toEqual({ id: 'm1', isRead: false });
    expect(store.rows.get('user-1/m1')?.labels).toContain('UNREAD');
  });

  it('returns NOT_FOUND for an id the user does not have, without calling the provider', async () => {
    const { mailbox, deps } = await setup();
    await expect(setMessageReadState('user-1', 'nope', true, deps)).rejects.toThrow(MessageNotFoundError);
    expect(mailbox.setReadState).not.toHaveBeenCalled();
  });

  it("treats another user's message id as not found", async () => {
    const { mailbox, store, deps } = await setup();
    await expect(setMessageReadState('user-1', 'other', true, deps)).rejects.toThrow(MessageNotFoundError);
    expect(mailbox.setReadState).not.toHaveBeenCalled();
    expect(store.rows.get('user-2/other')?.isRead).toBe(false);
  });

  it('leaves the local row unchanged when the provider call fails', async () => {
    const { store, mailbox, deps } = await setup();
    mailbox.setReadState.mockRejectedValueOnce(new ProviderError('UPSTREAM', 'gmail 500'));

    await expect(setMessageReadState('user-1', 'm1', true, deps)).rejects.toMatchObject({ kind: 'UPSTREAM' });
    const row = store.rows.get('user-1/m1');
    expect(row?.labels).toEqual(['INBOX', 'UNREAD', 'STARRED']);
    expect(row?.isRead).toBe(false);
  });
});
