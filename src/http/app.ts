import { createClient } from '@supabase/supabase-js';
import { waitUntil } from '@vercel/functions';
import { readConfig } from '../config';
import { createTokenCipher, parseEncryptionKey } from '../crypto/tokens';
import { SupabaseMessageStore } from '../db/supabase-message-store';
import { SupabaseUserStore } from '../db/supabase-user-store';
import { GmailAuth } from '../providers/gmail/auth';
import { connectGmailMailbox } from '../providers/gmail/mailbox';
import { preflightHandler, type AppDeps } from './handlers';
import { errorResponse } from './responses';

/**
 * Production dependencies, built once per function instance on first use. The server
 * talks to Supabase only with the service role key (CONTRACT.md §4 "Access control");
 * per-user scoping is enforced by every store call taking a user id.
 */

let cached: AppDeps | undefined;

export function productionDeps(): AppDeps {
  if (cached) return cached;
  const config = readConfig();
  const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const users = new SupabaseUserStore(supabase);
  const messages = new SupabaseMessageStore(supabase);
  const auth = new GmailAuth(
    {
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      redirectUri: config.googleRedirectUri,
      pubsubTopic: config.googlePubsubTopic,
    },
    { store: users, cipher: createTokenCipher(parseEncryptionKey(config.encryptionKey)) },
  );

  cached = {
    jwtSecret: config.jwtSecret,
    frontendUrl: config.frontendUrl,
    pubsubVerificationToken: config.pubsubVerificationToken,
    users,
    messages,
    auth,
    connect: (googleId) => connectGmailMailbox(auth, googleId),
    defer: (work) => waitUntil(work),
  };
  return cached;
}

type Handler = (request: Request) => Promise<Response>;

/**
 * Bind a handler factory to production dependencies at request time. A configuration
 * error (e.g. a missing environment variable) becomes a 500 envelope, not a crashed function.
 */
export function route(factory: (deps: AppDeps) => Handler): Handler {
  return async (request) => {
    let deps: AppDeps;
    try {
      deps = productionDeps();
    } catch (err) {
      console.error('Server is misconfigured', err);
      return errorResponse(500, 'INTERNAL_ERROR', 'Server is misconfigured');
    }
    return factory(deps)(request);
  };
}

/** CORS preflight (`OPTIONS`) for a route that accepts `methods`. */
export function preflight(methods: string[]): Handler {
  return route((deps) => preflightHandler(deps, methods));
}
