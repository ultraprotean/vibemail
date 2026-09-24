import { bearerToken, SessionError, verifySessionToken } from '../auth/jwt';
import type { SyncUser, UserStore } from '../db/user-store';

/**
 * JWT middleware for the authenticated routes (CONTRACT.md §2, §3): verify the Bearer
 * token, then load the user its `sub` names. Every failure here is a `SessionError`,
 * which maps to 401 `AUTH_FAILED` with `recoverable: true`.
 */

export interface SessionDeps {
  jwtSecret: string;
  users: Pick<UserStore, 'findUserById'>;
}

/** @throws SessionError if the token is missing, invalid, expired, or names no user. */
export async function authenticate(request: Request, deps: SessionDeps): Promise<SyncUser> {
  const token = bearerToken(request.headers.get('authorization'));
  const { userId } = verifySessionToken(token, deps.jwtSecret);
  const user = await deps.users.findUserById(userId);
  if (!user) throw new SessionError('invalid', 'Session user no longer exists');
  return user;
}

/** Wrap a handler so it only runs with an authenticated user. */
export function withAuth(
  deps: SessionDeps,
  handler: (request: Request, user: SyncUser) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => handler(request, await authenticate(request, deps));
}
