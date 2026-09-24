import { randomBytes } from 'node:crypto';
import { createTokenCipher, parseEncryptionKey, TokenDecryptionError } from '../../src/crypto/tokens';

describe('parseEncryptionKey', () => {
  const key = randomBytes(32);

  it('accepts 64 hex characters', () => {
    expect(parseEncryptionKey(key.toString('hex')).equals(key)).toBe(true);
  });

  it('accepts base64', () => {
    expect(parseEncryptionKey(key.toString('base64')).equals(key)).toBe(true);
  });

  it('rejects a missing key', () => {
    expect(() => parseEncryptionKey(undefined)).toThrow('ENCRYPTION_KEY is not set');
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow('must be 32 bytes');
  });
});

describe('createTokenCipher', () => {
  const cipher = createTokenCipher(randomBytes(32));

  it('round-trips a token', () => {
    expect(cipher.decrypt(cipher.encrypt('ya29.access-token'))).toBe('ya29.access-token');
  });

  it('uses a fresh IV for every encryption', () => {
    expect(cipher.encrypt('same').equals(cipher.encrypt('same'))).toBe(false);
  });

  it('stores iv (12) + tag (16) + ciphertext', () => {
    expect(cipher.encrypt('abc')).toHaveLength(12 + 16 + 3);
  });

  it('rejects a tampered ciphertext', () => {
    const blob = cipher.encrypt('secret');
    blob[blob.length - 1] ^= 0xff;
    expect(() => cipher.decrypt(blob)).toThrow(TokenDecryptionError);
  });

  it('rejects a blob encrypted with another key', () => {
    const other = createTokenCipher(randomBytes(32));
    expect(() => cipher.decrypt(other.encrypt('secret'))).toThrow(TokenDecryptionError);
  });

  it('rejects a blob too short to hold an IV and tag', () => {
    expect(() => cipher.decrypt(Buffer.alloc(10))).toThrow(TokenDecryptionError);
  });
});
