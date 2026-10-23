/**
 * Environment configuration, read once and validated (CLAUDE.md lists the variables).
 * Nothing is hardcoded; a missing variable fails loudly with every missing name listed.
 */

export interface AppConfig {
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  googlePubsubTopic: string;
  pubsubVerificationToken: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  jwtSecret: string;
  encryptionKey: string;
  /** Origin of the frontend, e.g. `http://localhost:3001` (no trailing slash). */
  frontendUrl: string;
  /** Vercel Cron sends it as `Authorization: Bearer <CRON_SECRET>` (§6.7). */
  cronSecret: string;
}

const VARIABLES = {
  googleClientId: 'GOOGLE_CLIENT_ID',
  googleClientSecret: 'GOOGLE_CLIENT_SECRET',
  googleRedirectUri: 'GOOGLE_REDIRECT_URI',
  googlePubsubTopic: 'GOOGLE_PUBSUB_TOPIC',
  pubsubVerificationToken: 'GOOGLE_PUBSUB_VERIFICATION_TOKEN',
  supabaseUrl: 'SUPABASE_URL',
  supabaseServiceRoleKey: 'SUPABASE_SERVICE_ROLE_KEY',
  jwtSecret: 'JWT_SECRET',
  encryptionKey: 'ENCRYPTION_KEY',
  frontendUrl: 'FRONTEND_URL',
  cronSecret: 'CRON_SECRET',
} as const satisfies Record<keyof AppConfig, string>;

/** A variable's value without the stray spaces, tabs or newlines that copy-paste adds; empty if unset. */
function clean(env: NodeJS.ProcessEnv, name: string): string {
  return env[name]?.trim() ?? '';
}

/**
 * Values are trimmed: a stray tab on `GOOGLE_REDIRECT_URI` once made Google reject every sign-in.
 * A value that is only whitespace counts as missing.
 * @throws Error naming every missing variable.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing = Object.values(VARIABLES).filter((name) => !clean(env, name));
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
  const value = (key: keyof AppConfig): string => clean(env, VARIABLES[key]);
  return {
    googleClientId: value('googleClientId'),
    googleClientSecret: value('googleClientSecret'),
    googleRedirectUri: value('googleRedirectUri'),
    googlePubsubTopic: value('googlePubsubTopic'),
    pubsubVerificationToken: value('pubsubVerificationToken'),
    supabaseUrl: value('supabaseUrl'),
    supabaseServiceRoleKey: value('supabaseServiceRoleKey'),
    jwtSecret: value('jwtSecret'),
    encryptionKey: value('encryptionKey'),
    frontendUrl: value('frontendUrl').replace(/\/+$/, ''),
    cronSecret: value('cronSecret'),
  };
}
