import { GET as authStartRoute } from '../../api/v1/auth/google';
import { issueSessionToken, verifySessionToken } from '../../src/auth/jwt';
import { SupabaseMessageStore } from '../../src/db/supabase-message-store';
import { SupabaseUserStore } from '../../src/db/supabase-user-store';
import {
  authCallbackHandler,
  authStartHandler,
  listMessagesHandler,
  markReadHandler,
  preflightHandler,
  renewWatchHandler,
  sendMessageHandler,
  type AppDeps,
} from '../../src/http/handlers';
import { GMAIL_MODIFY_SCOPE } from '../../src/providers/gmail/auth';
import { BASE, buildLiveApp, CRON_SECRET, FRONTEND, JWT_SECRET, type LiveApp, type SignedInUser } from './support/app';
import { gmailError } from './support/fake-gmail';
import { brokenDb, db, liveContext, messageIds, purgeStaleRuns, rawMessage, rawUser } from './support/live';

/**
 * Every endpoint in CONTRACT.md §6 through the real handlers and live Supabase, covering
 * every HTTP status and every `error.code` its errors table names. Only Google is faked.
 */

const ctx = liveContext('api');
let app: LiveApp;

beforeAll(async () => {
  await purgeStaleRuns();
});
beforeEach(() => {
  app = buildLiveApp(ctx);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await ctx.cleanup();
});

async function expectError(res: Response, status: number, code: string, recoverable?: boolean): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toBe('application/json');
  const body: unknown = await res.json();
  expect(body).toEqual({
    error:
      recoverable === undefined
        ? { code, message: expect.any(String) }
        : { code, message: expect.any(String), details: { recoverable } },
  });
}

// ---------------------------------------------------------------------------
// §6.1 GET /api/v1/auth/google
// ---------------------------------------------------------------------------

