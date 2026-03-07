// HonorClaw Tool: memory_search — Semantic similarity search over agent memory
import { createTool, z } from '@honorclaw/tool-sdk';
import pg from 'pg';

const { Pool } = pg;

// ── Input schema ────────────────────────────────────────────────────────

const InputSchema = z.object({
  query: z.string().min(1).describe('The search query text'),
  limit: z.number().int().min(1).max(100).optional()
    .describe('Maximum number of results to return'),
  threshold: z.number().min(0).max(1).optional()
    .describe('Minimum similarity score (0-1) for results'),
});

type Input = z.infer<typeof InputSchema>;

// ── Database connection ─────────────────────────────────────────────────

function getPool(): pg.Pool {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  return new Pool({ connectionString, max: 2 });
}

// ── Embedding generation ────────────────────────────────────────────────

/**
 * Generate an embedding vector for the given text.
 *
 * Uses the HonorClaw embedding service endpoint (same as the control plane).
 * Falls back to a simple SQL-based text search if the embedding service is
 * unavailable.
 */
async function getEmbedding(text: string): Promise<number[] | null> {
  const embeddingUrl = process.env['EMBEDDING_SERVICE_URL'];
  if (!embeddingUrl) {
    return null; // Fall back to text search
  }

  try {
    const response = await fetch(embeddingUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
    });

    if (!response.ok) {
      console.error(`[memory_search] Embedding service returned HTTP ${response.status}`);
      return null;
    }

    const result = await response.json() as { embedding?: number[] };
    return result.embedding ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[memory_search] Embedding service error: ${message}`);
    return null;
  }
}

// ── Memory search result ────────────────────────────────────────────────

interface MemoryEntry {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  score: number;
  createdAt: string;
}

// ── Search implementations ──────────────────────────────────────────────

/**
 * Vector similarity search using pgvector cosine distance.
 */
async function vectorSearch(
  pool: pg.Pool,
  embedding: number[],
  limit: number,
  threshold: number,
): Promise<MemoryEntry[]> {
  const embeddingStr = `[${embedding.join(',')}]`;

  const result = await pool.query<{
    id: string;
    content: string;
    metadata: Record<string, unknown> | null;
    score: number;
    created_at: string;
  }>(
    `SELECT
       id,
       content,
       metadata,
       1 - (embedding <=> $1::vector) AS score,
       created_at
     FROM memories
     WHERE 1 - (embedding <=> $1::vector) >= $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [embeddingStr, threshold, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    content: row.content,
    metadata: row.metadata,
    score: Math.round(row.score * 1000) / 1000,
    createdAt: row.created_at,
  }));
}

/**
 * Fallback: full-text search using PostgreSQL ts_vector when no embedding
 * service is available.
 */
async function textSearch(
  pool: pg.Pool,
  query: string,
  limit: number,
): Promise<MemoryEntry[]> {
  const result = await pool.query<{
    id: string;
    content: string;
    metadata: Record<string, unknown> | null;
    score: number;
    created_at: string;
  }>(
    `SELECT
       id,
       content,
       metadata,
       ts_rank_cd(to_tsvector('english', content), plainto_tsquery('english', $1)) AS score,
       created_at
     FROM memories
     WHERE to_tsvector('english', content) @@ plainto_tsquery('english', $1)
     ORDER BY score DESC
     LIMIT $2`,
    [query, limit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    content: row.content,
    metadata: row.metadata,
    score: Math.round(row.score * 1000) / 1000,
    createdAt: row.created_at,
  }));
}

// ── Main handler ────────────────────────────────────────────────────────

async function searchMemory(input: Input): Promise<{
  results: MemoryEntry[];
  count: number;
  searchType: 'vector' | 'text';
}> {
  const pool = getPool();
  const limit = input.limit ?? 10;
  const threshold = input.threshold ?? 0.7;

  try {
    const embedding = await getEmbedding(input.query);

    let results: MemoryEntry[];
    let searchType: 'vector' | 'text';

    if (embedding) {
      results = await vectorSearch(pool, embedding, limit, threshold);
      searchType = 'vector';
    } else {
      results = await textSearch(pool, input.query, limit);
      searchType = 'text';
    }

    return {
      results,
      count: results.length,
      searchType,
    };
  } finally {
    await pool.end();
  }
}

// ── Tool entry point ────────────────────────────────────────────────────

createTool(InputSchema, searchMemory);
