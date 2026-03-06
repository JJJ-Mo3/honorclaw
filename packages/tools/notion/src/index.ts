// HonorClaw Tool: Notion — search, pages, databases
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  tool_name: z.enum([
    'notion_search',
    'notion_read_page',
    'notion_create_page',
    'notion_append_to_page',
    'notion_query_database',
  ]),
  // Search
  query: z.string().optional(),
  max_results: z.number().optional(),
  // Page
  page_id: z.string().optional(),
  // Create page
  parent_page_id: z.string().optional(),
  parent_database_id: z.string().optional(),
  title: z.string().optional(),
  properties: z.record(z.unknown()).optional(),
  // Content blocks
  children: z.array(z.record(z.unknown())).optional(),
  content: z.string().optional(),
  // Database query
  database_id: z.string().optional(),
  filter: z.record(z.unknown()).optional(),
  sorts: z.array(z.record(z.unknown())).optional(),
});

type Input = z.infer<typeof InputSchema>;

interface NotionCreds {
  api_key: string;
}

function getCredentials(): NotionCreds {
  const raw = process.env.NOTION_CREDENTIALS;
  if (!raw) throw new Error('NOTION_CREDENTIALS env var is required');
  return JSON.parse(raw) as NotionCreds;
}

async function getClient() {
  const { Client } = await import('@notionhq/client');
  const creds = getCredentials();
  return new Client({ auth: creds.api_key });
}

// ── Search ─────────────────────────────────────────

async function notionSearch(input: Input) {
  const notion = await getClient();

  const res = await notion.search({
    query: input.query ?? '',
    page_size: Math.min(input.max_results ?? 20, 100),
  });

  return {
    results: res.results.map((r) => {
      if (r.object === 'page') {
        const page = r as Record<string, unknown>;
        const props = page.properties as Record<string, Record<string, unknown>> | undefined;
        const titleProp = props
          ? Object.values(props).find((p) => p.type === 'title')
          : undefined;
        const titleArr = titleProp?.title as Array<{ plain_text: string }> | undefined;
        return {
          id: page.id,
          object: 'page',
          title: titleArr?.map((t) => t.plain_text).join('') ?? '',
          url: page.url,
          created_time: page.created_time,
          last_edited_time: page.last_edited_time,
        };
      }
      if (r.object === 'database') {
        const db = r as Record<string, unknown>;
        const titleArr = db.title as Array<{ plain_text: string }> | undefined;
        return {
          id: db.id,
          object: 'database',
          title: titleArr?.map((t) => t.plain_text).join('') ?? '',
          url: db.url,
        };
      }
      const other = r as unknown as Record<string, unknown>;
      return { id: other.id, object: other.object };
    }),
    has_more: res.has_more,
  };
}

// ── Read Page ──────────────────────────────────────

async function readPage(input: Input) {
  const notion = await getClient();
  if (!input.page_id) throw new Error('page_id is required');

  const page = (await notion.pages.retrieve({ page_id: input.page_id })) as Record<string, unknown>;

  // Fetch blocks (content)
  const blocks = await notion.blocks.children.list({
    block_id: input.page_id,
    page_size: 100,
  });

  function extractText(block: Record<string, unknown>): string {
    const type = block.type as string;
    const data = block[type] as Record<string, unknown> | undefined;
    if (!data) return '';
    const richText = data.rich_text as Array<{ plain_text: string }> | undefined;
    return richText?.map((t) => t.plain_text).join('') ?? '';
  }

  return {
    id: page.id,
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    properties: page.properties,
    content: blocks.results.map((b) => {
      const block = b as Record<string, unknown>;
      return {
        id: block.id,
        type: block.type,
        text: extractText(block),
      };
    }),
  };
}

// ── Create Page ────────────────────────────────────

async function createPage(input: Input) {
  const notion = await getClient();
  if (!input.title && !input.properties) throw new Error('title or properties required');

  let parent: Record<string, unknown>;
  if (input.parent_database_id) {
    parent = { database_id: input.parent_database_id };
  } else if (input.parent_page_id) {
    parent = { page_id: input.parent_page_id };
  } else {
    throw new Error('parent_page_id or parent_database_id is required');
  }

  const properties: Record<string, unknown> = input.properties ?? {};
  if (input.title && !properties.title && !properties.Name) {
    properties.title = {
      title: [{ text: { content: input.title } }],
    };
  }

  const children = input.children ?? (input.content
    ? [{
        object: 'block' as const,
        type: 'paragraph' as const,
        paragraph: {
          rich_text: [{ type: 'text' as const, text: { content: input.content } }],
        },
      }]
    : []);

  const res = (await notion.pages.create({
    parent: parent as { database_id: string } | { page_id: string },
    properties: properties as Parameters<typeof notion.pages.create>[0]['properties'],
    children: children as Parameters<typeof notion.pages.create>[0]['children'],
  })) as Record<string, unknown>;

  return { id: res.id, url: res.url, created: true };
}

// ── Append to Page ─────────────────────────────────

async function appendToPage(input: Input) {
  const notion = await getClient();
  if (!input.page_id) throw new Error('page_id is required');

  const children = input.children ?? (input.content
    ? [{
        object: 'block' as const,
        type: 'paragraph' as const,
        paragraph: {
          rich_text: [{ type: 'text' as const, text: { content: input.content } }],
        },
      }]
    : []);

  if (children.length === 0) throw new Error('children or content is required');

  const res = await notion.blocks.children.append({
    block_id: input.page_id,
    children: children as Parameters<typeof notion.blocks.children.append>[0]['children'],
  });

  return { block_id: input.page_id, blocks_added: res.results.length };
}

// ── Query Database ─────────────────────────────────

async function queryDatabase(input: Input) {
  const notion = await getClient();
  if (!input.database_id) throw new Error('database_id is required');

  const params: Parameters<typeof notion.databases.query>[0] = {
    database_id: input.database_id,
    page_size: Math.min(input.max_results ?? 50, 100),
  };
  if (input.filter) {
    (params as Record<string, unknown>).filter = input.filter;
  }
  if (input.sorts) {
    (params as Record<string, unknown>).sorts = input.sorts;
  }

  const res = await notion.databases.query(params);

  return {
    results: res.results.map((r) => {
      const page = r as Record<string, unknown>;
      return {
        id: page.id,
        url: page.url,
        created_time: page.created_time,
        last_edited_time: page.last_edited_time,
        properties: page.properties,
      };
    }),
    has_more: res.has_more,
  };
}

// ── Dispatch ───────────────────────────────────────

const handlers: Record<string, (input: Input) => Promise<unknown>> = {
  notion_search: notionSearch,
  notion_read_page: readPage,
  notion_create_page: createPage,
  notion_append_to_page: appendToPage,
  notion_query_database: queryDatabase,
};

createTool(InputSchema, async (input) => {
  const handler = handlers[input.tool_name];
  if (!handler) throw new Error(`Unknown tool: ${input.tool_name}`);
  return handler(input);
});
