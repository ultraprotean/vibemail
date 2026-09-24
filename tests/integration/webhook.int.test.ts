import { gmailWebhookHandler } from '../../src/http/handlers';
import { BASE, buildLiveApp, PUBSUB_TOKEN, type LiveApp, type SignedInUser } from './support/app';
import { gmailError } from './support/fake-gmail';
import { liveContext, messageIds, rawMessage, rawUser } from './support/live';

/**
 * Pub/Sub webhook against live Supabase (CONTRACT.md §6.6): acknowledge first, then fetch
 * the delta from the stored history id, apply it, and move the watermark forward only.
 */

const ctx = liveContext('hook');
let app: LiveApp;

beforeEach(() => {
  app = buildLiveApp(ctx);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await ctx.cleanup();
});

function push(email: string, historyId: string, token = PUBSUB_TOKEN): Promise<Response> {
  const body = JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress: email, historyId })).toString('base64'),
      messageId: `pubsub-${historyId}`,
      publishTime: new Date().toISOString(),
    },
    subscription: 'projects/it/subscriptions/gmail',
  });
  return gmailWebhookHandler(app.deps)(
    new Request(`${BASE}/webhook/gmail?token=${encodeURIComponent(token)}`, { method: 'POST', body }),
  );
}

async function watermark(user: SignedInUser): Promise<string> {
  return String((await rawUser(user.googleId)).last_history_id);
}

describe('acknowledge first', () => {
  it('replies 200 before any sync work reaches the database', async () => {
    const user = await app.signIn(1);
    const gmail = app.gmail(user.googleId);
    gmail.deliver({ id: 'new-1' });
    const release = gmail.holdHistory();

    const response = await push(user.email, gmail.currentHistoryId);

    // Acknowledged while the sync is still blocked inside history.list.
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(app.deferred).toHaveLength(1);
    expect(await messageIds(user.userId)).toEqual([]);

    release();
    await app.deferred[0];
    expect(await messageIds(user.userId)).toEqual(['new-1']);
  });

  it('still returns 200 when the background sync fails, and leaves the watermark for the next notification', async () => {
    const user = await app.signIn(2);
    const gmail = app.gmail(user.googleId);
    const before = await watermark(user);
    gmail.deliver({ id: 'x' });
    gmail.failNext('history', gmailError(500));

    expect((await push(user.email, gmail.currentHistoryId)).status).toBe(200);
    await app.deferred[0];
    expect(await watermark(user)).toBe(before);

    // The next notification reads forward from the same watermark and catches up.
    await push(user.email, gmail.currentHistoryId);
    await app.deferred[1];
    expect(await messageIds(user.userId)).toEqual(['x']);
  });
});

describe('delta fetch using the stored history id', () => {
  it('reads from last_history_id, applies adds, label changes and deletes, and advances the watermark', async () => {
    const user = await app.signIn(3);
    const gmail = app.gmail(user.googleId);
    const start = await watermark(user);

    // Already synced before this notification.
    gmail.seed({ id: 'old-read', labels: ['INBOX', 'UNREAD'] });
    gmail.seed({ id: 'old-gone' });
    const { mailbox, settled } = await app.deps.connect(user.googleId);
    await app.messages.upsertMessages(user.userId, [await mailbox.getMessage('old-read'), await mailbox.getMessage('old-gone')], new Date());
    await settled();

    gmail.deliver({ id: 'arrived', subject: 'Fresh' });
    gmail.relabel('old-read', [], ['UNREAD']); // read in Gmail
    gmail.remove('old-gone');

    await push(user.email, gmail.currentHistoryId);
    await app.deferred[0];

    expect(gmail.calls.historyStart).toEqual([start]);
    expect(await messageIds(user.userId)).toEqual(['arrived', 'old-read']);
    expect((await rawMessage(user.userId, 'old-read'))?.is_read).toBe(true);
    expect((await rawMessage(user.userId, 'arrived'))?.subject).toBe('Fresh');
    expect(await watermark(user)).toBe(gmail.currentHistoryId);
  });

  it('reads from the stored watermark, not the notification historyId', async () => {
    const user = await app.signIn(4);
    const gmail = app.gmail(user.googleId);
    const start = await watermark(user);
    gmail.deliver({ id: 'a' });
    await push(user.email, '1'); // an old/odd notification id
    await app.deferred[0];
    expect(gmail.calls.historyStart).toEqual([start]);
    expect(await messageIds(user.userId)).toEqual(['a']);
  });

  it('never moves the watermark backwards on a redelivered notification', async () => {
    const user = await app.signIn(5);
    const gmail = app.gmail(user.googleId);
    gmail.deliver({ id: 'a' });
    await push(user.email, gmail.currentHistoryId);
    await app.deferred[0];
    const advanced = await watermark(user);

    await app.users.advanceHistoryId(user.userId, String(Number(advanced) - 5));
    expect(await watermark(user)).toBe(advanced);

    await push(user.email, gmail.currentHistoryId); // redelivery
    await app.deferred[1];
    expect(await watermark(user)).toBe(advanced);
    expect(await messageIds(user.userId)).toEqual(['a']);
  });

  it('runs a full resync when the stored history id has expired', async () => {
    const user = await app.signIn(6);
    const gmail = app.gmail(user.googleId);
    gmail.seed({ id: 'kept-1' });
    gmail.deliver({ id: 'kept-2' });
    gmail.expireHistory();
    gmail.deliver({ id: 'kept-3' });

    await push(user.email, gmail.currentHistoryId);
    await app.deferred[0];

    expect(await messageIds(user.userId)).toEqual(['kept-1', 'kept-2', 'kept-3']);
    expect(await watermark(user)).toBe(gmail.currentHistoryId);
  });

  it('ignores a notification for an address with no user', async () => {
    const user = await app.signIn(7);
    const gmail = app.gmail(user.googleId);
    gmail.deliver({ id: 'not-mine' });
    expect((await push(ctx.email('stranger'), gmail.currentHistoryId)).status).toBe(200);
    await app.deferred[0];
    expect(gmail.calls.historyStart).toEqual([]);
  });

  it('does nothing for a user whose Gmail access was revoked', async () => {
    const user = await app.signIn(8);
    const gmail = app.gmail(user.googleId);
    const before = await watermark(user);
    gmail.deliver({ id: 'a' });
    gmail.failNext('history', gmailError(400, 'invalid_grant'));
    await push(user.email, gmail.currentHistoryId);
    await app.deferred[0];
    expect(await watermark(user)).toBe(before);
    expect(await messageIds(user.userId)).toEqual([]);
  });
});

describe('request validation', () => {
  it('rejects a wrong token with 401 UNAUTHORIZED and does no work', async () => {
    const user = await app.signIn(9);
    const response = await push(user.email, '1', 'wrong-token');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
    expect(app.deferred).toHaveLength(0);
  });

  it('acknowledges a malformed envelope with 204 and does no work', async () => {
    const response = await gmailWebhookHandler(app.deps)(
      new Request(`${BASE}/webhook/gmail?token=${PUBSUB_TOKEN}`, { method: 'POST', body: '{"message":{"data":"@@@"}}' }),
    );
    expect(response.status).toBe(204);
    expect(app.deferred).toHaveLength(0);
  });
});
