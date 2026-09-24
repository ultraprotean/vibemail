import type { gmail_v1 } from 'googleapis';
import { GmailSender, type GmailSendApi } from '../../src/providers/gmail/send';
import { toMessageRow } from '../../src/db/supabase-message-store';
import { parseSendRequest, sendAndStore, SendValidationError } from '../../src/send';
import { ProviderError, type ProviderMessage, type SendMessageInput } from '../../src/types/provider';
import { MemoryMessageStore } from '../helpers/memory-message-store';

const input: SendMessageInput = { to: ['bob@example.com'], subject: 'Hello', bodyText: 'Hi Bob' };

function sentCopy(id: string, threadId: string): ProviderMessage {
  return {
    id,
    threadId,
    subject: 'Hello',
    from: 'Me <me@example.com>',
    to: 'bob@example.com',
    cc: null,
    snippet: 'Hi Bob',
    bodyText: 'Hi Bob',
    bodyHtml: null,
    labels: ['SENT'],
    isRead: true,
    receivedAt: new Date('2026-09-23T12:00:00Z'),
    cursor: '777',
  };
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

describe('parseSendRequest', () => {
  it('accepts the minimal request: to, subject, body, and optional threadId', () => {
    expect(parseSendRequest({ to: 'bob@example.com', subject: 'Hello', body: 'Hi', threadId: 't1' })).toEqual({
      to: ['bob@example.com'],
      cc: [],
      bcc: [],
      subject: 'Hello',
      bodyText: 'Hi',
      bodyHtml: undefined,
      threadId: 't1',
      inReplyTo: undefined,
    });
  });

  it('accepts the full CONTRACT.md §6.4 body', () => {
    const parsed = parseSendRequest({
      to: ['a@example.com', 'b@example.com'],
      cc: ['c@example.com'],
      bcc: ['d@example.com'],
      subject: 'Re: Plan',
      bodyText: 'plain',
      bodyHtml: '<p>html</p>',
      threadId: 't9',
      inReplyTo: '<m@mail.gmail.com>',
    });
    expect(parsed).toMatchObject({ to: ['a@example.com', 'b@example.com'], bodyText: 'plain', bodyHtml: '<p>html</p>' });
  });

  it('accepts an HTML-only body', () => {
    expect(parseSendRequest({ to: ['a@example.com'], subject: 'S', bodyHtml: '<p>x</p>' })).toMatchObject({
      bodyHtml: '<p>x</p>',
    });
  });

  it.each([
    ['a non-object body', 'text'],
    ['missing to', { subject: 'S', body: 'x' }],
    ['empty to', { to: [], subject: 'S', body: 'x' }],
    ['to of the wrong type', { to: 5, subject: 'S', body: 'x' }],
    ['a malformed address', { to: ['nope'], subject: 'S', body: 'x' }],
    ['a malformed cc', { to: ['a@example.com'], cc: ['nope'], subject: 'S', body: 'x' }],
    ['missing subject', { to: ['a@example.com'], body: 'x' }],
    ['missing body', { to: ['a@example.com'], subject: 'S' }],
    ['a non-string threadId', { to: ['a@example.com'], subject: 'S', body: 'x', threadId: 1 }],
  ])('rejects %s', (_label, body) => {
    expect(() => parseSendRequest(body)).toThrow(SendValidationError);
  });
});

// ---------------------------------------------------------------------------
// Gmail messages.send
// ---------------------------------------------------------------------------

describe('GmailSender', () => {
  function fakeApi(response: gmail_v1.Schema$Message = { id: 'sent-1', threadId: 'thread-1', labelIds: ['SENT'] }) {
    const send = jest.fn(async (_params: gmail_v1.Params$Resource$Users$Messages$Send) => ({ data: response }));
    const api: GmailSendApi = { send };
    return { api, send };
  }

  it('sends the RFC 2822 message as base64url in requestBody.raw, with the threadId', async () => {
    const { api, send } = fakeApi();
    const result = await new GmailSender(api).sendMessage({ ...input, threadId: 'thread-1' });

    expect(result).toEqual({ id: 'sent-1', threadId: 'thread-1' });
    const params = send.mock.calls[0][0];
    expect(params.userId).toBe('me');
    expect(params.requestBody?.threadId).toBe('thread-1');
    expect(params).not.toHaveProperty('media');

    const raw = params.requestBody?.raw ?? '';
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).toContain('To: bob@example.com\r\n');
    expect(decoded).toContain('Subject: Hello\r\n');
  });

  it('validates before calling Gmail', async () => {
    const { api, send } = fakeApi();
    await expect(new GmailSender(api).sendMessage({ ...input, to: ['nope'] })).rejects.toThrow(SendValidationError);
    expect(send).not.toHaveBeenCalled();
  });

  it('maps a 429 to RATE_LIMITED', async () => {
    const api: GmailSendApi = {
      send: jest.fn(async () => {
        throw Object.assign(new Error('quota'), { response: { status: 429 } });
      }),
    };
    await expect(new GmailSender(api).sendMessage(input)).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
  });

  it('maps other failures to UPSTREAM', async () => {
    const api: GmailSendApi = {
      send: jest.fn(async () => {
        throw Object.assign(new Error('backend'), { response: { status: 500 } });
      }),
    };
    await expect(new GmailSender(api).sendMessage(input)).rejects.toMatchObject({ kind: 'UPSTREAM' });
  });

  it('rejects a response with no id as UPSTREAM', async () => {
    const { api } = fakeApi({ labelIds: ['SENT'] });
    await expect(new GmailSender(api).sendMessage(input)).rejects.toMatchObject({ kind: 'UPSTREAM' });
  });
});

