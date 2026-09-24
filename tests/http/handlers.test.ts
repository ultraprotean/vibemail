import { randomBytes } from 'node:crypto';
import { issueSessionToken, verifySessionToken } from '../../src/auth/jwt';
import {
  authCallbackHandler,
  authStartHandler,
  gmailWebhookHandler,
  listMessagesHandler,
  markReadHandler,
  messageIdFromPath,
  preflightHandler,
  sendMessageHandler,
  type AppDeps,
  type AppMailbox,
} from '../../src/http/handlers';
import { PostConsentSetupError, type CompletedAuthorization } from '../../src/providers/gmail/auth';
import { ProviderError, type ProviderMessage } from '../../src/types/provider';
import { MemoryMessageStore } from '../helpers/memory-message-store';
import { MemoryUserStore } from '../helpers/memory-user-store';

const SECRET = 'jwt-secret';
const FRONTEND = 'http://localhost:3001';
const BASE = 'http://localhost:3000';

function message(id: string, receivedAt: string, labels: string[] = ['INBOX']): ProviderMessage {
  return {
    id,
    threadId: `t-${id}`,
    subject: `Subject ${id}`,
    from: 'a@example.com',
    to: 'me@example.com',
    cc: null,
    snippet: 'snippet',
    bodyText: 'text',
    bodyHtml: null,
    labels,
    isRead: !labels.includes('UNREAD'),
    receivedAt: new Date(receivedAt),
    cursor: '1',
  };
}

async function setup() {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'info').mockImplementation(() => undefined);

  const users = new MemoryUserStore();
  const messages = new MemoryMessageStore();
  const { userId } = await users.upsertUserTokens({
    googleId: 'google-1',
    email: 'me@example.com',
    accessTokenEnc: randomBytes(40),
    refreshTokenEnc: randomBytes(40),
    tokenExpiresAt: new Date(),
  });
  await users.saveWatch('google-1', { lastHistoryId: '100', watchExpiry: new Date() });

  const gmail = new Map<string, ProviderMessage>();
  const mailbox = {
    listMessages: jest.fn(async () => ({ messages: [...gmail.values()], nextPageCursor: null })),
    getMessage: jest.fn(async (id: string) => {
      const found = gmail.get(id);
      if (!found) throw new ProviderError('NOT_FOUND', id);
      return found;
    }),
    listChangesSince: jest.fn(async () => ({ changes: [], cursor: '100' })),
    getCurrentCursor: jest.fn(async () => '100'),
    sendMessage: jest.fn(async () => {
      gmail.set('sent-1', message('sent-1', '2026-09-24T10:00:00Z', ['SENT']));
      return { id: 'sent-1', threadId: 't-sent-1' };
    }),
    setReadState: jest.fn(async (_id: string, isRead: boolean) => ({
      labels: isRead ? ['INBOX'] : ['INBOX', 'UNREAD'],
    })),
  } satisfies AppMailbox;

  const settled = jest.fn(async () => undefined);
  const deferred: Array<Promise<void>> = [];
  const auth = {
    buildAuthUrl: jest.fn((state: string) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
    completeAuthorization: jest.fn(
      async (): Promise<CompletedAuthorization> => ({
        userId,
        googleId: 'google-1',
        email: 'me@example.com',
        watch: { cursor: '100', expiresAt: new Date() },
      }),
    ),
  };
  const deps: AppDeps = {
    jwtSecret: SECRET,
    frontendUrl: FRONTEND,
    pubsubVerificationToken: 'pubsub-token',
    users,
    messages,
    auth,
    connect: jest.fn(async () => ({ mailbox, settled })),
    defer: (work) => deferred.push(work),
    randomState: () => 'state-123',
  };
  const bearer = { Authorization: `Bearer ${issueSessionToken(userId, SECRET)}` };
  return { deps, users, messages, userId, gmail, mailbox, auth, settled, deferred, bearer };
}

afterEach(() => jest.restoreAllMocks());

async function expectEnvelope(res: Response, status: number, code: string, details?: object): Promise<void> {
  expect(res.status).toBe(status);
  const body: unknown = await res.json();
  expect(body).toEqual({
    error: details ? { code, message: expect.any(String), details } : { code, message: expect.any(String) },
  });
}

