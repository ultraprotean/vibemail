import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Live Supabase for the integration suite (BUILD_SEQUENCE.md unit 7). Supabase is never
 * mocked. Every test file works under its own `it-<label>-<run>` namespace and deletes
 * its rows afterwards (`messages` cascade from `users`).
 *
 * Missing credentials fail the suite instead of skipping it: the unit 7 gate requires
 * zero skipped tests.
 */

// Jest gives each test file its own process.env, so `process.loadEnvFile` (which writes the
// real one) wouldn't reach it: parse .env and copy values in, never overriding the environment.
if (existsSync('.env')) {
  for (const [key, value] of Object.entries(parseEnv(readFileSync('.env', 'utf8')))) {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
  }
}

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error(
    'Integration tests run against live Supabase and need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY ' +
      '(in .env or the environment). Use `npm run test:unit` to run without a database.',
  );
}

jest.setTimeout(60_000);

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

/** The live database, as the server sees it (service role). */
export const db: SupabaseClient = createClient(url, serviceRoleKey, clientOptions);

/** A client whose every request fails authentication: a real Supabase failure, not a mock. */
export function brokenDb(): SupabaseClient {
  return createClient(url ?? '', 'not-a-valid-key', clientOptions);
}

export interface LiveContext {
  runId: string;
  googleId(n: number | string): string;
  email(n: number | string): string;
  /** Delete every user (and, by cascade, message) this context created. */
  cleanup(): Promise<void>;
}

export function liveContext(label: string): LiveContext {
  const runId = `it-${label}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  return {
    runId,
    googleId: (n) => `${runId}-${n}`,
    email: (n) => `${runId}-${n}@vibemail.test`,
    async cleanup() {
      const { error } = await db.from('users').delete().like('google_id', `${runId}-%`);
      if (error) throw new Error(`Integration cleanup failed: ${error.message}`);
    },
  };
}

/** Remove leftovers from integration runs that crashed more than an hour ago. */
export async function purgeStaleRuns(): Promise<void> {
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { error } = await db.from('users').delete().like('google_id', 'it-%').lt('created_at', hourAgo);
  if (error) throw new Error(`Stale integration cleanup failed: ${error.message}`);
}

/** Read one raw `users` row, bypassing the store under test. */
export async function rawUser(googleId: string): Promise<Record<string, unknown>> {
  const { data, error } = await db
    .from('users')
    .select('id, google_id, email, access_token_enc, refresh_token_enc, token_expires_at, last_history_id::text, watch_expiration')
    .eq('google_id', googleId)
    .single();
  if (error) throw new Error(`rawUser: ${error.message}`);
  return { ...(data as object) };
}

/** Read one raw `messages` row, bypassing the store under test. */
export async function rawMessage(userId: string, id: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from('messages')
    .select('*, history_text:history_id::text')
    .eq('user_id', userId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`rawMessage: ${error.message}`);
  return data === null ? null : { ...(data as object) };
}

export async function messageIds(userId: string): Promise<string[]> {
  const { data, error } = await db.from('messages').select('id').eq('user_id', userId).order('id');
  if (error) throw new Error(`messageIds: ${error.message}`);
  return (data ?? []).map((row: { id: string }) => row.id);
}

/** Decode a PostgREST `\x…` bytea value. */
export function bytea(value: unknown): Buffer {
  if (typeof value !== 'string' || !value.startsWith('\\x')) throw new Error(`Not a bytea value: ${String(value)}`);
  return Buffer.from(value.slice(2), 'hex');
}
