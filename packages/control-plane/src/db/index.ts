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
