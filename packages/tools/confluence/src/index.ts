// HonorClaw Tool: Confluence — search, pages, content
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  tool_name: z.enum([
    'confluence_search',
    'confluence_read_page',
    'confluence_create_page',
    'confluence_update_page',
  ]),
  // Search
  query: z.string().optional(),
  cql: z.string().optional(),
  max_results: z.number().optional(),
  // Page
  page_id: z.string().optional(),
  // Create / Update
  space_key: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  parent_id: z.string().optional(),
  version_number: z.number().optional(),
});

type Input = z.infer<typeof InputSchema>;

interface ConfluenceCreds {
  base_url: string;
  email: string;
  api_token: string;
}

function getCredentials(): ConfluenceCreds {
  const raw = process.env.CONFLUENCE_CREDENTIALS;
  if (!raw) throw new Error('CONFLUENCE_CREDENTIALS env var is required');
  return JSON.parse(raw) as ConfluenceCreds;
}

async function confluenceRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const creds = getCredentials();
  const axios = (await import('axios')).default;
  const url = `${creds.base_url.replace(/\/$/, '')}/wiki/rest/api${path}`;
  const auth = Buffer.from(`${creds.email}:${creds.api_token}`).toString('base64');

  const res = await axios({
    method,
    url,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    data: body,
    validateStatus: () => true,
  });

  if (res.status >= 400) {
    throw new Error(`Confluence API error ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

// ── Search ─────────────────────────────────────────

async function confluenceSearch(input: Input) {
  const cql = input.cql ?? (input.query ? `text ~ "${input.query.replace(/"/g, '\\"')}"` : '');
  if (!cql) throw new Error('query or cql is required');

  const limit = input.max_results ?? 20;
  const data = (await confluenceRequest(
    'GET',
    `/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&expand=space,version`,
  )) as { results: Array<Record<string, unknown>>; totalSize: number };

  return {
    total: data.totalSize,
    results: (data.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      status: r.status,
      space: (r.space as Record<string, unknown> | undefined)?.key,
      version: (r.version as Record<string, unknown> | undefined)?.number,
      url: (r._links as Record<string, unknown> | undefined)?.webui,
    })),
  };
}

// ── Read Page ──────────────────────────────────────

async function readPage(input: Input) {
  if (!input.page_id) throw new Error('page_id is required');

  const data = (await confluenceRequest(
    'GET',
    `/content/${input.page_id}?expand=body.storage,version,space,children.page`,
  )) as Record<string, unknown>;

  const bodyStorage = (data.body as Record<string, unknown> | undefined)?.storage as Record<string, unknown> | undefined;

  return {
    id: data.id,
    title: data.title,
    type: data.type,
    status: data.status,
    space: (data.space as Record<string, unknown> | undefined)?.key,
    version: (data.version as Record<string, unknown> | undefined)?.number,
    body: bodyStorage?.value ?? '',
    url: (data._links as Record<string, unknown> | undefined)?.webui,
    children: ((data.children as Record<string, unknown> | undefined)?.page as Record<string, unknown> | undefined)
      ? (((data.children as Record<string, unknown>).page as Record<string, unknown>).results as Array<Record<string, unknown>> | undefined)?.map((c) => ({
          id: c.id,
          title: c.title,
        }))
      : [],
  };
}

// ── Create Page ────────────────────────────────────

async function createPage(input: Input) {
  if (!input.space_key) throw new Error('space_key is required');
  if (!input.title) throw new Error('title is required');

  const payload: Record<string, unknown> = {
    type: 'page',
    title: input.title,
    space: { key: input.space_key },
    body: {
      storage: {
        value: input.body ?? '',
        representation: 'storage',
      },
    },
  };

  if (input.parent_id) {
    payload.ancestors = [{ id: input.parent_id }];
  }

  const data = (await confluenceRequest('POST', '/content', payload)) as Record<string, unknown>;

  return {
    id: data.id,
    title: data.title,
    url: (data._links as Record<string, unknown> | undefined)?.webui,
    version: (data.version as Record<string, unknown> | undefined)?.number,
    created: true,
  };
}

// ── Update Page ────────────────────────────────────

async function updatePage(input: Input) {
  if (!input.page_id) throw new Error('page_id is required');
  if (!input.title) throw new Error('title is required');

  // Get current version
  let version = input.version_number;
  if (!version) {
    const current = (await confluenceRequest('GET', `/content/${input.page_id}?expand=version`)) as Record<string, unknown>;
    const currentVersion = (current.version as Record<string, unknown> | undefined)?.number as number | undefined;
    version = (currentVersion ?? 0) + 1;
  }

  const payload = {
    type: 'page',
    title: input.title,
    body: {
      storage: {
        value: input.body ?? '',
        representation: 'storage',
      },
    },
    version: { number: version },
  };

  const data = (await confluenceRequest('PUT', `/content/${input.page_id}`, payload)) as Record<string, unknown>;

  return {
    id: data.id,
    title: data.title,
    version: (data.version as Record<string, unknown> | undefined)?.number,
    url: (data._links as Record<string, unknown> | undefined)?.webui,
    updated: true,
  };
}

// ── Dispatch ───────────────────────────────────────

const handlers: Record<string, (input: Input) => Promise<unknown>> = {
  confluence_search: confluenceSearch,
  confluence_read_page: readPage,
  confluence_create_page: createPage,
  confluence_update_page: updatePage,
};

createTool(InputSchema, async (input) => {
  const handler = handlers[input.tool_name];
  if (!handler) throw new Error(`Unknown tool: ${input.tool_name}`);
  return handler(input);
});
