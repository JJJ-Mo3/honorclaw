import type { StorageProvider, PutOptions } from '@honorclaw/core';
import { readFile, writeFile, unlink, readdir, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export class LocalFilesystemStorageProvider implements StorageProvider {
  private rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  private resolvePath(key: string): string {
    // Prevent path traversal
    if (key.includes('..') || key.startsWith('/')) {
      throw new Error('Invalid storage key: path traversal not allowed');
    }
    return join(this.rootPath, key);
  }

  async put(key: string, body: Buffer, _opts?: PutOptions): Promise<void> {
    const filePath = this.resolvePath(key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, body);
  }

  async get(key: string): Promise<Buffer> {
    const filePath = this.resolvePath(key);
    return readFile(filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    await unlink(filePath);
  }

  async list(prefix: string): Promise<string[]> {
    const dirPath = this.resolvePath(prefix);
    try {
      const entries = await readdir(dirPath, { recursive: true });
      return entries.map(e => `${prefix}${e}`);
    } catch {
      return [];
    }
  }

  async getSignedUrl(_key: string, _expiresIn: number): Promise<string> {
    throw new Error('Signed URLs not supported for local filesystem storage');
  }
}
