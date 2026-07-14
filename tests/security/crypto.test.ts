import { describe, expect, it } from 'vitest';
import {
  constantTimeDigestMatch,
  decryptValue,
  digest,
  encryptValue,
} from '../../src/security/crypto.js';

describe('crypto', () => {
  it('encrypts, authenticates, and decrypts a value', () => {
    const key = Buffer.alloc(32, 7);
    const envelope = encryptValue('asqsk_demo_secret', key);
    expect(decryptValue(envelope, key)).toBe('asqsk_demo_secret');
    expect(digest('a')).not.toBe(digest('b'));
  });

  it('emits base64url envelope fields with 12-byte nonce and 16-byte auth tag', () => {
    const envelope = encryptValue('asqsk_demo_secret', Buffer.alloc(32, 7));
    const base64url = /^[A-Za-z0-9_-]*$/;

    expect(envelope.ciphertext).toMatch(base64url);
    expect(envelope.nonce).toMatch(base64url);
    expect(envelope.authTag).toMatch(base64url);
    expect(Buffer.from(envelope.nonce, 'base64url')).toHaveLength(12);
    expect(Buffer.from(envelope.authTag, 'base64url')).toHaveLength(16);
  });

  it('rejects an envelope with an invalid authentication tag', () => {
    const key = Buffer.alloc(32, 7);
    const envelope = encryptValue('asqsk_demo_secret', key);
    const tampered = { ...envelope, authTag: Buffer.alloc(16).toString('base64url') };

    expect(() => decryptValue(tampered, key)).toThrow();
  });

  it('rejects malformed or incorrectly sized envelope fields', () => {
    const key = Buffer.alloc(32, 7);
    const envelope = encryptValue('asqsk_demo_secret', key);

    expect(() => decryptValue({ ...envelope, nonce: 'bad?' }, key)).toThrow('invalid base64url nonce');
    expect(() => decryptValue({ ...envelope, nonce: Buffer.alloc(11).toString('base64url') }, key))
      .toThrow('invalid nonce length');
    expect(() => decryptValue({ ...envelope, authTag: Buffer.alloc(15).toString('base64url') }, key))
      .toThrow('invalid authTag length');
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => encryptValue('asqsk_demo_secret', Buffer.alloc(31))).toThrow();
  });

  it('compares digests in constant time', () => {
    const expected = digest('asqsk_demo_secret');

    expect(constantTimeDigestMatch('asqsk_demo_secret', expected)).toBe(true);
    expect(constantTimeDigestMatch('other_secret', expected)).toBe(false);
    expect(constantTimeDigestMatch('asqsk_demo_secret', expected.toUpperCase())).toBe(false);
    expect(constantTimeDigestMatch('asqsk_demo_secret', 'g'.repeat(64))).toBe(false);
    expect(constantTimeDigestMatch('asqsk_demo_secret', expected.slice(0, -1))).toBe(false);
    expect(constantTimeDigestMatch('asqsk_demo_secret', `${expected}zz`)).toBe(false);
  });
});
