/** Error codes the frontend handles (CONTRACT.md §2, §3, §6). */
export type ApiErrorCode =
  | 'AUTH_FAILED'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'INTERNAL_ERROR';

const KNOWN_CODES: readonly string[] = [
  'AUTH_FAILED',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'INTERNAL_ERROR',
];

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  /** `details.recoverable` for `AUTH_FAILED` (§3); null for every other code. */
  readonly recoverable: boolean | null;

  constructor(code: ApiErrorCode, message: string, status: number, recoverable: boolean | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.recoverable = recoverable;
  }
}

/** The request got no response at all (offline, DNS, CORS block). It has no API code. */
export class NetworkError extends Error {
  constructor(message = 'No response from the server') {
    super(message);
    this.name = 'NetworkError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isKnownCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && KNOWN_CODES.includes(value);
}

/** Turn a parsed error envelope (`{ error: { code, message, details } }`) into an ApiError. */
export function errorFromEnvelope(status: number, body: unknown): ApiError {
  const envelope = isRecord(body) && isRecord(body.error) ? body.error : null;
  const code = envelope && isKnownCode(envelope.code) ? envelope.code : 'INTERNAL_ERROR';
  const message = envelope && typeof envelope.message === 'string' ? envelope.message : `Request failed (${status})`;
  let recoverable: boolean | null = null;
  if (code === 'AUTH_FAILED') {
    const details = envelope && isRecord(envelope.details) ? envelope.details : null;
    recoverable = details && typeof details.recoverable === 'boolean' ? details.recoverable : true;
  }
  return new ApiError(code, message, status, recoverable);
}

export async function errorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return errorFromEnvelope(response.status, body);
}

export function isAuthFailed(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === 'AUTH_FAILED';
}

/** Sign-in screen copy for an `AUTH_FAILED` (docs/DESIGN_SPEC.md "Session handling"). */
export function signInNotice(recoverable: boolean | null): string {
  return recoverable === false
    ? 'Google access was revoked. Sign in again and approve access to continue.'
    : 'Your session ended. Sign in again to continue.';
}
