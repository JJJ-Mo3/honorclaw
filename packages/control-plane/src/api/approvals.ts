import type { FastifyInstance } from 'fastify';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';

export async function approvalRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  // List pending approval requests for the current workspace
  app.get('/', { preHandler: [requireRoles('workspace_admin', 'auditor')] }, async (request) => {
    const db = (app as any).db;
    const result = await db.query(
      `SELECT id, session_id, agent_id, tool_name, parameters_redacted, status, timeout_at, created_at
       FROM approval_requests
       WHERE workspace_id = $1 AND status = 'pending'
       ORDER BY created_at DESC`,
      [request.workspaceId]
    );
    return { approvals: result.rows };
  });

  // Get a single approval request
  app.get('/:id', { preHandler: [requireRoles('workspace_admin', 'auditor')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = (app as any).db;
    const result = await db.query(
      'SELECT * FROM approval_requests WHERE id = $1 AND workspace_id = $2',
      [id, request.workspaceId]
    );
    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'Approval request not found' });
      return;
    }
    return { approval: result.rows[0] };
  });

  // Approve a request
  app.post('/:id/approve', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = (app as any).db;

    const result = await db.query(
      `UPDATE approval_requests
       SET status = 'approved', resolved_by = $1, resolved_at = now()
       WHERE id = $2 AND workspace_id = $3 AND status = 'pending'
       RETURNING *`,
      [request.userId, id, request.workspaceId]
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'Approval request not found or already resolved' });
      return;
    }

    return { approval: result.rows[0] };
  });

  // Reject a request
  app.post('/:id/reject', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { reason } = (request.body as { reason?: string }) ?? {};
    const db = (app as any).db;

    const result = await db.query(
      `UPDATE approval_requests
       SET status = 'rejected', resolved_by = $1, resolved_at = now()
       WHERE id = $2 AND workspace_id = $3 AND status = 'pending'
       RETURNING *`,
      [request.userId, id, request.workspaceId]
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'Approval request not found or already resolved' });
      return;
    }

    // Log the rejection reason in the audit trail if provided
    if (reason) {
      const auditEmitter = (app as any).auditEmitter;
      if (auditEmitter) {
        await auditEmitter.emit({
          workspaceId: request.workspaceId,
          eventType: 'approval.rejected',
          actorType: 'user',
          actorId: request.userId,
          sessionId: result.rows[0].session_id,
          payload: { approvalId: id, reason },
        });
      }
    }

    return { approval: result.rows[0] };
  });
}
