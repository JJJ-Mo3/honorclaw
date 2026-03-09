import type { FastifyInstance } from 'fastify';
import { requireRoles } from '../middleware/rbac.js';
import { mapRows, toCamelCase } from './row-mapper.js';

export async function workspaceRoutes(app: FastifyInstance) {
  app.get('/', async (request) => {
    const db = (app as any).db;
    if (request.isDeploymentAdmin) {
      const result = await db.query('SELECT * FROM workspaces ORDER BY name');
      return { workspaces: mapRows(result.rows) };
    }
    const result = await db.query(
      `SELECT w.* FROM workspaces w
       JOIN user_workspace_roles uwr ON uwr.workspace_id = w.id
       WHERE uwr.user_id = $1 ORDER BY w.name`,
      [request.userId]
    );
    return { workspaces: mapRows(result.rows) };
  });

  app.post('/', { preHandler: [requireRoles('deployment_admin')] }, async (request, reply) => {
    const { name, displayName } = request.body as { name?: string; displayName?: string };
    const db = (app as any).db;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      reply.code(400).send({ error: 'Workspace name is required' });
      return;
    }

    const result = await db.query(
      'INSERT INTO workspaces (name, display_name) VALUES ($1, $2) RETURNING *',
      [name, displayName ?? name]
    );
    reply.code(201).send({ workspace: toCamelCase(result.rows[0]) });
  });
}
