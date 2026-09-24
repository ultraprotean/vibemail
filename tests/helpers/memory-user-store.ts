import type {
  EncryptedTokenUpdate,
  StoredUserTokens,
  UpsertUserInput,
  UserStore,
  WatchState,
} from '../../src/db/user-store';

interface MemoryUserRow extends StoredUserTokens {
  email: string;
  watch: WatchState | null;
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
    if (row) row.watch = watch;
  }
}
