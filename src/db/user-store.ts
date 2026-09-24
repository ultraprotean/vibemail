/**
 * Persistence interface for the `users` table (CONTRACT.md §4).
 *
 * Server logic depends only on this interface (CONTRACT.md §5); the Supabase
 * implementation lives in `supabase-user-store.ts`. Tokens cross this boundary already
 * encrypted — the store never sees plaintext and never holds the key.
 */

export interface EncryptedTokenUpdate {
  accessTokenEnc: Buffer;
  tokenExpiresAt: Date;
  /** Omitted means "keep the stored refresh token" (CONTRACT.md §3 merge rule). */
  refreshTokenEnc?: Buffer;
}

export interface UpsertUserInput extends EncryptedTokenUpdate {
  googleId: string;
  email: string;
}

export interface StoredUserTokens {
  userId: string;
  googleId: string;
  accessTokenEnc: Buffer;
  refreshTokenEnc: Buffer | null;
  tokenExpiresAt: Date;
}

export interface WatchState {
  /** Gmail historyId, kept as a string (CONTRACT.md §2). */
  lastHistoryId: string;
  watchExpiry: Date;
}

/** The user a webhook notification belongs to (CONTRACT.md §6.6 step 1). */
export interface SyncUser {
  userId: string;
  googleId: string;
  /** Kept as a string (CONTRACT.md §2); null before the first watch registration. */
  lastHistoryId: string | null;
}

/** A user whose Gmail watch needs renewing (CONTRACT.md §6.7). */
export interface WatchDueUser {
  userId: string;
  googleId: string;
  /** Null if no watch was ever registered (e.g. it failed at sign-in). */
  watchExpiration: Date | null;
}

export interface UserStore {
  /**
   * Insert or update the user on conflict `google_id` (§6.2 step 2).
   * @returns our `users.id`, used as the JWT `sub`.
   */
  upsertUserTokens(input: UpsertUserInput): Promise<{ userId: string }>;

  /** Write refreshed tokens back (the token persistence listener). */
  updateUserTokens(googleId: string, update: EncryptedTokenUpdate): Promise<void>;

  getUserTokens(googleId: string): Promise<StoredUserTokens | null>;

  /** Store the result of `users.watch()` (§6.2 step 3). */
  saveWatch(googleId: string, watch: WatchState): Promise<void>;

  /** §6.6 step 1 — The user whose mailbox a notification is for, by email. */
  findUserByEmail(email: string): Promise<SyncUser | null>;

  /** The user a session JWT's `sub` names; null if that user no longer exists. */
  findUserById(userId: string): Promise<SyncUser | null>;

  /** §6.7 — Users whose watch expires at or before `cutoff`, or who have none. */
  findUsersWithWatchDue(cutoff: Date): Promise<WatchDueUser[]>;

  /** §6.7 — Store a renewed watch's expiry. Leaves `last_history_id` untouched. */
  updateWatchExpiration(userId: string, expiresAt: Date): Promise<void>;

  /**
   * §6.6 step 4 — Move `last_history_id` forward to `historyId`, only if it is greater
   * than the stored value (or none is stored). Done as one conditional update, so it can
   * never move backwards, even under concurrent syncs.
   * @returns whether the watermark moved.
   */
  advanceHistoryId(userId: string, historyId: string): Promise<boolean>;
}
