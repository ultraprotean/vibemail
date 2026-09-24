import jwt from 'jsonwebtoken';
import { bearerToken, issueSessionToken, SessionError, verifySessionToken } from '../../src/auth/jwt';

const SECRET = 'test-secret';

describe('session JWT', () => {
  it('round-trips the user id as sub, valid for one hour', () => {
    const token = issueSessionToken('user-1', SECRET);
    expect(verifySessionToken(token, SECRET)).toEqual({ userId: 'user-1' });
    const decoded = jwt.decode(token);
    expect(decoded).toMatchObject({ sub: 'user-1' });
    if (decoded && typeof decoded !== 'string' && decoded.exp && decoded.iat) {
      expect(decoded.exp - decoded.iat).toBe(3600);
    }
  });

  it('rejects an expired token as expired', () => {
    const token = issueSessionToken('user-1', SECRET, -10);
    expect(() => verifySessionToken(token, SECRET)).toThrow(expect.objectContaining({ reason: 'expired' }));
  });

  it('rejects a token signed with another secret', () => {
    const token = issueSessionToken('user-1', 'other-secret');
    expect(() => verifySessionToken(token, SECRET)).toThrow(SessionError);
  });

  it('rejects an unsigned ("alg: none") token', () => {
    const unsigned = jwt.sign({ sub: 'user-1' }, '', { algorithm: 'none' });
    expect(() => verifySessionToken(unsigned, SECRET)).toThrow(SessionError);
  });

  it('rejects a token without a subject', () => {
    const token = jwt.sign({}, SECRET, { algorithm: 'HS256', expiresIn: 60 });
    expect(() => verifySessionToken(token, SECRET)).toThrow(SessionError);
  });

  it('rejects garbage', () => {
    expect(() => verifySessionToken('not.a.jwt', SECRET)).toThrow(SessionError);
  });
});

describe('bearerToken', () => {
  it('extracts the token', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer   abc')).toBe('abc');
  });

  it('reports a missing header', () => {
    expect(() => bearerToken(null)).toThrow(expect.objectContaining({ reason: 'missing' }));
  });

  it.each(['Basic abc', 'Bearer', 'Bearer a b', 'abc'])('reports %p as malformed', (header) => {
    expect(() => bearerToken(header)).toThrow(expect.objectContaining({ reason: 'malformed' }));
  });
});
