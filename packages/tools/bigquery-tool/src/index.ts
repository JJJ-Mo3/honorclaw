// HonorClaw Tool: BigQuery — read-only SQL queries
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  tool_name: z.enum([
    'bigquery_query',
    'bigquery_list_datasets',
    'bigquery_describe_table',
    'bigquery_list_tables',
  ]),
  // Query
  sql: z.string().optional(),
  project_id: z.string().optional(),
  dry_run: z.boolean().optional(),
  max_results: z.number().optional(),
  // Dataset / Table
  dataset_id: z.string().optional(),
  table_id: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;

interface BigQueryCreds {
  project_id: string;
  credentials?: Record<string, unknown>;
  keyFilename?: string;
}

function getCredentials(): BigQueryCreds {
  const raw = process.env.BIGQUERY_CREDENTIALS;
  if (!raw) throw new Error('BIGQUERY_CREDENTIALS env var is required');
  return JSON.parse(raw) as BigQueryCreds;
}

const DML_DDL_PATTERN = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|MERGE)\b/i;

function blockDML(sql: string): void {
  if (DML_DDL_PATTERN.test(sql)) {
    throw new Error('DML/DDL keywords are not allowed in read-only queries. Blocked keywords: DROP, DELETE, INSERT, UPDATE, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, MERGE');
  }
}

async function getClient() {
  const { BigQuery } = await import('@google-cloud/bigquery');
  const creds = getCredentials();

  const opts: Record<string, unknown> = {
    projectId: creds.project_id,
  };

  if (creds.credentials) {
    opts.credentials = creds.credentials;
  } else if (creds.keyFilename) {
    opts.keyFilename = creds.keyFilename;
  }

  return new BigQuery(opts);
}

// ── Query (Read-only) ──────────────────────────────

async function bigqueryQuery(input: Input) {
  if (!input.sql) throw new Error('sql is required');
  blockDML(input.sql);

  const bq = await getClient();
  const projectId = input.project_id ?? getCredentials().project_id;

  if (input.dry_run) {
    const [job] = await bq.createQueryJob({
      query: input.sql,
      dryRun: true,
      location: 'US',
    });
    const metadata = job.metadata as Record<string, unknown>;
    const stats = metadata.statistics as Record<string, unknown> | undefined;
    return {
      dry_run: true,
      total_bytes_processed: stats?.totalBytesProcessed,
      statement_type: (metadata.configuration as Record<string, unknown> | undefined)?.query
        ? ((metadata.configuration as Record<string, unknown>).query as Record<string, unknown>).statementType
        : undefined,
    };
  }

  const queryResult = await bq.query({
    query: input.sql,
    location: 'US',
    maximumBytesBilled: '1000000000', // 1 GB safety limit
    maxResults: input.max_results ?? 1000,
    projectId,
  });
  const rows = queryResult[0];

  const typedRows = rows as Array<Record<string, unknown>>;
  const columns = typedRows.length > 0 ? Object.keys(typedRows[0]!) : [];

  return {
    columns,
    rows: typedRows,
    row_count: typedRows.length,
  };
}

// ── List Datasets ──────────────────────────────────

async function listDatasets(input: Input) {
  const bq = await getClient();
  const projectId = input.project_id ?? getCredentials().project_id;

  const [datasets] = await bq.getDatasets({ projectId });

  return {
    datasets: datasets.map((ds) => {
      const meta = ds.metadata as Record<string, unknown>;
      const ref = meta.datasetReference as Record<string, unknown> | undefined;
      return {
        id: ref?.datasetId ?? ds.id,
        project_id: ref?.projectId,
        friendly_name: meta.friendlyName,
        description: meta.description,
        location: meta.location,
        created: meta.creationTime,
      };
    }),
  };
}

// ── List Tables ────────────────────────────────────

async function listTables(input: Input) {
  if (!input.dataset_id) throw new Error('dataset_id is required');

  const bq = await getClient();
  const dataset = bq.dataset(input.dataset_id);
  const [tables] = await dataset.getTables({ maxResults: input.max_results ?? 100 });

  return {
    tables: tables.map((t) => {
      const meta = t.metadata as Record<string, unknown>;
      const ref = meta.tableReference as Record<string, unknown> | undefined;
      return {
        id: ref?.tableId ?? t.id,
        type: meta.type,
        friendly_name: meta.friendlyName,
        description: meta.description,
        row_count: meta.numRows,
        size_bytes: meta.numBytes,
        created: meta.creationTime,
      };
    }),
  };
}

// ── Describe Table ─────────────────────────────────

async function describeTable(input: Input) {
  if (!input.dataset_id) throw new Error('dataset_id is required');
  if (!input.table_id) throw new Error('table_id is required');

  const bq = await getClient();
  const table = bq.dataset(input.dataset_id).table(input.table_id);
  const [metadata] = await table.getMetadata();

  const meta = metadata as Record<string, unknown>;
  const schema = meta.schema as Record<string, unknown> | undefined;
  const fields = (schema?.fields ?? []) as Array<Record<string, unknown>>;

  return {
    table_id: input.table_id,
    dataset_id: input.dataset_id,
    type: meta.type,
    description: meta.description,
    row_count: meta.numRows,
    size_bytes: meta.numBytes,
    created: meta.creationTime,
    last_modified: meta.lastModifiedTime,
    columns: fields.map((f) => ({
      name: f.name,
      type: f.type,
      mode: f.mode,
      description: f.description,
    })),
  };
}

// ── Dispatch ───────────────────────────────────────

const handlers: Record<string, (input: Input) => Promise<unknown>> = {
  bigquery_query: bigqueryQuery,
  bigquery_list_datasets: listDatasets,
  bigquery_list_tables: listTables,
  bigquery_describe_table: describeTable,
};

createTool(InputSchema, async (input) => {
  const handler = handlers[input.tool_name];
  if (!handler) throw new Error(`Unknown tool: ${input.tool_name}`);
  return handler(input);
});
