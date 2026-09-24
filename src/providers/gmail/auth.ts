import { google, type Auth } from 'googleapis';
import type { TokenCipher } from '../../crypto/tokens';
import type { EncryptedTokenUpdate, UserStore } from '../../db/user-store';
import {
  ProviderError,
  type AuthorizationGrant,
  type EmailProvider,
  type ProviderTokens,
  type WatchRegistration,
} from '../../types/provider';

/**
 * Gmail OAuth layer (BUILD_SEQUENCE.md unit 2).
 *
 * Every Gmail call goes through the googleapis OAuth2 client, which refreshes access tokens
 * itself; this module never hand-rolls a refresh request (CLAUDE.md). Tokens are encrypted
 * with the injected cipher before they reach the `UserStore` (CONTRACT.md §4).
 */

type OAuth2Client = Auth.OAuth2Client;
type Credentials = Auth.Credentials;

export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const GMAIL_SCOPES: readonly string[] = [GMAIL_MODIFY_SCOPE, 'openid', 'email'];

export interface GmailAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Fully qualified Pub/Sub topic, e.g. `projects/<id>/topics/<name>`. */
  pubsubTopic: string;
}

/** @throws Error naming every missing variable. */
export function gmailAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GmailAuthConfig {
  const required = {
    clientId: 'GOOGLE_CLIENT_ID',
    clientSecret: 'GOOGLE_CLIENT_SECRET',
    redirectUri: 'GOOGLE_REDIRECT_URI',
    pubsubTopic: 'GOOGLE_PUBSUB_TOPIC',
  } as const;
  const missing = Object.values(required).filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
  return {
    clientId: env[required.clientId] ?? '',
    clientSecret: env[required.clientSecret] ?? '',
    redirectUri: env[required.redirectUri] ?? '',
    pubsubTopic: env[required.pubsubTopic] ?? '',
  };
}

/** Calls Gmail `users.watch` for the mailbox the client is authorized for. */
export type WatchCall = (auth: OAuth2Client, topicName: string) => Promise<WatchRegistration>;

export const gmailWatch: WatchCall = async (auth, topicName) => {
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.watch({ userId: 'me', requestBody: { topicName } });
  const { historyId, expiration } = res.data;
  if (!historyId || !expiration) {
    throw new ProviderError('UPSTREAM', 'users.watch returned no historyId or expiration');
  }
  return { cursor: historyId, expiresAt: new Date(Number(expiration)) };
};

export interface GmailAuthDeps {
  store: UserStore;
  cipher: TokenCipher;
  /** Overridable for tests; defaults to a real googleapis OAuth2 client. */
  createClient?: (config: GmailAuthConfig) => OAuth2Client;
  watch?: WatchCall;
  /** Receives errors from background token writes, which have no caller to throw to. */
  onPersistError?: (err: unknown) => void;
}

/**
 * The tokens were saved but a later setup step (watch registration) failed. Still an
 * `UPSTREAM` provider error; the subclass lets the callback return 502 `PROVIDER_ERROR`
 * rather than the non-recoverable `AUTH_FAILED` used for token-exchange failures.
 */
export class PostConsentSetupError extends ProviderError {
  constructor(message: string, cause?: unknown) {
    super('UPSTREAM', message, cause);
    this.name = 'PostConsentSetupError';
  }
}

export interface CompletedAuthorization {
  userId: string;
  googleId: string;
  email: string;
  watch: WatchRegistration;
}

