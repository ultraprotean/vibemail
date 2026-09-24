import { randomBytes } from 'node:crypto';
import { RENEW_WINDOW_MS, renewWatches, type RenewWatchDeps } from '../../src/cron/renewWatch';
import { ProviderError, type WatchRegistration } from '../../src/types/provider';
import { MemoryUserStore } from '../helpers/memory-user-store';

const NOW = new Date('2026-09-24T06:00:00Z');
const HOUR = 60 * 60 * 1000;
const RENEWED_EXPIRY = new Date(NOW.getTime() + 7 * 24 * HOUR);

async function addUser(store: MemoryUserStore, googleId: string, watch: { expiresInMs: number } | null) {
  await store.upsertUserTokens({
    googleId,
    email: `${googleId}@example.com`,
    accessTokenEnc: randomBytes(40),
    refreshTokenEnc: randomBytes(40),
    tokenExpiresAt: NOW,
  });
  if (watch) {
    await store.saveWatch(googleId, { lastHistoryId: '500', watchExpiry: new Date(NOW.getTime() + watch.expiresInMs) });
  }
}

function setup() {
  const users = new MemoryUserStore();
  const watchMailbox = jest.fn(async (): Promise<WatchRegistration> => ({ cursor: '999', expiresAt: RENEWED_EXPIRY }));
  const settled = jest.fn(async () => undefined);
  const connect = jest.fn(async (_googleId: string) => ({ mailbox: { watchMailbox }, settled }));
  const log = { error: jest.fn() };
  const deps: RenewWatchDeps = { users, connect, now: () => NOW, log };
  return { users, watchMailbox, connect, settled, log, deps };
}

describe('renewWatches', () => {
  it('renews only users whose watch expires within 24 hours, or who have none', async () => {
    const { users, connect, deps } = setup();
    await addUser(users, 'soon', { expiresInMs: 5 * HOUR });
    await addUser(users, 'edge', { expiresInMs: RENEW_WINDOW_MS });
    await addUser(users, 'expired', { expiresInMs: -2 * HOUR });
    await addUser(users, 'never', null);
    await addUser(users, 'later', { expiresInMs: 25 * HOUR });

    const result = await renewWatches(deps);

    expect(result).toEqual({ renewed: 4, skippedAuthRevoked: 0, failed: 0 });
    expect(connect.mock.calls.map(([googleId]) => googleId).sort()).toEqual(['edge', 'expired', 'never', 'soon']);
  });

  it('stores the new expiry and leaves last_history_id alone', async () => {
    const { users, deps } = setup();
    await addUser(users, 'soon', { expiresInMs: HOUR });

    await renewWatches(deps);

    const row = users.rows.get('soon');
    expect(row?.watch?.watchExpiry).toEqual(RENEWED_EXPIRY);
    // The renewal's cursor (999) must not replace the sync watermark (500).
    expect((await users.findUserByEmail('soon@example.com'))?.lastHistoryId).toBe('500');
  });

  it('skips users whose refresh token is dead, without stopping the others', async () => {
    const { users, watchMailbox, deps } = setup();
    await addUser(users, 'a', { expiresInMs: HOUR });
    await addUser(users, 'b', { expiresInMs: HOUR });
    watchMailbox.mockRejectedValueOnce(new ProviderError('AUTH_REVOKED', 'invalid_grant'));

    expect(await renewWatches(deps)).toEqual({ renewed: 1, skippedAuthRevoked: 1, failed: 0 });
  });

  it('counts and logs other failures, without stopping the others', async () => {
    const { users, watchMailbox, log, deps } = setup();
    await addUser(users, 'a', { expiresInMs: HOUR });
    await addUser(users, 'b', { expiresInMs: HOUR });
    watchMailbox.mockRejectedValueOnce(new ProviderError('UPSTREAM', 'gmail 500'));

    expect(await renewWatches(deps)).toEqual({ renewed: 1, skippedAuthRevoked: 0, failed: 1 });
    expect(log.error).toHaveBeenCalledWith('Watch renewal failed', expect.objectContaining({ error: 'gmail 500' }));
  });

  it('treats a failure to connect (e.g. no refresh token) the same way', async () => {
    const { users, connect, deps } = setup();
    await addUser(users, 'a', { expiresInMs: HOUR });
    connect.mockRejectedValueOnce(new ProviderError('AUTH_REVOKED', 'no refresh token'));
    expect(await renewWatches(deps)).toEqual({ renewed: 0, skippedAuthRevoked: 1, failed: 0 });
  });

  it('waits for refreshed tokens to be written for every user', async () => {
    const { users, settled, deps } = setup();
    await addUser(users, 'a', { expiresInMs: HOUR });
    await addUser(users, 'b', { expiresInMs: HOUR });
    await renewWatches(deps);
    expect(settled).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no watch is due', async () => {
    const { users, connect, deps } = setup();
    await addUser(users, 'later', { expiresInMs: 3 * 24 * HOUR });
    expect(await renewWatches(deps)).toEqual({ renewed: 0, skippedAuthRevoked: 0, failed: 0 });
    expect(connect).not.toHaveBeenCalled();
  });

  it('throws when the list of due users cannot be read', async () => {
    const { users, deps } = setup();
    jest.spyOn(users, 'findUsersWithWatchDue').mockRejectedValueOnce(new Error('db down'));
    await expect(renewWatches(deps)).rejects.toThrow('db down');
  });
});
