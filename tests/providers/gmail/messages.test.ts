import type { gmail_v1 } from 'googleapis';
import {
  GmailMessageReader,
  normalizeGmailMessage,
  type GmailMessagesApi,
} from '../../../src/providers/gmail/messages';
import { ProviderError } from '../../../src/types/provider';

type GmailMessage = gmail_v1.Schema$Message;

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

function gmailMessage(overrides: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: 'msg-1',
    threadId: 'thread-1',
    historyId: '123456789012345678',
    internalDate: '1767225600000',
    snippet: 'Hello there',
    labelIds: ['INBOX', 'UNREAD'],
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'Subject', value: 'Greetings' },
        { name: 'From', value: 'Alice <alice@example.com>' },
        { name: 'To', value: 'bob@example.com' },
        { name: 'Cc', value: 'carol@example.com' },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('Plain body') } },
        { mimeType: 'text/html', body: { data: b64url('<p>HTML body</p>') } },
      ],
    },
    ...overrides,
  };
}

describe('normalizeGmailMessage', () => {
  it('maps a multipart message to the contract fields', () => {
    expect(normalizeGmailMessage(gmailMessage())).toEqual({
      id: 'msg-1',
      threadId: 'thread-1',
      subject: 'Greetings',
      from: 'Alice <alice@example.com>',
      to: 'bob@example.com',
      cc: 'carol@example.com',
      snippet: 'Hello there',
      bodyText: 'Plain body',
      bodyHtml: '<p>HTML body</p>',
      labels: ['INBOX', 'UNREAD'],
      isRead: false,
      receivedAt: new Date(1767225600000),
      cursor: '123456789012345678',
    });
  });

  it('matches header names case-insensitively', () => {
    const msg = gmailMessage();
    msg.payload = {
      ...msg.payload,
      headers: [
        { name: 'SUBJECT', value: 'Loud' },
        { name: 'from', value: 'quiet@example.com' },
        { name: 'tO', value: 'mixed@example.com' },
      ],
    };
    const result = normalizeGmailMessage(msg);
    expect(result).toMatchObject({ subject: 'Loud', from: 'quiet@example.com', to: 'mixed@example.com', cc: null });
  });

  it('uses empty strings for missing Subject/From/To and null for missing Cc', () => {
    const msg = gmailMessage();
    msg.payload = { ...msg.payload, headers: [] };
    expect(normalizeGmailMessage(msg)).toMatchObject({ subject: '', from: '', to: '', cc: null });
  });

  it('derives isRead from the absence of the UNREAD label', () => {
    expect(normalizeGmailMessage(gmailMessage({ labelIds: ['INBOX'] })).isRead).toBe(true);
    expect(normalizeGmailMessage(gmailMessage({ labelIds: ['INBOX', 'UNREAD'] })).isRead).toBe(false);
    expect(normalizeGmailMessage(gmailMessage({ labelIds: undefined })).isRead).toBe(true);
  });

  it('keeps STARRED in labels so starred state can be derived', () => {
    const result = normalizeGmailMessage(gmailMessage({ labelIds: ['INBOX', 'STARRED'] }));
    expect(result.labels).toContain('STARRED');
  });

  it('finds bodies nested inside multipart/mixed, skipping attachments', () => {
    const msg = gmailMessage();
    msg.payload = {
      mimeType: 'multipart/mixed',
      headers: [],
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('Nested plain') } },
            { mimeType: 'text/html', body: { data: b64url('<b>Nested html</b>') } },
          ],
        },
        { mimeType: 'text/plain', filename: 'notes.txt', body: { attachmentId: 'att-1', size: 10 } },
      ],
    };
    const result = normalizeGmailMessage(msg);
    expect(result.bodyText).toBe('Nested plain');
    expect(result.bodyHtml).toBe('<b>Nested html</b>');
  });

  it('never treats an attachment as the body', () => {
    const msg = gmailMessage();
    msg.payload = {
      mimeType: 'multipart/mixed',
      headers: [],
      parts: [{ mimeType: 'text/plain', filename: 'a.txt', body: { data: b64url('attachment text') } }],
    };
    expect(normalizeGmailMessage(msg).bodyText).toBeNull();
  });

  it('falls back to payload.body.data for a single-part plain message', () => {
    const msg = gmailMessage();
    msg.payload = { mimeType: 'text/plain', headers: [], body: { data: b64url('Single part') } };
    const result = normalizeGmailMessage(msg);
    expect(result.bodyText).toBe('Single part');
    expect(result.bodyHtml).toBeNull();
  });

  it('treats a single-part HTML payload as the HTML body', () => {
    const msg = gmailMessage();
    msg.payload = { mimeType: 'text/html', headers: [], body: { data: b64url('<i>only html</i>') } };
    const result = normalizeGmailMessage(msg);
    expect(result.bodyHtml).toBe('<i>only html</i>');
    expect(result.bodyText).toBeNull();
  });

  it('decodes base64url (with - and _ characters) and UTF-8', () => {
    const text = 'Ünïcödé ✓ ??>>';
    expect(b64url(text)).toMatch(/[-_]/);
    const msg = gmailMessage();
    msg.payload = { mimeType: 'text/plain', headers: [], body: { data: b64url(text) } };
    expect(normalizeGmailMessage(msg).bodyText).toBe(text);
  });

  it('falls back to the Date header when internalDate is missing', () => {
    const msg = gmailMessage({ internalDate: undefined });
    msg.payload = { ...msg.payload, headers: [{ name: 'Date', value: 'Thu, 01 Jan 2026 00:00:00 +0000' }] };
    expect(normalizeGmailMessage(msg).receivedAt).toEqual(new Date('2026-01-01T00:00:00Z'));
  });

  it('keeps historyId as an exact string beyond 2^53', () => {
    expect(normalizeGmailMessage(gmailMessage({ historyId: '9007199254740993' })).cursor).toBe('9007199254740993');
  });

  it('rejects a message missing required ids as UPSTREAM', () => {
    expect(() => normalizeGmailMessage(gmailMessage({ historyId: undefined }))).toThrow(ProviderError);
  });
});

