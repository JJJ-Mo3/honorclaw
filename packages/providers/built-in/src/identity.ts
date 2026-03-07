import type {
  IdentityProvider,
  TokenClaims,
  JWKS,
  CreateUserRequest,
  User,
  AuthResult,
  TokenPair,
  OIDCProviderConfig,
} from '@honorclaw/core';
import type { Pool } from 'pg';
import * as jose from 'jose';
import bcrypt from 'bcryptjs';

export class BuiltInIdentityProvider implements IdentityProvider {
  private readonly pool: Pool;
  private readonly jwtSecret: Uint8Array;
  private readonly issuer = 'honorclaw';

  constructor(pool: Pool, jwtSecretRaw: string) {
    this.pool = pool;
    this.jwtSecret = new TextEncoder().encode(jwtSecretRaw);
  }

  async validateToken(token: string): Promise<TokenClaims> {
    const { payload } = await jose.jwtVerify(token, this.jwtSecret, { issuer: this.issuer });
    return {
      sub: payload.sub!,
      workspaceId: payload.workspace_id as string | undefined,
      roles: (payload.roles as string[]) ?? [],
      isDeploymentAdmin: (payload.is_deployment_admin as boolean) ?? false,
      iat: payload.iat!,
      exp: payload.exp!,
    };
  }

  async getJWKS(): Promise<JWKS> {
    // For symmetric (HS256) signing, JWKS is not applicable.
    // Return empty keys array; a full implementation would use asymmetric keys.
    return { keys: [] };
  }

  async createUser(req: CreateUserRequest): Promise<User> {
    const passwordHash = req.password
      ? await bcrypt.hash(req.password, 12)
      : null;

    const result = await this.pool.query(
      `INSERT INTO users (email, password_hash, is_deployment_admin)
       VALUES ($1, $2, $3)
       RETURNING id, email, is_deployment_admin, totp_enabled, created_at, last_login_at`,
      [req.email, passwordHash, req.isDeploymentAdmin ?? false],
    );

    const row = result.rows[0] as Record<string, unknown>;
    return this.mapUser(row);
  }

  async updateUserRoles(userId: string, workspaceId: string, roles: string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM user_workspace_roles WHERE user_id = $1 AND workspace_id = $2',
        [userId, workspaceId],
      );
      for (const role of roles) {
        await client.query(
          'INSERT INTO user_workspace_roles (user_id, workspace_id, role) VALUES ($1, $2, $3)',
          [userId, workspaceId, role],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listUsers(workspaceId?: string): Promise<User[]> {
    let result;
    if (workspaceId) {
      result = await this.pool.query(
        `SELECT DISTINCT u.id, u.email, u.is_deployment_admin, u.totp_enabled, u.created_at, u.last_login_at
         FROM users u
         INNER JOIN user_workspace_roles uwr ON u.id = uwr.user_id
         WHERE uwr.workspace_id = $1
         ORDER BY u.created_at DESC`,
        [workspaceId],
      );
    } else {
      result = await this.pool.query(
        'SELECT id, email, is_deployment_admin, totp_enabled, created_at, last_login_at FROM users ORDER BY created_at DESC',
      );
    }
    return result.rows.map((row: Record<string, unknown>) => this.mapUser(row));
  }

  async authenticateLocal(email: string, password: string): Promise<AuthResult> {
    const result = await this.pool.query(
      'SELECT id, email, password_hash, is_deployment_admin, totp_enabled, created_at, last_login_at, failed_login_count, locked_until FROM users WHERE email = $1',
      [email],
    );

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error('Invalid credentials');
    }

    // Check lockout
    if (row.locked_until && new Date(row.locked_until as string) > new Date()) {
      throw new Error('Account locked. Try again later.');
    }

    const valid = await bcrypt.compare(password, row.password_hash as string);
    if (!valid) {
      const newCount = ((row.failed_login_count as number) ?? 0) + 1;
      const lockUntil = newCount >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
      await this.pool.query(
        'UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3',
        [newCount, lockUntil, row.id],
      );
      throw new Error('Invalid credentials');
    }

    // Reset failed count
    await this.pool.query(
      'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
      [row.id],
    );

    return {
      user: this.mapUser(row),
      requiresMfa: row.totp_enabled as boolean,
    };
  }

  async issueTokens(userId: string, workspaceId: string): Promise<TokenPair> {
    const rolesResult = await this.pool.query(
      'SELECT role FROM user_workspace_roles WHERE user_id = $1 AND workspace_id = $2',
      [userId, workspaceId],
    );
    const roles = rolesResult.rows.map((r: Record<string, unknown>) => r.role as string);

    const userResult = await this.pool.query(
      'SELECT is_deployment_admin FROM users WHERE id = $1',
      [userId],
    );
    const isDeploymentAdmin = (userResult.rows[0] as Record<string, unknown> | undefined)?.is_deployment_admin as boolean ?? false;

    const accessToken = await new jose.SignJWT({
      workspace_id: workspaceId,
      roles,
      is_deployment_admin: isDeploymentAdmin,
      type: 'access',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(this.issuer)
      .setExpirationTime('1h')
      .setIssuedAt()
      .sign(this.jwtSecret);

    const refreshToken = await new jose.SignJWT({
      workspace_id: workspaceId,
      roles,
      is_deployment_admin: isDeploymentAdmin,
      type: 'refresh',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(this.issuer)
      .setExpirationTime('7d')
      .setIssuedAt()
      .sign(this.jwtSecret);

    return { accessToken, refreshToken };
  }

  async configureOIDCProvider(_config: OIDCProviderConfig): Promise<void> {
    // OIDC federation is a Tier 3+ feature.
    // In the built-in provider, store the config for later use with an external IdP.
    throw new Error('OIDC provider configuration requires an external identity provider (Keycloak). Use Tier 3+ deployment.');
  }

  private mapUser(row: Record<string, unknown>): User {
    return {
      id: row.id as string,
      email: row.email as string,
      isDeploymentAdmin: row.is_deployment_admin as boolean,
      totpEnabled: (row.totp_enabled as boolean) ?? false,
      createdAt: new Date(row.created_at as string),
      lastLoginAt: row.last_login_at ? new Date(row.last_login_at as string) : undefined,
    };
  }
}
