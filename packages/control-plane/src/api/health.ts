import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/live', async () => ({ status: 'ok' }));

  app.get('/ready', async () => {
    const db = (app as any).db;
    const redis = (app as any).redis;

    try {
      await db.query('SELECT 1');
      await redis.ping();
      return { status: 'ready', timestamp: new Date().toISOString() };
    } catch (err) {
      return { status: 'not_ready', error: err instanceof Error ? err.message : 'Unknown' };
    }
  });
}
