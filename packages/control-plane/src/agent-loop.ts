import type { Redis } from 'ioredis';
import type { Database } from './db/index.js';
import type { HonorClawConfig } from '@honorclaw/core';
import { RedisChannels } from '@honorclaw/core';
import type { LLMRequest } from '@honorclaw/core';
import crypto from 'node:crypto';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * AgentLoop bridges user messages (agent:*:input) and the LLM Router (llm:*:request).
 *
 * When a user sends a message the SessionManager publishes to agent:{sessionId}:input.
 * The LLM Router subscribes to llm:*:request and pushes responses to a Redis list.
 * This class subscribes to the input channel, constructs an LLM request from session
 * context and conversation history, publishes it to the LLM Router, waits for the
 * response via BRPOP, persists both messages in the database, and publishes the
 * agent reply to agent:{sessionId}:output for the WebSocket handler.
 */
export class AgentLoop {
  private db: Database;
  private redis: Redis;
  private config: HonorClawConfig;

  constructor(db: Database, redis: Redis, config: HonorClawConfig) {
    this.db = db;
    this.redis = redis;
    this.config = config;
  }

  async start(): Promise<void> {
    // Use a dedicated connection for pattern subscription
    const sub = this.redis.duplicate();
    await sub.psubscribe('agent:*:input');

    sub.on('pmessage', async (_pattern: string, channel: string, message: string) => {
      try {
        const input = JSON.parse(message) as {
          sessionId: string;
          content: string;
          senderId: string;
          timestamp: string;
        };

        await this.handleMessage(input.sessionId, input.content, input.senderId);
      } catch (err) {
        logger.error({ err, channel }, 'AgentLoop: error handling input message');
      }
    });

    logger.info('AgentLoop started — listening on agent:*:input');
  }

  private async handleMessage(sessionId: string, content: string, senderId: string): Promise<void> {
    // 1. Load session context from Redis (set by SessionManager.create)
    const contextRaw = await this.redis.get(`session:${sessionId}:context`);
    if (!contextRaw) {
      logger.error({ sessionId }, 'AgentLoop: no session context found');
      await this.publishError(sessionId, 'No session context found. Was the session created?');
      return;
    }

    const context = JSON.parse(contextRaw) as {
      model: string;
      tools: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>;
      maxTokens: number;
      toolTimeoutSeconds: number;
      workspaceId: string;
      agentId: string;
      systemPrompt?: string;
    };

    // 2. Load conversation history from session_messages table
    //    (The user message was already stored by SessionManager.sendMessage)
    const historyResult = await this.db.query(
      'SELECT role, content FROM session_messages WHERE session_id = $1 ORDER BY created_at ASC',
      [sessionId],
    );

    // 3. Build messages array (system prompt + history)
    const messages: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string }> = [];

    if (context.systemPrompt) {
      messages.push({ role: 'system', content: context.systemPrompt });
    }

    for (const row of historyResult.rows) {
      messages.push({ role: row.role, content: row.content });
    }

    // 4. Build and publish the LLM request
    const correlationId = crypto.randomUUID();
    const llmRequest: LLMRequest = {
      sessionId,
      correlationId,
      messages,
      tools: context.tools.length > 0 ? context.tools : undefined,
      model: context.model ?? this.config.llm.defaultModel,
      maxTokens: Math.min(4096, context.maxTokens),
    };

    const requestChannel = RedisChannels.llmRequest(sessionId);
    await this.redis.publish(requestChannel, JSON.stringify(llmRequest));

    // 5. Wait for the LLM response via BRPOP (the Router uses LPUSH)
    const responseListKey = `llm:${sessionId}:response:${correlationId}`;
    const timeoutSeconds = context.toolTimeoutSeconds || 60;

    const result = await this.redis.brpop(responseListKey, timeoutSeconds);

    if (!result) {
      logger.error({ sessionId, correlationId }, 'AgentLoop: LLM response timed out');
      await this.publishError(sessionId, 'LLM response timed out');
      return;
    }

    // BRPOP returns [key, value]
    const responseRaw = result[1];
    const llmResponse = JSON.parse(responseRaw) as {
      sessionId: string;
      correlationId: string;
      content: string | null;
      tokensUsed: { prompt: number; completion: number; total: number };
      model: string;
      finishReason: string;
    };

    if (llmResponse.finishReason === 'error') {
      logger.error({ sessionId, content: llmResponse.content }, 'AgentLoop: LLM returned error');
      await this.publishError(sessionId, llmResponse.content ?? 'LLM error');
      return;
    }

    const replyContent = typeof llmResponse.content === 'string'
      ? llmResponse.content
      : JSON.stringify(llmResponse.content);

    // 6. Store the agent response in DB
    await this.db.query(
      'INSERT INTO session_messages (session_id, role, content) VALUES ($1, $2, $3)',
      [sessionId, 'assistant', replyContent],
    );

    // 7. Update session token usage
    await this.db.query(
      'UPDATE sessions SET tokens_used = tokens_used + $1 WHERE id = $2',
      [llmResponse.tokensUsed.total, sessionId],
    );

    // 8. Publish the agent response to the output channel (for WebSocket consumers)
    const outputChannel = RedisChannels.agentOutput(sessionId);
    await this.redis.publish(outputChannel, JSON.stringify({
      sessionId,
      content: replyContent,
      model: llmResponse.model,
      tokensUsed: llmResponse.tokensUsed,
      timestamp: new Date().toISOString(),
    }));

    logger.info(
      { sessionId, model: llmResponse.model, tokens: llmResponse.tokensUsed.total },
      'AgentLoop: message processed',
    );
  }

  private async publishError(sessionId: string, message: string): Promise<void> {
    const errorChannel = RedisChannels.agentOutput(sessionId);
    await this.redis.publish(errorChannel, JSON.stringify({
      sessionId,
      content: `Error: ${message}`,
      error: true,
      timestamp: new Date().toISOString(),
    }));
  }
}