// ---------------------------------------------------------------------------
// Send and store
// ---------------------------------------------------------------------------

describe('sendAndStore', () => {
  const now = new Date('2026-09-23T12:00:05Z');

  function setup() {
    const store = new MemoryMessageStore();
    const mailbox = {
      sendMessage: jest.fn(async () => ({ id: 'sent-1', threadId: 'thread-1' })),
      getMessage: jest.fn(async (id: string) => sentCopy(id, 'thread-1')),
    };
    const onStoreError = jest.fn();
    return { store, mailbox, onStoreError, deps: { mailbox, store, now: () => now, onStoreError } };
  }

  it('sends, fetches the sent copy, and upserts it under the user', async () => {
    const { store, mailbox, deps } = setup();
    const result = await sendAndStore('user-1', input, deps);

    expect(result).toEqual({ id: 'sent-1', threadId: 'thread-1', status: 'sent', stored: true });
    expect(mailbox.sendMessage).toHaveBeenCalledWith(input);
    expect(mailbox.getMessage).toHaveBeenCalledWith('sent-1');
    expect(store.idsFor('user-1')).toEqual(['sent-1']);
  });

  it('stores the sent copy in the database shape, with from_address and to_address', async () => {
    const { store, deps } = setup();
    await sendAndStore('user-1', input, deps);
    const stored = store.rows.get('user-1/sent-1');
    expect(stored).toBeDefined();
    if (!stored) return;
    expect(toMessageRow('user-1', stored, now)).toMatchObject({
      user_id: 'user-1',
      id: 'sent-1',
      thread_id: 'thread-1',
      from_address: 'Me <me@example.com>',
      to_address: 'bob@example.com',
      label_ids: ['SENT'],
      history_id: '777',
      synced_at: now.toISOString(),
    });
  });

  it('still reports success when the sent copy cannot be fetched or stored', async () => {
    const { store, mailbox, onStoreError, deps } = setup();
    mailbox.getMessage.mockRejectedValueOnce(new ProviderError('UPSTREAM', 'gmail 500'));

    const result = await sendAndStore('user-1', input, deps);

    expect(result).toEqual({ id: 'sent-1', threadId: 'thread-1', status: 'sent', stored: false });
    expect(onStoreError).toHaveBeenCalledWith(expect.any(ProviderError), { id: 'sent-1', threadId: 'thread-1' });
    expect(store.idsFor('user-1')).toEqual([]);
  });

  it('still reports success when the database write fails', async () => {
    const { store, onStoreError, deps } = setup();
    jest.spyOn(store, 'upsertMessages').mockRejectedValueOnce(new Error('db down'));
    const result = await sendAndStore('user-1', input, deps);
    expect(result.stored).toBe(false);
    expect(onStoreError).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed send and stores nothing', async () => {
    const { store, mailbox, deps } = setup();
    mailbox.sendMessage.mockRejectedValueOnce(new ProviderError('RATE_LIMITED', 'quota'));
    await expect(sendAndStore('user-1', input, deps)).rejects.toMatchObject({ kind: 'RATE_LIMITED' });
    expect(mailbox.getMessage).not.toHaveBeenCalled();
    expect(store.idsFor('user-1')).toEqual([]);
  });
});
