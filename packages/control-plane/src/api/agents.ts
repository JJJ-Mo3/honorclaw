import type { FastifyInstance } from 'fastify';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';

export async function agentRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  app.get('/', async (request) => {
    const db = (app as any).db;
    const result = await db.query(
      'SELECT id, name, display_name, model, status, created_at, updated_at FROM agents WHERE workspace_id = $1 ORDER BY name',
      [request.workspaceId]
    );
    return { agents: result.rows };
  });

  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const db = (app as any).db;
    const result = await db.query(
      'SELECT * FROM agents WHERE id = $1 AND workspace_id = $2',
      [id, request.workspaceId]
    );
    if (result.rows.length === 0) return { error: 'Agent not found' };

    // Get latest manifest
    const manifest = await db.query(
      'SELECT * FROM capability_manifests WHERE agent_id = $1 ORDER BY version DESC LIMIT 1',
      [id]
    );

    return { agent: result.rows[0], manifest: manifest.rows[0]?.manifest };
  });

  app.post('/', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { name, displayName, model, systemPrompt, manifest } = request.body as any;
    const db = (app as any).db;

    const result = await db.query(
      'INSERT INTO agents (workspace_id, name, display_name, model, system_prompt) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [request.workspaceId, name, displayName, model ?? 'ollama/llama3.2', systemPrompt ?? '']
    );

    const agent = result.rows[0];

    // Create initial manifest
    if (manifest) {
      await db.query(
        'INSERT INTO capability_manifests (agent_id, workspace_id, version, manifest, created_by) VALUES ($1, $2, 1, $3, $4)',
        [agent.id, request.workspaceId, JSON.stringify(manifest), request.userId]
      );
    }

    reply.code(201).send({ agent });
  });

  app.put('/:id', { preHandler: [requireRoles('workspace_admin')] }, async (request) => {
    const { id } = request.params as { id: string };
    const { name, displayName, model, systemPrompt, status } = request.body as any;
    const db = (app as any).db;

    const result = await db.query(
      `UPDATE agents SET
        name = COALESCE($1, name),
        display_name = COALESCE($2, display_name),
        model = COALESCE($3, model),
        system_prompt = COALESCE($4, system_prompt),
        status = COALESCE($5, status),
        updated_at = now()
      WHERE id = $6 AND workspace_id = $7 RETURNING *`,
      [name, displayName, model, systemPrompt, status, id, request.workspaceId]
    );

    return { agent: result.rows[0] };
  });

  // Soft-delete an agent (set status to 'archived')
  app.delete('/:id', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = (app as any).db;

    const result = await db.query(
      `UPDATE agents SET status = 'archived', updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND status != 'archived'
       RETURNING id, name, status`,
      [id, request.workspaceId]
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'Agent not found or already archived' });
      return;
    }

    return { agent: result.rows[0], archived: true };
  });
}
