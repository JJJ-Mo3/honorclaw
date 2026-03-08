import type { FastifyInstance } from 'fastify';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';
import { mapRows } from './row-mapper.js';

export async function auditRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());
  app.addHook('onRequest', requireRoles('workspace_admin', 'auditor'));

  app.get('/events', async (request) => {
    const db = (app as any).db;
    const { eventType, actorId, agentId, sessionId, startDate, endDate, cursor, limit } = request.query as any;

    const params: unknown[] = [request.workspaceId];
    let query = 'SELECT * FROM audit_events WHERE workspace_id = $1';
    let paramIdx = 2;

    if (eventType) { query += ` AND event_type = $${paramIdx++}`; params.push(eventType); }
    if (actorId) { query += ` AND actor_id = $${paramIdx++}`; params.push(actorId); }
    if (agentId) { query += ` AND agent_id = $${paramIdx++}`; params.push(agentId); }
    if (sessionId) { query += ` AND session_id = $${paramIdx++}`; params.push(sessionId); }
    if (startDate) { query += ` AND created_at >= $${paramIdx++}`; params.push(startDate); }
    if (endDate) { query += ` AND created_at <= $${paramIdx++}`; params.push(endDate); }
    if (cursor) { query += ` AND id > $${paramIdx++}`; params.push(cursor); }

    query += ` ORDER BY created_at DESC LIMIT $${paramIdx}`;
    params.push(Math.min(parseInt(limit) || 50, 100));

    const result = await db.query(query, params);
    const events = mapRows(result.rows);
    const nextCursor = events.length > 0 ? (events[events.length - 1] as any).id : undefined;

    return { events, nextCursor };
  });

  app.get('/export', async (request, reply) => {
    const db = (app as any).db;
    const { startDate, endDate } = request.query as any;

    reply.header('Content-Type', 'application/x-ndjson');
    reply.header('Content-Disposition', 'attachment; filename="audit-export.jsonl"');

    const params: unknown[] = [request.workspaceId];
    let query = 'SELECT * FROM audit_events WHERE workspace_id = $1';
    let paramIdx = 2;
    if (startDate) { query += ` AND created_at >= $${paramIdx++}`; params.push(startDate); }
    if (endDate) { query += ` AND created_at <= $${paramIdx++}`; params.push(endDate); }
    query += ' ORDER BY created_at ASC';

    const result = await db.query(query, params);
    const lines = mapRows(result.rows).map((row: unknown) => JSON.stringify(row)).join('\n');
    return lines;
  });
}
