import type { FastifyInstance } from 'fastify';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';
import { mapRows } from './row-mapper.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ---------------------------------------------------------------------------
// Memory admin API
// ---------------------------------------------------------------------------

export async function memoryRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  const INDEX_NAME = 'memories';

  // -----------------------------------------------------------------------
  // GET /agents/:id/memory/documents — list indexed documents
  // -----------------------------------------------------------------------
  app.get('/:id/memory/documents', async (request) => {
    const { id: agentId } = request.params as { id: string };
    const db = (app as any).db;

    // Group by source_hash to get distinct documents
    const result = await db.query(
      `SELECT
         metadata->>'source_name' AS source_name,
         metadata->>'source_hash' AS source_hash,
         COUNT(*) AS chunk_count,
         MIN(created_at) AS ingested_at
       FROM ${INDEX_NAME}
       WHERE workspace_id = $1 AND agent_id = $2
       GROUP BY metadata->>'source_name', metadata->>'source_hash'
       ORDER BY MIN(created_at) DESC`,
      [request.workspaceId, agentId],
    );

    return { documents: mapRows(result.rows) };
  });

  // -----------------------------------------------------------------------
  // GET /agents/:id/memory/documents/:docId/chunks — list chunks
  // -----------------------------------------------------------------------
  app.get('/:id/memory/documents/:docId/chunks', async (request) => {
    const { id: agentId, docId: sourceHash } = request.params as { id: string; docId: string };
    const db = (app as any).db;

    const result = await db.query(
      `SELECT id, content, metadata, created_at
       FROM ${INDEX_NAME}
       WHERE workspace_id = $1 AND agent_id = $2
         AND metadata->>'source_hash' = $3
       ORDER BY (metadata->>'chunk_index')::int ASC`,
      [request.workspaceId, agentId, sourceHash],
    );

    return { chunks: mapRows(result.rows) };
  });

  // -----------------------------------------------------------------------
  // DELETE /agents/:id/memory/documents/:docId — delete + audit
  // -----------------------------------------------------------------------
  app.delete(
    '/:id/memory/documents/:docId',
    { preHandler: [requireRoles('workspace_admin')] },
    async (request, _reply) => {
      const { id: agentId, docId: sourceHash } = request.params as { id: string; docId: string };
      const db = (app as any).db;
      const auditEmitter = (app as any).auditEmitter;

      const result = await db.query(
        `DELETE FROM ${INDEX_NAME}
         WHERE workspace_id = $1 AND agent_id = $2
           AND metadata->>'source_hash' = $3`,
        [request.workspaceId, agentId, sourceHash],
      );

      const deleted = result.rowCount ?? 0;

      if (auditEmitter) {
        auditEmitter.emit({
          workspaceId: request.workspaceId,
          eventType: 'admin.action',
          actorType: 'user',
          actorId: request.userId,
          agentId,
          payload: { action: 'memory.document.delete', sourceHash, chunksDeleted: deleted },
        });
      }

      logger.info({ agentId, sourceHash, deleted }, 'Memory document deleted');
      return { deleted };
    },
  );

  // -----------------------------------------------------------------------
  // POST /agents/:id/memory/documents/:docId/reingest — re-ingest
  // -----------------------------------------------------------------------
  app.post(
    '/:id/memory/documents/:docId/reingest',
    { preHandler: [requireRoles('workspace_admin')] },
    async (request, reply) => {
      const { id: agentId, docId: sourceHash } = request.params as { id: string; docId: string };
      const db = (app as any).db;

      // Look up original content from existing chunks
      const existing = await db.query(
        `SELECT content, metadata FROM ${INDEX_NAME}
         WHERE workspace_id = $1 AND agent_id = $2
           AND metadata->>'source_hash' = $3
         ORDER BY (metadata->>'chunk_index')::int ASC`,
        [request.workspaceId, agentId, sourceHash],
      );

      if (existing.rows.length === 0) {
        reply.code(404).send({ error: 'Document not found' });
        return;
      }

      // Reconstruct original text from chunks
      const fullText = existing.rows.map((r: any) => r.content).join('\n');
      const sourceName = existing.rows[0]?.metadata?.source_name ?? 'unknown';

      // Delete old chunks
      await db.query(
        `DELETE FROM ${INDEX_NAME}
         WHERE workspace_id = $1 AND agent_id = $2
           AND metadata->>'source_hash' = $3`,
        [request.workspaceId, agentId, sourceHash],
      );

      logger.info({ agentId, sourceHash, sourceName }, 'Re-ingest requested — old chunks deleted');

      // Return the extracted text so the caller can run the ingest pipeline
      return {
        status: 'ready_for_ingest',
        sourceName,
        sourceHash,
        textLength: fullText.length,
        previousChunks: existing.rows.length,
      };
    },
  );

  // -----------------------------------------------------------------------
  // GET /agents/:id/memory/stats — memory statistics
  // -----------------------------------------------------------------------
  app.get('/:id/memory/stats', async (request) => {
    const { id: agentId } = request.params as { id: string };
    const db = (app as any).db;

    // Total chunks
    const chunksResult = await db.query(
      `SELECT COUNT(*) AS total_chunks FROM ${INDEX_NAME}
       WHERE workspace_id = $1 AND agent_id = $2`,
      [request.workspaceId, agentId],
    );

    // Total distinct documents
    const docsResult = await db.query(
      `SELECT COUNT(DISTINCT metadata->>'source_hash') AS total_documents FROM ${INDEX_NAME}
       WHERE workspace_id = $1 AND agent_id = $2`,
      [request.workspaceId, agentId],
    );

    // Estimated size
    const sizeResult = await db.query(
      `SELECT COALESCE(SUM(LENGTH(content)), 0) AS total_chars FROM ${INDEX_NAME}
       WHERE workspace_id = $1 AND agent_id = $2`,
      [request.workspaceId, agentId],
    );

    // Get embedding dimensions from table definition
    const dimResult = await db.query(
      `SELECT atttypmod FROM pg_attribute
       WHERE attrelid = $1::regclass AND attname = 'embedding'`,
      [INDEX_NAME],
    );

    const totalChunks = parseInt(chunksResult.rows[0]?.total_chunks ?? '0', 10);
    const totalDocuments = parseInt(docsResult.rows[0]?.total_documents ?? '0', 10);
    const totalChars = parseInt(sizeResult.rows[0]?.total_chars ?? '0', 10);
    const embeddingDimensions = dimResult.rows[0]?.atttypmod ?? 768;

    return {
      agentId,
      totalDocuments,
      totalChunks,
      embeddingDimensions,
      estimatedTokens: Math.ceil(totalChars / 4),
      totalChars,
    };
  });
}
