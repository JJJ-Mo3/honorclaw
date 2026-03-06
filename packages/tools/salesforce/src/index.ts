// HonorClaw Tool: Salesforce — SOQL, records, cases
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  tool_name: z.enum([
    'salesforce_query',
    'salesforce_read_record',
    'salesforce_create_record',
    'salesforce_update_record',
    'salesforce_search',
    'salesforce_list_cases',
  ]),
  // Query
  soql: z.string().optional(),
  // Record
  sobject: z.string().optional(),
  record_id: z.string().optional(),
  fields: z.record(z.unknown()).optional(),
  // Search
  query: z.string().optional(),
  max_results: z.number().optional(),
  // Cases
  status: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;

interface SalesforceCreds {
  instance_url: string;
  access_token?: string;
  username?: string;
  password?: string;
  security_token?: string;
  client_id?: string;
  client_secret?: string;
}

function getCredentials(): SalesforceCreds {
  const raw = process.env.SALESFORCE_CREDENTIALS;
  if (!raw) throw new Error('SALESFORCE_CREDENTIALS env var is required');
  return JSON.parse(raw) as SalesforceCreds;
}

const DML_PATTERN = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|TRUNCATE)\b/i;

function blockDML(sql: string): void {
  if (DML_PATTERN.test(sql)) {
    throw new Error('DML/DDL keywords are not allowed in read-only queries. Blocked keywords: DROP, DELETE, INSERT, UPDATE, ALTER, TRUNCATE');
  }
}

async function getConnection() {
  const jsforce = await import('jsforce');
  const creds = getCredentials();

  const conn = new jsforce.Connection({
    instanceUrl: creds.instance_url,
    ...(creds.access_token ? { accessToken: creds.access_token } : {}),
  });

  if (!creds.access_token && creds.username && creds.password) {
    const password = creds.security_token
      ? `${creds.password}${creds.security_token}`
      : creds.password;
    await conn.login(creds.username, password);
  }

  return conn;
}

// ── Query (Read-only) ──────────────────────────────

async function salesforceQuery(input: Input) {
  if (!input.soql) throw new Error('soql is required');
  blockDML(input.soql);

  const conn = await getConnection();
  const result = await conn.query(input.soql);

  return {
    total_size: result.totalSize,
    done: result.done,
    records: result.records.map((r: Record<string, unknown>) => {
      const { attributes: _attributes, ...rest } = r;
      return rest;
    }),
  };
}

// ── Read Record ────────────────────────────────────

async function readRecord(input: Input) {
  if (!input.sobject) throw new Error('sobject is required');
  if (!input.record_id) throw new Error('record_id is required');

  const conn = await getConnection();
  const record = (await conn.sobject(input.sobject).retrieve(input.record_id)) as Record<string, unknown>;
  const { attributes: _attributes, ...rest } = record;
  return rest;
}

// ── Create Record ──────────────────────────────────

async function createRecord(input: Input) {
  if (!input.sobject) throw new Error('sobject is required');
  if (!input.fields) throw new Error('fields is required');

  const conn = await getConnection();
  const result = (await conn.sobject(input.sobject).create(input.fields)) as Record<string, unknown>;

  return {
    id: result.id,
    success: result.success,
    created: true,
  };
}

// ── Update Record ──────────────────────────────────

async function updateRecord(input: Input) {
  if (!input.sobject) throw new Error('sobject is required');
  if (!input.record_id) throw new Error('record_id is required');
  if (!input.fields) throw new Error('fields is required');

  const conn = await getConnection();
  const updateData = { ...input.fields, Id: input.record_id };
  const result = (await conn.sobject(input.sobject).update(updateData)) as Record<string, unknown>;

  return {
    id: result.id,
    success: result.success,
    updated: true,
  };
}

// ── Search (SOSL) ──────────────────────────────────

async function salesforceSearch(input: Input) {
  if (!input.query) throw new Error('query is required');

  const conn = await getConnection();
  const sosl = input.query.startsWith('FIND')
    ? input.query
    : `FIND {${input.query.replace(/[{}]/g, '')}} IN ALL FIELDS RETURNING Account(Id, Name), Contact(Id, Name, Email), Opportunity(Id, Name), Case(Id, Subject) LIMIT ${input.max_results ?? 20}`;

  const result = (await conn.search(sosl)) as { searchRecords: Array<Record<string, unknown>> };

  return {
    records: (result.searchRecords ?? []).map((r) => {
      const { attributes: _attributes, ...rest } = r;
      return rest;
    }),
  };
}

// ── List Cases ─────────────────────────────────────

async function listCases(input: Input) {
  const conn = await getConnection();
  const statusFilter = input.status ? `WHERE Status = '${input.status.replace(/'/g, "\\'")}'` : '';
  const limit = input.max_results ?? 50;
  const soql = `SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, ContactId, AccountId, OwnerId FROM Case ${statusFilter} ORDER BY CreatedDate DESC LIMIT ${limit}`;

  const result = await conn.query(soql);

  return {
    total_size: result.totalSize,
    cases: result.records.map((r: Record<string, unknown>) => {
      const { attributes: _attributes, ...rest } = r;
      return rest;
    }),
  };
}

// ── Dispatch ───────────────────────────────────────

const handlers: Record<string, (input: Input) => Promise<unknown>> = {
  salesforce_query: salesforceQuery,
  salesforce_read_record: readRecord,
  salesforce_create_record: createRecord,
  salesforce_update_record: updateRecord,
  salesforce_search: salesforceSearch,
  salesforce_list_cases: listCases,
};

createTool(InputSchema, async (input) => {
  const handler = handlers[input.tool_name];
  if (!handler) throw new Error(`Unknown tool: ${input.tool_name}`);
  return handler(input);
});
