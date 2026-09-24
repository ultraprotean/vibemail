import { SessionError } from '../../src/auth/jwt';
import { TokenDecryptionError } from '../../src/crypto/tokens';
import { readCookie, stateCookie } from '../../src/http/cookies';
import { decodeCursor, encodeCursor } from '../../src/http/cursor';
import { InvalidRequestError, toErrorResponse } from '../../src/http/responses';
import { PostConsentSetupError } from '../../src/providers/gmail/auth';
import { MessageNotFoundError } from '../../src/read-state';
import { SendValidationError } from '../../src/send/mime';
import { ProviderError, type ProviderErrorKind } from '../../src/types/provider';

describe('toErrorResponse (CONTRACT.md error envelope)', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  async function envelope(err: unknown): Promise<{ status: number; body: unknown }> {
    const res = toErrorResponse(err);
    expect(res.headers.get('content-type')).toBe('application/json');
    return { status: res.status, body: await res.json() };
  }

  it.each<[string, unknown, number, unknown]>([
    ['session error', new SessionError('expired', 'expired'), 401, { code: 'AUTH_FAILED', details: { recoverable: true } }],
    ['revoked refresh token', new ProviderError('AUTH_REVOKED', 'dead'), 401, { code: 'AUTH_FAILED', details: { recoverable: false } }],
    ['invalid auth code', new ProviderError('AUTH_CODE_INVALID', 'bad code'), 400, { code: 'AUTH_FAILED', details: { recoverable: true } }],
    ['invalid request', new InvalidRequestError('bad'), 400, { code: 'INVALID_REQUEST' }],
    ['send validation', new SendValidationError('bad to'), 400, { code: 'INVALID_REQUEST' }],
    ['local not found', new MessageNotFoundError('m1'), 404, { code: 'NOT_FOUND' }],
    ['provider not found', new ProviderError('NOT_FOUND', 'gone'), 404, { code: 'NOT_FOUND' }],
    ['rate limit', new ProviderError('RATE_LIMITED', 'quota'), 429, { code: 'RATE_LIMITED' }],
    ['gmail failure', new ProviderError('UPSTREAM', 'boom'), 502, { code: 'PROVIDER_ERROR' }],
    ['post-consent setup failure', new PostConsentSetupError('watch failed'), 502, { code: 'PROVIDER_ERROR' }],
    ['corrupt stored token', new TokenDecryptionError('bad tag'), 500, { code: 'INTERNAL_ERROR' }],
    ['anything else', new Error('secret internals'), 500, { code: 'INTERNAL_ERROR' }],
  ])('maps %s', async (_label, err, status, error) => {
    const res = await envelope(err);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: expect.objectContaining({ ...(error as object), message: expect.any(String) }) });
  });

  it('never leaks the message of an unexpected error', async () => {
    const { body } = await envelope(new Error('password=hunter2'));
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('omits details when there are none', async () => {
    const { body } = await envelope(new InvalidRequestError('bad'));
    expect(body).toEqual({ error: { code: 'INVALID_REQUEST', message: 'bad' } });
  });

  it('covers every provider error kind', () => {
    const kinds: ProviderErrorKind[] = [
      'AUTH_CODE_INVALID',
      'AUTH_SCOPE_MISSING',
      'AUTH_REVOKED',
      'RATE_LIMITED',
      'NOT_FOUND',
      'CURSOR_EXPIRED',
      'UPSTREAM',
    ];
    for (const kind of kinds) {
      expect(toErrorResponse(new ProviderError(kind, 'x')).status).not.toBe(500);
    }
  });
});

describe('cursor', () => {
  it('round-trips a position', () => {
    const position = { receivedAt: new Date('2026-01-01T00:00:00.123Z'), id: '18c2f0a1b2' };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it.each(['', 'not-base64-json', Buffer.from('{"r":"nope","i":"x"}').toString('base64url'),
    Buffer.from('{"r":"2026-01-01T00:00:00Z","i":"bad id,with)chars"}').toString('base64url')])(
    'rejects %p as INVALID_REQUEST',
    (cursor) => {
      expect(() => decodeCursor(cursor)).toThrow(InvalidRequestError);
    },
  );
});

describe('cookies', () => {
  it('sets a hardened, short-lived state cookie', () => {
    const cookie = stateCookie('abc');
    expect(cookie).toContain('oauth_state=abc');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
  });

  it('reads a cookie from a header with several', () => {
    expect(readCookie('a=1; oauth_state=xyz; b=2', 'oauth_state')).toBe('xyz');
    expect(readCookie('a=1', 'oauth_state')).toBeUndefined();
    expect(readCookie(null, 'oauth_state')).toBeUndefined();
  });
});
