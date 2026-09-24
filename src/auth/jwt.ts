import jwt from 'jsonwebtoken';

/**
 * Session JWTs (CONTRACT.md §2): HS256, signed with `JWT_SECRET`, `sub` = `users.id`,
 * valid for one hour. Any problem with the token is a recoverable auth failure (§3):
 * the client re-runs the OAuth flow to get a new one.
 */

export const SESSION_TTL_SECONDS = 60 * 60;
const ALGORITHM = 'HS256';

export type SessionErrorReason = 'missing' | 'malformed' | 'expired' | 'invalid';

/** Maps to 401 `AUTH_FAILED`, `recoverable: true`. */
export class SessionError extends Error {
  constructor(readonly reason: SessionErrorReason, message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

export function issueSessionToken(userId: string, secret: string, ttlSeconds = SESSION_TTL_SECONDS): string {
  return jwt.sign({}, secret, { algorithm: ALGORITHM, subject: userId, expiresIn: ttlSeconds });
}

/**
 * Verify a session token and return its user id.
 * @throws SessionError for an expired, tampered, wrongly signed or subject-less token.
 */
export function verifySessionToken(token: string, secret: string): { userId: string } {
  let payload: string | jwt.JwtPayload;
  try {
    // Pin the algorithm so a token can't choose a weaker one (e.g. "none").
    payload = jwt.verify(token, secret, { algorithms: [ALGORITHM] });
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new SessionError('expired', 'Session token has expired');
    throw new SessionError('invalid', 'Session token is invalid');
  }
  if (typeof payload === 'string' || !payload.sub) {
    throw new SessionError('invalid', 'Session token has no subject');
  }
  return { userId: payload.sub };
}

/**
 * Pull the token out of an `Authorization: Bearer <jwt>` header.
 * @throws SessionError `missing` or `malformed`.
 */
export function bearerToken(header: string | null): string {
  if (!header) throw new SessionError('missing', 'Authorization header is missing');
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) throw new SessionError('malformed', 'Authorization header must be "Bearer <token>"');
  return match[1];
}