describe('§6.1 GET /api/v1/auth/google', () => {
  it('302 to Google with the state cookie', async () => {
    const res = await authStartHandler(app.deps)(new Request(`${BASE}/api/v1/auth/google`));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.hostname).toBe('accounts.google.com');
    expect(location.searchParams.get('access_type')).toBe('offline');
    expect(location.searchParams.get('prompt')).toBe('consent');
    expect(location.searchParams.get('scope')).toContain(GMAIL_MODIFY_SCOPE);
    expect(location.searchParams.get('state')).toBe('it-state');
    expect(res.headers.get('set-cookie')).toMatch(/^oauth_state=it-state;.*HttpOnly; Secure; SameSite=Lax/);
  });

  it('500 INTERNAL_ERROR when the server is misconfigured (the real api/ route)', async () => {
    const saved = process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_ID;
    try {
      await expectError(await authStartRoute(new Request(`${BASE}/api/v1/auth/google`)), 500, 'INTERNAL_ERROR');
    } finally {
      if (saved !== undefined) process.env.GOOGLE_CLIENT_ID = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// §6.2 GET /api/v1/auth/google/callback
// ---------------------------------------------------------------------------

describe('§6.2 GET /api/v1/auth/google/callback', () => {
  const callback = (query: string, cookie = 'oauth_state=it-state') =>
    authCallbackHandler(app.deps)(new Request(`${BASE}/api/v1/auth/google/callback?${query}`, { headers: { cookie } }));

  it('302 to the frontend with a JWT; user stored, watch registered, inbox backfilled', async () => {
    const googleId = ctx.googleId('cb-ok');
    app.gmail(googleId).seed({ id: 'welcome' });
    app.nextGrant({ googleId, email: ctx.email('cb-ok') });

    const res = await callback('code=good&state=it-state');

    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith(`${FRONTEND}/inbox#token=`)).toBe(true);
    const { userId } = verifySessionToken(decodeURIComponent(location.split('#token=')[1]), JWT_SECRET);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');

    const row = await rawUser(googleId);
    expect(row.id).toBe(userId);
    expect(row.watch_expiration).not.toBeNull();
    expect(await messageIds(userId)).toEqual(['welcome']);
  });

  it.each([
    ['Google reports access_denied', 'error=access_denied&state=it-state', 'oauth_state=it-state'],
    ['the code is missing', 'state=it-state', 'oauth_state=it-state'],
    ['state does not match the cookie', 'code=x&state=forged', 'oauth_state=it-state'],
    ['there is no state cookie', 'code=x&state=it-state', ''],
  ])('400 AUTH_FAILED (recoverable) when %s', async (_label, query, cookie) => {
    await expectError(await callback(query, cookie), 400, 'AUTH_FAILED', true);
  });

  it('400 AUTH_FAILED (recoverable) for an expired or reused code (invalid_grant)', async () => {
    app.nextGrant({ googleId: ctx.googleId('cb-used'), email: ctx.email('cb-used'), error: gmailError(400, 'invalid_grant') });
    await expectError(await callback('code=used&state=it-state'), 400, 'AUTH_FAILED', true);
  });

  it('400 AUTH_FAILED (recoverable) when gmail.modify was not granted', async () => {
    app.nextGrant({ googleId: ctx.googleId('cb-scope'), email: ctx.email('cb-scope'), scope: 'openid email' });
    await expectError(await callback('code=partial&state=it-state'), 400, 'AUTH_FAILED', true);
  });

  it("502 AUTH_FAILED (not recoverable) when Google's token endpoint fails", async () => {
    app.nextGrant({ googleId: ctx.googleId('cb-down'), email: ctx.email('cb-down'), error: gmailError(500) });
    await expectError(await callback('code=x&state=it-state'), 502, 'AUTH_FAILED', false);
  });

  it('502 PROVIDER_ERROR when watch() fails after the tokens were saved', async () => {
    const googleId = ctx.googleId('cb-watch');
    app.nextGrant({ googleId, email: ctx.email('cb-watch') });
    app.failNextWatch(gmailError(500));
    await expectError(await callback('code=x&state=it-state'), 502, 'PROVIDER_ERROR');
    expect((await rawUser(googleId)).access_token_enc).toBeTruthy();
  });

  it('502 PROVIDER_ERROR when the backfill fails', async () => {
    const googleId = ctx.googleId('cb-fill');
    app.nextGrant({ googleId, email: ctx.email('cb-fill') });
    app.gmail(googleId).failNext('list', gmailError(500));
    await expectError(await callback('code=x&state=it-state'), 502, 'PROVIDER_ERROR');
  });
});

// ---------------------------------------------------------------------------
// JWT middleware, shared by §6.3–6.5
// ---------------------------------------------------------------------------

describe('JWT middleware on the authenticated routes', () => {
  const routes: Array<[string, (d: AppDeps) => (r: Request) => Promise<Response>, string, string]> = [
    ['GET /messages', listMessagesHandler, 'GET', '/api/v1/messages'],
    ['POST /messages/send', sendMessageHandler, 'POST', '/api/v1/messages/send'],
    ['PATCH /messages/:id/read', markReadHandler, 'PATCH', '/api/v1/messages/m1/read'],
  ];

  it.each(routes)('%s: 401 AUTH_FAILED (recoverable) without a token', async (_n, handler, method, path) => {
    const res = await handler(app.deps)(new Request(`${BASE}${path}`, { method }));
    await expectError(res, 401, 'AUTH_FAILED', true);
    expect(res.headers.get('access-control-allow-origin')).toBe(FRONTEND);
  });

  it.each(routes)('%s: 401 AUTH_FAILED (recoverable) with an expired token', async (_n, handler, method, path) => {
    const user = await app.signIn(`jwt-exp-${method}`);
    const expired = issueSessionToken(user.userId, JWT_SECRET, -60);
    const res = await handler(app.deps)(new Request(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${expired}` } }));
    await expectError(res, 401, 'AUTH_FAILED', true);
  });

  it.each(routes)('%s: 401 AUTH_FAILED (recoverable) with a forged token', async (_n, handler, method, path) => {
    const user = await app.signIn(`jwt-forged-${method}`);
    const forged = issueSessionToken(user.userId, 'not-the-server-secret');
    const res = await handler(app.deps)(new Request(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${forged}` } }));
    await expectError(res, 401, 'AUTH_FAILED', true);
  });

  it.each(routes)('%s: 401 AUTH_FAILED (recoverable) for a deleted user', async (_n, handler, method, path) => {
    const ghost = issueSessionToken('00000000-0000-0000-0000-000000000000', JWT_SECRET);
    const res = await handler(app.deps)(new Request(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${ghost}` } }));
    await expectError(res, 401, 'AUTH_FAILED', true);
  });

  it('answers CORS preflight for the frontend origin only', async () => {
    const res = await preflightHandler(app.deps, ['GET'])(new Request(`${BASE}/api/v1/messages`, { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(FRONTEND);
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
  });
});

// ---------------------------------------------------------------------------
// §6.3 GET /api/v1/messages
// ---------------------------------------------------------------------------

describe('§6.3 GET /api/v1/messages', () => {
  let user: SignedInUser;

  beforeEach(async () => {
    user = await app.signIn('list');
    await db.from('messages').delete().eq('user_id', user.userId);
    const gmail = app.gmail(user.googleId);
    // Five messages, two sharing a timestamp to exercise the (received_at, id) keyset tie-break.
    gmail.seed({ id: 'm1', receivedAt: '2026-09-01T00:00:00Z', labels: ['INBOX', 'UNREAD'] });
    gmail.seed({ id: 'm2', receivedAt: '2026-09-02T00:00:00Z' });
    gmail.seed({ id: 'm3a', receivedAt: '2026-09-03T00:00:00Z', labels: ['INBOX', 'UNREAD'] });
    gmail.seed({ id: 'm3b', receivedAt: '2026-09-03T00:00:00Z' });
    gmail.seed({ id: 'm4', receivedAt: '2026-09-04T00:00:00Z', labels: ['INBOX', 'UNREAD'] });
    const { mailbox, settled } = await app.deps.connect(user.googleId);
    const all = await Promise.all(['m1', 'm2', 'm3a', 'm3b', 'm4'].map((id) => mailbox.getMessage(id)));
    await app.messages.upsertMessages(user.userId, all, new Date());
    await settled();
  });

  const list = (query = '', deps: AppDeps = app.deps) =>
    listMessagesHandler(deps)(new Request(`${BASE}/api/v1/messages${query}`, { headers: user.bearer }));

  it('200 with the contract shape, newest first, only this user', async () => {
    const intruder = await app.signIn('list-other');
    app.gmail(intruder.googleId).seed({ id: 'theirs', receivedAt: '2027-01-01T00:00:00Z' });
    const { mailbox, settled } = await app.deps.connect(intruder.googleId);
    await app.messages.upsertMessages(intruder.userId, [await mailbox.getMessage('theirs')], new Date());
    await settled();

    const res = await list();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>>; nextCursor: string | null };
    expect(body.messages.map((m) => m.id)).toEqual(['m4', 'm3b', 'm3a', 'm2', 'm1']);
    expect(body.nextCursor).toBeNull();
    expect(Object.keys(body.messages[0]).sort()).toEqual(
      ['bodyHtml', 'bodyText', 'cc', 'from', 'id', 'isRead', 'receivedAt', 'snippet', 'subject', 'threadId', 'to'].sort(),
    );
    expect(body.messages[0]).toMatchObject({ isRead: false, receivedAt: '2026-09-04T00:00:00.000Z', from: 'Sender <sender@example.com>' });
  });

  it('200 pages through the live keyset with an opaque cursor, across a timestamp tie', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?limit=2&cursor=${cursor}` : '?limit=2';
      const page = (await (await list(query)).json()) as { messages: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...page.messages.map((m) => m.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(['m4', 'm3b', 'm3a', 'm2', 'm1']);
  });

  it('200 filters to unread using the generated is_read column', async () => {
    const body = (await (await list('?unreadOnly=true')).json()) as { messages: Array<{ id: string }> };
    expect(body.messages.map((m) => m.id)).toEqual(['m4', 'm3a', 'm1']);
  });

  it.each(['?limit=0', '?limit=101', '?limit=ten', '?cursor=bogus', '?unreadOnly=maybe'])(
    '400 INVALID_REQUEST for %s',
    async (query) => {
      await expectError(await list(query), 400, 'INVALID_REQUEST');
    },
  );

  it('500 INTERNAL_ERROR when Supabase rejects the query', async () => {
    const deps = { ...app.deps, messages: new SupabaseMessageStore(brokenDb()) };
    await expectError(await list('', deps), 500, 'INTERNAL_ERROR');
  });
});

// ---------------------------------------------------------------------------
// §6.4 POST /api/v1/messages/send
// ---------------------------------------------------------------------------

describe('§6.4 POST /api/v1/messages/send', () => {
  const valid = { to: ['bob@example.com'], subject: 'Hello', bodyText: 'Hi Bob' };
  const send = (user: SignedInUser, body: unknown) =>
    sendMessageHandler(app.deps)(
      new Request(`${BASE}/api/v1/messages/send`, {
        method: 'POST',
        headers: { ...user.bearer, 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );

  it('201 { id, threadId, status: "sent" } and the sent copy is stored with from_address/to_address', async () => {
    const user = await app.signIn('send-ok');
    const res = await send(user, valid);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; threadId: string; status: string };
    expect(body.status).toBe('sent');

    const raw = Buffer.from(app.gmail(user.googleId).calls.sentRaw[0], 'base64url').toString('utf8');
    expect(raw).toContain('To: bob@example.com\r\n');
    expect(raw).toContain('Subject: Hello\r\n');

    const row = await rawMessage(user.userId, body.id);
    expect(row).toMatchObject({ thread_id: body.threadId, to_address: 'bob@example.com', from_address: 'Me <me@example.com>' });
  });

  it.each([
    ['missing subject', { to: ['bob@example.com'], bodyText: 'x' }],
    ['missing body', { to: ['bob@example.com'], subject: 'x' }],
    ['missing to', { subject: 'x', bodyText: 'x' }],
    ['a malformed address', { to: ['bob'], subject: 'x', bodyText: 'x' }],
    ['invalid JSON', '{"to": ['],
  ])('400 INVALID_REQUEST for %s', async (_label, body) => {
    const user = await app.signIn('send-bad');
    await expectError(await send(user, body), 400, 'INVALID_REQUEST');
    expect(app.gmail(user.googleId).calls.sentRaw).toEqual([]);
  });

  it('401 AUTH_FAILED (not recoverable) when Gmail access was revoked', async () => {
    const user = await app.signIn('send-revoked');
    app.gmail(user.googleId).failNext('send', gmailError(400, 'invalid_grant'));
    await expectError(await send(user, valid), 401, 'AUTH_FAILED', false);
  });

  it('429 RATE_LIMITED when Gmail quota is exhausted', async () => {
    const user = await app.signIn('send-429');
    app.gmail(user.googleId).failNext('send', gmailError(429));
    await expectError(await send(user, valid), 429, 'RATE_LIMITED');
  });

  it("502 PROVIDER_ERROR when Gmail's messages.send fails", async () => {
    const user = await app.signIn('send-502');
    app.gmail(user.googleId).failNext('send', gmailError(500));
    await expectError(await send(user, valid), 502, 'PROVIDER_ERROR');
  });

  it('500 INTERNAL_ERROR when the stored token is corrupt', async () => {
    const user = await app.signIn('send-corrupt');
    const { error } = await db.from('users').update({ access_token_enc: '\\x00ff00ff' }).eq('google_id', user.googleId);
    expect(error).toBeNull();
    await expectError(await send(user, valid), 500, 'INTERNAL_ERROR');
  });
});

// ---------------------------------------------------------------------------
// §6.5 PATCH /api/v1/messages/:id/read
// ---------------------------------------------------------------------------

describe('§6.5 PATCH /api/v1/messages/:id/read', () => {
  async function userWithMessage(n: string, labels: string[]) {
    const user = await app.signIn(n);
    app.gmail(user.googleId).seed({ id: 'msg', labels });
    const { mailbox, settled } = await app.deps.connect(user.googleId);
    await app.messages.upsertMessages(user.userId, [await mailbox.getMessage('msg')], new Date());
    await settled();
    return user;
  }
  const patch = (user: SignedInUser, id: string, body?: unknown, deps: AppDeps = app.deps) =>
    markReadHandler(deps)(
      new Request(`${BASE}/api/v1/messages/${id}/read`, {
        method: 'PATCH',
        headers: user.bearer,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );

  it('200 marks read in Gmail, then in Supabase (generated is_read)', async () => {
    const user = await userWithMessage('read-ok', ['INBOX', 'UNREAD']);
    const res = await patch(user, 'msg');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'msg', isRead: true });
    expect(app.gmail(user.googleId).messages.get('msg')?.labelIds).not.toContain('UNREAD');
    expect((await rawMessage(user.userId, 'msg'))?.is_read).toBe(true);
  });

  it('200 marks unread with { "isRead": false }', async () => {
    const user = await userWithMessage('read-unread', ['INBOX']);
    const res = await patch(user, 'msg', { isRead: false });
    expect(await res.json()).toEqual({ id: 'msg', isRead: false });
    expect((await rawMessage(user.userId, 'msg'))?.is_read).toBe(false);
  });

  it('404 NOT_FOUND for an unknown id', async () => {
    const user = await userWithMessage('read-404', ['INBOX']);
    await expectError(await patch(user, 'nope'), 404, 'NOT_FOUND');
  });

  it("404 NOT_FOUND for another user's message, which stays untouched", async () => {
    const owner = await userWithMessage('read-owner', ['INBOX', 'UNREAD']);
    const other = await app.signIn('read-other');
    await expectError(await patch(other, 'msg'), 404, 'NOT_FOUND');
    expect((await rawMessage(owner.userId, 'msg'))?.is_read).toBe(false);
  });

  it('400 INVALID_REQUEST when isRead is not a boolean', async () => {
    const user = await userWithMessage('read-400', ['INBOX']);
    await expectError(await patch(user, 'msg', { isRead: 'yes' }), 400, 'INVALID_REQUEST');
  });

  it("502 PROVIDER_ERROR when Gmail's messages.modify fails, and the row is not updated", async () => {
    const user = await userWithMessage('read-502', ['INBOX', 'UNREAD']);
    app.gmail(user.googleId).failNext('modify', gmailError(500));
    await expectError(await patch(user, 'msg'), 502, 'PROVIDER_ERROR');
    expect((await rawMessage(user.userId, 'msg'))?.is_read).toBe(false);
  });

  it('500 INTERNAL_ERROR when Supabase rejects the lookup', async () => {
    const user = await userWithMessage('read-500', ['INBOX']);
    const deps = { ...app.deps, messages: new SupabaseMessageStore(brokenDb()) };
    await expectError(await patch(user, 'msg', undefined, deps), 500, 'INTERNAL_ERROR');
  });
});

// ---------------------------------------------------------------------------
// §6.7 GET /api/cron/renew-watch  (§6.6 is covered in webhook.int.test.ts)
// ---------------------------------------------------------------------------

describe('§6.7 GET /api/cron/renew-watch', () => {
  const cron = (auth?: string, deps: AppDeps = app.deps) =>
    renewWatchHandler(deps)(new Request(`${BASE}/api/cron/renew-watch`, { headers: auth ? { Authorization: auth } : {} }));

  it('200 renews only this run’s users that are due, without touching last_history_id', async () => {
    const due = await app.signIn('cron-due');
    const fresh = await app.signIn('cron-fresh');
    const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
    await db.from('users').update({ watch_expiration: soon }).eq('google_id', due.googleId);
    const beforeDue = await rawUser(due.googleId);
    const beforeFresh = await rawUser(fresh.googleId);

    // Scope the run to this test's two users: other rows in the dev database (including
    // other tests' users, e.g. one whose watch failed at sign-in) aren't this test's to renew.
    const mine = new Set([due.googleId, fresh.googleId]);
    const scoped: AppDeps = {
      ...app.deps,
      users: Object.assign(Object.create(app.users) as SupabaseUserStore, {
        findUsersWithWatchDue: async (cutoff: Date) =>
          (await app.users.findUsersWithWatchDue(cutoff)).filter((u) => mine.has(u.googleId)),
      }),
    };
    const res = await cron(`Bearer ${CRON_SECRET}`, scoped);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ renewed: 1, skippedAuthRevoked: 0, failed: 0 });
    const afterDue = await rawUser(due.googleId);
    expect(new Date(String(afterDue.watch_expiration)).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3_600_000);
    expect(afterDue.last_history_id).toBe(beforeDue.last_history_id);
    expect((await rawUser(fresh.googleId)).watch_expiration).toBe(beforeFresh.watch_expiration);
  });

  it.each([undefined, 'Bearer wrong', CRON_SECRET])('401 UNAUTHORIZED for Authorization %p', async (auth) => {
    await expectError(await cron(auth), 401, 'UNAUTHORIZED');
  });

  it('500 INTERNAL_ERROR when the user list cannot be read', async () => {
    const deps = { ...app.deps, users: new SupabaseUserStore(brokenDb()) };
    await expectError(await cron(`Bearer ${CRON_SECRET}`, deps), 500, 'INTERNAL_ERROR');
  });
});
