import type { SecretsProvider } from '@honorclaw/core';
import crypto from 'node:crypto';
import type { Pool } from 'pg';

export class BuiltInSecretsProvider implements SecretsProvider {
  private pool: Pool;
  private masterKey: Buffer;
  private cache = new Map<string, { value: string; expiresAt: number }>();

  constructor(pool: Pool, masterKeyBase64: string) {
    this.pool = pool;
    this.masterKey = Buffer.from(masterKeyBase64, 'base64');
    if (this.masterKey.length !== 32) {
      throw new Error('Master key must be exactly 32 bytes (256 bits)');
    }
  }

  async getSecret(path: string, workspaceId?: string): Promise<string> {
    const cacheKey = `${workspaceId ?? 'global'}:${path}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const result = await this.pool.query(
      'SELECT encrypted_value FROM secrets WHERE path = $1 AND (workspace_id = $2 OR ($2 IS NULL AND workspace_id IS NULL))',
      [path, workspaceId ?? null],
    );

    if (result.rows.length === 0) {
      throw new Error(`Secret not found: ${path}`);
    }

    const decrypted = this.decrypt(result.rows[0].encrypted_value);
    this.cache.set(cacheKey, { value: decrypted, expiresAt: Date.now() + 300_000 }); // 5 min cache
    return decrypted;
  }

  async setSecret(path: string, value: string, workspaceId?: string): Promise<void> {
    const encrypted = this.encrypt(value);
    await this.pool.query(
      `INSERT INTO secrets (workspace_id, path, encrypted_value, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (workspace_id, path) DO UPDATE SET encrypted_value = $3, updated_at = now()`,
      [workspaceId ?? null, path, encrypted],
    );
    // Invalidate cache
    this.cache.delete(`${workspaceId ?? 'global'}:${path}`);
  }

  async deleteSecret(path: string, workspaceId?: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM secrets WHERE path = $1 AND (workspace_id = $2 OR ($2 IS NULL AND workspace_id IS NULL))',
      [path, workspaceId ?? null],
    );
    this.cache.delete(`${workspaceId ?? 'global'}:${path}`);
  }

  async listSecrets(prefix: string, workspaceId?: string): Promise<string[]> {
    const result = await this.pool.query(
      'SELECT path FROM secrets WHERE path LIKE $1 AND (workspace_id = $2 OR ($2 IS NULL AND workspace_id IS NULL))',
      [`${prefix}%`, workspaceId ?? null],
    );
    return result.rows.map((r: { path: string }) => r.path);
  }

  private encrypt(plaintext: string): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]); // 12 + 16 + N bytes
  }

  private decrypt(data: Buffer): string {
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.masterKey, iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}
