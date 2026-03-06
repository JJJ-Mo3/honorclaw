import type { FastifyInstance } from 'fastify';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';
import bcrypt from 'bcryptjs';

export async function userRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [requireWorkspace(), requireRoles('workspace_admin')] }, async (request) => {
    const db = (app as any).db;
    const result = await db.query(
      `SELECT u.id, u.email, u.is_deployment_admin, u.totp_enabled, u.created_at, u.last_login_at, uwr.role
       FROM users u
       JOIN user_workspace_roles uwr ON uwr.user_id = u.id
       WHERE uwr.workspace_id = $1 ORDER BY u.email`,
      [request.workspaceId]
    );
    return { users: result.rows };
  });

  app.post('/', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { email, password, role, workspaceId } = request.body as any;
    const db = (app as any).db;
    const hash = await bcrypt.hash(password, 12);

    const userResult = await db.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING *',
      [email, hash]
    );

    const user = userResult.rows[0] ?? (await db.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];

    const targetWorkspace = workspaceId ?? request.workspaceId;
    await db.query(
      'INSERT INTO user_workspace_roles (user_id, workspace_id, role) VALUES ($1, $2, $3) ON CONFLICT (user_id, workspace_id) DO UPDATE SET role = $3',
      [user.id, targetWorkspace, role ?? 'agent_user']
    );

    reply.code(201).send({ user: { id: user.id, email: user.email } });
  });
}
