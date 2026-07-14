import { createCipheriv, createDecipheriv, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

export interface EncryptedValue { ciphertext: string; nonce: string; authTag: string }

const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const BASE64URL = /^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}|[A-Za-z0-9_-]{3})?$/;
const DIGEST_HEX = /^[a-f0-9]{64}$/;

function decodeBase64Url(value: string, field: string): Buffer {
  if (typeof value !== 'string' || !BASE64URL.test(value)) {
    throw new Error(`invalid base64url ${field}`);
  }

  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) {
    throw new Error(`invalid base64url ${field}`);
  }
  return decoded;
}

export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function constantTimeDigestMatch(value: string, expectedHex: string): boolean {
  if (!DIGEST_HEX.test(expectedHex)) return false;

  const actual = Buffer.from(digest(value), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function encryptValue(value: string, key: Buffer): EncryptedValue {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64url'),
    nonce: nonce.toString('base64url'),
    authTag: cipher.getAuthTag().toString('base64url'),
  };
}

export function decryptValue(value: EncryptedValue, key: Buffer): string {
  const nonce = decodeBase64Url(value.nonce, 'nonce');
  if (nonce.length !== NONCE_BYTES) throw new Error(`invalid nonce length: expected ${NONCE_BYTES}`);

  const authTag = decodeBase64Url(value.authTag, 'authTag');
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new Error(`invalid authTag length: expected ${AUTH_TAG_BYTES}`);
  }

  const ciphertext = decodeBase64Url(value.ciphertext, 'ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}
