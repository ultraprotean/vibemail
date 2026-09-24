import { randomBytes } from 'node:crypto';
import {
  handleGmailWebhook,
  parsePushEnvelope,
  planChanges,
  processGmailNotification,
  tokensMatch,
  type GmailNotification,
  type ProcessDeps,
  type SyncMailbox,
  type SyncOutcome,
  type WebhookHandlerDeps,
} from '../../src/webhook/gmail';
import { ProviderError, type ChangeSet, type MessagePage, type ProviderMessage } from '../../src/types/provider';
import { MemoryMessageStore } from '../helpers/memory-message-store';
import { MemoryUserStore } from '../helpers/memory-user-store';

const TOKEN = 'shared-secret';

function envelope(data: unknown, messageId = 'pubsub-1'): unknown {
  return {
    message: {
      data: Buffer.from(JSON.stringify(data)).toString('base64'),
      messageId,
      publishTime: '2026-09-23T12:00:00Z',
    },
    subscription: 'projects/test/subscriptions/gmail',
  };
}

function message(id: string, labels: string[] = ['INBOX']): ProviderMessage {
  return {
    id,
    threadId: `t-${id}`,
    subject: id,
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
// Envelope and token
// ---------------------------------------------------------------------------

describe('parsePushEnvelope', () => {
  it('decodes emailAddress and historyId from base64 data', () => {
    expect(parsePushEnvelope(envelope({ emailAddress: 'a@example.com', historyId: '12345' }))).toEqual({
      messageId: 'pubsub-1',
      emailAddress: 'a@example.com',
      historyId: '12345',
    });
  });

  it('accepts a numeric historyId as a string', () => {
    expect(parsePushEnvelope(envelope({ emailAddress: 'a@example.com', historyId: 12345 }))?.historyId).toBe('12345');
  });

  it.each([
    ['a non-object body', 'nope'],
    ['a missing message', {}],
    ['missing data', { message: { messageId: 'x' } }],
    ['data that is not base64 JSON', { message: { data: '!!!not-json' } }],
    ['data without emailAddress', envelope({ historyId: '1' })],
    ['a non-numeric historyId', envelope({ emailAddress: 'a@example.com', historyId: 'abc' })],
  ])('returns null for %s', (_label, body) => {
    expect(parsePushEnvelope(body)).toBeNull();
  });
});

describe('tokensMatch', () => {
  it('accepts the exact token only', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch('shared-secreT', TOKEN)).toBe(false);
    expect(tokensMatch('short', TOKEN)).toBe(false);
    expect(tokensMatch(undefined, TOKEN)).toBe(false);
    expect(tokensMatch('', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Acknowledge first
// ---------------------------------------------------------------------------

describe('handleGmailWebhook', () => {
  function handlerDeps(process: WebhookHandlerDeps['process']) {
    const deferred: Array<Promise<void>> = [];
    const log = { info: jest.fn(), error: jest.fn() };
    const deps: WebhookHandlerDeps = {
      verificationToken: TOKEN,
      defer: (work) => deferred.push(work),
      process,
      log,
    };
    return { deps, deferred, log };
  }

  it('replies 200 before processing starts, then runs the sync via defer', async () => {
    let resolveProcess: (outcome: SyncOutcome) => void = () => undefined;
    const process = jest.fn(
      () => new Promise<SyncOutcome>((resolve) => {
        resolveProcess = resolve;
      }),
    );
    const { deps, deferred, log } = handlerDeps(process);

    const response = handleGmailWebhook(
      { token: TOKEN, body: envelope({ emailAddress: 'a@example.com', historyId: '5' }) },
      deps,
    );

    // The response exists while the sync is still pending.
    expect(response).toEqual({ status: 200 });
    expect(process).toHaveBeenCalledWith({ messageId: 'pubsub-1', emailAddress: 'a@example.com', historyId: '5' });
    expect(deferred).toHaveLength(1);
    expect(log.info).not.toHaveBeenCalled();

    resolveProcess({ result: 'unknown-user' });
    await deferred[0];
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('rejects a wrong token with 401 UNAUTHORIZED and does not process', () => {
    const process = jest.fn();
    const { deps, deferred } = handlerDeps(process);
    const response = handleGmailWebhook({ token: 'wrong', body: envelope({}) }, deps);
    expect(response).toEqual({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Invalid webhook token' } } });
    expect(process).not.toHaveBeenCalled();
    expect(deferred).toHaveLength(0);
  });

  it('rejects a missing token with 401', () => {
    const { deps } = handlerDeps(jest.fn());
    expect(handleGmailWebhook({ token: undefined, body: envelope({}) }, deps).status).toBe(401);
  });

  it('acknowledges a malformed envelope with 204 and does not process', () => {
    const process = jest.fn();
    const { deps, log } = handlerDeps(process);
    expect(handleGmailWebhook({ token: TOKEN, body: { message: { data: '***' } } }, deps)).toEqual({ status: 204 });
    expect(process).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it('logs a failed sync instead of rejecting, after the 200 was already sent', async () => {
    const { deps, deferred, log } = handlerDeps(jest.fn(async () => Promise.reject(new Error('gmail down'))));
    const response = handleGmailWebhook(
      { token: TOKEN, body: envelope({ emailAddress: 'a@example.com', historyId: '5' }) },
      deps,
    );
    expect(response.status).toBe(200);
    await expect(deferred[0]).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      expect.objectContaining({ error: 'gmail down', emailAddress: 'a@example.com' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

describe('planChanges', () => {
  it('keeps one final action per message, the later record winning', () => {
    expect(
      planChanges([
        { type: 'added', messageId: 'a' },
        { type: 'labelsChanged', messageId: 'b', added: [], removed: ['UNREAD'] },
        { type: 'added', messageId: 'c' },
        { type: 'deleted', messageId: 'c' },
        { type: 'deleted', messageId: 'd' },
        { type: 'added', messageId: 'd' },
      ]),
    ).toEqual({ refetch: ['a', 'b', 'd'], remove: ['c'] });
  });
});

describe('processGmailNotification', () => {
  const notification: GmailNotification = { messageId: 'm', emailAddress: 'user@example.com', historyId: '500' };
  const now = new Date('2026-09-23T12:00:00Z');

  async function setup(opts: { lastHistoryId?: string | null } = {}) {
    const users = new MemoryUserStore();
    const messages = new MemoryMessageStore();
    const { userId } = await users.upsertUserTokens({
      googleId: 'google-1',
      email: 'user@example.com',
      accessTokenEnc: randomBytes(40),
      refreshTokenEnc: randomBytes(40),
      tokenExpiresAt: now,
    });
    const lastHistoryId = opts.lastHistoryId === undefined ? '100' : opts.lastHistoryId;
    if (lastHistoryId !== null) {
      await users.saveWatch('google-1', { lastHistoryId, watchExpiry: now });
    }

    const gmail = new Map<string, ProviderMessage>();
    const mailbox = {
      listChangesSince: jest.fn(async (): Promise<ChangeSet> => ({ changes: [], cursor: '100' })),
      getMessage: jest.fn(async (id: string): Promise<ProviderMessage> => {
        const found = gmail.get(id);
        if (!found) throw new ProviderError('NOT_FOUND', `no ${id}`);
        return found;
      }),
      getCurrentCursor: jest.fn(async () => '900'),
      listMessages: jest.fn(async (): Promise<MessagePage> => ({
        messages: [...gmail.values()],
        nextPageCursor: null,
      })),
    } satisfies SyncMailbox;
    const settled = jest.fn(async () => undefined);
    const connect = jest.fn(async () => ({ mailbox, settled }));
    const deps: ProcessDeps = { users, messages, connect, now: () => now };
    return { users, messages, userId, gmail, mailbox, settled, connect, deps };
  }

  it('reads history from the stored watermark, applies the delta and advances the watermark', async () => {
    const { users, messages, userId, gmail, mailbox, settled, deps } = await setup();
    await messages.upsertMessages(userId, [message('old-1'), message('old-2', ['INBOX', 'UNREAD'])], now);
    gmail.set('new-1', message('new-1'));
    gmail.set('old-2', message('old-2', ['INBOX'])); // marked read in Gmail
    mailbox.listChangesSince.mockResolvedValueOnce({
      changes: [
        { type: 'added', messageId: 'new-1' },
        { type: 'labelsChanged', messageId: 'old-2', added: [], removed: ['UNREAD'] },
        { type: 'deleted', messageId: 'old-1' },
      ],
      cursor: '480',
    });

    const outcome = await processGmailNotification(notification, deps);

    // Starts from the stored watermark, not the notification's historyId.
    expect(mailbox.listChangesSince).toHaveBeenCalledWith('100');
    expect(outcome).toEqual({ result: 'synced', upserted: 2, deleted: 1, advanced: true });
    expect(messages.idsFor(userId)).toEqual(['new-1', 'old-2']);
    expect(messages.rows.get(`${userId}/old-2`)?.isRead).toBe(true);
    // Watermark = the final history.list historyId, not the notification's 500.
    expect((await users.findUserByEmail('user@example.com'))?.lastHistoryId).toBe('480');
    expect(settled).toHaveBeenCalled();
  });

  it('deletes a message that 404s when refetched', async () => {
    const { messages, userId, mailbox, deps } = await setup();
    await messages.upsertMessages(userId, [message('vanished')], now);
    mailbox.listChangesSince.mockResolvedValueOnce({
      changes: [{ type: 'labelsChanged', messageId: 'vanished', added: ['STARRED'], removed: [] }],
      cursor: '120',
    });
    const outcome = await processGmailNotification(notification, deps);
    expect(outcome).toMatchObject({ result: 'synced', upserted: 0, deleted: 1 });
    expect(messages.idsFor(userId)).toEqual([]);
  });

  it('never moves the watermark backwards', async () => {
    const { users, mailbox, deps } = await setup({ lastHistoryId: '300' });
    mailbox.listChangesSince.mockResolvedValueOnce({ changes: [], cursor: '250' });
    const outcome = await processGmailNotification(notification, deps);
    expect(outcome).toMatchObject({ result: 'synced', advanced: false });
    expect((await users.findUserByEmail('user@example.com'))?.lastHistoryId).toBe('300');
  });

  it('compares watermarks beyond 2^53 exactly', async () => {
    const { users, mailbox, deps } = await setup({ lastHistoryId: '9007199254740993' });
    mailbox.listChangesSince.mockResolvedValueOnce({ changes: [], cursor: '9007199254740994' });
    await processGmailNotification(notification, deps);
    expect((await users.findUserByEmail('user@example.com'))?.lastHistoryId).toBe('9007199254740994');
  });

  it('runs a full resync when history has expired', async () => {
    const { users, messages, userId, gmail, mailbox, deps } = await setup();
    gmail.set('m1', message('m1'));
    gmail.set('m2', message('m2'));
    mailbox.listChangesSince.mockRejectedValueOnce(new ProviderError('CURSOR_EXPIRED', 'too old'));

    const outcome = await processGmailNotification(notification, deps);

    expect(outcome).toEqual({ result: 'resynced', upserted: 2, advanced: true });
    expect(mailbox.getCurrentCursor).toHaveBeenCalled();
    expect(mailbox.listMessages).toHaveBeenCalledWith(expect.objectContaining({ inboxOnly: true }));
    expect(messages.idsFor(userId)).toEqual(['m1', 'm2']);
    expect((await users.findUserByEmail('user@example.com'))?.lastHistoryId).toBe('900');
  });

  it('does nothing for an unknown email address', async () => {
    const { connect, deps } = await setup();
    const outcome = await processGmailNotification({ ...notification, emailAddress: 'stranger@example.com' }, deps);
    expect(outcome).toEqual({ result: 'unknown-user' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('does nothing before a watch has stored a watermark', async () => {
    const { connect, deps } = await setup({ lastHistoryId: null });
    expect(await processGmailNotification(notification, deps)).toEqual({ result: 'no-watermark' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('does nothing when the refresh token is dead at connect time', async () => {
    const { connect, deps } = await setup();
    connect.mockRejectedValueOnce(new ProviderError('AUTH_REVOKED', 'dead'));
    expect(await processGmailNotification(notification, deps)).toEqual({ result: 'auth-revoked' });
  });

  it('does nothing when the refresh token is rejected mid-sync', async () => {
    const { users, mailbox, deps } = await setup();
    mailbox.listChangesSince.mockRejectedValueOnce(new ProviderError('AUTH_REVOKED', 'invalid_grant'));
    expect(await processGmailNotification(notification, deps)).toEqual({ result: 'auth-revoked' });
    expect((await users.findUserByEmail('user@example.com'))?.lastHistoryId).toBe('100');
  });

  it('leaves the watermark unchanged when the sync fails, so the next notification retries', async () => {
    const { users, mailbox, deps } = await setup();
    mailbox.listChangesSince.mockResolvedValueOnce({ changes: [{ type: 'added', messageId: 'x' }], cursor: '200' });
    mailbox.getMessage.mockRejectedValueOnce(new ProviderError('UPSTREAM', 'gmail 500'));

    await expect(processGmailNotification(notification, deps)).rejects.toMatchObject({ kind: 'UPSTREAM' });
    expect((await users.findUserByEmail('user@example.com'))?.lastHistoryId).toBe('100');
  });

  it('is idempotent: a redelivered notification leaves the same state', async () => {
    const { messages, userId, gmail, mailbox, deps } = await setup();
    gmail.set('a', message('a'));
    const delta: ChangeSet = { changes: [{ type: 'added', messageId: 'a' }], cursor: '150' };
    mailbox.listChangesSince.mockResolvedValue(delta);

    await processGmailNotification(notification, deps);
    const second = await processGmailNotification(notification, deps);

    expect(messages.idsFor(userId)).toEqual(['a']);
    expect(second).toMatchObject({ result: 'synced', advanced: false });
  });
});
