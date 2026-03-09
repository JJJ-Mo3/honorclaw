import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { encryptSecret, decryptSecret } from './crypto.js';

describe('crypto', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Generate a valid 32-byte key
    process.env.HONORCLAW_MASTER_KEY = crypto.randomBytes(32).toString('base64');
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.HONORCLAW_MASTER_KEY = originalEnv.HONORCLAW_MASTER_KEY;
    process.env.NODE_ENV = originalEnv.NODE_ENV;
  });

  it('round-trips: encrypt then decrypt returns original', () => {
    const plaintext = 'my-super-secret-api-key-12345';
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).toMatch(/^enc:/);
    expect(encrypted).not.toContain(plaintext);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const plaintext = 'same-value';
    const a = encryptSecret(plaintext);
    const b = encryptSecret(plaintext);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(plaintext);
    expect(decryptSecret(b)).toBe(plaintext);
  });

  it('handles empty string', () => {
    const encrypted = encryptSecret('');
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe('');
  });

  it('handles unicode characters', () => {
    const plaintext = 'Unicode: éàü 日本語 🔐';
    const encrypted = encryptSecret(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it('treats non-enc: prefix as legacy plaintext', () => {
    expect(decryptSecret('plain-value')).toBe('plain-value');
    expect(decryptSecret('')).toBe('');
  });

  it('throws when decrypting with wrong key', () => {
    const encrypted = encryptSecret('secret');
    // Change to a different key
    process.env.HONORCLAW_MASTER_KEY = crypto.randomBytes(32).toString('base64');
    expect(() => decryptSecret(encrypted)).toThrow();
  });

  it('throws in production when master key is missing', () => {
    delete process.env.HONORCLAW_MASTER_KEY;
    expect(() => encryptSecret('value')).toThrow('HONORCLAW_MASTER_KEY must be set in production');
  });

  it('throws when key is wrong length', () => {
    process.env.HONORCLAW_MASTER_KEY = crypto.randomBytes(16).toString('base64'); // 16 bytes, not 32
    expect(() => encryptSecret('value')).toThrow('must be exactly 32 bytes');
  });

  it('returns plaintext in dev mode without key', () => {
    delete process.env.HONORCLAW_MASTER_KEY;
    process.env.NODE_ENV = 'development';
    const result = encryptSecret('dev-secret');
    expect(result).toBe('dev-secret');
  });

  it('throws when trying to decrypt enc: value without key', () => {
    const encrypted = encryptSecret('secret');
    delete process.env.HONORCLAW_MASTER_KEY;
    expect(() => decryptSecret(encrypted)).toThrow('HONORCLAW_MASTER_KEY is required');
  });
});
