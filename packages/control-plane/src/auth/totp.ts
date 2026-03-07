import type { FastifyInstance } from 'fastify';
import * as jose from 'jose';
import { authenticator } from 'otplib';
import { encryptSecret, decryptSecret } from './crypto.js';
import { checkRateLimit, recordFailedAttempt, clearRateLimit } from './rate-limiter.js';

export async function totpRoutes(app: FastifyInstance) {
  const rawSecret = process.env.JWT_SECRET;
  if (!rawSecret) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[totp] WARNING: JWT_SECRET is not set. Using insecure default for development only.');
    } else {
      throw new Error('JWT_SECRET must be set in production');
    }
  }
  const jwtSecret = new TextEncoder().encode(
    rawSecret ?? 'honorclaw-dev-secret-change-in-production'
  );

  // Set up TOTP for the authenticated user
  app.post('/api/auth/totp/setup', async (request, reply) => {
    if (!request.userId) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }

    const db = (app as any).db;

    // Check if TOTP is already enabled
    const userResult = await db.query(
      'SELECT id, email, totp_enabled FROM users WHERE id = $1',
      [request.userId]
    );

    if (userResult.rows.length === 0) {
      reply.code(404).send({ error: 'User not found' });
      return;
    }

    const user = userResult.rows[0];

    if (user.totp_enabled) {
      reply.code(409).send({ error: 'TOTP is already enabled for this account' });
      return;
    }

    // Generate a new TOTP secret
    const secret = authenticator.generateSecret();

    // Encrypt and store the secret (not yet enabled — user must verify first)
    const encryptedSecret = encryptSecret(secret);
    await db.query(
      'UPDATE users SET totp_secret = $1, updated_at = now() WHERE id = $2',
      [encryptedSecret, request.userId]
    );

    // Generate provisioning URI for QR code scanning
    const otpauthUri = authenticator.keyuri(user.email, 'HonorClaw', secret);

    return { secret, otpauthUri };
  });

  // Verify a TOTP code and issue session tokens
  app.post('/api/auth/totp/verify', async (request, reply) => {
    // Rate limit by IP
    if (!checkRateLimit(request, reply)) return;

    const { code } = request.body as { code: string };

    if (!code) {
      reply.code(400).send({ error: 'TOTP code is required' });
      return;
    }

    // Extract the mfa_pending token from Authorization header
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : request.cookies?.token;

    if (!token) {
      reply.code(401).send({ error: 'MFA pending token required' });
      return;
    }

    let payload: jose.JWTPayload;
    try {
      const result = await jose.jwtVerify(token, jwtSecret, { issuer: 'honorclaw' });
      payload = result.payload;
    } catch {
      reply.code(401).send({ error: 'Invalid or expired MFA token' });
      return;
    }

    if (payload.type !== 'mfa_pending') {
      reply.code(401).send({ error: 'Invalid token type — expected mfa_pending token' });
      return;
    }

    const userId = payload.sub;
    if (!userId) {
      reply.code(401).send({ error: 'Invalid token' });
      return;
    }

    const db = (app as any).db;

    // Fetch user with TOTP secret
    const userResult = await db.query(
      'SELECT id, email, totp_secret, totp_enabled, is_deployment_admin FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) {
      reply.code(404).send({ error: 'User not found' });
      return;
    }

    const user = userResult.rows[0];

    if (!user.totp_secret) {
      reply.code(400).send({ error: 'TOTP is not configured for this account' });
      return;
    }

    // Decrypt the stored TOTP secret before verification
    const decryptedSecret = decryptSecret(user.totp_secret);

    // Verify the TOTP code
    const isValid = authenticator.check(code, decryptedSecret);

    if (!isValid) {
      recordFailedAttempt(request);
      reply.code(401).send({ error: 'Invalid TOTP code' });
      return;
    }

    // TOTP verified successfully — clear rate limit for this IP
    clearRateLimit(request);

    // If TOTP was not yet enabled (first verification after setup), enable it
    if (!user.totp_enabled) {
      await db.query(
        'UPDATE users SET totp_enabled = true, updated_at = now() WHERE id = $1',
        [userId]
      );
    }

    // Get workspace roles
    const rolesResult = await db.query(
      'SELECT workspace_id, role FROM user_workspace_roles WHERE user_id = $1',
      [userId]
    );

    const firstWorkspace = rolesResult.rows[0];
    const workspaceId = firstWorkspace?.workspace_id as string | undefined;
    const roles = rolesResult.rows
      .filter((r: any) => r.workspace_id === workspaceId)
      .map((r: any) => r.role) as string[];

    // Issue real session tokens
    const accessToken = await new jose.SignJWT({
      workspace_id: workspaceId,
      roles,
      is_deployment_admin: user.is_deployment_admin,
      type: 'access',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer('honorclaw')
      .setExpirationTime('1h')
      .setIssuedAt()
      .sign(jwtSecret);

    const refreshToken = await new jose.SignJWT({
      workspace_id: workspaceId,
      roles,
      is_deployment_admin: user.is_deployment_admin,
      type: 'refresh',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer('honorclaw')
      .setExpirationTime('7d')
      .setIssuedAt()
      .sign(jwtSecret);

    reply
      .setCookie('token', accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV !== 'development',
        sameSite: 'strict',
        path: '/',
        maxAge: 3600,
      })
      .setCookie('refresh_token', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV !== 'development',
        sameSite: 'strict',
        path: '/api/auth/refresh',
        maxAge: 7 * 86400,
      })
      .send({
        user: { id: userId, email: user.email, isDeploymentAdmin: user.is_deployment_admin },
        workspaceId,
        roles,
      });
  });
}
