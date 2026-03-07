// HonorClaw Tool: Database Query — read-only SQL against configured databases
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  sql: z.string(),
  connection_id: z.string(),
  max_rows: z.number().optional(),
  timeout_ms: z.number().optional(),
});

type Input = z.infer<typeof InputSchema>;

interface DatabaseConnection {
  type: 'postgres' | 'mysql' | 'sqlite';
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  password?: string;
  ssl?: boolean;
  file_path?: string; // for sqlite
}

interface DatabaseCredentials {
  connections: Record<string, DatabaseConnection>;
}

function getCredentials(): DatabaseCredentials {
  const raw = process.env.DATABASE_CREDENTIALS;
  if (!raw) throw new Error('DATABASE_CREDENTIALS env var is required');
  return JSON.parse(raw) as DatabaseCredentials;
}

// Block DML/DDL keywords for read-only enforcement
const BLOCKED_KEYWORDS = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|MERGE|REPLACE|UPSERT)\b/i;

// Block dangerous Postgres server-side functions that can read/write the filesystem
const BLOCKED_FUNCTIONS = /\b(pg_read_file|pg_read_binary_file|lo_import|lo_export)\b/i;
const BLOCKED_COPY = /\bCOPY\b/i;

function sanitizeSQL(sql: string): string {
  // Strip trailing semicolons to prevent multi-statement injection
  return sql.replace(/;\s*$/, '').trim();
}

function blockDML(sql: string): void {
  if (BLOCKED_KEYWORDS.test(sql)) {
    throw new Error(
      'DML/DDL keywords are not allowed. This tool only supports read-only queries (SELECT). ' +
      'Blocked keywords: DROP, DELETE, INSERT, UPDATE, ALTER, TRUNCATE, GRANT, REVOKE, CREATE, MERGE, REPLACE, UPSERT',
    );
  }
  if (BLOCKED_FUNCTIONS.test(sql)) {
    throw new Error(
      'Dangerous functions are not allowed: pg_read_file, pg_read_binary_file, lo_import, lo_export',
    );
  }
  if (BLOCKED_COPY.test(sql)) {
    throw new Error('COPY statements are not allowed in read-only mode.');
  }
}

function getConnection(connectionId: string): DatabaseConnection {
  const creds = getCredentials();
  const conn = creds.connections[connectionId];
  if (!conn) {
    throw new Error(`Unknown connection_id: ${connectionId}. Available: ${Object.keys(creds.connections).join(', ')}`);
  }
  return conn;
}

// ── PostgreSQL ─────────────────────────────────────

function sanitizeMaxRows(maxRows: number): number {
  const parsed = parseInt(String(maxRows), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid max_rows value: ${maxRows}. Must be a positive integer.`);
  }
  return parsed;
}

async function queryPostgres(conn: DatabaseConnection, sql: string, maxRows: number, timeoutMs: number) {
  const safeMaxRows = sanitizeMaxRows(maxRows);
  const safeSql = sanitizeSQL(sql);
  const pg = await import('pg');
  const client = new pg.default.Client({
    host: conn.host,
    port: conn.port ?? 5432,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    ssl: conn.ssl ? { rejectUnauthorized: true } : undefined,
    statement_timeout: timeoutMs,
  });

  try {
    await client.connect();

    // Wrap in a read-only transaction so SET TRANSACTION takes effect
    await client.query('BEGIN');
    await client.query('SET TRANSACTION READ ONLY');

    const result = await client.query(`${safeSql} LIMIT $1`, [safeMaxRows]);

    await client.query('COMMIT');

    return {
      columns: result.fields.map((f: { name: string }) => f.name),
      rows: result.rows as Array<Record<string, unknown>>,
      row_count: result.rowCount ?? result.rows.length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* ignore rollback errors */ });
    throw err;
  } finally {
    await client.end();
  }
}

// ── MySQL ──────────────────────────────────────────

async function queryMySQL(conn: DatabaseConnection, sql: string, maxRows: number, timeoutMs: number) {
  const safeMaxRows = sanitizeMaxRows(maxRows);
  const safeSql = sanitizeSQL(sql);
  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection({
    host: conn.host,
    port: conn.port ?? 3306,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    connectTimeout: timeoutMs,
  });

  try {
    // Wrap in a read-only transaction
    await connection.query('START TRANSACTION READ ONLY');

    const [rows, fields] = await connection.query({
      sql: `${safeSql} LIMIT ?`,
      timeout: timeoutMs,
      values: [safeMaxRows],
    });

    await connection.query('COMMIT');

    const typedRows = (Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>;
    const columns = Array.isArray(fields)
      ? fields.map((f) => f.name)
      : typedRows.length > 0 ? Object.keys(typedRows[0]!) : [];

    return {
      columns,
      rows: typedRows,
      row_count: typedRows.length,
    };
  } catch (err) {
    await connection.query('ROLLBACK').catch(() => { /* ignore rollback errors */ });
    throw err;
  } finally {
    await connection.end();
  }
}

// ── SQLite ─────────────────────────────────────────

async function querySQLite(conn: DatabaseConnection, sql: string, maxRows: number) {
  const safeMaxRows = sanitizeMaxRows(maxRows);
  const safeSql = sanitizeSQL(sql);
  // Use better-sqlite3 synchronous driver
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(conn.file_path ?? conn.database ?? ':memory:', { readonly: true });

  try {
    const stmt = db.prepare(`${safeSql} LIMIT ?`);
    const rows = stmt.all(safeMaxRows) as Array<Record<string, unknown>>;
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];

    return {
      columns,
      rows,
      row_count: rows.length,
    };
  } finally {
    db.close();
  }
}

createTool(InputSchema, async (input: Input) => {
  // Enforce read-only
  blockDML(input.sql);

  const conn = getConnection(input.connection_id);
  const maxRows = input.max_rows ?? 1000;
  const timeoutMs = input.timeout_ms ?? 30_000;

  switch (conn.type) {
    case 'postgres':
      return queryPostgres(conn, input.sql, maxRows, timeoutMs);
    case 'mysql':
      return queryMySQL(conn, input.sql, maxRows, timeoutMs);
    case 'sqlite':
      return querySQLite(conn, input.sql, maxRows);
    default:
      throw new Error(`Unsupported database type: ${conn.type}. Supported: postgres, mysql, sqlite`);
  }
});
