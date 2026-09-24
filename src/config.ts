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
} as const satisfies Record<keyof AppConfig, string>;

/** @throws Error naming every missing variable. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing = Object.values(VARIABLES).filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }
  const value = (key: keyof AppConfig): string => env[VARIABLES[key]] ?? '';
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
  };
}
