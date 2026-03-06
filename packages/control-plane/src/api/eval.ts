import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireWorkspace } from '../middleware/rbac.js';

/**
 * Eval API routes for the HonorClaw evaluation framework.
 *
 * POST /eval/sessions              — create an eval session
 * POST /eval/sessions/:id/mocks    — register mock tool handlers
 * POST /eval/sessions/:id/turns    — send a conversation turn
 * GET  /eval/sessions/:id/events   — stream session events (SSE)
 */
export async function evalRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  /**
   * POST /eval/sessions
   *
   * Create a new headless eval session.
   */
  app.post('/sessions', async (request, reply) => {
    const { agentId, sessionType } = request.body as {
      agentId: string;
      sessionType?: string;
    };

    const db = (app as any).db;
    const sessionId = crypto.randomUUID();

    await db.query(
      `INSERT INTO sessions (id, agent_id, workspace_id, user_id, session_type, status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'running', NOW())`,
      [
        sessionId,
        agentId,
        request.workspaceId,
        request.userId,
        sessionType ?? 'eval',
      ],
    );

    reply.code(201).send({ sessionId, agentId, status: 'running' });
  });

  /**
   * POST /eval/sessions/:id/mocks
   *
   * Register mock tool handlers for an eval session.
   * Mocks override real tool execution with deterministic responses.
   */
  app.post('/sessions/:id/mocks', async (request) => {
    const { id } = request.params as { id: string };
    const { mocks } = request.body as {
      mocks: Array<{
        toolName: string;
        when?: Record<string, unknown>;
        response: unknown;
        delayMs?: number;
        simulateError?: boolean;
        errorMessage?: string;
      }>;
    };

    const redis = (app as any).redis;

    // Store mocks in Redis keyed by session ID
    await redis.set(
      `honorclaw:eval:mocks:${id}`,
      JSON.stringify(mocks),
      'EX',
      3600, // 1 hour TTL
    );

    return {
      registered: mocks.length,
      sessionId: id,
    };
  });

  /**
   * POST /eval/sessions/:id/turns
   *
   * Send a conversation turn to an eval session and receive the agent's response.
   */
  app.post('/sessions/:id/turns', async (request) => {
    const { id } = request.params as { id: string };
    const { role, content } = request.body as {
      role: 'user' | 'system';
      content: string;
    };

    const db = (app as any).db;
    const redis = (app as any).redis;

    // Verify session exists and is running
    const sessionResult = await db.query(
      `SELECT id, agent_id, workspace_id, status FROM sessions WHERE id = $1`,
      [id],
    );

    const session = sessionResult.rows[0];
    if (!session) {
      return { error: 'Session not found' };
    }
    if (session.status !== 'running') {
      return { error: `Session is ${session.status}, not running` };
    }

    // Store the turn
    const turnId = crypto.randomUUID();
    await db.query(
      `INSERT INTO session_messages (id, session_id, role, content, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [turnId, id, role, content],
    );

    // Publish the turn to Redis for the orchestration layer to process
    await redis.publish(
      `honorclaw:sessions:${id}`,
      JSON.stringify({
        type: 'eval.turn',
        turnId,
        sessionId: id,
        role,
        content,
      }),
    );

    // Wait for the response from the orchestration layer
    const response = await waitForTurnResponse(redis, id, turnId);

    return {
      turnId,
      output: response.output,
      tokenUsage: response.tokenUsage,
      cost: response.cost,
      toolCalls: response.toolCalls,
      auditTrail: response.auditTrail,
    };
  });

  /**
   * GET /eval/sessions/:id/events
   *
   * Server-Sent Events stream for real-time session events.
   */
  app.get('/sessions/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const redis = (app as any).redis;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const subscriber = redis.duplicate();
    const channel = `honorclaw:eval:events:${id}`;

    await subscriber.subscribe(channel);

    subscriber.on('message', (_ch: string, message: string) => {
      reply.raw.write(`data: ${message}\n\n`);
    });

    // Clean up when client disconnects
    request.raw.on('close', () => {
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.disconnect();
    });

    // Send initial connected event
    reply.raw.write(`data: ${JSON.stringify({ type: 'connected', sessionId: id })}\n\n`);
  });
}

// ── Internal Helpers ──────────────────────────────────────────────────────

interface TurnResponse {
  output: string;
  tokenUsage?: { prompt: number; completion: number; total: number };
  cost?: number;
  toolCalls?: Array<{ name: string; parameters: Record<string, unknown>; result: unknown }>;
  auditTrail?: Record<string, unknown>;
}

/**
 * Wait for the orchestration layer to respond to an eval turn.
 */
async function waitForTurnResponse(
  redis: any,
  sessionId: string,
  turnId: string,
): Promise<TurnResponse> {
  return new Promise((resolve) => {
    const channel = `honorclaw:eval:turn:${sessionId}:${turnId}`;
    const subscriber = redis.duplicate();

    const timeout = setTimeout(() => {
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.disconnect();
      resolve({
        output: '',
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
      });
    }, 120_000); // 2 minute timeout

    subscriber.subscribe(channel).then(() => {
      subscriber.on('message', (_ch: string, message: string) => {
        clearTimeout(timeout);
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.disconnect();

        try {
          resolve(JSON.parse(message));
        } catch {
          resolve({ output: message });
        }
      });
    }).catch(() => {
      clearTimeout(timeout);
      resolve({ output: '' });
    });
  });
}
