import { randomBytes } from 'node:crypto';
import { google, type Auth } from 'googleapis';
import { createTokenCipher } from '../../../src/crypto/tokens';
import {
  GMAIL_MODIFY_SCOPE,
  GmailAuth,
  toProviderError,
  type GmailAuthConfig,
  type WatchCall,
} from '../../../src/providers/gmail/auth';
import { ProviderError } from '../../../src/types/provider';
import { MemoryUserStore } from '../../helpers/memory-user-store';

type OAuth2Client = Auth.OAuth2Client;

const config: GmailAuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'http://localhost:3000/api/v1/auth/google/callback',
  pubsubTopic: 'projects/test/topics/gmail',
};

const GRANTED_SCOPES = `${GMAIL_MODIFY_SCOPE} openid https://www.googleapis.com/auth/userinfo.email`;
const EXPIRES = 1_900_000_000_000;

/** A Google OAuth error as gaxios surfaces it. */
function oauthError(error: string, status = 400): Error & { response: { status: number; data: { error: string } } } {
  return Object.assign(new Error(error), { response: { status, data: { error } } });
}

interface Stubs {
  getToken: jest.Mock;
  verifyIdToken: jest.Mock;
  refreshAccessToken: jest.Mock;
}

/**
 * A real OAuth2 client with its network calls stubbed. `refreshAccessToken` mimics the
 * library: it emits `tokens` (without a refresh token) and returns merged credentials.
 */
function makeClientFactory(stubs: Stubs): { factory: () => OAuth2Client; clients: OAuth2Client[] } {
  const clients: OAuth2Client[] = [];
  const factory = (): OAuth2Client => {
    const client = new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
    jest.spyOn(client, 'getToken').mockImplementation(stubs.getToken as unknown as OAuth2Client['getToken']);
    jest
      .spyOn(client, 'verifyIdToken')
      .mockImplementation(stubs.verifyIdToken as unknown as OAuth2Client['verifyIdToken']);
    jest.spyOn(client, 'refreshAccessToken').mockImplementation((async () => {
      const fresh = await stubs.refreshAccessToken();
      client.emit('tokens', fresh);
      const credentials = { ...fresh, refresh_token: client.credentials.refresh_token };
      client.credentials = credentials;
      return { credentials, res: null };
    }) as unknown as OAuth2Client['refreshAccessToken']);
    clients.push(client);
    return client;
  };
  return { factory, clients };
}

function setup(overrides: { watch?: WatchCall } = {}) {
  const store = new MemoryUserStore();
  const cipher = createTokenCipher(randomBytes(32));
  const stubs: Stubs = {
    getToken: jest.fn(async () => ({
      tokens: {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expiry_date: EXPIRES,
        scope: GRANTED_SCOPES,
        id_token: 'id-token',
      },
      res: null,
    })),
    verifyIdToken: jest.fn(async () => ({
      getPayload: () => ({ sub: 'google-123', email: 'user@example.com' }),
    })),
    refreshAccessToken: jest.fn(async () => ({ access_token: 'access-2', expiry_date: EXPIRES + 3_600_000 })),
  };
  const watch: jest.MockedFunction<WatchCall> = jest.fn(
    overrides.watch ?? (async () => ({ cursor: '987654321', expiresAt: new Date(EXPIRES) })),
  );
  const { factory, clients } = makeClientFactory(stubs);
  const onPersistError = jest.fn();
  const auth = new GmailAuth(config, { store, cipher, createClient: factory, watch, onPersistError });
  return { auth, store, cipher, stubs, watch, clients, onPersistError };
}

