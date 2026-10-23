export const TOKEN_KEY = 'vibemail.token';
export const NOTICE_KEY = 'vibemail.signin-notice';
export const MODE_KEY = 'vibemail.mode';

/** gmail = real mailbox through the API; sample = built-in pretend mail, no account. */
export type LaunchMode = 'gmail' | 'sample';

export function readMode(storage: Storage = window.localStorage): LaunchMode | null {
  try {
    const value = storage.getItem(MODE_KEY);
    return value === 'gmail' || value === 'sample' ? value : null;
  } catch {
    return null;
  }
}

export function writeMode(mode: LaunchMode, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(MODE_KEY, mode);
  } catch {
    // Without storage the choice lasts only until reload.
  }
}

export function clearMode(storage: Storage = window.localStorage): void {
  try {
    storage.removeItem(MODE_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function readToken(storage: Storage = window.localStorage): string | null {
  try {
    return storage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(TOKEN_KEY, token);
  } catch {
    // Without storage the session lasts only until reload.
  }
}

export function clearToken(storage: Storage = window.localStorage): void {
  try {
    storage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Pull `token` out of a `#token=<jwt>` URL fragment (CONTRACT.md §6.2); null if absent. */
export function tokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const token = params.get('token');
  return token && token.length > 0 ? token : null;
}

export function setNotice(message: string, storage: Storage = window.sessionStorage): void {
  try {
    storage.setItem(NOTICE_KEY, message);
  } catch {
    // The notice is a courtesy.
  }
}

/** Read and clear the pending sign-in notice. */
export function takeNotice(storage: Storage = window.sessionStorage): string | null {
  try {
    const message = storage.getItem(NOTICE_KEY);
    if (message) storage.removeItem(NOTICE_KEY);
    return message;
  } catch {
    return null;
  }
}
