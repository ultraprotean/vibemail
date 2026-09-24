import type { MessageStore } from '../db/message-store';
import type { MailboxClient } from '../types/provider';

/**
 * Initial sync: the backfill run once when a user first connects (CONTRACT.md §6.2 step 4).
 *
 * Provider-agnostic: messages are read through `MailboxClient` and written through
 * `MessageStore`. The history watermark is not touched here; the watch registration
 * already stored it before the backfill began (CONTRACT.md §4, `last_history_id`).
 */

export const INITIAL_SYNC_LIMIT = 50;

export interface InitialSyncDeps {
  mailbox: Pick<MailboxClient, 'listMessages'>;
  store: MessageStore;
  now?: () => Date;
}

export interface InitialSyncResult {
  synced: number;
}

/**
 * Page through the user's inbox, newest first, upserting each page, and stop once
 * `limit` messages have been synced or the inbox runs out.
 */
export async function runInitialSync(
  userId: string,
  deps: InitialSyncDeps,
  limit: number = INITIAL_SYNC_LIMIT,
): Promise<InitialSyncResult> {
  const now = deps.now ?? (() => new Date());
  let synced = 0;
  let pageCursor: string | undefined;

  while (synced < limit) {
    const remaining = limit - synced;
    const page = await deps.mailbox.listMessages({ limit: remaining, pageCursor, inboxOnly: true });
    const batch = page.messages.slice(0, remaining);

    await deps.store.upsertMessages(userId, batch, now());
    synced += batch.length;

    // An empty page with a cursor would otherwise loop forever.
    if (!page.nextPageCursor || batch.length === 0) break;
    pageCursor = page.nextPageCursor;
  }

  return { synced };
}
