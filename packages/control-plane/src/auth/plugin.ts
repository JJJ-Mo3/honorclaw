import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import * as jose from 'jose';
import bcrypt from 'bcryptjs';
import { checkRateLimit, recordFailedAttempt, clearRateLimit } from './rate-limiter.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    workspaceId?: string;
    roles?: string[];
    isDeploymentAdmin?: boolean;
  }
}

async function authPluginImpl(app: FastifyInstance) {
  const rawSecret = process.env.JWT_SECRET;
  if (!rawSecret && process.env.NODE_ENV !== 'development') {
    throw new Error('JWT_SECRET environment variable must be set (only skipped when NODE_ENV=development)');
  }
  if (!rawSecret) {
    console.warn('[auth] WARNING: JWT_SECRET is not set. Using insecure default for development only.');
  }
  const jwtSecret = new TextEncoder().encode(
    rawSecret ?? (process.env.NODE_ENV === 'development' ? 'honorclaw-dev-secret-change-in-production' : '')
  );

  // Read auth config for token TTLs
  const authConfig = (app as any).config?.auth as { accessTokenTtlMinutes?: number; refreshTokenTtlDays?: number; mfaRequired?: boolean } | undefined;
  const tokenTtl = {
    accessMinutes: authConfig?.accessTokenTtlMinutes ?? 60,
    refreshDays: authConfig?.refreshTokenTtlDays ?? 7,
  };

  app.decorateRequest('userId', undefined);
  app.decorateRequest('workspaceId', undefined);
  app.decorateRequest('roles', undefined);
  app.decorateRequest('isDeploymentAdmin', undefined);

  // Auth middleware — skip for health + login
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const path = request.url;
    if (path.startsWith('/health') || path === '/api/auth/login' || path === '/api/auth/register' || path === '/api/auth/totp/verify' || path === '/api/auth/config' || path === '/api/admin/bootstrap') {
      return;
    }

    const token = extractToken(request);
    if (!token) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }

    try {
      const { payload } = await jose.jwtVerify(token, jwtSecret, { issuer: 'honorclaw' });

      // Only allow access tokens (reject refresh/mfa tokens used as access)
      if (payload.type && payload.type !== 'access') {
        reply.code(401).send({ error: 'Invalid token type' });
        return;
      }

      request.userId = payload.sub;
      request.workspaceId = payload.workspace_id as string | undefined;
      request.roles = (payload.roles as string[]) ?? [];
      request.isDeploymentAdmin = (payload.is_deployment_admin as boolean) ?? false;
    } catch {
      reply.code(401).send({ error: 'Invalid or expired token' });
      return;
    }
  });

  // Auth routes
  app.post('/api/auth/login', async (request, reply) => {
    // Rate limit by IP
    if (!checkRateLimit(request, reply)) return;

    const { email, password } = request.body as { email: string; password: string };

    if (!email || !password || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      reply.code(400).send({ error: 'Valid email and password are required' });
      return;
    }

    const db = (app as any).db;

    const result = await db.query('SELECT id, email, password_hash, is_deployment_admin, totp_enabled, failed_login_count, locked_until FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      recordFailedAttempt(request);
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
      recordFailedAttempt(request);
      const newCount = (user.failed_login_count ?? 0) + 1;
      const lockUntil = newCount >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
      await db.query('UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3', [newCount, lockUntil, user.id]);
      reply.code(401).send({ error: 'Invalid credentials' });
      return;
    }

    // Reset failed count and clear IP rate limit on success
    clearRateLimit(request);
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

    const tokens = await issueTokens(user.id, workspaceId, roles, user.is_deployment_admin, jwtSecret, tokenTtl);

    reply
      .setCookie('token', tokens.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV !== 'development',
        sameSite: 'strict',
        path: '/',
        maxAge: tokenTtl.accessMinutes * 60,
      })
      .setCookie('refresh_token', tokens.refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV !== 'development',
        sameSite: 'strict',
        path: '/api/auth/refresh',
        maxAge: tokenTtl.refreshDays * 86400,
      })
      .send({
        user: { id: user.id, email: user.email, isDeploymentAdmin: user.is_deployment_admin },
        workspaceId,
        roles,
        // Include tokens in response body so CLI and headless clients can capture them
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: new Date(Date.now() + tokenTtl.accessMinutes * 60 * 1000).toISOString(),
      });
  });

  app.post('/api/auth/register', async (request, reply) => {
    // Rate limit by IP
    if (!checkRateLimit(request, reply)) return;

    const { email, password, displayName } = request.body as { email: string; password: string; displayName?: string };
    const db = (app as any).db;

    if (!email || !password || password.length < 8 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      reply.code(400).send({ error: 'Valid email and password (min 8 chars) are required' });
      return;
    }

    // Check if any users exist — first user becomes deployment admin
    const countResult = await db.query('SELECT count(*) AS cnt FROM users');
    const isFirst = parseInt(countResult.rows[0].cnt, 10) === 0;

    // Registration gate: after the first user, self-registration is disabled
    // unless ALLOW_SELF_REGISTRATION=true is set. New users must be invited
    // by a workspace_admin via the users API.
    if (!isFirst && process.env.ALLOW_SELF_REGISTRATION !== 'true') {
      reply.code(403).send({ error: 'Self-registration is disabled. Contact your administrator for an invite.' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    try {
      const result = await db.query(
        `INSERT INTO users (email, display_name, password_hash, is_deployment_admin)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, display_name, is_deployment_admin`,
        [email, displayName ?? null, passwordHash, isFirst],
      );
      const user = result.rows[0];

      // Auto-assign to default workspace
      const ws = await db.query(`SELECT id FROM workspaces WHERE name = 'default' LIMIT 1`);
      let workspaceId: string | undefined;
      let roles: string[] = [];
      if (ws.rows.length > 0) {
        workspaceId = ws.rows[0].id;
        const role = isFirst ? 'workspace_admin' : 'agent_user';
        roles = [role];
        await db.query(
          'INSERT INTO user_workspace_roles (user_id, workspace_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [user.id, workspaceId, role],
        );
      }

      // Auto-login: issue tokens so the user is immediately authenticated
      const tokens = await issueTokens(user.id, workspaceId, roles, user.is_deployment_admin, jwtSecret, tokenTtl);

      reply
        .code(201)
        .setCookie('token', tokens.accessToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV !== 'development',
          sameSite: 'strict',
          path: '/',
          maxAge: tokenTtl.accessMinutes * 60,
        })
        .setCookie('refresh_token', tokens.refreshToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV !== 'development',
          sameSite: 'strict',
          path: '/api/auth/refresh',
          maxAge: tokenTtl.refreshDays * 86400,
        })
        .send({
          user: { id: user.id, email: user.email, isDeploymentAdmin: user.is_deployment_admin },
          workspaceId,
          roles,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: new Date(Date.now() + tokenTtl.accessMinutes * 60 * 1000).toISOString(),
        });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        reply.code(409).send({ error: 'User with this email already exists' });
        return;
      }
      throw err;
    }
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

      const userId = payload.sub!;
      const db = (app as any).db;

      // Query current roles from the database instead of reusing stale token claims
      const userResult = await db.query(
        `SELECT u.is_deployment_admin, uwr.role, uwr.workspace_id
         FROM users u
         LEFT JOIN user_workspace_roles uwr ON u.id = uwr.user_id
         WHERE u.id = $1`,
        [userId],
      );

      if (userResult.rows.length === 0) {
        reply.code(401).send({ error: 'User not found' });
        return;
      }

      const isDeploymentAdmin: boolean = userResult.rows[0]?.is_deployment_admin ?? false;
      // Prefer the workspace from the original token if the user still has access, otherwise use the first available
      const requestedWorkspace = payload.workspace_id as string | undefined;
      const availableWorkspaces = userResult.rows
        .filter((r: any) => r.workspace_id != null)
        .map((r: any) => ({ workspaceId: r.workspace_id as string, role: r.role as string }));
      const matchingWorkspace = availableWorkspaces.find((w: { workspaceId: string }) => w.workspaceId === requestedWorkspace);
      const activeWorkspace = matchingWorkspace ?? availableWorkspaces[0];
      const workspaceId = activeWorkspace?.workspaceId;
      const roles = availableWorkspaces
        .filter((w: { workspaceId: string }) => w.workspaceId === workspaceId)
        .map((w: { role: string }) => w.role);

      const tokens = await issueTokens(
        userId,
        workspaceId,
        roles,
        isDeploymentAdmin,
        jwtSecret,
        tokenTtl,
      );

      reply
        .setCookie('token', tokens.accessToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV !== 'development',
          sameSite: 'strict',
          path: '/',
          maxAge: tokenTtl.accessMinutes * 60,
        })
        .send({ success: true });
    } catch {
      reply.code(401).send({ error: 'Invalid refresh token' });
    }
  });

  app.get('/api/auth/me', async (request, reply) => {
    // request.userId, request.workspaceId, request.roles are set by the onRequest hook
    const db = (app as any).db;
    const { rows } = await db.query('SELECT id, email, display_name FROM users WHERE id = $1', [request.userId]);
    if (!rows[0]) return reply.code(404).send({ error: 'User not found' });
    return {
      user: { id: rows[0].id, email: rows[0].email, displayName: rows[0].display_name ?? rows[0].email },
      workspaceId: request.workspaceId,
      roles: request.roles ?? [],
    };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    reply
      .clearCookie('token', { path: '/' })
      .clearCookie('refresh_token', { path: '/api/auth/refresh' })
      .send({ success: true });
  });

  // Bootstrap endpoint — creates the first workspace + admin user in one call.
  // Only works when no users exist (same gate as self-registration).
  app.post('/api/admin/bootstrap', async (request, reply) => {
    if (!checkRateLimit(request, reply)) return;

    const { workspaceName, adminEmail, adminPassword } = request.body as {
      workspaceName?: string;
      adminEmail: string;
      adminPassword: string;
    };
    const db = (app as any).db;

    if (!adminEmail || !adminPassword || adminPassword.length < 8 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
      reply.code(400).send({ error: 'Valid email and password (min 8 chars) are required' });
      return;
    }

    // Only allowed when no users exist
    const countResult = await db.query('SELECT count(*) AS cnt FROM users');
    if (parseInt(countResult.rows[0].cnt, 10) > 0) {
      reply.code(409).send({ error: 'Bootstrap already completed. Use /api/auth/login.' });
      return;
    }

    const passwordHash = await bcrypt.hash(adminPassword, 12);

    // Create workspace
    const wsName = workspaceName?.trim() || 'default';
    const wsResult = await db.query(
      `INSERT INTO workspaces (name) VALUES ($1)
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [wsName],
    );
    const workspaceId = wsResult.rows[0].id;

    // Create admin user
    const userResult = await db.query(
      `INSERT INTO users (email, password_hash, is_deployment_admin)
       VALUES ($1, $2, true)
       RETURNING id, email`,
      [adminEmail, passwordHash],
    );
    const user = userResult.rows[0];

    // Assign workspace_admin role
    await db.query(
      'INSERT INTO user_workspace_roles (user_id, workspace_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [user.id, workspaceId, 'workspace_admin'],
    );

    reply.code(201).send({
      user: { id: user.id, email: user.email, isDeploymentAdmin: true },
      workspaceId,
      roles: ['workspace_admin'],
    });
  });

  // Public auth config — exposes non-secret settings the UI needs
  app.get('/api/auth/config', async () => {
    const db = (app as any).db;
    let selfRegistrationEnabled = process.env.ALLOW_SELF_REGISTRATION === 'true';
    // Also enable registration if no users exist yet (first-user flow)
    if (!selfRegistrationEnabled) {
      try {
        const { rows } = await db.query('SELECT count(*) AS cnt FROM users');
        if (parseInt(rows[0].cnt, 10) === 0) selfRegistrationEnabled = true;
      } catch {
        // Non-fatal
      }
    }
    return {
      selfRegistrationEnabled,
      mfaRequired: authConfig?.mfaRequired ?? false,
    };
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

export async function issueTokens(
  userId: string,
  workspaceId: string | undefined,
  roles: string[],
  isDeploymentAdmin: boolean,
  secret: Uint8Array,
  ttl?: { accessMinutes?: number; refreshDays?: number },
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessTtl = `${ttl?.accessMinutes ?? 60}m`;
  const refreshTtl = `${ttl?.refreshDays ?? 7}d`;

  const accessToken = await new jose.SignJWT({
    workspace_id: workspaceId,
    roles,
    is_deployment_admin: isDeploymentAdmin,
    type: 'access',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer('honorclaw')
    .setExpirationTime(accessTtl)
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
    .setExpirationTime(refreshTtl)
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
