import { describe, expect, it } from 'vitest';
import { ApiError, errorFromEnvelope, isAuthFailed, signInNotice } from '@/lib/errors';

describe('errorFromEnvelope', () => {
  it('maps every contract error code', () => {
    for (const code of ['INVALID_REQUEST', 'NOT_FOUND', 'RATE_LIMITED', 'PROVIDER_ERROR', 'INTERNAL_ERROR'] as const) {
      const error = errorFromEnvelope(400, { error: { code, message: 'm' } });
      expect(error.code).toBe(code);
      expect(error.recoverable).toBeNull();
    }
  });

  it('carries details.recoverable for AUTH_FAILED', () => {
    expect(errorFromEnvelope(401, { error: { code: 'AUTH_FAILED', message: 'x', details: { recoverable: true } } }).recoverable).toBe(true);
    expect(errorFromEnvelope(401, { error: { code: 'AUTH_FAILED', message: 'x', details: { recoverable: false } } }).recoverable).toBe(false);
  });

  it('treats AUTH_FAILED without details as recoverable', () => {
    expect(errorFromEnvelope(401, { error: { code: 'AUTH_FAILED', message: 'x' } }).recoverable).toBe(true);
  });

  it('falls back to INTERNAL_ERROR for unknown codes and malformed bodies', () => {
    expect(errorFromEnvelope(500, { error: { code: 'WHO_KNOWS', message: 'x' } }).code).toBe('INTERNAL_ERROR');
    expect(errorFromEnvelope(502, 'not json').code).toBe('INTERNAL_ERROR');
    expect(errorFromEnvelope(500, null).message).toContain('500');
  });

  it('identifies AUTH_FAILED', () => {
    expect(isAuthFailed(new ApiError('AUTH_FAILED', 'x', 401, true))).toBe(true);
    expect(isAuthFailed(new ApiError('NOT_FOUND', 'x', 404))).toBe(false);
    expect(isAuthFailed(new Error('x'))).toBe(false);
  });
});

describe('signInNotice', () => {
  it('distinguishes a session that ended from revoked Google access', () => {
    expect(signInNotice(true)).toMatch(/session ended/i);
    expect(signInNotice(false)).toMatch(/revoked/i);
  });
});
