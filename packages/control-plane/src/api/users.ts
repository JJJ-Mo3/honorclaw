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

  app.post('/', { preHandler: [requireWorkspace(), requireRoles('workspace_admin')] }, async (request, reply) => {
    const { email, password, role } = request.body as {
      email?: string; password?: string; role?: string;
    };
    const db = (app as any).db;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      reply.code(400).send({ error: 'Valid email is required' });
      return;
    }

    // Generate a random temp password if none provided (admin invite flow)
    const userPassword = password ?? crypto.randomBytes(16).toString('base64url');
    const hash = await bcrypt.hash(userPassword, 12);

    const userResult = await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING *',
      [email, hash]
    );

    const user = userResult.rows[0] ?? (await db.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];

    // Always assign to the caller's workspace — cross-workspace assignment requires deployment_admin
    const targetWorkspace = request.workspaceId;
    const validRole = role && (VALID_ROLES as readonly string[]).includes(role) ? role : 'agent_user';
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

  // Remove a user from this workspace
  app.delete('/:id', { preHandler: [requireWorkspace(), requireRoles('workspace_admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = (app as any).db;

    // Prevent self-deletion
    if (id === request.userId) {
      reply.code(400).send({ error: 'Cannot remove yourself from the workspace' });
      return;
    }

    const result = await db.query(
      'DELETE FROM user_workspace_roles WHERE user_id = $1 AND workspace_id = $2 RETURNING *',
      [id, request.workspaceId]
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'User not found in this workspace' });
      return;
    }

    return { removed: true, userId: id };
  });

  // Change a user's password (admin-only or self-service)
  app.patch('/:id/password', { preHandler: [requireWorkspace()] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { currentPassword, newPassword } = request.body as {
      currentPassword?: string; newPassword?: string;
    };
    const db = (app as any).db;

    if (!newPassword || newPassword.length < 12) {
      reply.code(400).send({ error: 'New password must be at least 12 characters' });
      return;
    }

    // Self-service: verify current password. Admin: skip if workspace_admin
    const userRoles = request.roles ?? [];
    const isAdmin = request.isDeploymentAdmin || userRoles.includes('workspace_admin');
    const isSelf = id === request.userId;

    if (!isSelf && !isAdmin) {
      reply.code(403).send({ error: 'Cannot change another user\'s password' });
      return;
    }

    if (isSelf && !isAdmin) {
      if (!currentPassword) {
        reply.code(400).send({ error: 'Current password is required' });
        return;
      }
      const user = await db.query('SELECT password_hash FROM users WHERE id = $1', [id]);
      if (user.rows.length === 0) {
        reply.code(404).send({ error: 'User not found' });
        return;
      }
      const valid = await bcrypt.compare(currentPassword, user.rows[0].password_hash);
      if (!valid) {
        reply.code(401).send({ error: 'Current password is incorrect' });
        return;
      }
    }

    const hash = await bcrypt.hash(newPassword, 12);
    const result = await db.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id',
      [hash, id]
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'User not found' });
      return;
    }

    return { updated: true };
  });
}