/** Handle returned by `attachTokenPersistence`. */
export interface TokenPersistence {
  /**
   * Resolves once every token write triggered so far has finished.
   * @throws the first write error, so callers that must not proceed with unsaved tokens
   * (e.g. `refreshAccessToken`) can fail instead.
   */
  settled(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function httpStatusOf(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined;
  const response = err.response;
  if (isRecord(response) && typeof response.status === 'number') return response.status;
  return typeof err.status === 'number' ? err.status : undefined;
}

/** Google signals a dead code or refresh token with the OAuth error `invalid_grant`. */
function isInvalidGrant(err: unknown): boolean {
  if (!isRecord(err)) return false;
  const response = err.response;
  if (isRecord(response) && isRecord(response.data) && response.data.error === 'invalid_grant') {
    return true;
  }
  return err instanceof Error && err.message.includes('invalid_grant');
}

/**
 * Map a googleapis error onto a `ProviderError`. An `invalid_grant` means different things
 * depending on what was being exchanged: a bad authorization code (recoverable) or a dead
 * refresh token (not recoverable).
 */
export function toProviderError(err: unknown, during: 'code-exchange' | 'refresh' | 'api'): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = err instanceof Error ? err.message : 'Unknown Gmail error';
  if (isInvalidGrant(err)) {
    return during === 'code-exchange'
      ? new ProviderError('AUTH_CODE_INVALID', 'Authorization code is invalid or expired', err)
      : new ProviderError('AUTH_REVOKED', 'Refresh token is invalid or revoked', err);
  }
  if (httpStatusOf(err) === 429) {
    return new ProviderError('RATE_LIMITED', message, err);
  }
  return new ProviderError('UPSTREAM', message, err);
}

// ---------------------------------------------------------------------------
// GmailAuth
// ---------------------------------------------------------------------------

function expiryOf(credentials: Credentials): Date {
  // No expiry reported: treat the token as already expired so the client refreshes it.
  return new Date(credentials.expiry_date ?? Date.now());
}

export class GmailAuth implements Pick<EmailProvider, 'buildAuthUrl' | 'exchangeCode'> {
  private readonly createClient: (config: GmailAuthConfig) => OAuth2Client;
  private readonly watch: WatchCall;
  private readonly onPersistError: (err: unknown) => void;

  constructor(
    private readonly config: GmailAuthConfig,
    private readonly deps: GmailAuthDeps,
  ) {
    this.createClient =
      deps.createClient ??
      ((c) => new google.auth.OAuth2(c.clientId, c.clientSecret, c.redirectUri));
    this.watch = deps.watch ?? gmailWatch;
    this.onPersistError =
      deps.onPersistError ?? ((err) => console.error('Failed to persist refreshed Gmail tokens', err));
  }

