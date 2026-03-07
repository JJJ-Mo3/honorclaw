// Shared AES-256-GCM encryption helpers using HONORCLAW_MASTER_KEY
import crypto from 'node:crypto';

function getMasterKey(): Buffer | null {
  const masterKeyBase64 = process.env.HONORCLAW_MASTER_KEY;
  if (!masterKeyBase64) {
    return null;
  }
  const key = Buffer.from(masterKeyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('HONORCLAW_MASTER_KEY must be exactly 32 bytes (base64-encoded)');
  }
  return key;
}

/**
 * Encrypt a plaintext string with AES-256-GCM using HONORCLAW_MASTER_KEY.
 * Returns "enc:" + base64(iv || authTag || ciphertext).
 * In dev mode without a master key, returns plaintext with a warning.
 */
export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('HONORCLAW_MASTER_KEY must be set in production to encrypt secrets');
    }
    console.warn('[crypto] WARNING: HONORCLAW_MASTER_KEY not set — storing secret unencrypted');
    return plaintext;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64( iv || tag || ciphertext ) prefixed with "enc:" so we know it's encrypted
  return 'enc:' + Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypt a value previously encrypted with encryptSecret().
 * If the value is not prefixed with "enc:", it is treated as legacy plaintext.
 */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith('enc:')) {
    return stored;
  }
  const key = getMasterKey();
  if (!key) {
    throw new Error('HONORCLAW_MASTER_KEY is required to decrypt secrets');
  }
  const data = Buffer.from(stored.slice(4), 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