describe('GmailAuth.buildAuthUrl', () => {
  it('requests offline access, forced consent, gmail.modify and the given state', () => {
    const url = new URL(setup().auth.buildAuthUrl('csrf-state'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(
      expect.arrayContaining([GMAIL_MODIFY_SCOPE, 'openid', 'email']),
    );
    expect(url.searchParams.get('state')).toBe('csrf-state');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
  });
});

describe('GmailAuth.exchangeCode', () => {
  it('returns the tokens and the verified identity', async () => {
    const { auth, stubs } = setup();
    const grant = await auth.exchangeCode('code');
    expect(grant.identity).toEqual({ providerUserId: 'google-123', email: 'user@example.com' });
    expect(grant.tokens).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: new Date(EXPIRES),
    });
    expect(stubs.verifyIdToken).toHaveBeenCalledWith({ idToken: 'id-token', audience: config.clientId });
  });

  it('maps invalid_grant to AUTH_CODE_INVALID', async () => {
    const { auth, stubs } = setup();
    stubs.getToken.mockRejectedValueOnce(oauthError('invalid_grant'));
    await expect(auth.exchangeCode('used-code')).rejects.toMatchObject({ kind: 'AUTH_CODE_INVALID' });
  });

  it('maps other token-endpoint failures to UPSTREAM', async () => {
    const { auth, stubs } = setup();
    stubs.getToken.mockRejectedValueOnce(oauthError('server_error', 500));
    await expect(auth.exchangeCode('code')).rejects.toMatchObject({ kind: 'UPSTREAM' });
  });

  it('rejects partial consent without gmail.modify as AUTH_SCOPE_MISSING', async () => {
    const { auth, stubs } = setup();
    stubs.getToken.mockResolvedValueOnce({
      tokens: { access_token: 'a', refresh_token: 'r', expiry_date: EXPIRES, scope: 'openid email', id_token: 'id' },
      res: null,
    });
    await expect(auth.exchangeCode('code')).rejects.toMatchObject({ kind: 'AUTH_SCOPE_MISSING' });
  });

  it('rejects an ID token without sub or email as UPSTREAM', async () => {
    const { auth, stubs } = setup();
    stubs.verifyIdToken.mockResolvedValueOnce({ getPayload: () => ({ sub: 'google-123' }) });
    await expect(auth.exchangeCode('code')).rejects.toMatchObject({ kind: 'UPSTREAM' });
  });
});

describe('GmailAuth.completeAuthorization', () => {
  it('stores encrypted tokens keyed by google_id, then registers the watch', async () => {
    const { auth, store, cipher, watch } = setup();
    const result = await auth.completeAuthorization('code');

    const row = store.rows.get('google-123');
    expect(row).toBeDefined();
    expect(result).toMatchObject({ userId: row?.userId, googleId: 'google-123', email: 'user@example.com' });
    expect(row?.email).toBe('user@example.com');

    // Encrypted at rest: the stored bytes are not the plaintext, but decrypt back to it.
    expect(row?.accessTokenEnc.toString('utf8')).not.toContain('access-1');
    expect(row && cipher.decrypt(row.accessTokenEnc)).toBe('access-1');
    expect(row?.refreshTokenEnc && cipher.decrypt(row.refreshTokenEnc)).toBe('refresh-1');

    expect(watch).toHaveBeenCalledWith(expect.anything(), config.pubsubTopic);
    expect(row?.watch).toEqual({ lastHistoryId: '987654321', watchExpiry: new Date(EXPIRES) });
  });

  it('upserts on google_id: re-consent updates the same user and keeps the refresh token if none is issued', async () => {
    const { auth, store, cipher, stubs } = setup();
    const first = await auth.completeAuthorization('code-1');

    stubs.getToken.mockResolvedValueOnce({
      tokens: { access_token: 'access-9', expiry_date: EXPIRES, scope: GRANTED_SCOPES, id_token: 'id' },
      res: null,
    });
    const second = await auth.completeAuthorization('code-2');

    expect(second.userId).toBe(first.userId);
    expect(store.rows.size).toBe(1);
    const row = store.rows.get('google-123');
    expect(row && cipher.decrypt(row.accessTokenEnc)).toBe('access-9');
    expect(row?.refreshTokenEnc && cipher.decrypt(row.refreshTokenEnc)).toBe('refresh-1');
  });

  it('keeps separate rows for different Google accounts', async () => {
    const { auth, store, stubs } = setup();
    await auth.completeAuthorization('code-a');
    stubs.verifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ sub: 'google-456', email: 'other@example.com' }),
    });
    await auth.completeAuthorization('code-b');
    expect([...store.rows.keys()].sort()).toEqual(['google-123', 'google-456']);
  });

  it('reports a watch failure as UPSTREAM after the tokens were saved', async () => {
    const { auth, store } = setup({
      watch: async () => {
        throw oauthError('backendError', 503);
      },
    });
    await expect(auth.completeAuthorization('code')).rejects.toMatchObject({ kind: 'UPSTREAM' });
    expect(store.rows.get('google-123')?.accessTokenEnc).toBeDefined();
    expect(store.rows.get('google-123')?.watch).toBeNull();
  });
});

