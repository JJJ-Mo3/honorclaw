import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import * as jose from 'jose';
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
import { initTelemetry, RedisChannels } from '@honorclaw/core';
import { LLMRouter } from './llm/router.js';
import { SessionManager } from './sessions/manager.js';
import { ToolExecutor } from './tools/executor.js';
import { AuditEmitter } from './audit/emitter.js';
import { AgentScheduler } from './scheduler/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  // WebSocket support
  await app.register(websocket);

  // Core services
  const db = createDb(config.database);
  await runMigrations(db);

  // Seed a default agent on first startup (only if a workspace exists and no agents yet)
  try {
    const { rows: workspaceRows } = await db.query('SELECT id FROM workspaces LIMIT 1');
    if (workspaceRows.length > 0) {
      const { rows: agentRows } = await db.query('SELECT COUNT(*) as count FROM agents');
      if (parseInt(agentRows[0]?.count ?? '0', 10) === 0) {
        await db.query(
          `INSERT INTO agents (id, workspace_id, name, model, system_prompt, status, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, 'General Assistant',
                   'ollama/llama3.2', 'You are a helpful AI assistant.', 'active', NOW(), NOW())
           ON CONFLICT DO NOTHING`,
          [workspaceRows[0].id],
        );
        logger.info('Created default "General Assistant" agent');
      }
    }
  } catch (err) {
    // Non-fatal: the agents table may not exist yet if migrations are still pending
    logger.warn({ err }, 'Could not seed default agent (non-fatal)');
  }

  const redis = createRedis(config.redis);
  const auditEmitter = new AuditEmitter(db);
  const llmRouter = new LLMRouter(config.llm, redis, auditEmitter);
  const toolExecutor = new ToolExecutor(redis, db, auditEmitter);
  const sessionManager = new SessionManager(redis, db, llmRouter, toolExecutor, auditEmitter, config);

  // Start LLM and tool execution pipelines (subscribes to Redis pub/sub)
  await llmRouter.start();
  await toolExecutor.start();

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
  const allowHttpWebhooks = process.env['ALLOW_HTTP_WEBHOOKS'] === 'true';
  const webhookDispatcher = new WebhookDispatcher(db, encryption, allowHttpWebhooks);
  registerWebhookRoutes(app, db, encryption, webhookDispatcher);

  // WebSocket chat endpoint
  const rawJwtSecret = process.env.JWT_SECRET;
  const jwtSecret = new TextEncoder().encode(
    rawJwtSecret ?? 'honorclaw-dev-secret-change-in-production',
  );

  app.get('/api/ws/chat', { websocket: true }, (socket, request) => {
    let userId: string | undefined;
    let workspaceId: string | undefined;

    // Authenticate via token query parameter
    const url = new URL(request.url, `http://${request.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      socket.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
      socket.close(4401, 'Authentication required');
      return;
    }

    // Verify token asynchronously then set up message handling
    jose.jwtVerify(token, jwtSecret, { issuer: 'honorclaw' }).then(({ payload }) => {
      userId = payload.sub;
      workspaceId = payload.workspace_id as string | undefined;

      if (!userId || !workspaceId) {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid token claims' }));
        socket.close(4401, 'Invalid token claims');
        return;
      }

      socket.send(JSON.stringify({ type: 'connected', userId, workspaceId }));

      // Subscribe to agent output channels for this user
      const sub = redis.duplicate();
      const subscribedChannels = new Set<string>();

      socket.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as { agentId?: string; sessionId?: string; content?: string; action?: string };

          if (msg.action === 'subscribe' && msg.sessionId) {
            // Subscribe to output for a specific session
            const outputChannel = RedisChannels.agentOutput(msg.sessionId);
            if (!subscribedChannels.has(outputChannel)) {
              subscribedChannels.add(outputChannel);
              sub.subscribe(outputChannel).catch((err: unknown) => {
                logger.error({ err, channel: outputChannel }, 'Failed to subscribe to agent output');
              });
            }
            return;
          }

          if (msg.content && msg.agentId) {
            // Create session or send message
            if (!msg.sessionId) {
              // Create a new session
              sessionManager.create({
                workspaceId: workspaceId!,
                agentId: msg.agentId,
                userId: userId!,
                channel: 'websocket',
              }).then((session) => {
                socket.send(JSON.stringify({ type: 'session_created', sessionId: session.id }));

                // Subscribe to output for the new session
                const outputChannel = RedisChannels.agentOutput(session.id);
                subscribedChannels.add(outputChannel);
                sub.subscribe(outputChannel).catch((err: unknown) => {
                  logger.error({ err, channel: outputChannel }, 'Failed to subscribe to agent output');
                });

                // Send the message
                sessionManager.sendMessage(session.id, msg.content!, userId!).catch((err: unknown) => {
                  logger.error({ err }, 'Failed to send message');
                  socket.send(JSON.stringify({ type: 'error', message: 'Failed to send message' }));
                });
              }).catch((err: unknown) => {
                logger.error({ err }, 'Failed to create session');
                socket.send(JSON.stringify({ type: 'error', message: 'Failed to create session' }));
              });
            } else {
              // Send message to existing session
              sessionManager.sendMessage(msg.sessionId, msg.content, userId!).catch((err: unknown) => {
                logger.error({ err }, 'Failed to send message');
                socket.send(JSON.stringify({ type: 'error', message: 'Failed to send message' }));
              });
            }
          }
        } catch (err) {
          logger.error({ err }, 'WebSocket message parse error');
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
      });

      // Forward agent responses to the client
      sub.on('message', (channel: string, message: string) => {
        socket.send(JSON.stringify({ type: 'agent_message', channel, data: JSON.parse(message) }));
      });

      socket.on('close', () => {
        sub.unsubscribe().catch(() => {});
        sub.disconnect();
      });
    }).catch(() => {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid or expired token' }));
      socket.close(4401, 'Invalid or expired token');
    });
  });

  // Serve Web UI static files
  const webUiPath = process.env.HONORCLAW_WEB_UI_PATH
    ?? path.resolve(__dirname, '..', '..', '..', 'web-ui', 'dist');

  await app.register(fastifyStatic, {
    root: webUiPath,
    prefix: '/',
    wildcard: false,
    decorateReply: true,
  });

  // SPA fallback: serve index.html for non-API, non-health routes
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/health')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  // Agent Scheduler
  const scheduler = new AgentScheduler({ redis, db });
  await scheduler.start();
  logger.info('Agent scheduler started');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    await scheduler.stop();
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