describe('GmailMessageReader', () => {
  function fakeApi(pages: Record<string, gmail_v1.Schema$ListMessagesResponse>) {
    const list = jest.fn(async (params: gmail_v1.Params$Resource$Users$Messages$List) => ({
      data: pages[params.pageToken ?? 'first'] ?? {},
    }));
    const get = jest.fn(async (params: gmail_v1.Params$Resource$Users$Messages$Get) => ({
      data: gmailMessage({ id: params.id, threadId: `t-${params.id}` }),
    }));
    const api: GmailMessagesApi = { list, get };
    return { api, list, get };
  }

  it('lists the inbox with pageToken and fetches each message with format=full', async () => {
    const { api, list, get } = fakeApi({
      'page-2': { messages: [{ id: 'a' }, { id: 'b' }], nextPageToken: 'page-3' },
    });
    const page = await new GmailMessageReader(api).listMessages({
      limit: 50,
      pageCursor: 'page-2',
      inboxOnly: true,
    });

    expect(list).toHaveBeenCalledWith({ userId: 'me', maxResults: 50, pageToken: 'page-2', labelIds: ['INBOX'] });
    expect(get).toHaveBeenCalledWith({ userId: 'me', id: 'a', format: 'full' });
    expect(get).toHaveBeenCalledWith({ userId: 'me', id: 'b', format: 'full' });
    expect(page.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(page.nextPageCursor).toBe('page-3');
  });

  it('omits the label filter when inboxOnly is not set', async () => {
    const { api, list } = fakeApi({ first: { messages: [] } });
    await new GmailMessageReader(api).listMessages({ limit: 10 });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ labelIds: undefined }));
  });

  it('never fetches more messages than the limit', async () => {
    const { api, get } = fakeApi({ first: { messages: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } });
    const page = await new GmailMessageReader(api).listMessages({ limit: 2 });
    expect(get).toHaveBeenCalledTimes(2);
    expect(page.messages).toHaveLength(2);
    expect(page.nextPageCursor).toBeNull();
  });

  it('maps a 404 from messages.get to NOT_FOUND', async () => {
    const api: GmailMessagesApi = {
      list: jest.fn(),
      get: jest.fn(async () => {
        throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
      }),
    };
    await expect(new GmailMessageReader(api).getMessage('gone')).rejects.toMatchObject({ kind: 'NOT_FOUND' });
  });

  it('maps a 429 from messages.list to RATE_LIMITED', async () => {
    const api: GmailMessagesApi = {
      list: jest.fn(async () => {
        throw Object.assign(new Error('Too many'), { response: { status: 429 } });
      }),
      get: jest.fn(),
    };
    await expect(new GmailMessageReader(api).listMessages({ limit: 5 })).rejects.toMatchObject({
      kind: 'RATE_LIMITED',
    });
  });
});