  /** §6.1 — Consent URL with offline access and forced consent, so a refresh token is issued. */
  buildAuthUrl(state: string): string {
    return this.createClient(this.config).generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [...GMAIL_SCOPES],
      state,
    });
  }

  /**
   * §6.2 steps 1–2 — Exchange the code, check `gmail.modify` was granted, and read the
   * verified ID token's `sub` (google_id) and `email`. Nothing is persisted here.
   */
  async exchangeCode(code: string): Promise<AuthorizationGrant> {
    // A fresh client with no persistence listener: the user row may not exist yet.
    const client = this.createClient(this.config);

    let credentials: Credentials;
    try {
      ({ tokens: credentials } = await client.getToken(code));
    } catch (err) {
      throw toProviderError(err, 'code-exchange');
    }

    const granted = (credentials.scope ?? '').split(' ');
    if (!granted.includes(GMAIL_MODIFY_SCOPE)) {
      throw new ProviderError('AUTH_SCOPE_MISSING', 'The gmail.modify scope was not granted');
    }
    if (!credentials.access_token) {
      throw new ProviderError('UPSTREAM', 'Token response contained no access token');
    }
    if (!credentials.id_token) {
      throw new ProviderError('UPSTREAM', 'Token response contained no ID token');
    }

    let sub: string | undefined;
    let email: string | undefined;
    try {
      const ticket = await client.verifyIdToken({
        idToken: credentials.id_token,
        audience: this.config.clientId,
      });
      ({ sub, email } = ticket.getPayload() ?? {});
    } catch (err) {
      throw toProviderError(err, 'api');
    }
    if (!sub || !email) {
      throw new ProviderError('UPSTREAM', 'ID token is missing the sub or email claim');
    }

    return {
      tokens: {
        accessToken: credentials.access_token,
        refreshToken: credentials.refresh_token ?? null,
        expiresAt: expiryOf(credentials),
      },
      identity: { providerUserId: sub, email },
    };
  }

  /**
   * §6.2 steps 1–3 — Exchange the code, encrypt and upsert the tokens on conflict
   * `google_id`, then register `users.watch` and store its expiry and initial history id.
   * The backfill (step 4) and JWT (step 5) belong to later units.
   *
   * @throws ProviderError from `exchangeCode`, or `PostConsentSetupError` if `watch()` fails
   * after the tokens were saved (CONTRACT.md §6.2: 502 `PROVIDER_ERROR`, safe to retry).
   */
  async completeAuthorization(code: string): Promise<CompletedAuthorization> {
    const { tokens, identity } = await this.exchangeCode(code);
    const googleId = identity.providerUserId;

    const { userId } = await this.deps.store.upsertUserTokens({
      googleId,
      email: identity.email,
      ...this.encryptTokens(tokens),
    });

    const client = this.createClient(this.config);
    client.setCredentials({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expiry_date: tokens.expiresAt.getTime(),
    });
    const persistence = this.attachTokenPersistence(client, googleId);

    let watch: WatchRegistration;
    try {
      watch = await this.watch(client, this.config.pubsubTopic);
    } catch (err) {
      const mapped = toProviderError(err, 'api');
      // A dead refresh token is still an auth failure; anything else is a setup failure.
      if (mapped.kind === 'AUTH_REVOKED' || mapped.kind === 'RATE_LIMITED') throw mapped;
      throw new PostConsentSetupError(`users.watch failed: ${mapped.message}`, err);
    }
    await this.deps.store.saveWatch(googleId, {
      lastHistoryId: watch.cursor,
      watchExpiry: watch.expiresAt,
    });
    await persistence.settled();

    return { userId, googleId, email: identity.email, watch };
  }

  /**
   * An OAuth2 client authorized as the given user, with the token persistence listener
   * attached, so any automatic refresh is written straight back to the store.
   * @throws ProviderError `AUTH_REVOKED` if the user has no stored refresh token.
   */
  async authorizedClient(googleId: string): Promise<{ client: OAuth2Client; persistence: TokenPersistence }> {
    const stored = await this.deps.store.getUserTokens(googleId);
    if (!stored || !stored.refreshTokenEnc) {
      throw new ProviderError('AUTH_REVOKED', 'No stored refresh token for this user');
    }
    const client = this.createClient(this.config);
    client.setCredentials({
      access_token: this.deps.cipher.decrypt(stored.accessTokenEnc),
      refresh_token: this.deps.cipher.decrypt(stored.refreshTokenEnc),
      expiry_date: stored.tokenExpiresAt.getTime(),
    });
    return { client, persistence: this.attachTokenPersistence(client, googleId) };
  }

  /**
   * Force a refresh: load the stored refresh token, decrypt it, and have the OAuth2 client
   * obtain a new access token. The new tokens reach the store through the persistence
   * listener; this waits for that write before returning.
   * @throws ProviderError `AUTH_REVOKED` if Google rejects the refresh token.
   */
  async refreshAccessToken(googleId: string): Promise<ProviderTokens> {
    const { client, persistence } = await this.authorizedClient(googleId);
    let credentials: Credentials;
    try {
      ({ credentials } = await client.refreshAccessToken());
    } catch (err) {
      throw toProviderError(err, 'refresh');
    }
    await persistence.settled();
    if (!credentials.access_token) {
      throw new ProviderError('UPSTREAM', 'Refresh returned no access token');
    }
    return {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token ?? null,
      expiresAt: expiryOf(credentials),
    };
  }

  /**
   * Token persistence listener. The OAuth2 client emits `tokens` whenever it obtains new
   * tokens, including automatic refreshes. Each emission is encrypted and written back via
   * `updateUserTokens` immediately. Writes run one at a time in emission order, so an older
   * token can never overwrite a newer one. Refresh emissions carry no refresh token, and
   * the stored one is then kept (CONTRACT.md §3 merge rule).
   */
  attachTokenPersistence(client: OAuth2Client, googleId: string): TokenPersistence {
    let chain: Promise<void> = Promise.resolve();
    let firstFailure: { error: unknown } | null = null;

    client.on('tokens', (credentials: Credentials) => {
      if (!credentials.access_token) return;
      const update = this.encryptTokens({
        accessToken: credentials.access_token,
        refreshToken: credentials.refresh_token ?? null,
        expiresAt: expiryOf(credentials),
      });
      chain = chain
        .then(() => this.deps.store.updateUserTokens(googleId, update))
        .catch((error: unknown) => {
          firstFailure ??= { error };
          this.onPersistError(error);
        });
    });

    return {
      settled: async () => {
        await chain;
        if (firstFailure) throw firstFailure.error;
      },
    };
  }

  private encryptTokens(tokens: ProviderTokens): EncryptedTokenUpdate {
    const update: EncryptedTokenUpdate = {
      accessTokenEnc: this.deps.cipher.encrypt(tokens.accessToken),
      tokenExpiresAt: tokens.expiresAt,
    };
    if (tokens.refreshToken) {
      update.refreshTokenEnc = this.deps.cipher.encrypt(tokens.refreshToken);
    }
    return update;
  }
}
