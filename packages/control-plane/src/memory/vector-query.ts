import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Lightweight vector query helper for the control-plane memory subsystem.
// Uses pg directly — no dependency on @honorclaw/rag.
// ---------------------------------------------------------------------------

export interface VectorScope {
  workspaceId: string;
  agentId: string;
  /** When set, also filter by session_id (session-specific + global memories). */
  sessionId?: string;
}

export interface VectorSearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

/**
 * Cosine-similarity vector search scoped to workspace + agent.
 * indexName is validated to be a safe identifier.
 */
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

  // SECURITY: workspace_id AND agent_id filters ALWAYS applied.
  // When sessionId is provided, include session-specific + global memories.
  const hasSession = !!scope.sessionId;
  const sql = hasSession
    ? `SELECT id, content, metadata, 1 - (embedding <=> $1::vector) AS score
       FROM ${indexName}
       WHERE workspace_id = $2 AND agent_id = $3
         AND (session_id = $5 OR session_id IS NULL)
       ORDER BY embedding <=> $1::vector
       LIMIT $4`
    : `SELECT id, content, metadata, 1 - (embedding <=> $1::vector) AS score
       FROM ${indexName}
       WHERE workspace_id = $2 AND agent_id = $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4`;

  const params = hasSession
    ? [vectorStr, scope.workspaceId, scope.agentId, topK, scope.sessionId]
    : [vectorStr, scope.workspaceId, scope.agentId, topK];

  const result = await pool.query(sql, params);

  return result.rows.map((r: any) => ({
    id: r.id as string,
    content: r.content as string,
    score: parseFloat(r.score),
    metadata: r.metadata as Record<string, unknown>,
  }));
}

/**
 * Delete vector rows by source_hash, scoped to workspace + agent.
 */
export async function deleteBySource(
  pool: Pool,
  indexName: string,
  scope: VectorScope,
  sourceHash: string,
): Promise<number> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(indexName)) {
    throw new Error(`Invalid index name: ${indexName}`);
  }

  const result = await pool.query(
    `DELETE FROM ${indexName}
     WHERE workspace_id = $1 AND agent_id = $2
       AND metadata->>'source_hash' = $3`,
    [scope.workspaceId, scope.agentId, sourceHash],
  );

  return result.rowCount ?? 0;
}
