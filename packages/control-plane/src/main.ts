import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import crypto from 'node:crypto';
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
import { integrationRoutes } from './api/integrations.js';
import { toolRoutes } from './api/tools.js';
import { scheduledRunRoutes } from './api/scheduled-runs.js';
import { apiKeyRoutes } from './api/api-keys.js';
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
import { AgentLoop } from './agent-loop.js';
import { SessionReaper } from './sessions/reaper.js';
import { SecurityMonitor } from './security/monitor.js';
import { NotificationDispatcher } from './notifications/dispatcher.js';

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
    trustProxy: config.server.trustProxy ?? false,
  });

  await app.register(cors, { origin: config.server.corsOrigins, credentials: true });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
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

  // Global error handler — consistent JSON error response shape
  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    logger.error({ err: error, statusCode }, 'Request error');
    reply.status(statusCode).send({
      error: error.message ?? 'Internal server error',
      ...(statusCode === 400 && error.validation ? { validation: error.validation } : {}),
    });
  });

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
  const llmRouter = new LLMRouter(config.llm, redis, auditEmitter, db);
  const toolExecutor = new ToolExecutor(redis, db, auditEmitter);
  const sessionManager = new SessionManager(redis, db, llmRouter, toolExecutor, auditEmitter, config);

  // Start LLM and tool execution pipelines (subscribes to Redis pub/sub)
  await llmRouter.start();
  await toolExecutor.start();

  // Start the AgentLoop — bridges user input to LLM requests and delivers responses
  const agentLoop = new AgentLoop(db, redis, config, auditEmitter);
  await agentLoop.start();

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
  await app.register(integrationRoutes, { prefix: '/api/integrations' });
  await app.register(toolRoutes, { prefix: '/api/tools' });
  await app.register(scheduledRunRoutes, { prefix: '/api/scheduled-runs' });
  await app.register(apiKeyRoutes, { prefix: '/api/api-keys' });
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
  await app.register(
    async (scope) => registerWebhookRoutes(scope, db, encryption, webhookDispatcher),
    { prefix: '/api' },
  );

  // WebSocket chat endpoint
  const rawJwtSecret = process.env.JWT_SECRET;
  const jwtSecret = new TextEncoder().encode(
    rawJwtSecret ?? (process.env.NODE_ENV === 'development' ? 'honorclaw-dev-secret-change-in-production' : ''),
  );

  app.get('/api/ws/chat', { websocket: true }, (socket, request) => {
    let userId: string | undefined;
    let workspaceId: string | undefined;

    // Authenticate via cookie first (browser), then fall back to ?token= param (CLI/API)
    const url = new URL(request.url, `http://${request.headers.host}`);
    const agentIdFromQuery = url.searchParams.get('agentId');

    let token: string | null = null;

    // Try to extract token from cookie header
    const cookieHeader = request.headers.cookie;
    if (cookieHeader) {
      const match = cookieHeader.split(';').map(c => c.trim()).find(c => c.startsWith('token='));
      if (match) {
        token = match.split('=').slice(1).join('=');
      }
    }

    // Fall back to query parameter for CLI/API clients
    if (!token) {
      token = url.searchParams.get('token');
    }

    if (!token) {
      socket.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
      socket.close(4401, 'Authentication required');
      return;
    }

    // Verify token asynchronously then set up message handling
    jose.jwtVerify(token, jwtSecret, { issuer: 'honorclaw' }).then(({ payload }) => {
      // Reject non-access tokens (e.g. mfa_pending, refresh) to prevent auth bypass
      if (payload.type && payload.type !== 'access') {
        socket.send(JSON.stringify({ type: 'error', message: 'Invalid token type' }));
        socket.close(4401, 'Invalid token type');
        return;
      }

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
      let currentSessionId: string | null = null;

      // Per-connection rate limiting: max 30 messages per 60-second window
      const messageTimes: number[] = [];
      const RATE_LIMIT_WINDOW_MS = 60_000;
      const RATE_LIMIT_MAX = 30;

      socket.on('message', (raw) => {
        try {
          // Rate limiting: clean up timestamps older than the window
          const now = Date.now();
          while (messageTimes.length > 0 && messageTimes[0]! < now - RATE_LIMIT_WINDOW_MS) {
            messageTimes.shift();
          }
          if (messageTimes.length >= RATE_LIMIT_MAX) {
            socket.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded: max 30 messages per minute' }));
            return;
          }
          messageTimes.push(now);

          const parsed = JSON.parse(raw.toString()) as Record<string, unknown>;

          // Handle legacy format: { agentId, sessionId, content, action }
          // Handle ChatPage format: { type: 'user_message', content, id }
          const msgType = parsed.type as string | undefined;
          const content = parsed.content as string | undefined;
          const msgAgentId = (parsed.agentId as string | undefined) ?? agentIdFromQuery;
          const msgSessionId = (parsed.sessionId as string | undefined) ?? currentSessionId;
          const action = parsed.action as string | undefined;

          if (action === 'subscribe' && msgSessionId) {
            // Verify session belongs to the user's workspace before subscribing
            db.query('SELECT id FROM sessions WHERE id = $1 AND workspace_id = $2', [msgSessionId, workspaceId])
              .then((result: { rows: { id: string }[] }) => {
                if (result.rows.length === 0) {
                  socket.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
                  return;
                }
                const outputChannel = RedisChannels.agentOutput(msgSessionId);
                if (!subscribedChannels.has(outputChannel)) {
                  subscribedChannels.add(outputChannel);
                  sub.subscribe(outputChannel).catch((err: unknown) => {
                    logger.error({ err, channel: outputChannel }, 'Failed to subscribe to agent output');
                  });
                }
              })
              .catch(() => {
                socket.send(JSON.stringify({ type: 'error', message: 'Failed to verify session' }));
              });
            return;
          }

          // Handle tool approval messages from the Web UI
          if (msgType === 'tool_approval') {
            const toolCallId = parsed.toolCallId as string | undefined;
            const decision = parsed.decision as string | undefined;
            if (toolCallId && decision && currentSessionId) {
              const approvalChannel = `honorclaw:tools:${currentSessionId}:approval:${toolCallId}`;
              redis.publish(approvalChannel, JSON.stringify({ decision })).catch((err: unknown) => {
                logger.error({ err }, 'Failed to publish tool approval');
              });
            }
            return;
          }

          // Accept both { type: 'user_message', content } and { content, agentId }
          if (content && (msgType === 'user_message' || msgAgentId)) {
            const effectiveAgentId = msgAgentId;
            if (!effectiveAgentId) {
              socket.send(JSON.stringify({ type: 'error', message: 'agentId is required' }));
              return;
            }

            if (!msgSessionId) {
              // Create a new session on first message
              sessionManager.create({
                workspaceId: workspaceId!,
                agentId: effectiveAgentId,
                userId: userId!,
                channel: 'websocket',
              }).then((session) => {
                currentSessionId = session.id;
                socket.send(JSON.stringify({ type: 'session_created', sessionId: session.id }));

                // Subscribe to output for the new session
                const outputChannel = RedisChannels.agentOutput(session.id);
                subscribedChannels.add(outputChannel);
                sub.subscribe(outputChannel).catch((err: unknown) => {
                  logger.error({ err, channel: outputChannel }, 'Failed to subscribe to agent output');
                });

                // Send the message
                sessionManager.sendMessage(session.id, content!, userId!).catch((err: unknown) => {
                  logger.error({ err }, 'Failed to send message');
                  socket.send(JSON.stringify({ type: 'error', message: 'Failed to send message' }));
                });
              }).catch((err: unknown) => {
                logger.error({ err }, 'Failed to create session');
                socket.send(JSON.stringify({ type: 'error', message: 'Failed to create session' }));
              });
            } else {
              // Verify session ownership then send message
              db.query('SELECT id FROM sessions WHERE id = $1 AND workspace_id = $2', [msgSessionId, workspaceId])
                .then((result: { rows: { id: string }[] }) => {
                  if (result.rows.length === 0) {
                    socket.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
                    return;
                  }
                  return sessionManager.sendMessage(msgSessionId!, content!, userId!);
                })
                .catch((err: unknown) => {
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

      // Forward agent responses to the client, preserving the original message type
      sub.on('message', (_channel: string, message: string) => {
        try {
          const data = JSON.parse(message) as Record<string, unknown>;
          socket.send(JSON.stringify({
            type: data.type ?? 'agent_response',
            id: data.messageId ?? crypto.randomUUID(),
            content: data.content ?? '',
            timestamp: data.timestamp ?? new Date().toISOString(),
            toolCallId: data.toolCallId,
            toolName: data.toolName,
            toolParams: data.toolParams,
            toolStatus: data.toolStatus,
            toolResult: data.toolResult,
          }));
        } catch {
          socket.send(JSON.stringify({ type: 'agent_response', id: crypto.randomUUID(), content: message, timestamp: new Date().toISOString() }));
        }
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
    ?? path.resolve(__dirname, '..', '..', 'web-ui', 'dist');

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

  // Session Reaper — auto-expire sessions that exceed their max duration
  const sessionReaper = new SessionReaper(redis, db);
  sessionReaper.start();

  // Security Monitor — violation tracking, tool-call anomaly detection, approval timeouts
  const notificationDispatcher = new NotificationDispatcher({
    redis,
    db,
    slackWebhookUrl: process.env['SLACK_WEBHOOK_URL'],
    teamsWebhookUrl: process.env['TEAMS_WEBHOOK_URL'],
  });
  const securityMonitor = new SecurityMonitor({
    redis,
    db,
    notifications: notificationDispatcher,
    auditEmitter,
  });
  securityMonitor.start();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    securityMonitor.stop();
    sessionReaper.stop();
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
