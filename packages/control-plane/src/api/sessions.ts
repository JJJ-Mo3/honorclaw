import type { FastifyInstance } from 'fastify';
import { requireWorkspace } from '../middleware/rbac.js';

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

  app.post('/:id/messages', async (request) => {
    const { id } = request.params as { id: string };
    const { content } = request.body as { content: string };
    const sessionManager = (app as any).sessionManager;

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
    return { session: result.rows[0] };
  });

  app.delete('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const sessionManager = (app as any).sessionManager;
    await sessionManager.end(id);
    return { ended: true };
  });
}
