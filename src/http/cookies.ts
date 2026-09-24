/** Minimal cookie parsing and the OAuth state cookie (CONTRACT.md §6.1). */

export const OAUTH_STATE_COOKIE = 'oauth_state';
const STATE_COOKIE_PATH = '/api/v1/auth';
const STATE_MAX_AGE_SECONDS = 10 * 60;

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) {
      return decodeURIComponent(pair.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/**
 * `HttpOnly` so scripts can't read it, `Secure` so it only travels over HTTPS (browsers
 * treat `http://localhost` as secure), `SameSite=Lax` so it survives Google's top-level
 * redirect back to the callback.
 */
export function stateCookie(state: string): string {
  return `${OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}; Path=${STATE_COOKIE_PATH}; Max-Age=${STATE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearStateCookie(): string {
  return `${OAUTH_STATE_COOKIE}=; Path=${STATE_COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}
