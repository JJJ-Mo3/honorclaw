import { readFileSync, existsSync } from 'node:fs';
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
 *
 * Looks for schema.sql in both the dist/ directory (after build script copy)
 * and the src/ directory (during development with tsx).
 */
export async function runMigrations(pool: Database): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  // tsc doesn't copy .sql files to dist/, so check multiple locations
  const candidates = [
    join(__dirname, 'schema.sql'),                           // co-located (if copied by build script)
    join(__dirname, '..', '..', 'src', 'db', 'schema.sql'), // relative to dist/db/ → src/db/
  ];

  let sql: string | null = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      sql = readFileSync(candidate, 'utf-8');
      break;
    }
  }

  if (!sql) {
    throw new Error(
      `schema.sql not found. Searched: ${candidates.join(', ')}. ` +
      `Ensure the control-plane package build copies schema.sql to the dist directory.`
    );
  }

  await pool.query(sql);
}
