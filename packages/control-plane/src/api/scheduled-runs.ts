import type { FastifyInstance } from 'fastify';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';
import { mapRows, toCamelCase } from './row-mapper.js';

export async function scheduledRunRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  // List scheduled runs for the workspace
  app.get('/', { preHandler: [requireRoles('workspace_admin')] }, async (request) => {
    const db = (app as any).db;
    const result = await db.query(
      `SELECT id, workspace_id, agent_id, cron_expression, enabled, next_run_at, last_run_at, created_at
       FROM scheduled_runs WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [request.workspaceId],
    );
    return { scheduledRuns: mapRows(result.rows) };
  });

  // Create a scheduled run
  app.post('/', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { agentId, cronExpression, enabled } = request.body as {
      agentId?: string; cronExpression?: string; enabled?: boolean;
    };
    const db = (app as any).db;

    if (!agentId || !cronExpression) {
      reply.code(400).send({ error: 'agentId and cronExpression are required' });
      return;
    }

    // Validate cron expression (basic check for 5 fields)
    const cronParts = cronExpression.trim().split(/\s+/);
    if (cronParts.length < 5 || cronParts.length > 6) {
      reply.code(400).send({ error: 'Invalid cron expression (expected 5-6 fields)' });
      return;
    }

    // Verify agent exists in workspace
    const agentCheck = await db.query(
      'SELECT id FROM agents WHERE id = $1 AND workspace_id = $2',
      [agentId, request.workspaceId],
    );
    if (agentCheck.rows.length === 0) {
      reply.code(404).send({ error: 'Agent not found in this workspace' });
      return;
    }

    const result = await db.query(
      `INSERT INTO scheduled_runs (workspace_id, agent_id, cron_expression, enabled)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [request.workspaceId, agentId, cronExpression, enabled !== false],
    );

    reply.code(201).send({ scheduledRun: toCamelCase(result.rows[0]) });
  });

  // Update a scheduled run
  app.put('/:id', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { cronExpression, enabled } = request.body as {
      cronExpression?: string; enabled?: boolean;
    };
    const db = (app as any).db;

    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (cronExpression !== undefined) {
      sets.push(`cron_expression = $${idx++}`);
      params.push(cronExpression);
    }
    if (enabled !== undefined) {
      sets.push(`enabled = $${idx++}`);
      params.push(enabled);
    }

    if (sets.length === 0) {
      reply.code(400).send({ error: 'No fields to update' });
      return;
    }

    params.push(id, request.workspaceId);
    const result = await db.query(
      `UPDATE scheduled_runs SET ${sets.join(', ')} WHERE id = $${idx++} AND workspace_id = $${idx} RETURNING *`,
      params,
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'Scheduled run not found' });
      return;
    }

    return { scheduledRun: toCamelCase(result.rows[0]) };
  });

  // Delete a scheduled run
  app.delete('/:id', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = (app as any).db;

    const result = await db.query(
      'DELETE FROM scheduled_runs WHERE id = $1 AND workspace_id = $2 RETURNING id',
      [id, request.workspaceId],
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'Scheduled run not found' });
      return;
    }

    return { deleted: true };
  });
}
