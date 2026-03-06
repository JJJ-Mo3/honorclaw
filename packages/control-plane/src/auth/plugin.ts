import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import * as jose from 'jose';
import bcrypt from 'bcryptjs';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    workspaceId?: string;
    roles?: string[];
    isDeploymentAdmin?: boolean;
  }
}

async function authPluginImpl(app: FastifyInstance) {
  const jwtSecret = new TextEncoder().encode(
    process.env.JWT_SECRET ?? 'honorclaw-dev-secret-change-in-production'
  );

  app.decorateRequest('userId', undefined);
  app.decorateRequest('workspaceId', undefined);
  app.decorateRequest('roles', undefined);
  app.decorateRequest('isDeploymentAdmin', undefined);

  // Auth middleware — skip for health + login
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url;
    if (path.startsWith('/health') || path === '/api/auth/login' || path === '/api/auth/register') {
      return;
    }

    const token = extractToken(request);
    if (!token) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }

    try {
      const { payload } = await jose.jwtVerify(token, jwtSecret, { issuer: 'honorclaw' });
      request.userId = payload.sub;
      request.workspaceId = payload.workspace_id as string | undefined;
      request.roles = (payload.roles as string[]) ?? [];
      request.isDeploymentAdmin = (payload.is_deployment_admin as boolean) ?? false;
    } catch {
      reply.code(401).send({ error: 'Invalid or expired token' });
    }
  });

  // Auth routes
  app.post('/api/auth/login', async (request, reply) => {
    const { email, password } = request.body as { email: string; password: string };
    const db = (app as any).db;

    const result = await db.query('SELECT id, email, password_hash, is_deployment_admin, totp_enabled, failed_login_count, locked_until FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      reply.code(401).send({ error: 'Invalid credentials' });
      return;
    }

    // Check lockout
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      reply.code(423).send({ error: 'Account locked. Try again later.' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const newCount = (user.failed_login_count ?? 0) + 1;
      const lockUntil = newCount >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
      await db.query('UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3', [newCount, lockUntil, user.id]);
      reply.code(401).send({ error: 'Invalid credentials' });
      return;
    }

    // Reset failed count
    await db.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);

    if (user.totp_enabled) {
      reply.send({ requiresMfa: true, mfaToken: await issueMfaToken(user.id, jwtSecret) });
      return;
    }

    // Get workspace roles
    const rolesResult = await db.query(
      'SELECT workspace_id, role FROM user_workspace_roles WHERE user_id = $1',
      [user.id]
    );

    // Default to first workspace or 'default'
    const firstWorkspace = rolesResult.rows[0];
    const workspaceId = firstWorkspace?.workspace_id;
    const roles = rolesResult.rows.filter((r: any) => r.workspace_id === workspaceId).map((r: any) => r.role);

    const tokens = await issueTokens(user.id, workspaceId, roles, user.is_deployment_admin, jwtSecret);

    reply
      .setCookie('token', tokens.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: 3600,
      })
      .setCookie('refresh_token', tokens.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/api/auth/refresh',
        maxAge: 7 * 86400,
      })
      .send({ user: { id: user.id, email: user.email, isDeploymentAdmin: user.is_deployment_admin }, workspaceId, roles });
  });

  app.post('/api/auth/refresh', async (request, reply) => {
    const refreshToken = request.cookies.refresh_token;
    if (!refreshToken) {
      reply.code(401).send({ error: 'No refresh token' });
      return;
    }

    try {
      const { payload } = await jose.jwtVerify(refreshToken, jwtSecret, { issuer: 'honorclaw' });
      if (payload.type !== 'refresh') throw new Error('Invalid token type');

      const tokens = await issueTokens(
        payload.sub!,
        payload.workspace_id as string,
        (payload.roles as string[]) ?? [],
        (payload.is_deployment_admin as boolean) ?? false,
        jwtSecret,
      );

      reply
        .setCookie('token', tokens.accessToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'strict',
          path: '/',
          maxAge: 3600,
        })
        .send({ success: true });
    } catch {
      reply.code(401).send({ error: 'Invalid refresh token' });
    }
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply
      .clearCookie('token', { path: '/' })
      .clearCookie('refresh_token', { path: '/api/auth/refresh' })
      .send({ success: true });
  });
}

function extractToken(request: FastifyRequest): string | null {
  // Cookie first
  const cookie = request.cookies?.token;
  if (cookie) return cookie;

  // Authorization header
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);

  return null;
}

async function issueTokens(
  userId: string,
  workspaceId: string | undefined,
  roles: string[],
  isDeploymentAdmin: boolean,
  secret: Uint8Array,
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = await new jose.SignJWT({
    workspace_id: workspaceId,
    roles,
    is_deployment_admin: isDeploymentAdmin,
    type: 'access',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('honorclaw')
    .setExpirationTime('1h')
    .setIssuedAt()
    .sign(secret);

  const refreshToken = await new jose.SignJWT({
    workspace_id: workspaceId,
    roles,
    is_deployment_admin: isDeploymentAdmin,
    type: 'refresh',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('honorclaw')
    .setExpirationTime('7d')
    .setIssuedAt()
    .sign(secret);

  return { accessToken, refreshToken };
}

async function issueMfaToken(userId: string, secret: Uint8Array): Promise<string> {
  return new jose.SignJWT({ type: 'mfa_pending' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('honorclaw')
    .setExpirationTime('5m')
    .sign(secret);
}

export const authPlugin = fp(authPluginImpl, { name: 'auth' });
