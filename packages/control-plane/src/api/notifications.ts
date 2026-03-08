import type { FastifyInstance } from 'fastify';
import { requireWorkspace } from '../middleware/rbac.js';
import { mapRows } from './row-mapper.js';

/**
 * Notification API routes.
 *
 * GET  /notifications         — list unread + recent notifications
 * POST /notifications/:id/read — mark a single notification as read
 * POST /notifications/read-all — mark all notifications as read
 */
export async function notificationRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  /**
   * GET /notifications
   *
   * Returns unread notifications first, then recent read notifications.
   * Query params:
   *   - limit (default: 50)
   *   - offset (default: 0)
   *   - unreadOnly (default: false)
   */
  app.get('/', async (request) => {
    const {
      limit = '50',
      offset = '0',
      unreadOnly = 'false',
    } = request.query as Record<string, string>;

    const db = (app as any).db;
    const parsedLimit = Math.min(Number(limit) || 50, 200);
    const parsedOffset = Number(offset) || 0;

    let query: string;
    let params: unknown[];

    if (unreadOnly === 'true') {
      query = `
        SELECT id, trigger, workspace_id, user_id, agent_id, session_id,
               title, body, severity, read, created_at
        FROM notifications
        WHERE workspace_id = $1
          AND (user_id = $2 OR user_id IS NULL)
          AND read = false
        ORDER BY created_at DESC
        LIMIT $3 OFFSET $4
      `;
      params = [request.workspaceId, request.userId, parsedLimit, parsedOffset];
    } else {
      // Return unread first, then recent read, ordered by creation time
      query = `
        SELECT id, trigger, workspace_id, user_id, agent_id, session_id,
               title, body, severity, read, created_at
        FROM notifications
        WHERE workspace_id = $1
          AND (user_id = $2 OR user_id IS NULL)
        ORDER BY read ASC, created_at DESC
        LIMIT $3 OFFSET $4
      `;
      params = [request.workspaceId, request.userId, parsedLimit, parsedOffset];
    }

    const result = await db.query(query, params);

    // Also get total unread count
    const unreadResult = await db.query(
      `SELECT COUNT(*) as count FROM notifications
       WHERE workspace_id = $1
         AND (user_id = $2 OR user_id IS NULL)
         AND read = false`,
      [request.workspaceId, request.userId],
    );

    return {
      notifications: mapRows(result.rows),
      unreadCount: Number(unreadResult.rows[0]?.count ?? 0),
    };
  });

  /**
   * POST /notifications/:id/read
   *
   * Mark a single notification as read.
   */
  app.post('/:id/read', async (request) => {
    const { id } = request.params as { id: string };
    const db = (app as any).db;

    const result = await db.query(
      `UPDATE notifications SET read = true
       WHERE id = $1
         AND workspace_id = $2
         AND (user_id = $3 OR user_id IS NULL)
       RETURNING id`,
      [id, request.workspaceId, request.userId],
    );

    if (result.rowCount === 0) {
      return { error: 'Notification not found', updated: false };
    }

    return { updated: true };
  });

  /**
   * POST /notifications/read-all
   *
   * Mark all notifications as read for the current user in the workspace.
   */
  app.post('/read-all', async (request) => {
    const db = (app as any).db;

    const result = await db.query(
      `UPDATE notifications SET read = true
       WHERE workspace_id = $1
         AND (user_id = $2 OR user_id IS NULL)
         AND read = false`,
      [request.workspaceId, request.userId],
    );

    return {
      updated: true,
      count: result.rowCount ?? 0,
    };
  });
}
