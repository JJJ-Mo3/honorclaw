import type { FastifyInstance } from 'fastify';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const startTime = Date.now();

export async function healthRoutes(app: FastifyInstance) {
  app.get('/live', async () => ({ status: 'ok' }));

  app.get('/ready', async () => {
    const db = (app as any).db;
    const redis = (app as any).redis;

    try {
      await db.query('SELECT 1');
      await redis.ping();
      return { status: 'ready', timestamp: new Date().toISOString() };
    } catch {
      return { status: 'not_ready' };
    }
  });

  // Deep health check with latency measurements
  app.get('/deep', async () => {
    const db = (app as any).db;
    const redis = (app as any).redis;

    const checks: {
      database: { status: string; latencyMs?: number };
      redis: { status: string; latencyMs?: number };
    } = {
      database: { status: 'error' },
      redis: { status: 'error' },
    };

    // Database check with latency
    try {
      const dbStart = Date.now();
      await db.query('SELECT 1');
      const dbLatency = Date.now() - dbStart;
      checks.database = { status: 'ok', latencyMs: dbLatency };
    } catch {
      checks.database = { status: 'error' };
    }

    // Redis check with round-trip latency
    try {
      const redisStart = Date.now();
      await redis.ping();
      const redisLatency = Date.now() - redisStart;
      checks.redis = { status: 'ok', latencyMs: redisLatency };
    } catch {
      checks.redis = { status: 'error' };
    }

    const allHealthy = checks.database.status === 'ok' && checks.redis.status === 'ok';

    return {
      status: allHealthy ? 'healthy' : 'degraded',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      checks,
    };
  });
}

export async function statusRoutes(app: FastifyInstance) {
  app.get('/status', async () => {
    const db = (app as any).db;
    const redis = (app as any).redis;

    let version = '0.1.0';
    try {
      const pkg = require('../../package.json') as { version: string };
      version = pkg.version;
    } catch {
      // Fall back to default
    }

    let dbStatus = 'error';
    let agents = 0;
    let activeSessions = 0;

    try {
      await db.query('SELECT 1');
      dbStatus = 'ok';

      const agentResult = await db.query('SELECT count(*) AS cnt FROM agents');
      agents = parseInt(agentResult.rows[0].cnt, 10);

      const sessionResult = await db.query("SELECT count(*) AS cnt FROM sessions WHERE status = 'active'");
      activeSessions = parseInt(sessionResult.rows[0].cnt, 10);
    } catch {
      dbStatus = 'error';
    }

    let redisStatus = 'error';
    try {
      await redis.ping();
      redisStatus = 'ok';
    } catch {
      redisStatus = 'error';
    }

    return {
      version,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      agents,
      activeSessions,
      database: dbStatus,
      redis: redisStatus,
    };
  });
}
