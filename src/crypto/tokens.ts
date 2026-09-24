import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Application-level token encryption (CONTRACT.md §4, "Token encryption").
 *
 * AES-256-GCM with a fresh 12-byte IV per encryption. Stored layout:
 * `iv (12) ‖ authTag (16) ‖ ciphertext`.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface TokenCipher {
  encrypt(plaintext: string): Buffer;
  /** @throws TokenDecryptionError if the blob is malformed or fails authentication. */
  decrypt(blob: Buffer): string;
}

/** Stored ciphertext is corrupt or was encrypted with another key. Maps to INTERNAL_ERROR. */
export class TokenDecryptionError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'TokenDecryptionError';
  }
}

/**
 * Parse `ENCRYPTION_KEY`: exactly 32 bytes, given as 64 hex characters or as base64.
 * @throws Error if the key is missing or not 32 bytes.
 */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw) {
    throw new Error('ENCRYPTION_KEY is not set');
  }
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `ENCRYPTION_KEY must be ${KEY_BYTES} bytes (64 hex chars or base64); got ${key.length} bytes`,
    );
  }
  return key;
}

export function createTokenCipher(key: Buffer): TokenCipher {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption key must be ${KEY_BYTES} bytes; got ${key.length}`);
  }

  return {
    encrypt(plaintext: string): Buffer {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    },

    decrypt(blob: Buffer): string {
      if (blob.length < IV_BYTES + TAG_BYTES) {
        throw new TokenDecryptionError('Encrypted token is too short to be valid');
      }
      const iv = blob.subarray(0, IV_BYTES);
      const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch (err) {
        throw new TokenDecryptionError('Encrypted token failed authentication', err);
      }
    },
  };
}
