import type { FastifyInstance } from 'fastify';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';
import { mapRows, toCamelCase } from './row-mapper.js';

export async function manifestRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  app.get('/:agentId', async (request) => {
    const { agentId } = request.params as { agentId: string };
    const db = (app as any).db;
    const result = await db.query(
      'SELECT * FROM capability_manifests WHERE agent_id = $1 AND workspace_id = $2 ORDER BY version DESC',
      [agentId, request.workspaceId]
    );
    return { manifests: mapRows(result.rows) };
  });

  app.post('/:agentId', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const { manifest } = request.body as any;
    const db = (app as any).db;

    // Get next version
    const versionResult = await db.query(
      'SELECT COALESCE(MAX(version), 0) + 1 as next_version FROM capability_manifests WHERE agent_id = $1',
      [agentId]
    );
    const nextVersion = versionResult.rows[0].next_version;

    const result = await db.query(
      'INSERT INTO capability_manifests (agent_id, workspace_id, version, manifest, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [agentId, request.workspaceId, nextVersion, JSON.stringify(manifest), request.userId]
    );

    reply.code(201).send({ manifest: toCamelCase(result.rows[0]) });
  });
}
