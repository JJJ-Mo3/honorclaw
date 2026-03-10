import type { FastifyInstance } from 'fastify';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';
import { toCamelCase } from './row-mapper.js';
import crypto from 'node:crypto';
import { encryptSecret } from '../auth/crypto.js';

export async function secretRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  // List secret paths (names only, not values) — admin-only
  app.get('/', { preHandler: [requireRoles('workspace_admin')] }, async (request) => {
    const db = (app as any).db;
    const { prefix } = request.query as { prefix?: string };

    let query = 'SELECT path, expires_at, created_at, updated_at FROM secrets WHERE workspace_id = $1';
    const params: unknown[] = [request.workspaceId];

    if (prefix) {
      // Escape LIKE wildcards to prevent injection
      const escapedPrefix = prefix.replace(/[%_\\]/g, '\\$&');
      query += " AND path LIKE $2 ESCAPE '\\'";
      params.push(`${escapedPrefix}%`);
    }

    query += ' ORDER BY path';

    const result = await db.query(query, params);
    return { secrets: result.rows.map((r: { path: string; expires_at: string | null; created_at: string; updated_at: string }) => ({
      path: r.path,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })) };
  });

  // Create or set a secret
  app.post('/', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { path: secretPath, value, expires_at } = request.body as {
      path: string;
      value: string;
      expires_at?: string;
    };
    const db = (app as any).db;

    if (!secretPath || !value) {
      reply.code(400).send({ error: 'Secret path and value are required' });
      return;
    }

    // Encrypt the value using AES-256-GCM with HONORCLAW_MASTER_KEY
    const encryptedValue = Buffer.from(encryptSecret(value), 'utf-8');

    const result = await db.query(
      `INSERT INTO secrets (workspace_id, path, encrypted_value, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, path) DO UPDATE
         SET encrypted_value = $3, expires_at = $4, updated_at = now()
       RETURNING id, path, expires_at, created_at, updated_at`,
      [request.workspaceId, secretPath, encryptedValue, expires_at ?? null]
    );

    reply.code(201).send({ secret: toCamelCase(result.rows[0]) });
  });

  // Delete a secret
  app.delete('/:secretPath', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { secretPath } = request.params as { secretPath: string };
    const db = (app as any).db;

    const result = await db.query(
      'DELETE FROM secrets WHERE workspace_id = $1 AND path = $2 RETURNING id',
      [request.workspaceId, secretPath]
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'Secret not found' });
      return;
    }

    return { deleted: true, path: secretPath };
  });

  // Rotate a secret
  app.post('/rotate', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { path: secretPath, value } = request.body as {
      path: string;
      value?: string;
    };
    const db = (app as any).db;

    if (!secretPath) {
      reply.code(400).send({ error: 'Secret path is required' });
      return;
    }

    // Use provided value or generate a new random one
    const newValue = value ?? crypto.randomBytes(32).toString('base64url');
    const encryptedValue = Buffer.from(encryptSecret(newValue), 'utf-8');

    const result = await db.query(
      `UPDATE secrets SET encrypted_value = $1, updated_at = now()
       WHERE workspace_id = $2 AND path = $3
       RETURNING id, path, expires_at, created_at, updated_at`,
      [encryptedValue, request.workspaceId, secretPath]
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'Secret not found' });
      return;
    }

    return { secret: toCamelCase(result.rows[0]), rotated: true };
  });
}
