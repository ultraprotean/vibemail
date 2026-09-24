import type { UserStore, WatchDueUser } from '../db/user-store';
import { ProviderError, type MailboxClient } from '../types/provider';

/**
 * Watch renewal (CONTRACT.md §6.7). Gmail stops push notifications unless `users.watch`
 * is called again within 7 days; this renews every user whose watch expires within the
 * next 24 hours (or who has none), one user at a time, so one failure never stops the rest.
 *
 * Only `watch_expiration` changes. `last_history_id` is the sync watermark and must not
 * move here, or changes between the watermark and now would be skipped.
 */

export const RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RenewWatchDeps {
  users: Pick<UserStore, 'findUsersWithWatchDue' | 'updateWatchExpiration'>;
  /** An authorized mailbox for one user; `settled` waits for refreshed-token writes. */
  connect(googleId: string): Promise<{ mailbox: Pick<MailboxClient, 'watchMailbox'>; settled(): Promise<void> }>;
  now?: () => Date;
  log?: { error(message: string, context?: Record<string, unknown>): void };
}

export interface RenewWatchResult {
  renewed: number;
  /** Refresh token dead: nothing works for this user until they re-consent. */
  skippedAuthRevoked: number;
  failed: number;
}

async function renewOne(user: WatchDueUser, deps: RenewWatchDeps): Promise<void> {
  const { mailbox, settled } = await deps.connect(user.googleId);
  try {
    const watch = await mailbox.watchMailbox();
    await deps.users.updateWatchExpiration(user.userId, watch.expiresAt);
  } finally {
    await settled().catch(() => undefined);
  }
}

/**
 * Renew every due watch.
 * @throws only if the list of due users can't be read (§6.7: 500 `INTERNAL_ERROR`).
 */
export async function renewWatches(deps: RenewWatchDeps): Promise<RenewWatchResult> {
  const now = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? { error: (message, context) => console.error(message, context ?? {}) };
  const due = await deps.users.findUsersWithWatchDue(new Date(now.getTime() + RENEW_WINDOW_MS));

  const result: RenewWatchResult = { renewed: 0, skippedAuthRevoked: 0, failed: 0 };
  for (const user of due) {
    try {
      await renewOne(user, deps);
      result.renewed += 1;
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'AUTH_REVOKED') {
        result.skippedAuthRevoked += 1;
        continue;
      }
      result.failed += 1;
      log.error('Watch renewal failed', {
        userId: user.userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
