import { randomBytes } from 'node:crypto';
import { google, type Auth } from 'googleapis';
import { issueSessionToken } from '../../../src/auth/jwt';
import { createTokenCipher, type TokenCipher } from '../../../src/crypto/tokens';
import { SupabaseMessageStore } from '../../../src/db/supabase-message-store';
import { SupabaseUserStore } from '../../../src/db/supabase-user-store';
import type { AppDeps } from '../../../src/http/handlers';
import { GMAIL_MODIFY_SCOPE, GmailAuth, type GmailAuthConfig, type WatchCall } from '../../../src/providers/gmail/auth';
import { connectGmailMailbox } from '../../../src/providers/gmail/mailbox';
import { FakeGmail, gmailError } from './fake-gmail';
import { db, type LiveContext } from './live';

/**
 * The production app, wired to live Supabase and real GmailAuth/encryption, with only
 * Google's endpoints faked: the OAuth2 client's network calls and the Gmail API.
 */

type OAuth2Client = Auth.OAuth2Client;

export const JWT_SECRET = `it-jwt-${randomBytes(8).toString('hex')}`;
export const FRONTEND = 'http://localhost:3001';
export const BASE = 'http://localhost:3000';
export const PUBSUB_TOKEN = 'it-pubsub-token';
export const CRON_SECRET = 'it-cron-secret';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const googleConfig: GmailAuthConfig = {
  clientId: 'it-client-id',
  clientSecret: 'it-client-secret',
  redirectUri: `${BASE}/api/v1/auth/google/callback`,
  pubsubTopic: 'projects/it/topics/gmail',
};

/** What Google's token endpoint returns for the next code exchange. */
export interface NextGrant {
  googleId: string;
  email: string;
  refreshToken?: string | null;
  scope?: string;
  error?: Error;
}

export interface LiveApp {
  deps: AppDeps;
  auth: GmailAuth;
  cipher: TokenCipher;
  users: SupabaseUserStore;
  messages: SupabaseMessageStore;
  deferred: Array<Promise<void>>;
  /** Each user's Gmail, by google_id. */
  gmail(googleId: string): FakeGmail;
  nextGrant(grant: NextGrant): void;
  /** Make the next `users.watch` fail with this error. */
  failNextWatch(error: Error): void;
  /** Make the next access-token refresh fail with this error. */
  failNextRefresh(error: Error): void;
  /** Clients created so far (for emitting token events). */
  clients: OAuth2Client[];
  /** Sign a user in through the real callback path's service layer. */
  signIn(n: number | string): Promise<SignedInUser>;
}

export interface SignedInUser {
  userId: string;
  googleId: string;
  email: string;
  bearer: { Authorization: string };
}

export function buildLiveApp(ctx: LiveContext, overrides: Partial<AppDeps> = {}): LiveApp {
  const users = new SupabaseUserStore(db);
  const messages = new SupabaseMessageStore(db);
  const cipher = createTokenCipher(randomBytes(32));
  const mailboxes = new Map<string, FakeGmail>();
  const gmail = (googleId: string): FakeGmail => {
    let box = mailboxes.get(googleId);
    if (!box) {
      box = new FakeGmail();
      mailboxes.set(googleId, box);
    }
    return box;
  };

  let grant: NextGrant | null = null;
  let watchFailure: Error | null = null;
  let refreshFailure: Error | null = null;
  const clients: OAuth2Client[] = [];

  /** Tokens embed the google_id, so a client can be traced back to its user. */
  const googleIdOf = (client: OAuth2Client): string => String(client.credentials.refresh_token ?? '').replace(/^refresh-/, '');

  const createClient = (): OAuth2Client => {
    const client = new google.auth.OAuth2(googleConfig.clientId, googleConfig.clientSecret, googleConfig.redirectUri);
    jest.spyOn(client, 'getToken').mockImplementation((async () => {
      const g = grant;
      grant = null;
      if (!g) throw gmailError(400, 'invalid_grant');
      if (g.error) throw g.error;
      return {
        tokens: {
          access_token: `access-${g.googleId}`,
          refresh_token: g.refreshToken === undefined ? `refresh-${g.googleId}` : g.refreshToken,
          expiry_date: Date.now() + 3_600_000,
          scope: g.scope ?? `${GMAIL_MODIFY_SCOPE} openid email`,
          id_token: JSON.stringify({ sub: g.googleId, email: g.email }),
        },
        res: null,
      };
    }) as unknown as OAuth2Client['getToken']);
    jest.spyOn(client, 'verifyIdToken').mockImplementation((async (opts: { idToken: string }) => {
      const payload: unknown = JSON.parse(opts.idToken);
      return { getPayload: () => payload };
    }) as unknown as OAuth2Client['verifyIdToken']);
    jest.spyOn(client, 'refreshAccessToken').mockImplementation((async () => {
      if (refreshFailure) {
        const error = refreshFailure;
        refreshFailure = null;
        throw error;
      }
      const fresh = { access_token: `access-${googleIdOf(client)}-${Date.now()}`, expiry_date: Date.now() + 3_600_000 };
      // Like google-auth-library: the event carries no refresh token.
      client.emit('tokens', fresh);
      client.credentials = { ...fresh, refresh_token: client.credentials.refresh_token };
      return { credentials: client.credentials, res: null };
    }) as unknown as OAuth2Client['refreshAccessToken']);
    clients.push(client);
    return client;
  };

  const watch: WatchCall = async (client) => {
    if (watchFailure) {
      const error = watchFailure;
      watchFailure = null;
      throw error;
    }
    return { cursor: gmail(googleIdOf(client)).currentHistoryId, expiresAt: new Date(Date.now() + WEEK_MS) };
  };

  const auth = new GmailAuth(googleConfig, { store: users, cipher, createClient, watch, onPersistError: () => undefined });
  const deferred: Array<Promise<void>> = [];
  const deps: AppDeps = {
    jwtSecret: JWT_SECRET,
    frontendUrl: FRONTEND,
    pubsubVerificationToken: PUBSUB_TOKEN,
    cronSecret: CRON_SECRET,
    users,
    messages,
    auth,
    connect: (googleId) => connectGmailMailbox(auth, googleId, () => gmail(googleId).apis()),
    defer: (work) => deferred.push(work),
    randomState: () => 'it-state',
    ...overrides,
  };

  return {
    deps,
    auth,
    cipher,
    users,
    messages,
    deferred,
    gmail,
    clients,
    nextGrant: (g) => {
      grant = g;
    },
    failNextWatch: (error) => {
      watchFailure = error;
    },
    failNextRefresh: (error) => {
      refreshFailure = error;
    },
    async signIn(n) {
      const googleId = ctx.googleId(n);
      const email = ctx.email(n);
      grant = { googleId, email };
      const completed = await auth.completeAuthorization(`code-${googleId}`);
      return {
        userId: completed.userId,
        googleId,
        email,
        bearer: { Authorization: `Bearer ${issueSessionToken(completed.userId, JWT_SECRET)}` },
      };
    },
  };
}
