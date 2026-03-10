import type { FastifyInstance } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';
import { mapRows, toCamelCase } from './row-mapper.js';

export async function apiKeyRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  // List API keys for workspace (secrets masked)
  app.get('/', { preHandler: [requireRoles('workspace_admin')] }, async (request) => {
    const db = (app as any).db;
    const result = await db.query(
      `SELECT id, name, scopes, expires_at, created_at, last_used_at
       FROM api_keys WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [request.workspaceId],
    );
    return { apiKeys: mapRows(result.rows) };
  });

  // Create API key
  app.post('/', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { name, scopes, expiresInDays } = request.body as {
      name?: string; scopes?: string[]; expiresInDays?: number;
    };
    const db = (app as any).db;

    if (!name || name.trim().length === 0) {
      reply.code(400).send({ error: 'API key name is required' });
      return;
    }

    // Generate a secure random key with hc_ prefix for identification
    const rawKey = `hc_${randomBytes(32).toString('hex')}`;
    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 86400_000).toISOString()
      : null;

    const result = await db.query(
      `INSERT INTO api_keys (workspace_id, user_id, key_hash, name, scopes, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, scopes, expires_at, created_at`,
      [request.workspaceId, request.userId, keyHash, name.trim(), scopes ?? [], expiresAt],
    );

    // Return the raw key ONCE — it cannot be retrieved again
    reply.code(201).send({
      ...toCamelCase(result.rows[0]),
      key: rawKey,
    });
  });

  // Revoke (delete) an API key
  app.delete('/:id', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = (app as any).db;

    const result = await db.query(
      'DELETE FROM api_keys WHERE id = $1 AND workspace_id = $2 RETURNING id',
      [id, request.workspaceId],
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'API key not found' });
      return;
    }

    return { deleted: true };
  });
}
