import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { RedisChannels } from '@honorclaw/core';
import { requireWorkspace } from '../middleware/rbac.js';
import { mapRows, toCamelCase } from './row-mapper.js';

export async function sessionRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  app.post('/', async (request, reply) => {
    const { agentId, channel, message } = request.body as { agentId: string; channel?: string; message?: string };
    const sessionManager = (app as any).sessionManager;

    const session = await sessionManager.create({
      workspaceId: request.workspaceId!,
      agentId,
      userId: request.userId!,
      channel: channel ?? 'api',
    });

    if (message) {
      await sessionManager.sendMessage(session.id, message, request.userId!);
    }

    reply.code(201).send({ session });
  });

  app.post('/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { content, sync } = request.body as { content: string; sync?: boolean };
    const sessionManager = (app as any).sessionManager;
    const redis = (app as any).redis as Redis;
    const db = (app as any).db;

    // Verify session belongs to the requester's workspace
    const ownerCheck = await db.query(
      'SELECT id FROM sessions WHERE id = $1 AND workspace_id = $2',
      [id, request.workspaceId]
    );
    if (ownerCheck.rows.length === 0) {
      reply.code(404).send({ error: 'Session not found' });
      return;
    }

    // If the client wants a synchronous response (e.g., CLI chat), subscribe to
    // the output channel BEFORE sending the message to avoid a race condition
    // where the AgentLoop publishes the response before we start listening.
    // Default to synchronous for backward compatibility with the CLI.
    const wantSync = sync !== false;

    if (wantSync) {
      const outputChannel = RedisChannels.agentOutput(id);
      const sub = redis.duplicate();

      try {
        // Set up the listener first, then send the message
        const replyPromise = new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            sub.unsubscribe().catch(() => {});
            sub.disconnect();
            reject(new Error('Timeout waiting for agent response'));
          }, 60_000);

          sub.subscribe(outputChannel).then(() => {
            sub.on('message', (_ch: string, msg: string) => {
              clearTimeout(timeout);
              sub.unsubscribe().catch(() => {});
              sub.disconnect();
              resolve(msg);
            });

            // Only send the message after the subscription is confirmed
            sessionManager.sendMessage(id, content, request.userId!).catch((err: unknown) => {
              clearTimeout(timeout);
              sub.unsubscribe().catch(() => {});
              sub.disconnect();
              reject(err);
            });
          }).catch((err: unknown) => {
            clearTimeout(timeout);
            sub.disconnect();
            reject(err);
          });
        });

        const reply = await replyPromise;
        const parsed = JSON.parse(reply) as { content?: string; error?: boolean };
        return { sent: true, reply: parsed.content ?? null, error: parsed.error ?? false };
      } catch {
        return { sent: true, reply: null, error: true, message: 'Timeout waiting for agent response' };
      }
    }

    // Async mode: just send and return immediately
    await sessionManager.sendMessage(id, content, request.userId!);
    return { sent: true };
  });

  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const db = (app as any).db;
    const result = await db.query(
      'SELECT * FROM sessions WHERE id = $1 AND workspace_id = $2',
      [id, request.workspaceId]
    );
    return { session: toCamelCase(result.rows[0]) };
  });

  // Get messages for a session, with optional ?after=<iso-timestamp> filter
  app.get('/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { after } = request.query as { after?: string };
    const db = (app as any).db;

    // Verify the session belongs to the requester's workspace
    const sessionCheck = await db.query(
      'SELECT id FROM sessions WHERE id = $1 AND workspace_id = $2',
      [id, request.workspaceId]
    );

    if (sessionCheck.rows.length === 0) {
      reply.code(404).send({ error: 'Session not found' });
      return;
    }

    let query: string;
    let params: unknown[];

    if (after) {
      query =
        'SELECT id, session_id, role, content, metadata, created_at FROM session_messages WHERE session_id = $1 AND created_at > $2 ORDER BY created_at ASC';
      params = [id, after];
    } else {
      query =
        'SELECT id, session_id, role, content, metadata, created_at FROM session_messages WHERE session_id = $1 ORDER BY created_at ASC';
      params = [id];
    }

    const result = await db.query(query, params);
    return { messages: mapRows(result.rows) };
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const db = (app as any).db;
    const sessionManager = (app as any).sessionManager;

    // Verify session belongs to the requester's workspace
    const ownerCheck = await db.query(
      'SELECT id FROM sessions WHERE id = $1 AND workspace_id = $2',
      [id, request.workspaceId]
    );
    if (ownerCheck.rows.length === 0) {
      reply.code(404).send({ error: 'Session not found' });
      return;
    }

    await sessionManager.end(id);
    return { ended: true };
  });
}
