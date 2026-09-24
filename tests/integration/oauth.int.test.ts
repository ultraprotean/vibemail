import { buildLiveApp, type LiveApp } from './support/app';
import { gmailError } from './support/fake-gmail';
import { bytea, liveContext, purgeStaleRuns, rawUser } from './support/live';

/**
 * OAuth against live Supabase: token encryption at rest, persistence keyed on google_id,
 * and the token persistence listener writing refreshed tokens back (CONTRACT.md §3, §4, §6.2).
 */

const ctx = liveContext('oauth');
let app: LiveApp;

beforeAll(async () => {
  await purgeStaleRuns();
});
beforeEach(() => {
  app = buildLiveApp(ctx);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await ctx.cleanup();
});

describe('token encryption at rest', () => {
  it('stores AES-256-GCM ciphertext, never the plaintext token', async () => {
    const user = await app.signIn(1);
    const row = await rawUser(user.googleId);

    const access = bytea(row.access_token_enc);
    const refresh = bytea(row.refresh_token_enc);
    // iv (12) + tag (16) + ciphertext
    expect(access.length).toBe(12 + 16 + `access-${user.googleId}`.length);
    expect(access.toString('utf8')).not.toContain('access-');
    expect(refresh.toString('utf8')).not.toContain('refresh-');

    expect(app.cipher.decrypt(access)).toBe(`access-${user.googleId}`);
    expect(app.cipher.decrypt(refresh)).toBe(`refresh-${user.googleId}`);
  });

  it('round-trips the ciphertext through Supabase bytea unchanged', async () => {
    const user = await app.signIn(2);
    const stored = await app.users.getUserTokens(user.googleId);
    const row = await rawUser(user.googleId);
    expect(stored?.accessTokenEnc.equals(bytea(row.access_token_enc))).toBe(true);
    expect(stored && app.cipher.decrypt(stored.accessTokenEnc)).toBe(`access-${user.googleId}`);
  });
});

describe('token persistence', () => {
  it('upserts on google_id: re-consent updates the same row', async () => {
    const first = await app.signIn(3);
    const second = await app.signIn(3);
    expect(second.userId).toBe(first.userId);
    const { count } = await (await import('./support/live')).db
      .from('users')
      .select('id', { count: 'exact', head: true })
      .eq('google_id', first.googleId);
    expect(count).toBe(1);
  });

  it('keeps the stored refresh token when a re-consent issues none (§3 merge rule)', async () => {
    const user = await app.signIn(4);
    app.nextGrant({ googleId: user.googleId, email: user.email, refreshToken: null });
    await app.auth.completeAuthorization('code-without-refresh');

    const row = await rawUser(user.googleId);
    expect(app.cipher.decrypt(bytea(row.refresh_token_enc))).toBe(`refresh-${user.googleId}`);
  });

  it('refuses a brand-new user who arrives without a refresh token (column is NOT NULL)', async () => {
    app.nextGrant({ googleId: ctx.googleId('4b'), email: ctx.email('4b'), refreshToken: null });
    await expect(app.auth.completeAuthorization('code-new-no-refresh')).rejects.toThrow('no refresh token');
  });

  it('stores the watch expiry and the initial history id as the watermark', async () => {
    const user = await app.signIn(5);
    const row = await rawUser(user.googleId);
    expect(row.last_history_id).toBe(app.gmail(user.googleId).currentHistoryId);
    expect(new Date(String(row.watch_expiration)).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3_600_000);
  });

  it('keeps separate rows for different Google accounts', async () => {
    const a = await app.signIn('6a');
    const b = await app.signIn('6b');
    expect(a.userId).not.toBe(b.userId);
  });
});

describe('token persistence listener', () => {
  it('writes an automatically refreshed access token back to Supabase immediately', async () => {
    const user = await app.signIn(7);
    const { client, persistence } = await app.auth.authorizedClient(user.googleId);

    client.emit('tokens', { access_token: 'auto-refreshed-access', expiry_date: Date.UTC(2031, 0, 1) });
    await persistence.settled();

    const row = await rawUser(user.googleId);
    expect(app.cipher.decrypt(bytea(row.access_token_enc))).toBe('auto-refreshed-access');
    expect(new Date(String(row.token_expires_at)).toISOString()).toBe('2031-01-01T00:00:00.000Z');
    // The refresh emission carried no refresh token, so the stored one is kept.
    expect(app.cipher.decrypt(bytea(row.refresh_token_enc))).toBe(`refresh-${user.googleId}`);
  });

  it('stores a rotated refresh token when one is emitted', async () => {
    const user = await app.signIn(8);
    const { client, persistence } = await app.auth.authorizedClient(user.googleId);
    client.emit('tokens', { access_token: 'a', refresh_token: 'rotated-refresh', expiry_date: Date.now() + 1000 });
    await persistence.settled();
    expect(app.cipher.decrypt(bytea((await rawUser(user.googleId)).refresh_token_enc))).toBe('rotated-refresh');
  });

  it('applies back-to-back refreshes in order, so the newest token wins', async () => {
    const user = await app.signIn(9);
    const { client, persistence } = await app.auth.authorizedClient(user.googleId);
    client.emit('tokens', { access_token: 'older', expiry_date: Date.now() + 1000 });
    client.emit('tokens', { access_token: 'newer', expiry_date: Date.now() + 2000 });
    await persistence.settled();
    expect(app.cipher.decrypt(bytea((await rawUser(user.googleId)).access_token_enc))).toBe('newer');
  });

  it('forced refresh: decrypts the stored refresh token and persists the result (no mismatch)', async () => {
    const user = await app.signIn(10);
    const tokens = await app.auth.refreshAccessToken(user.googleId);

    const refreshingClient = app.clients[app.clients.length - 1];
    expect(refreshingClient.credentials.refresh_token).toBe(`refresh-${user.googleId}`);

    const row = await rawUser(user.googleId);
    expect(app.cipher.decrypt(bytea(row.access_token_enc))).toBe(tokens.accessToken);
    expect(new Date(String(row.token_expires_at)).getTime()).toBe(tokens.expiresAt.getTime());
  });

  it('reports a rejected refresh token as AUTH_REVOKED and leaves the row alone', async () => {
    const user = await app.signIn(11);
    const before = await rawUser(user.googleId);
    app.failNextRefresh(gmailError(400, 'invalid_grant'));
    await expect(app.auth.refreshAccessToken(user.googleId)).rejects.toMatchObject({ kind: 'AUTH_REVOKED' });
    expect((await rawUser(user.googleId)).access_token_enc).toBe(before.access_token_enc);
  });
});
