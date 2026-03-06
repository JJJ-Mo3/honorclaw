import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VectorRow {
  id: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorScope {
  workspaceId: string;
  agentId: string;
}

export interface VectorSearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Index management
// ---------------------------------------------------------------------------

/**
 * Create a pgvector table and HNSW index.
 * Safe to call multiple times (IF NOT EXISTS).
 */
export async function createIndex(
  pool: Pool,
  indexName: string,
  dimensions: number,
): Promise<void> {
  // Validate indexName is alphanumeric + underscores only
  if (!/^[a-z_][a-z0-9_]*$/i.test(indexName)) {
    throw new Error(`Invalid index name: ${indexName}`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${indexName} (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding vector(${dimensions}),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_${indexName}_hnsw
    ON ${indexName} USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_${indexName}_scope
    ON ${indexName} (workspace_id, agent_id)
  `);
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

export async function upsert(
  pool: Pool,
  indexName: string,
  rows: VectorRow[],
): Promise<void> {
  if (rows.length === 0) return;

  if (!/^[a-z_][a-z0-9_]*$/i.test(indexName)) {
    throw new Error(`Invalid index name: ${indexName}`);
  }

  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const off = i * 4;
    placeholders.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}::vector)`);
    values.push(
      row.id,
      row.content,
      JSON.stringify(row.metadata ?? {}),
      `[${row.embedding.join(',')}]`,
    );
  }

  // We keep workspace_id and agent_id inside metadata for upsert.
  // The caller embeds scope in the VectorRow.metadata before calling upsert.
  // However the table also has dedicated columns, so we extract them.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const off = i * 4;
    const meta = row.metadata ?? {};
    const wsId = (meta.workspace_id as string) ?? '';
    const agId = (meta.agent_id as string) ?? '';
    placeholders[i] = `($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}::vector, $${off + 5}, $${off + 6})`;
    // rebuild values for this row
    values.splice(off, 4,
      row.id,
      row.content,
      JSON.stringify(meta),
      `[${row.embedding.join(',')}]`,
      wsId,
      agId,
    );
  }

  // Rebuild cleanly — the splice above mutates in-place but offsets shift.
  // Redo from scratch for correctness.
  values.length = 0;
  placeholders.length = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const meta = row.metadata ?? {};
    const off = i * 6;
    placeholders.push(
      `($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}::vector, $${off + 5}, $${off + 6})`,
    );
    values.push(
      row.id,
      row.content,
      JSON.stringify(meta),
      `[${row.embedding.join(',')}]`,
      (meta.workspace_id as string) ?? '',
      (meta.agent_id as string) ?? '',
    );
  }

  await pool.query(
    `INSERT INTO ${indexName} (id, content, metadata, embedding, workspace_id, agent_id)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (id) DO UPDATE SET
       content = EXCLUDED.content,
       metadata = EXCLUDED.metadata,
       embedding = EXCLUDED.embedding`,
    values,
  );
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export async function query(
  pool: Pool,
  indexName: string,
  scope: VectorScope,
  queryEmbedding: number[],
  topK: number,
): Promise<VectorSearchResult[]> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(indexName)) {
    throw new Error(`Invalid index name: ${indexName}`);
  }

  const vectorStr = `[${queryEmbedding.join(',')}]`;

  // SECURITY: workspace_id AND agent_id filters ALWAYS applied
  const result = await pool.query(
    `SELECT id, content, metadata, 1 - (embedding <=> $1::vector) AS score
     FROM ${indexName}
     WHERE workspace_id = $2 AND agent_id = $3
     ORDER BY embedding <=> $1::vector
     LIMIT $4`,
    [vectorStr, scope.workspaceId, scope.agentId, topK],
  );

  return result.rows.map((r: any) => ({
    id: r.id as string,
    content: r.content as string,
    score: parseFloat(r.score),
    metadata: r.metadata as Record<string, unknown>,
  }));
}

// ---------------------------------------------------------------------------
// Delete by source hash
// ---------------------------------------------------------------------------

export async function deleteBySource(
  pool: Pool,
  indexName: string,
  scope: VectorScope,
  sourceHash: string,
): Promise<number> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(indexName)) {
    throw new Error(`Invalid index name: ${indexName}`);
  }

  // SECURITY: workspace_id AND agent_id filters ALWAYS applied
  const result = await pool.query(
    `DELETE FROM ${indexName}
     WHERE workspace_id = $1 AND agent_id = $2
       AND metadata->>'source_hash' = $3`,
    [scope.workspaceId, scope.agentId, sourceHash],
  );

  return result.rowCount ?? 0;
}
