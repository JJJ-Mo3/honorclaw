import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { DatabaseConfig } from '@honorclaw/core';

const { Pool } = pg;

export type Database = pg.Pool;

export function createDb(config: DatabaseConfig): Database {
  if (config.url) {
    return new Pool({ connectionString: config.url, max: config.poolSize });
  }
  if (config.socket) {
    return new Pool({ host: config.socket, database: config.name, max: config.poolSize });
  }
  return new Pool({
    host: '/var/run/postgresql',
    database: config.name,
    max: config.poolSize,
  });
}

/**
 * Run database migrations by executing schema.sql against the pool.
 * Idempotent — all statements use IF NOT EXISTS / IF EXISTS guards.
 */
export async function runMigrations(pool: Database): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(__dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');
  await pool.query(sql);
}
