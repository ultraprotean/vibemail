import { randomBytes } from 'node:crypto';
import { issueSessionToken } from '../auth/jwt';
import type { MessageStore, MessageSummary } from '../db/message-store';
import type { UserStore } from '../db/user-store';
import type { CompletedAuthorization } from '../providers/gmail/auth';
import { PostConsentSetupError } from '../providers/gmail/auth';
import { setMessageReadState } from '../read-state';
import { parseSendRequest, sendAndStore } from '../send';
import { runInitialSync } from '../sync';
import { ProviderError, type MailboxClient } from '../types/provider';
import { handleGmailWebhook, processGmailNotification, tokensMatch } from '../webhook/gmail';
import { clearStateCookie, OAUTH_STATE_COOKIE, readCookie, stateCookie } from './cookies';
import { corsHeaders, preflightResponse } from './cors';
import { decodeCursor, encodeCursor } from './cursor';
import { authFailed, errorResponse, handleErrors, InvalidRequestError, jsonResponse } from './responses';
import { withAuth } from './session';

/**
 * Route handlers for CONTRACT.md §6, as Web-standard `(Request) => Promise<Response>`
 * functions. The files under `api/` only bind these to production dependencies.
 */

export type AppMailbox = Pick<
  MailboxClient,
  'listMessages' | 'getMessage' | 'listChangesSince' | 'getCurrentCursor' | 'sendMessage' | 'setReadState'
>;

export interface AppDeps {
  jwtSecret: string;
  frontendUrl: string;
  pubsubVerificationToken: string;
  users: UserStore;
  messages: MessageStore;
  auth: {
    buildAuthUrl(state: string): string;
    completeAuthorization(code: string): Promise<CompletedAuthorization>;
  };
  /** An authorized mailbox for one user; `settled` waits for refreshed-token writes. */
  connect(googleId: string): Promise<{ mailbox: AppMailbox; settled(): Promise<void> }>;
  /** Keeps work alive after the response (Vercel: `waitUntil`). */
  defer(work: Promise<void>): void;
  randomState?: () => string;
}

type Handler = (request: Request) => Promise<Response>;

const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;

/** Token writes that fail after the response is decided are logged, not surfaced. */
async function settleQuietly(settled: () => Promise<void>): Promise<void> {
  try {
    await settled();
  } catch (err) {
    console.error('Refreshed Gmail tokens could not be saved', err);
  }
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidRequestError('Request body must be valid JSON');
  }
}

// ---------------------------------------------------------------------------
// §6.1 GET /api/v1/auth/google
// ---------------------------------------------------------------------------

export function authStartHandler(deps: AppDeps): Handler {
  const randomState = deps.randomState ?? (() => randomBytes(32).toString('base64url'));
  return async () =>
    handleErrors(async () => {
      const state = randomState();
      return new Response(null, {
        status: 302,
        headers: { Location: deps.auth.buildAuthUrl(state), 'Set-Cookie': stateCookie(state) },
      });
    });
}

// ---------------------------------------------------------------------------
// §6.2 GET /api/v1/auth/google/callback
// ---------------------------------------------------------------------------

export function authCallbackHandler(deps: AppDeps): Handler {
  return async (request) => {
    const clear = { 'Set-Cookie': clearStateCookie() };
    const params = new URL(request.url).searchParams;

    const googleError = params.get('error');
    if (googleError) {
      return authFailed(400, `Google sign-in did not complete: ${googleError}`, true, clear);
    }
    const code = params.get('code');
    const state = params.get('state');
    const expected = readCookie(request.headers.get('cookie'), OAUTH_STATE_COOKIE);
    if (!code) return authFailed(400, 'Missing authorization code', true, clear);
    if (!state || !expected || !tokensMatch(state, expected)) {
      return authFailed(400, 'Sign-in state did not match; start sign-in again', true, clear);
    }

    let completed: CompletedAuthorization;
    try {
      completed = await deps.auth.completeAuthorization(code);
    } catch (err) {
      // A token-endpoint failure (not a watch failure after tokens were saved) is not
      // recoverable by retrying the flow: §6.2 502 AUTH_FAILED, recoverable false.
      if (err instanceof ProviderError && err.kind === 'UPSTREAM' && !(err instanceof PostConsentSetupError)) {
        return authFailed(502, 'Google token exchange failed', false, clear);
      }
      return handleErrors(() => Promise.reject(err), clear);
    }

    return handleErrors(async () => {
      // §6.2 step 4: initial backfill. Failures here are 502 PROVIDER_ERROR; retrying the
      // flow repeats every step safely.
      const { mailbox, settled } = await deps.connect(completed.googleId);
      try {
        await runInitialSync(completed.userId, { mailbox, store: deps.messages });
      } catch (err) {
        if (err instanceof ProviderError && err.kind !== 'AUTH_REVOKED' && err.kind !== 'RATE_LIMITED') {
          throw new PostConsentSetupError(`Initial sync failed: ${err.message}`, err);
        }
        throw err;
      } finally {
        await settleQuietly(settled);
      }

      // §6.2 step 5: the JWT travels in the URL fragment, which browsers never send to a server.
      const token = issueSessionToken(completed.userId, deps.jwtSecret);
      return new Response(null, {
        status: 302,
        headers: { Location: `${deps.frontendUrl}/inbox#token=${encodeURIComponent(token)}`, ...clear },
      });
    }, clear);
  };
}