describe('token persistence listener', () => {
  it('encrypts and writes back auto-refreshed tokens, keeping the stored refresh token', async () => {
    const { auth, store, cipher } = setup();
    await auth.completeAuthorization('code');

    const { client, persistence } = await auth.authorizedClient('google-123');
    client.emit('tokens', { access_token: 'auto-refreshed', expiry_date: EXPIRES + 1 });
    await persistence.settled();

    const row = store.rows.get('google-123');
    expect(row && cipher.decrypt(row.accessTokenEnc)).toBe('auto-refreshed');
    expect(row?.tokenExpiresAt).toEqual(new Date(EXPIRES + 1));
    expect(row?.refreshTokenEnc && cipher.decrypt(row.refreshTokenEnc)).toBe('refresh-1');
  });

  it('stores a rotated refresh token when one is emitted', async () => {
    const { auth, store, cipher } = setup();
    await auth.completeAuthorization('code');

    const { client, persistence } = await auth.authorizedClient('google-123');
    client.emit('tokens', { access_token: 'a', refresh_token: 'refresh-rotated', expiry_date: EXPIRES });
    await persistence.settled();

    const row = store.rows.get('google-123');
    expect(row?.refreshTokenEnc && cipher.decrypt(row.refreshTokenEnc)).toBe('refresh-rotated');
  });

  it('applies writes in emission order so the newest token wins', async () => {
    const { auth, store, cipher } = setup();
    await auth.completeAuthorization('code');

    const { client, persistence } = await auth.authorizedClient('google-123');
    client.emit('tokens', { access_token: 'older', expiry_date: EXPIRES + 1 });
    client.emit('tokens', { access_token: 'newer', expiry_date: EXPIRES + 2 });
    await persistence.settled();

    const row = store.rows.get('google-123');
    expect(row && cipher.decrypt(row.accessTokenEnc)).toBe('newer');
  });

  it('surfaces a failed write through settled() and the error hook', async () => {
    const { auth, store, onPersistError } = setup();
    await auth.completeAuthorization('code');
    jest.spyOn(store, 'updateUserTokens').mockRejectedValueOnce(new Error('db down'));

    const { client, persistence } = await auth.authorizedClient('google-123');
    client.emit('tokens', { access_token: 'lost', expiry_date: EXPIRES });

    await expect(persistence.settled()).rejects.toThrow('db down');
    expect(onPersistError).toHaveBeenCalledTimes(1);
  });
});

describe('GmailAuth.refreshAccessToken', () => {
  it('uses the decrypted stored refresh token and persists the new access token (no mismatch)', async () => {
    const { auth, store, cipher, clients } = setup();
    await auth.completeAuthorization('code');

    const tokens = await auth.refreshAccessToken('google-123');

    // The refreshing client was loaded with the decrypted stored refresh token.
    expect(clients[clients.length - 1].credentials.refresh_token).toBe('refresh-1');

    // What the caller gets back and what the store holds are the same tokens.
    const row = store.rows.get('google-123');
    expect(tokens.accessToken).toBe('access-2');
    expect(row && cipher.decrypt(row.accessTokenEnc)).toBe(tokens.accessToken);
    expect(row?.tokenExpiresAt).toEqual(tokens.expiresAt);
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(row?.refreshTokenEnc && cipher.decrypt(row.refreshTokenEnc)).toBe('refresh-1');
  });

  it('maps a rejected refresh token (invalid_grant) to AUTH_REVOKED', async () => {
    const { auth, stubs } = setup();
    await auth.completeAuthorization('code');
    stubs.refreshAccessToken.mockRejectedValueOnce(oauthError('invalid_grant'));
    await expect(auth.refreshAccessToken('google-123')).rejects.toMatchObject({ kind: 'AUTH_REVOKED' });
  });

  it('reports an unknown user as AUTH_REVOKED', async () => {
    const { auth } = setup();
    await expect(auth.refreshAccessToken('nobody')).rejects.toMatchObject({ kind: 'AUTH_REVOKED' });
  });

  it('fails when the refreshed token could not be saved', async () => {
    const { auth, store } = setup();
    await auth.completeAuthorization('code');
    jest.spyOn(store, 'updateUserTokens').mockRejectedValueOnce(new Error('db down'));
    await expect(auth.refreshAccessToken('google-123')).rejects.toThrow('db down');
  });
});

describe('toProviderError', () => {
  it('maps HTTP 429 to RATE_LIMITED', () => {
    expect(toProviderError(oauthError('rateLimitExceeded', 429), 'api').kind).toBe('RATE_LIMITED');
  });

  it('passes an existing ProviderError through unchanged', () => {
    const original = new ProviderError('NOT_FOUND', 'gone');
    expect(toProviderError(original, 'api')).toBe(original);
  });
});