// ---------------------------------------------------------------------------
// JWT middleware (all three authenticated routes)
// ---------------------------------------------------------------------------

describe('JWT middleware', () => {
  const routes: Array<[string, (deps: AppDeps) => (r: Request) => Promise<Response>, string, string]> = [
    ['GET /messages', listMessagesHandler, 'GET', `${BASE}/api/v1/messages`],
    ['POST /messages/send', sendMessageHandler, 'POST', `${BASE}/api/v1/messages/send`],
    ['PATCH /messages/:id/read', markReadHandler, 'PATCH', `${BASE}/api/v1/messages/m1/read`],
  ];

  it.each(routes)('%s rejects a missing token with AUTH_FAILED recoverable', async (_n, factory, method, url) => {
    const { deps } = await setup();
    const res = await factory(deps)(new Request(url, { method }));
    await expectEnvelope(res, 401, 'AUTH_FAILED', { recoverable: true });
    expect(res.headers.get('access-control-allow-origin')).toBe(FRONTEND);
  });

  it.each(routes)('%s rejects an expired token', async (_n, factory, method, url) => {
    const { deps, userId } = await setup();
    const expired = issueSessionToken(userId, SECRET, -10);
    const res = await factory(deps)(new Request(url, { method, headers: { Authorization: `Bearer ${expired}` } }));
    await expectEnvelope(res, 401, 'AUTH_FAILED', { recoverable: true });
  });

  it.each(routes)('%s rejects a token for a user that no longer exists', async (_n, factory, method, url) => {
    const { deps } = await setup();
    const ghost = issueSessionToken('deleted-user', SECRET);
    const res = await factory(deps)(new Request(url, { method, headers: { Authorization: `Bearer ${ghost}` } }));
    await expectEnvelope(res, 401, 'AUTH_FAILED', { recoverable: true });
  });

  it('reports a dead Gmail refresh token as AUTH_FAILED not recoverable', async () => {
    const { deps, bearer } = await setup();
    deps.connect = jest.fn(async () => {
      throw new ProviderError('AUTH_REVOKED', 'dead');
    });
    const res = await markReadHandler(deps)(new Request(`${BASE}/api/v1/messages/m1/read`, { method: 'PATCH', headers: bearer }));
    await expectEnvelope(res, 401, 'AUTH_FAILED', { recoverable: false });
  });
});

// ---------------------------------------------------------------------------
// §6.1 and §6.2
// ---------------------------------------------------------------------------

describe('GET /api/v1/auth/google', () => {
  it('redirects to Google and sets the state cookie', async () => {
    const { deps, auth } = await setup();
    const res = await authStartHandler(deps)(new Request(`${BASE}/api/v1/auth/google`));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('state=state-123');
    expect(res.headers.get('set-cookie')).toContain('oauth_state=state-123');
    expect(auth.buildAuthUrl).toHaveBeenCalledWith('state-123');
  });
});

