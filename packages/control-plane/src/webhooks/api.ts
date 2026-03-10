import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import type { EncryptionProvider } from '@honorclaw/core';
import { WebhookDispatcher } from './dispatcher.js';
import { validateWebhookUrl } from './url-validator.js';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';
import { mapRows } from '../api/row-mapper.js';

export function registerWebhookRoutes(
  app: FastifyInstance,
  db: Pool,
  encryption: EncryptionProvider,
  dispatcher: WebhookDispatcher,
) {
  // All webhook routes require workspace_admin role
  const webhookPreHandler = [requireWorkspace(), requireRoles('workspace_admin')];

  // List webhook subscriptions for workspace
  app.get('/webhooks', { preHandler: webhookPreHandler }, async (request, reply) => {
    const workspaceId = request.workspaceId;
    if (!workspaceId) return reply.status(401).send({ error: 'No workspace context' });

    const result = await db.query(
      `SELECT id, url, event_types, enabled, created_at, last_delivered_at, consecutive_failures
       FROM webhook_subscriptions WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId],
    );

    return { webhooks: mapRows(result.rows) };
  });

  // Create webhook subscription
  app.post('/webhooks', { preHandler: webhookPreHandler }, async (request, reply) => {
    const workspaceId = request.workspaceId;
    if (!workspaceId) return reply.status(401).send({ error: 'No workspace context' });

    const { url, event_types } = request.body as { url: string; event_types: string[] };

    // Validate URL (SSRF protection)
    const allowHttp = process.env['ALLOW_HTTP_WEBHOOKS'] === 'true';
    const urlCheck = await validateWebhookUrl(url, allowHttp);
    if (!urlCheck.valid) {
      return reply.status(400).send({ error: `Invalid webhook URL: ${urlCheck.reason}` });
    }

    // Generate signing secret
    const signingSecret = randomBytes(32).toString('hex');
    const signingSecretEncrypted = await encryption.encrypt(Buffer.from(signingSecret));

    const id = randomUUID();
    await db.query(
      `INSERT INTO webhook_subscriptions (id, workspace_id, url, event_types, signing_secret_encrypted, enabled)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [id, workspaceId, url, event_types, signingSecretEncrypted],
    );

    // Return signing secret ONCE — not stored in plaintext
    return reply.status(201).send({
      id,
      signing_secret: signingSecret,
      url,
      event_types,
      enabled: true,
    });
  });

  // Update webhook subscription
  app.put('/webhooks/:id', { preHandler: webhookPreHandler }, async (request, reply) => {
    const workspaceId = request.workspaceId;
    if (!workspaceId) return reply.status(401).send({ error: 'No workspace context' });

    const { id } = request.params as { id: string };
    const { url, event_types, enabled } = request.body as {
      url?: string;
      event_types?: string[];
      enabled?: boolean;
    };

    if (url) {
      const allowHttp = process.env['ALLOW_HTTP_WEBHOOKS'] === 'true';
      const urlCheck = await validateWebhookUrl(url, allowHttp);
      if (!urlCheck.valid) {
        return reply.status(400).send({ error: `Invalid webhook URL: ${urlCheck.reason}` });
      }
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (url !== undefined) {
      sets.push(`url = $${idx++}`);
      params.push(url);
    }
    if (event_types !== undefined) {
      sets.push(`event_types = $${idx++}`);
      params.push(event_types);
    }
    if (enabled !== undefined) {
      sets.push(`enabled = $${idx++}`);
      params.push(enabled);
      if (enabled) {
        sets.push(`consecutive_failures = 0`);
      }
    }

    if (sets.length === 0) {
      return reply.status(400).send({ error: 'No fields to update' });
    }

    params.push(id, workspaceId);
    const result = await db.query(
      `UPDATE webhook_subscriptions SET ${sets.join(', ')} WHERE id = $${idx++} AND workspace_id = $${idx} RETURNING id`,
      params,
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Webhook not found' });
    }

    return { success: true };
  });

  // Delete webhook subscription
  app.delete('/webhooks/:id', { preHandler: webhookPreHandler }, async (request, reply) => {
    const workspaceId = request.workspaceId;
    if (!workspaceId) return reply.status(401).send({ error: 'No workspace context' });

    const { id } = request.params as { id: string };

    const result = await db.query(
      `DELETE FROM webhook_subscriptions WHERE id = $1 AND workspace_id = $2 RETURNING id`,
      [id, workspaceId],
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Webhook not found' });
    }

    return { success: true };
  });

  // Test webhook delivery
  app.post('/webhooks/:id/test', { preHandler: webhookPreHandler }, async (request, reply) => {
    const workspaceId = request.workspaceId;
    if (!workspaceId) return reply.status(401).send({ error: 'No workspace context' });

    const { id } = request.params as { id: string };

    const result = await db.query(
      `SELECT id, url, event_types, signing_secret_encrypted FROM webhook_subscriptions
       WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Webhook subscription not found' });
    }

    const testEvent = {
      id: randomUUID(),
      event_type: 'test',
      workspace_id: workspaceId,
      timestamp: new Date().toISOString(),
      details: { message: 'This is a test webhook delivery from HonorClaw' },
    };

    // Dispatch synchronously for test
    try {
      await dispatcher.dispatch(testEvent as any);
      return { success: true, message: 'Test delivery sent' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ success: false, error: message });
    }
  });

  // Get delivery log for a subscription
  app.get('/webhooks/:id/deliveries', { preHandler: webhookPreHandler }, async (request, reply) => {
    const workspaceId = request.workspaceId;
    if (!workspaceId) return reply.status(401).send({ error: 'No workspace context' });

    const { id } = request.params as { id: string };

    const result = await db.query(
      `SELECT d.id, d.event_id, d.attempt, d.status, d.response_status, d.error_message, d.delivered_at
       FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON d.subscription_id = s.id
       WHERE d.subscription_id = $1 AND s.workspace_id = $2
       ORDER BY d.delivered_at DESC LIMIT 50`,
      [id, workspaceId],
    );

    return { deliveries: mapRows(result.rows) };
  });
}
