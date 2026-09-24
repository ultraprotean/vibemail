import type {
  EncryptedTokenUpdate,
  StoredUserTokens,
  SyncUser,
  UpsertUserInput,
  UserStore,
  WatchState,
} from '../../src/db/user-store';

interface MemoryUserRow extends StoredUserTokens {
  email: string;
  watch: WatchState | null;
  lastHistoryId: string | null;
}

/**
 * In-memory `UserStore` with the same semantics as the Supabase one: upsert on conflict
 * `google_id`, and an omitted refresh token leaves the stored one untouched.
 */
export class MemoryUserStore implements UserStore {
  readonly rows = new Map<string, MemoryUserRow>();
  private nextId = 1;

  async upsertUserTokens(input: UpsertUserInput): Promise<{ userId: string }> {
    const existing = this.rows.get(input.googleId);
    const row: MemoryUserRow = {
      userId: existing?.userId ?? `user-${this.nextId++}`,
      googleId: input.googleId,
      email: input.email,
      accessTokenEnc: input.accessTokenEnc,
      refreshTokenEnc: input.refreshTokenEnc ?? existing?.refreshTokenEnc ?? null,
      tokenExpiresAt: input.tokenExpiresAt,
      watch: existing?.watch ?? null,
      lastHistoryId: existing?.lastHistoryId ?? null,
    };
    this.rows.set(input.googleId, row);
    return { userId: row.userId };
  }

  async updateUserTokens(googleId: string, update: EncryptedTokenUpdate): Promise<void> {
    const row = this.rows.get(googleId);
    if (!row) return; // matches an UPDATE ... WHERE that matches no row
    row.accessTokenEnc = update.accessTokenEnc;
    row.tokenExpiresAt = update.tokenExpiresAt;
    if (update.refreshTokenEnc) row.refreshTokenEnc = update.refreshTokenEnc;
  }

  async getUserTokens(googleId: string): Promise<StoredUserTokens | null> {
    return this.rows.get(googleId) ?? null;
  }

  async saveWatch(googleId: string, watch: WatchState): Promise<void> {
    const row = this.rows.get(googleId);
    if (row) {
      row.watch = watch;
      row.lastHistoryId = watch.lastHistoryId;
    }
  }

  async findUserByEmail(email: string): Promise<SyncUser | null> {
    for (const row of this.rows.values()) {
      if (row.email === email) {
        return { userId: row.userId, googleId: row.googleId, lastHistoryId: row.lastHistoryId };
      }
    }
    return null;
  }

  async advanceHistoryId(userId: string, historyId: string): Promise<boolean> {
    for (const row of this.rows.values()) {
      if (row.userId !== userId) continue;
      // BigInt comparison, like the bigint column: never through a JS number.
      if (row.lastHistoryId !== null && BigInt(historyId) <= BigInt(row.lastHistoryId)) return false;
      row.lastHistoryId = historyId;
      return true;
    }
    return false;
  }
}