describe('GET /api/v1/auth/google/callback', () => {
  const callback = (query: string, cookie = 'oauth_state=state-123') =>
    new Request(`${BASE}/api/v1/auth/google/callback?${query}`, { headers: { cookie } });

  it('completes sign-in, backfills, and redirects with a JWT in the fragment', async () => {
    const { deps, messages, userId, gmail, auth } = await setup();
    gmail.set('m1', message('m1', '2026-09-20T10:00:00Z'));

    const res = await authCallbackHandler(deps)(callback('code=abc&state=state-123'));

    expect(res.status).toBe(302);
    expect(auth.completeAuthorization).toHaveBeenCalledWith('abc');
    expect(messages.idsFor(userId)).toEqual(['m1']);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith(`${FRONTEND}/inbox#token=`)).toBe(true);
    const token = decodeURIComponent(location.split('#token=')[1]);
    expect(verifySessionToken(token, SECRET)).toEqual({ userId });
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it.each([
    ['a Google error', 'error=access_denied', 'oauth_state=state-123'],
    ['a missing code', 'state=state-123', 'oauth_state=state-123'],
    ['a state mismatch', 'code=abc&state=other', 'oauth_state=state-123'],
    ['a missing state cookie', 'code=abc&state=state-123', ''],
  ])('rejects %s with 400 AUTH_FAILED recoverable', async (_label, query, cookie) => {
    const { deps, auth } = await setup();
    const res = await authCallbackHandler(deps)(callback(query, cookie));
    await expectEnvelope(res, 400, 'AUTH_FAILED', { recoverable: true });
    expect(auth.completeAuthorization).not.toHaveBeenCalled();
  });

  it('maps an invalid code to 400 AUTH_FAILED recoverable', async () => {
    const { deps, auth } = await setup();
    auth.completeAuthorization.mockRejectedValueOnce(new ProviderError('AUTH_CODE_INVALID', 'used'));
    await expectEnvelope(await authCallbackHandler(deps)(callback('code=abc&state=state-123')), 400, 'AUTH_FAILED', {
      recoverable: true,
    });
  });

  it('maps a token-endpoint failure to 502 AUTH_FAILED not recoverable', async () => {
    const { deps, auth } = await setup();
    auth.completeAuthorization.mockRejectedValueOnce(new ProviderError('UPSTREAM', 'google down'));
    await expectEnvelope(await authCallbackHandler(deps)(callback('code=abc&state=state-123')), 502, 'AUTH_FAILED', {
      recoverable: false,
    });
  });

  it('maps a watch failure after tokens were saved to 502 PROVIDER_ERROR', async () => {
    const { deps, auth } = await setup();
    auth.completeAuthorization.mockRejectedValueOnce(new PostConsentSetupError('watch failed'));
    await expectEnvelope(await authCallbackHandler(deps)(callback('code=abc&state=state-123')), 502, 'PROVIDER_ERROR');
  });

  it('maps a backfill failure to 502 PROVIDER_ERROR', async () => {
    const { deps, mailbox } = await setup();
    mailbox.listMessages.mockRejectedValueOnce(new ProviderError('UPSTREAM', 'gmail down'));
    await expectEnvelope(await authCallbackHandler(deps)(callback('code=abc&state=state-123')), 502, 'PROVIDER_ERROR');
  });
});

// ---------------------------------------------------------------------------
// §6.3 GET /messages
// ---------------------------------------------------------------------------

describe('GET /api/v1/messages', () => {
  async function seeded() {
    const ctx = await setup();
    const rows = Array.from({ length: 5 }, (_, i) =>
      message(`m${i}`, `2026-09-2${i}T10:00:00Z`, i % 2 === 0 ? ['INBOX', 'UNREAD'] : ['INBOX']),
    );
    await ctx.messages.upsertMessages(ctx.userId, rows, new Date());
    // Another user's message must never appear.
    await ctx.messages.upsertMessages('someone-else', [message('theirs', '2026-09-29T10:00:00Z')], new Date());
    return ctx;
  }

  const list = (deps: AppDeps, bearer: Record<string, string>, query = '') =>
    listMessagesHandler(deps)(new Request(`${BASE}/api/v1/messages${query}`, { headers: bearer }));

  it('returns the contract shape, newest first, only for this user', async () => {
    const { deps, bearer } = await seeded();
    const res = await list(deps, bearer);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(FRONTEND);
    const body = (await res.json()) as { messages: Array<Record<string, unknown>>; nextCursor: string | null };
    expect(body.messages.map((m) => m.id)).toEqual(['m4', 'm3', 'm2', 'm1', 'm0']);
    expect(body.nextCursor).toBeNull();
    expect(body.messages[0]).toEqual({
      id: 'm4',
      threadId: 't-m4',
      subject: 'Subject m4',
      from: 'a@example.com',
      to: 'me@example.com',
      cc: null,
      snippet: 'snippet',
      bodyText: 'text',
      bodyHtml: null,
      isRead: false,
      receivedAt: '2026-09-24T10:00:00.000Z',
    });
  });

  it('pages with an opaque cursor', async () => {
    const { deps, bearer } = await seeded();
    const first = (await (await list(deps, bearer, '?limit=2')).json()) as { messages: Array<{ id: string }>; nextCursor: string };
    expect(first.messages.map((m) => m.id)).toEqual(['m4', 'm3']);
    const second = (await (await list(deps, bearer, `?limit=2&cursor=${first.nextCursor}`)).json()) as {
      messages: Array<{ id: string }>;
      nextCursor: string;
    };
    expect(second.messages.map((m) => m.id)).toEqual(['m2', 'm1']);
    const third = (await (await list(deps, bearer, `?limit=2&cursor=${second.nextCursor}`)).json()) as {
      messages: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(third.messages.map((m) => m.id)).toEqual(['m0']);
    expect(third.nextCursor).toBeNull();
  });

  it('filters to unread messages', async () => {
    const { deps, bearer } = await seeded();
    const body = (await (await list(deps, bearer, '?unreadOnly=true')).json()) as { messages: Array<{ id: string }> };
    expect(body.messages.map((m) => m.id)).toEqual(['m4', 'm2', 'm0']);
  });

  it.each(['?limit=0', '?limit=101', '?limit=abc', '?cursor=garbage', '?unreadOnly=yes'])(
    'rejects %s with 400 INVALID_REQUEST',
    async (query) => {
      const { deps, bearer } = await seeded();
      await expectEnvelope(await list(deps, bearer, query), 400, 'INVALID_REQUEST');
    },
  );
});

// ---------------------------------------------------------------------------
// §6.4 POST /messages/send
// ---------------------------------------------------------------------------

describe('POST /api/v1/messages/send', () => {
  const send = (deps: AppDeps, bearer: Record<string, string>, body: string) =>
    sendMessageHandler(deps)(
      new Request(`${BASE}/api/v1/messages/send`, {
        method: 'POST',
        headers: { ...bearer, 'Content-Type': 'application/json' },
        body,
      }),
    );

  it('sends and returns 201 with the contract body', async () => {
    const { deps, bearer, messages, userId, settled } = await setup();
    const res = await send(deps, bearer, JSON.stringify({ to: ['bob@example.com'], subject: 'Hi', bodyText: 'Hello' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 'sent-1', threadId: 't-sent-1', status: 'sent' });
    expect(messages.idsFor(userId)).toEqual(['sent-1']);
    expect(settled).toHaveBeenCalled();
  });

  it('rejects invalid JSON and missing fields with 400 INVALID_REQUEST', async () => {
    const { deps, bearer, mailbox } = await setup();
    await expectEnvelope(await send(deps, bearer, '{not json'), 400, 'INVALID_REQUEST');
    await expectEnvelope(await send(deps, bearer, JSON.stringify({ to: ['bob@example.com'] })), 400, 'INVALID_REQUEST');
    expect(mailbox.sendMessage).not.toHaveBeenCalled();
  });

  it('maps a Gmail quota error to 429 and a Gmail failure to 502', async () => {
    const { deps, bearer, mailbox } = await setup();
    const body = JSON.stringify({ to: ['bob@example.com'], subject: 'Hi', bodyText: 'Hello' });
    mailbox.sendMessage.mockRejectedValueOnce(new ProviderError('RATE_LIMITED', 'quota'));
    await expectEnvelope(await send(deps, bearer, body), 429, 'RATE_LIMITED');
    mailbox.sendMessage.mockRejectedValueOnce(new ProviderError('UPSTREAM', 'boom'));
    await expectEnvelope(await send(deps, bearer, body), 502, 'PROVIDER_ERROR');
  });
});

// ---------------------------------------------------------------------------
// §6.5 PATCH /messages/:id/read
// ---------------------------------------------------------------------------

describe('PATCH /api/v1/messages/:id/read', () => {
  const patch = (deps: AppDeps, bearer: Record<string, string>, id: string, body?: string) =>
    markReadHandler(deps)(new Request(`${BASE}/api/v1/messages/${id}/read`, { method: 'PATCH', headers: bearer, body }));

  it('marks read with no body', async () => {
    const { deps, bearer, messages, userId } = await setup();
    await messages.upsertMessages(userId, [message('m1', '2026-09-20T10:00:00Z', ['INBOX', 'UNREAD'])], new Date());
    const res = await patch(deps, bearer, 'm1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'm1', isRead: true });
    expect(messages.rows.get(`${userId}/m1`)?.isRead).toBe(true);
  });

  it('marks unread with { "isRead": false }', async () => {
    const { deps, bearer, messages, userId, mailbox } = await setup();
    await messages.upsertMessages(userId, [message('m1', '2026-09-20T10:00:00Z')], new Date());
    const res = await patch(deps, bearer, 'm1', JSON.stringify({ isRead: false }));
    expect(await res.json()).toEqual({ id: 'm1', isRead: false });
    expect(mailbox.setReadState).toHaveBeenCalledWith('m1', false);
  });

  it("returns 404 for an unknown id or another user's message", async () => {
    const { deps, bearer, messages } = await setup();
    await messages.upsertMessages('someone-else', [message('theirs', '2026-09-20T10:00:00Z')], new Date());
    await expectEnvelope(await patch(deps, bearer, 'nope'), 404, 'NOT_FOUND');
    await expectEnvelope(await patch(deps, bearer, 'theirs'), 404, 'NOT_FOUND');
  });

  it('returns 502 and leaves the row unchanged when Gmail fails', async () => {
    const { deps, bearer, messages, userId, mailbox } = await setup();
    await messages.upsertMessages(userId, [message('m1', '2026-09-20T10:00:00Z', ['INBOX', 'UNREAD'])], new Date());
    mailbox.setReadState.mockRejectedValueOnce(new ProviderError('UPSTREAM', 'boom'));
    await expectEnvelope(await patch(deps, bearer, 'm1'), 502, 'PROVIDER_ERROR');
    expect(messages.rows.get(`${userId}/m1`)?.isRead).toBe(false);
  });

  it('rejects a non-boolean isRead', async () => {
    const { deps, bearer } = await setup();
    await expectEnvelope(await patch(deps, bearer, 'm1', JSON.stringify({ isRead: 'yes' })), 400, 'INVALID_REQUEST');
  });
});

describe('messageIdFromPath', () => {
  it('reads the id segment', () => {
    expect(messageIdFromPath(`${BASE}/api/v1/messages/18c2f0a1b2/read`)).toBe('18c2f0a1b2');
  });

  it('rejects odd ids', () => {
    expect(() => messageIdFromPath(`${BASE}/api/v1/messages/a%2Cb/read`)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// §6.6 POST /webhook/gmail
// ---------------------------------------------------------------------------

describe('POST /webhook/gmail', () => {
  const push = (deps: AppDeps, token: string, body: string) =>
    gmailWebhookHandler(deps)(new Request(`${BASE}/webhook/gmail?token=${token}`, { method: 'POST', body }));
  const envelope = JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress: 'me@example.com', historyId: '150' })).toString('base64'),
      messageId: 'p1',
    },
  });

  it('acknowledges with 200 and runs the sync in the background', async () => {
    const { deps, deferred, mailbox } = await setup();
    const res = await push(deps, 'pubsub-token', envelope);
    expect(res.status).toBe(200);
    expect(deferred).toHaveLength(1);
    await deferred[0];
    expect(mailbox.listChangesSince).toHaveBeenCalledWith('100');
  });

  it('rejects a wrong token with 401 UNAUTHORIZED', async () => {
    const { deps } = await setup();
    await expectEnvelope(await push(deps, 'wrong', envelope), 401, 'UNAUTHORIZED');
  });

  it('acknowledges unparseable bodies with 204', async () => {
    const { deps, deferred } = await setup();
    expect((await push(deps, 'pubsub-token', '{broken')).status).toBe(204);
    expect(deferred).toHaveLength(0);
  });
});

describe('OPTIONS preflight', () => {
  it('allows only the frontend origin with Authorization', async () => {
    const res = await preflightHandler({ frontendUrl: FRONTEND }, ['GET'])(new Request(`${BASE}/api/v1/messages`, { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(FRONTEND);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toContain('Authorization');
  });
});
