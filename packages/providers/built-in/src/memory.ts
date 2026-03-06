import type { MemoryStore, MemoryResult, EmbeddingService } from '@honorclaw/core';
import type { Pool } from 'pg';
import crypto from 'node:crypto';

export class PgVectorMemoryStore implements MemoryStore {
  private pool: Pool;
  private embeddings: EmbeddingService;

  constructor(pool: Pool, embeddings: EmbeddingService) {
    this.pool = pool;
    this.embeddings = embeddings;
  }

  async store(workspaceId: string, agentId: string, content: string, metadata?: Record<string, unknown>): Promise<string> {
    const id = crypto.randomUUID();
    const embedding = await this.embeddings.embed(content);
    const vectorStr = `[${embedding.join(',')}]`;

    await this.pool.query(
      `INSERT INTO memories (id, workspace_id, agent_id, content, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5::vector, $6)`,
      [id, workspaceId, agentId, content, vectorStr, JSON.stringify(metadata ?? {})],
    );

    return id;
  }

  async search(workspaceId: string, agentId: string, query: string, topK = 5): Promise<MemoryResult[]> {
    const queryEmbedding = await this.embeddings.embed(query);
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    // SECURITY: workspace_id AND agent_id filters ALWAYS applied — hardcoded, not parameterizable
    const result = await this.pool.query(
      `SELECT id, content, metadata, 1 - (embedding <=> $1::vector) AS score
       FROM memories
       WHERE workspace_id = $2 AND agent_id = $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [vectorStr, workspaceId, agentId, topK],
    );

    return result.rows.map((r: any) => ({
      id: r.id,
      content: r.content,
      score: parseFloat(r.score),
      metadata: r.metadata,
    }));
  }

  async delete(workspaceId: string, agentId: string, memoryId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM memories WHERE id = $1 AND workspace_id = $2 AND agent_id = $3',
      [memoryId, workspaceId, agentId],
    );
  }
}