// ---------------------------------------------------------------------------
// §6.3 GET /api/v1/messages
// ---------------------------------------------------------------------------

function parseLimit(raw: string | null): number {
  if (raw === null) return LIST_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw)) throw new InvalidRequestError('limit must be a whole number');
  const limit = Number(raw);
  if (limit < 1 || limit > LIST_MAX_LIMIT) throw new InvalidRequestError(`limit must be between 1 and ${LIST_MAX_LIMIT}`);
  return limit;
}

function parseBoolean(name: string, raw: string | null): boolean {
  if (raw === null) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new InvalidRequestError(`${name} must be true or false`);
}

function toApiMessage(m: MessageSummary): Record<string, unknown> {
  return {
    id: m.id,
    threadId: m.threadId,
    subject: m.subject,
    from: m.from,
    to: m.to,
    cc: m.cc,
    snippet: m.snippet,
    bodyText: m.bodyText,
    bodyHtml: m.bodyHtml,
    isRead: m.isRead,
    receivedAt: m.receivedAt.toISOString(),
  };
}

export function listMessagesHandler(deps: AppDeps): Handler {
  const cors = corsHeaders(deps.frontendUrl);
  const authed = withAuth({ jwtSecret: deps.jwtSecret, users: deps.users }, async (request, user) => {
    const params = new URL(request.url).searchParams;
    const limit = parseLimit(params.get('limit'));
    const unreadOnly = parseBoolean('unreadOnly', params.get('unreadOnly'));
    const cursor = params.get('cursor');
    const after = cursor ? decodeCursor(cursor) : undefined;

    // One extra row tells us whether another page exists.
    const rows = await deps.messages.listMessages(user.userId, { limit: limit + 1, after, unreadOnly });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? encodeCursor({ receivedAt: last.receivedAt, id: last.id }) : null;

    return jsonResponse(200, { messages: page.map(toApiMessage), nextCursor }, cors);
  });
  return (request) => handleErrors(() => authed(request), cors);
}

// ---------------------------------------------------------------------------
// §6.4 POST /api/v1/messages/send
// ---------------------------------------------------------------------------

export function sendMessageHandler(deps: AppDeps): Handler {
  const cors = corsHeaders(deps.frontendUrl);
  const authed = withAuth({ jwtSecret: deps.jwtSecret, users: deps.users }, async (request, user) => {
    const input = parseSendRequest(await readJson(request));
    const { mailbox, settled } = await deps.connect(user.googleId);
    try {
      const sent = await sendAndStore(user.userId, input, { mailbox, store: deps.messages });
      return jsonResponse(201, { id: sent.id, threadId: sent.threadId, status: sent.status }, cors);
    } finally {
      await settleQuietly(settled);
    }
  });
  return (request) => handleErrors(() => authed(request), cors);
}

// ---------------------------------------------------------------------------
// §6.5 PATCH /api/v1/messages/:id/read
// ---------------------------------------------------------------------------

/** The `:id` segment of `/api/v1/messages/:id/read`. */
export function messageIdFromPath(url: string): string {
  const match = /\/messages\/([^/]+)\/read\/?$/.exec(new URL(url).pathname);
  const id = match ? decodeURIComponent(match[1]) : '';
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new InvalidRequestError('Message id is invalid');
  return id;
}

function parseReadBody(body: unknown): boolean {
  if (body === undefined) return true;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidRequestError('Request body must be a JSON object');
  }
  if (!('isRead' in body)) return true;
  if (typeof body.isRead !== 'boolean') throw new InvalidRequestError('isRead must be true or false');
  return body.isRead;
}

export function markReadHandler(deps: AppDeps): Handler {
  const cors = corsHeaders(deps.frontendUrl);
  const authed = withAuth({ jwtSecret: deps.jwtSecret, users: deps.users }, async (request, user) => {
    const id = messageIdFromPath(request.url);
    const isRead = parseReadBody(await readJson(request));
    const { mailbox, settled } = await deps.connect(user.googleId);
    try {
      const result = await setMessageReadState(user.userId, id, isRead, { mailbox, store: deps.messages });
      return jsonResponse(200, result, cors);
    } finally {
      await settleQuietly(settled);
    }
  });
  return (request) => handleErrors(() => authed(request), cors);
}

// ---------------------------------------------------------------------------
// §6.6 POST /webhook/gmail
// ---------------------------------------------------------------------------

export function gmailWebhookHandler(deps: AppDeps): Handler {
  return async (request) =>
    handleErrors(async () => {
      let body: unknown;
      try {
        body = await readJson(request);
      } catch {
        body = undefined; // Unparseable JSON is a malformed envelope: acknowledged with 204.
      }
      const response = handleGmailWebhook(
        { token: new URL(request.url).searchParams.get('token') ?? undefined, body },
        {
          verificationToken: deps.pubsubVerificationToken,
          defer: deps.defer,
          process: (notification) =>
            processGmailNotification(notification, {
              users: deps.users,
              messages: deps.messages,
              connect: (user) => deps.connect(user.googleId),
            }),
        },
      );
      return response.body
        ? errorResponse(response.status, response.body.error.code, response.body.error.message)
        : new Response(null, { status: response.status });
    });
}

// ---------------------------------------------------------------------------
// CORS preflight
// ---------------------------------------------------------------------------

export function preflightHandler(deps: Pick<AppDeps, 'frontendUrl'>, methods: string[]): Handler {
  return async () => preflightResponse(deps.frontendUrl, methods);
}
