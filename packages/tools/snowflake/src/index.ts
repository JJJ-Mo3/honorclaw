// HonorClaw Tool: Snowflake — read-only SQL queries
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  tool_name: z.enum([
    'snowflake_query',
    'snowflake_list_databases',
    'snowflake_describe_table',
  ]),
  // Query
  sql: z.string().optional(),
  warehouse: z.string().optional(),
  database: z.string().optional(),
  schema: z.string().optional(),
  // Describe table
  table_name: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;

interface SnowflakeCreds {
  account: string;
  username: string;
  password?: string;
  private_key?: string;
  warehouse?: string;
  database?: string;
  schema?: string;
  role?: string;
}

function getCredentials(): SnowflakeCreds {
  const raw = process.env.SNOWFLAKE_CREDENTIALS;
  if (!raw) throw new Error('SNOWFLAKE_CREDENTIALS env var is required');
  return JSON.parse(raw) as SnowflakeCreds;
}

const DML_DDL_PATTERN = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|MERGE|COPY\s+INTO)\b/i;

function blockDML(sql: string): void {
  if (DML_DDL_PATTERN.test(sql)) {
    throw new Error('DML/DDL keywords are not allowed in read-only queries. Blocked keywords: DROP, DELETE, INSERT, UPDATE, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, MERGE, COPY INTO');
  }
}

interface SnowflakeRow {
  [key: string]: unknown;
}

async function executeQuery(
  sql: string,
  opts?: { warehouse?: string; database?: string; schema?: string },
): Promise<{ columns: string[]; rows: SnowflakeRow[]; row_count: number }> {
  const snowflake = await import('snowflake-sdk');
  const creds = getCredentials();

  type ConnOpts = import('snowflake-sdk').ConnectionOptions;
  const baseConfig: ConnOpts = {
    account: creds.account,
    username: creds.username,
    warehouse: opts?.warehouse ?? creds.warehouse,
    database: opts?.database ?? creds.database,
    schema: opts?.schema ?? creds.schema,
    role: creds.role,
  };

  if (creds.password) {
    baseConfig.password = creds.password;
    baseConfig.authenticator = 'SNOWFLAKE';
  } else if (creds.private_key) {
    (baseConfig as ConnOpts & { privateKey?: string }).privateKey = creds.private_key;
    baseConfig.authenticator = 'SNOWFLAKE_JWT';
  }

  return new Promise((resolve, reject) => {
    const connection = snowflake.createConnection(baseConfig);

    const timeout = setTimeout(() => {
      reject(new Error('Snowflake query timed out after 30 seconds'));
    }, 30_000);

    connection.connect((err) => {
      if (err) {
        clearTimeout(timeout);
        reject(new Error(`Snowflake connection failed: ${err.message}`));
        return;
      }

      connection.execute({
        sqlText: sql,
        complete: (execErr, _stmt, rows) => {
          clearTimeout(timeout);
          connection.destroy(() => { /* cleanup */ });

          if (execErr) {
            reject(new Error(`Snowflake query failed: ${execErr.message}`));
            return;
          }

          const resultRows = (rows ?? []) as SnowflakeRow[];
          const columns = resultRows.length > 0 ? Object.keys(resultRows[0]!) : [];

          resolve({
            columns,
            rows: resultRows,
            row_count: resultRows.length,
          });
        },
      });
    });
  });
}

// ── Query (Read-only) ──────────────────────────────

async function snowflakeQuery(input: Input) {
  if (!input.sql) throw new Error('sql is required');
  blockDML(input.sql);

  return executeQuery(input.sql, {
    warehouse: input.warehouse,
    database: input.database,
    schema: input.schema,
  });
}

// ── List Databases ─────────────────────────────────

async function listDatabases(input: Input) {
  const result = await executeQuery('SHOW DATABASES', {
    warehouse: input.warehouse,
  });

  return {
    databases: result.rows.map((r) => ({
      name: r.name,
      created_on: r.created_on,
      owner: r.owner,
      comment: r.comment,
      retention_time: r.retention_time,
    })),
  };
}

// ── Describe Table ─────────────────────────────────

// Snowflake identifier validation — prevents SQL injection in DESCRIBE TABLE
const SNOWFLAKE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function validateAndQuoteIdentifier(value: string, label: string): string {
  if (!SNOWFLAKE_IDENTIFIER_RE.test(value)) {
    throw new Error(
      `Invalid ${label}: "${value}". Identifiers must start with a letter or underscore ` +
      `and contain only letters, digits, and underscores.`,
    );
  }
  // Double-quote the identifier for Snowflake
  return `"${value}"`;
}

async function describeTable(input: Input) {
  if (!input.table_name) throw new Error('table_name is required');

  const parts: string[] = [];
  if (input.database) parts.push(validateAndQuoteIdentifier(input.database, 'database'));
  if (input.schema) parts.push(validateAndQuoteIdentifier(input.schema, 'schema'));
  parts.push(validateAndQuoteIdentifier(input.table_name, 'table_name'));

  const qualifiedName = parts.join('.');

  const result = await executeQuery(`DESCRIBE TABLE ${qualifiedName}`, {
    warehouse: input.warehouse,
    database: input.database,
    schema: input.schema,
  });

  return {
    table: qualifiedName,
    columns: result.rows.map((r) => ({
      name: r.name,
      type: r.type,
      nullable: r.null === 'Y' || r['null?'] === 'Y',
      default: r.default,
      comment: r.comment,
    })),
  };
}

// ── Dispatch ───────────────────────────────────────

const handlers: Record<string, (input: Input) => Promise<unknown>> = {
  snowflake_query: snowflakeQuery,
  snowflake_list_databases: listDatabases,
  snowflake_describe_table: describeTable,
};

createTool(InputSchema, async (input) => {
  const handler = handlers[input.tool_name];
  if (!handler) throw new Error(`Unknown tool: ${input.tool_name}`);
  return handler(input);
});
