import type { EncryptionProvider } from '@honorclaw/core';
import crypto from 'node:crypto';

export class BuiltInEncryptionProvider implements EncryptionProvider {
  private masterKey: Buffer;

  constructor(masterKeyBase64: string) {
    this.masterKey = Buffer.from(masterKeyBase64, 'base64');
    if (this.masterKey.length !== 32) {
      throw new Error('Master key must be exactly 32 bytes');
    }
  }

  async encrypt(plaintext: Buffer): Promise<Buffer> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]);
  }

  async decrypt(ciphertext: Buffer): Promise<Buffer> {
    const iv = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(12, 28);
    const encrypted = ciphertext.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
}
