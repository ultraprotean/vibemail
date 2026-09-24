import { SessionError } from '../auth/jwt';
import { TokenDecryptionError } from '../crypto/tokens';
import { MissingRefreshTokenError } from '../db/supabase-user-store';
import { PostConsentSetupError } from '../providers/gmail/auth';
import { MessageNotFoundError } from '../read-state';
import { SendValidationError } from '../send/mime';
import { ProviderError } from '../types/provider';

/**
 * JSON responses and the CONTRACT.md §2 error envelope:
 * `{ "error": { "code", "message", "details"? } }`.
 */

export type ErrorCode =
  | 'AUTH_FAILED'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'INTERNAL_ERROR'
  | 'UNAUTHORIZED'
  | 'METHOD_NOT_ALLOWED';

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

type Headers = Record<string, string>;

export function jsonResponse(status: number, body: unknown, headers: Headers = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  headers: Headers = {},
): Response {
  const envelope: ErrorEnvelope = { error: details ? { code, message, details } : { code, message } };
  return jsonResponse(status, envelope, headers);
}

/** §3: every session-related failure is `AUTH_FAILED` carrying a `recoverable` flag. */
export function authFailed(status: 400 | 401 | 502, message: string, recoverable: boolean, headers: Headers = {}): Response {
  return errorResponse(status, 'AUTH_FAILED', message, { recoverable }, headers);
}

/** Thrown by handlers for a request the client must fix. Maps to 400 `INVALID_REQUEST`. */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

/**
 * Map any error from the service layer to its contract response. Unknown errors become a
 * generic 500 whose message never leaks internals; they are logged instead.
 */
export function toErrorResponse(err: unknown, headers: Headers = {}): Response {
  if (err instanceof SessionError) return authFailed(401, err.message, true, headers);
  if (err instanceof MissingRefreshTokenError) return authFailed(400, err.message, true, headers);
  if (err instanceof InvalidRequestError || err instanceof SendValidationError) {
    return errorResponse(400, 'INVALID_REQUEST', err.message, undefined, headers);
  }
  if (err instanceof MessageNotFoundError) return errorResponse(404, 'NOT_FOUND', err.message, undefined, headers);
  if (err instanceof PostConsentSetupError) {
    return errorResponse(502, 'PROVIDER_ERROR', 'Signed in, but Gmail setup failed; retry sign-in', undefined, headers);
  }
  if (err instanceof ProviderError) {
    switch (err.kind) {
      case 'AUTH_REVOKED':
        return authFailed(401, 'Gmail access was revoked; complete Google sign-in again', false, headers);
      case 'AUTH_CODE_INVALID':
      case 'AUTH_SCOPE_MISSING':
        return authFailed(400, err.message, true, headers);
      case 'RATE_LIMITED':
        return errorResponse(429, 'RATE_LIMITED', 'Gmail API quota exceeded; retry later', undefined, headers);
      case 'NOT_FOUND':
        return errorResponse(404, 'NOT_FOUND', err.message, undefined, headers);
      case 'CURSOR_EXPIRED':
      case 'UPSTREAM':
        return errorResponse(502, 'PROVIDER_ERROR', 'Gmail API request failed', undefined, headers);
    }
  }
  if (err instanceof TokenDecryptionError) {
    console.error('Stored token failed decryption', err);
  } else {
    console.error('Unhandled error', err);
  }
  return errorResponse(500, 'INTERNAL_ERROR', 'Unexpected server error', undefined, headers);
}

/** Run a handler body, turning any thrown error into its contract response. */
export async function handleErrors(run: () => Promise<Response>, headers: Headers = {}): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    return toErrorResponse(err, headers);
  }
}
