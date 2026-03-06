import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import pino from 'pino';
import { loadConfig } from './config.js';
import { createDb } from './db/index.js';
import { createRedis } from './redis.js';
import { authPlugin } from './auth/plugin.js';
import { agentRoutes } from './api/agents.js';
import { sessionRoutes } from './api/sessions.js';
import { auditRoutes } from './api/audit.js';
import { healthRoutes } from './api/health.js';
import { workspaceRoutes } from './api/workspaces.js';
import { userRoutes } from './api/users.js';
import { manifestRoutes } from './api/manifests.js';
import { modelRoutes } from './api/models.js';
import { LLMRouter } from './llm/router.js';
import { SessionManager } from './sessions/manager.js';
import { ToolExecutor } from './tools/executor.js';
import { AuditEmitter } from './audit/emitter.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

async function main() {
  const config = loadConfig();

  const app = Fastify({
    logger,
    trustProxy: true,
  });

  await app.register(cors, { origin: config.server.corsOrigins, credentials: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie, { secret: config.server.sessionCookieSecret ?? 'change-me-in-production' });

  // Core services
  const db = createDb(config.database);
  const redis = createRedis(config.redis);
  const auditEmitter = new AuditEmitter(db);
  const llmRouter = new LLMRouter(config.llm, redis, auditEmitter);
  const toolExecutor = new ToolExecutor(redis, auditEmitter);
  const sessionManager = new SessionManager(redis, db, llmRouter, toolExecutor, auditEmitter, config);

  // Decorate Fastify
  app.decorate('db', db);
  app.decorate('redis', redis);
  app.decorate('config', config);
  app.decorate('auditEmitter', auditEmitter);
  app.decorate('llmRouter', llmRouter);
  app.decorate('sessionManager', sessionManager);

  // Auth
  await app.register(authPlugin);

  // Routes
  await app.register(healthRoutes, { prefix: '/health' });
  await app.register(agentRoutes, { prefix: '/api/agents' });
  await app.register(sessionRoutes, { prefix: '/api/sessions' });
  await app.register(auditRoutes, { prefix: '/api/audit' });
  await app.register(workspaceRoutes, { prefix: '/api/workspaces' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(manifestRoutes, { prefix: '/api/manifests' });
  await app.register(modelRoutes, { prefix: '/api/models' });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    await sessionManager.drainAll();
    await auditEmitter.flush();
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start
  await app.listen({ port: config.server.port, host: config.server.host });
  logger.info({ port: config.server.port }, 'Control Plane started');
}

main().catch((err) => {
  logger.fatal({ err }, 'Startup failed');
  process.exit(1);
});
