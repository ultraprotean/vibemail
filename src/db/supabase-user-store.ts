import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  EncryptedTokenUpdate,
  StoredUserTokens,
  SyncUser,
  UpsertUserInput,
  WatchDueUser,
  UserStore,
  WatchState,
} from './user-store';

/**
 * Supabase implementation of `UserStore`, using the service role key (server-side only).
 *
 * Generated database types live in the schema session's `types/`, which isn't merged yet,
 * so query results are treated as `unknown` and validated here.
 */

const TABLE = 'users';

/**
 * A first-time user arrived with no refresh token, so there is nothing to store (the
 * column is NOT NULL). Forced consent (§6.1) normally prevents this; signing in again fixes it.
 */
export class MissingRefreshTokenError extends Error {
  constructor(readonly googleId: string) {
    super('Google issued no refresh token for a new user; sign in again');
    this.name = 'MissingRefreshTokenError';
  }
}

/** PostgREST exchanges `bytea` as a `\x`-prefixed hex string. */
export function toByteaHex(buf: Buffer): string {
  return `\\x${buf.toString('hex')}`;
}

export function fromByteaHex(value: string): Buffer {
  if (!value.startsWith('\\x')) {
    throw new Error('Expected a \\x-prefixed hex bytea value');
  }
  return Buffer.from(value.slice(2), 'hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function requireString(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`users.${column} is missing or not a string`);
  }
  return value;
}

function tokenColumns(update: EncryptedTokenUpdate): Record<string, string> {
  const columns: Record<string, string> = {
    access_token_enc: toByteaHex(update.accessTokenEnc),
    token_expires_at: update.tokenExpiresAt.toISOString(),
  };
  // Omitting the column leaves the stored refresh token untouched (CONTRACT.md §3).
  if (update.refreshTokenEnc) {
    columns.refresh_token_enc = toByteaHex(update.refreshTokenEnc);
  }
  return columns;
}

export class SupabaseUserStore implements UserStore {
  constructor(private readonly client: SupabaseClient) {}

