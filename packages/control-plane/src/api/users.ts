import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';
import { mapRows } from './row-mapper.js';
import bcrypt from 'bcryptjs';

const VALID_ROLES = ['workspace_admin', 'agent_user', 'auditor', 'api_service'] as const;

export async function userRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [requireWorkspace(), requireRoles('workspace_admin')] }, async (request) => {
    const db = (app as any).db;
    const result = await db.query(
      `SELECT u.id, u.email, u.display_name, u.is_deployment_admin, u.totp_enabled, u.created_at, u.last_login_at, uwr.role
       FROM users u
       JOIN user_workspace_roles uwr ON uwr.user_id = u.id
       WHERE uwr.workspace_id = $1 ORDER BY u.email`,
      [request.workspaceId]
    );
    return { users: mapRows(result.rows) };
  });

  app.post('/', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { email, password, role, workspaceId } = request.body as any;
    const db = (app as any).db;

    // Generate a random temp password if none provided (admin invite flow)
    const userPassword = password ?? crypto.randomBytes(16).toString('base64url');
    const hash = await bcrypt.hash(userPassword, 12);

    const userResult = await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING *',
      [email, hash]
    );

    const user = userResult.rows[0] ?? (await db.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];

    const targetWorkspace = workspaceId ?? request.workspaceId;
    const validRole = VALID_ROLES.includes(role) ? role : 'agent_user';
    await db.query(
      'INSERT INTO user_workspace_roles (user_id, workspace_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, workspace_id) DO UPDATE SET role = $3',
      [user.id, targetWorkspace, validRole]
    );

    reply.code(201).send({
      user: { id: user.id, email: user.email },
      // Include temp password so admin can share it (only shown once)
      ...(password ? {} : { tempPassword: userPassword }),
    });
  });

  // Change a user's role within the workspace
  app.patch('/:id/role', { preHandler: [requireWorkspace(), requireRoles('workspace_admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { role } = request.body as { role: string };
    const db = (app as any).db;

    if (!VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
      reply.code(400).send({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
      return;
    }

    const result = await db.query(
      'UPDATE user_workspace_roles SET role = $1 WHERE user_id = $2 AND workspace_id = $3 RETURNING *',
      [role, id, request.workspaceId]
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'User not found in this workspace' });
      return;
    }

    return { updated: true, role };
  });
}
