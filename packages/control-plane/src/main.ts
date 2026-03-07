import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import pino from 'pino';
import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/index.js';
import { createRedis } from './redis.js';
import { authPlugin } from './auth/plugin.js';
import { agentRoutes } from './api/agents.js';
import { sessionRoutes } from './api/sessions.js';
import { auditRoutes } from './api/audit.js';
import { healthRoutes, statusRoutes } from './api/health.js';
import { workspaceRoutes } from './api/workspaces.js';
import { skillRoutes } from './api/skills.js';
import { secretRoutes } from './api/secrets.js';
import { upgradeRoutes } from './api/upgrade.js';
import { migrateRoutes } from './api/migrate.js';
import { userRoutes } from './api/users.js';
import { manifestRoutes } from './api/manifests.js';
import { modelRoutes } from './api/models.js';
import { memoryRoutes } from './api/memory.js';
import { notificationRoutes } from './api/notifications.js';
import { evalRoutes } from './api/eval.js';
import { metricsRoutes } from './api/metrics.js';
import { approvalRoutes } from './api/approvals.js';
import { totpRoutes } from './auth/totp.js';
import { registerWebhookRoutes } from './webhooks/api.js';
import { WebhookDispatcher } from './webhooks/dispatcher.js';
import { BuiltInEncryptionProvider } from '@honorclaw/providers-built-in';
import type { EncryptionProvider } from '@honorclaw/core';
import { initTelemetry } from '@honorclaw/core';
import { LLMRouter } from './llm/router.js';
import { SessionManager } from './sessions/manager.js';
import { ToolExecutor } from './tools/executor.js';
import { AuditEmitter } from './audit/emitter.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

async function main() {
  const config = loadConfig();

  // Initialize OpenTelemetry if an OTLP endpoint is configured
  if (process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) {
    initTelemetry({
      serviceName: 'honorclaw-control-plane',
    });
    logger.info('OpenTelemetry initialized');
  }

  const app = Fastify({
    logger,
    trustProxy: true,
  });

  await app.register(cors, { origin: config.server.corsOrigins, credentials: true });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
      },
    },
  });

  const cookieSecret = config.server.sessionCookieSecret;
  if (!cookieSecret) {
    if (process.env.NODE_ENV === 'development') {
      console.warn('[main] WARNING: sessionCookieSecret is not set. Using insecure default for development only.');
    } else {
      throw new Error('sessionCookieSecret must be set in production');
    }
  }
  await app.register(cookie, { secret: cookieSecret ?? 'change-me-in-production' });

  // Core services
  const db = createDb(config.database);
  await runMigrations(db);
  const redis = createRedis(config.redis);
  const auditEmitter = new AuditEmitter(db);
  const llmRouter = new LLMRouter(config.llm, redis, auditEmitter);
  const toolExecutor = new ToolExecutor(redis, db, auditEmitter);
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
  await app.register(memoryRoutes, { prefix: '/api/agents' });
  await app.register(notificationRoutes, { prefix: '/api/notifications' });
  await app.register(evalRoutes, { prefix: '/api/eval' });
  await app.register(metricsRoutes, { prefix: '/api' });
  await app.register(approvalRoutes, { prefix: '/api/approvals' });
  await app.register(skillRoutes, { prefix: '/api/skills' });
  await app.register(secretRoutes, { prefix: '/api/secrets' });
  await app.register(statusRoutes, { prefix: '/api' });
  await app.register(upgradeRoutes, { prefix: '/api/upgrade' });
  await app.register(migrateRoutes, { prefix: '/api/migrate' });
  await app.register(totpRoutes);

  // Webhook routes (different registration pattern — needs db + encryption + dispatcher)
  const masterKey = process.env.HONORCLAW_MASTER_KEY;
  let encryption: EncryptionProvider;
  if (masterKey) {
    encryption = new BuiltInEncryptionProvider(masterKey);
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error('HONORCLAW_MASTER_KEY must be set in production for webhook secret encryption');
  } else {
    console.warn('[main] WARNING: HONORCLAW_MASTER_KEY not set — webhook secrets will NOT be encrypted (dev only)');
    encryption = {
      encrypt: async (buf: Buffer) => buf,
      decrypt: async (buf: Buffer) => buf,
    };
  }
  const webhookDispatcher = new WebhookDispatcher(db, auditEmitter as any);
  registerWebhookRoutes(app, db, encryption, webhookDispatcher);

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