  static fromServiceRole(url: string | undefined, serviceRoleKey: string | undefined): SupabaseUserStore {
    if (!url || !serviceRoleKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    return new SupabaseUserStore(
      createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }),
    );
  }

  async upsertUserTokens(input: UpsertUserInput): Promise<{ userId: string }> {
    const columns = {
      google_id: input.googleId,
      email: input.email,
      ...tokenColumns(input),
      updated_at: new Date().toISOString(),
    };

    // Without a refresh token this can only update an existing user. An upsert that omits
    // refresh_token_enc fails even when the row exists: Postgres checks NOT NULL on the
    // INSERT half of INSERT ... ON CONFLICT before it resolves the conflict.
    const { data, error } = input.refreshTokenEnc
      ? await this.client.from(TABLE).upsert(columns, { onConflict: 'google_id' }).select('id').single()
      : await this.client.from(TABLE).update(columns).eq('google_id', input.googleId).select('id').maybeSingle();
    if (error) {
      throw new Error(`Failed to upsert user: ${error.message}`);
    }
    const row: unknown = data;
    if (row === null && !input.refreshTokenEnc) {
      throw new MissingRefreshTokenError(input.googleId);
    }
    if (!isRecord(row)) {
      throw new Error('Upsert returned no row');
    }
    return { userId: requireString(row, 'id') };
  }

  async updateUserTokens(googleId: string, update: EncryptedTokenUpdate): Promise<void> {
    const { error } = await this.client
      .from(TABLE)
      .update({ ...tokenColumns(update), updated_at: new Date().toISOString() })
      .eq('google_id', googleId);
    if (error) {
      throw new Error(`Failed to update tokens: ${error.message}`);
    }
  }

  async getUserTokens(googleId: string): Promise<StoredUserTokens | null> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('id, google_id, access_token_enc, refresh_token_enc, token_expires_at')
      .eq('google_id', googleId)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to read tokens: ${error.message}`);
    }
    const row: unknown = data;
    if (row === null) {
      return null;
    }
    if (!isRecord(row)) {
      throw new Error('Unexpected users row shape');
    }
    const refresh = row.refresh_token_enc;
    return {
      userId: requireString(row, 'id'),
      googleId: requireString(row, 'google_id'),
      accessTokenEnc: fromByteaHex(requireString(row, 'access_token_enc')),
      refreshTokenEnc: typeof refresh === 'string' ? fromByteaHex(refresh) : null,
      tokenExpiresAt: new Date(requireString(row, 'token_expires_at')),
    };
  }

  async saveWatch(googleId: string, watch: WatchState): Promise<void> {
    const { error } = await this.client
      .from(TABLE)
      .update({
        // bigint column; sent as a string so no precision is lost (CONTRACT.md §2).
        last_history_id: watch.lastHistoryId,
        watch_expiration: watch.watchExpiry.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('google_id', googleId);
    if (error) {
      throw new Error(`Failed to save watch: ${error.message}`);
    }
  }

  async findUserByEmail(email: string): Promise<SyncUser | null> {
    return this.findSyncUser('email', email);
  }

  async findUserById(userId: string): Promise<SyncUser | null> {
    return this.findSyncUser('id', userId);
  }

  private async findSyncUser(column: 'email' | 'id', value: string): Promise<SyncUser | null> {
    const { data, error } = await this.client
      .from(TABLE)
      // Cast to text so the bigint never passes through a JS number (CONTRACT.md §2).
      .select('id, google_id, last_history_id::text')
      .eq(column, value)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to find user by ${column}: ${error.message}`);
    }
    const row: unknown = data;
    if (row === null) {
      return null;
    }
    if (!isRecord(row)) {
      throw new Error('Unexpected users row shape');
    }
    const lastHistoryId = row.last_history_id;
    return {
      userId: requireString(row, 'id'),
      googleId: requireString(row, 'google_id'),
      lastHistoryId: typeof lastHistoryId === 'string' ? lastHistoryId : null,
    };
  }

  async findUsersWithWatchDue(cutoff: Date): Promise<WatchDueUser[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('id, google_id, watch_expiration')
      .or(`watch_expiration.is.null,watch_expiration.lte."${cutoff.toISOString()}"`);
    if (error) {
      throw new Error(`Failed to list users due for watch renewal: ${error.message}`);
    }
    const rows: unknown = data;
    if (!Array.isArray(rows)) {
      throw new Error('Unexpected users result');
    }
    return rows.map((row: unknown) => {
      if (!isRecord(row)) throw new Error('Unexpected users row shape');
      const expiration = row.watch_expiration;
      return {
        userId: requireString(row, 'id'),
        googleId: requireString(row, 'google_id'),
        watchExpiration: typeof expiration === 'string' ? new Date(expiration) : null,
      };
    });
  }

  async updateWatchExpiration(userId: string, expiresAt: Date): Promise<void> {
    const { error } = await this.client
      .from(TABLE)
      .update({ watch_expiration: expiresAt.toISOString(), updated_at: new Date().toISOString() })
      .eq('id', userId);
    if (error) {
      throw new Error(`Failed to update watch expiration: ${error.message}`);
    }
  }

  async advanceHistoryId(userId: string, historyId: string): Promise<boolean> {
    // The value is interpolated into a PostgREST filter, so accept digits only.
    if (!/^\d+$/.test(historyId)) {
      throw new Error(`Invalid historyId: ${historyId}`);
    }
    const { data, error } = await this.client
      .from(TABLE)
      .update({ last_history_id: historyId, updated_at: new Date().toISOString() })
      .eq('id', userId)
      .or(`last_history_id.is.null,last_history_id.lt.${historyId}`)
      .select('id');
    if (error) {
      throw new Error(`Failed to advance history id: ${error.message}`);
    }
    const rows: unknown = data;
    return Array.isArray(rows) && rows.length > 0;
  }
}
