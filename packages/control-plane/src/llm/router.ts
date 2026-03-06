import type { Redis } from 'ioredis';
import { RedisChannels } from '@honorclaw/core';
import type { LLMRequest, LLMResponse } from '@honorclaw/core';
import { LLMRequestSchema } from '@honorclaw/core';
import type { AuditEmitter } from '../audit/emitter.js';
import type { LlmConfig } from '@honorclaw/core';
import { OllamaAdapter } from './adapters/ollama.js';
import type { LLMAdapter } from './adapters/base.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export class LLMRouter {
  private adapters = new Map<string, LLMAdapter>();
  private redis: Redis;
  private auditEmitter: AuditEmitter;

  constructor(config: LlmConfig, redis: Redis, auditEmitter: AuditEmitter) {
    this.redis = redis;
    this.auditEmitter = auditEmitter;

    // Register adapters
    this.adapters.set('ollama', new OllamaAdapter(
      config.providers?.ollama?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434'
    ));
  }

  async start(): Promise<void> {
    // Subscribe to LLM request channels
    const sub = this.redis.duplicate();
    await sub.psubscribe('llm:*:request');

    sub.on('pmessage', async (_pattern: string, channel: string, message: string) => {
      try {
        const request = LLMRequestSchema.parse(JSON.parse(message));
        await this.handleRequest(request);
      } catch (err) {
        logger.error({ err, channel }, 'LLM request handling error');
      }
    });
  }

  async handleRequest(request: LLMRequest): Promise<void> {
    const startTime = Date.now();
    const [providerName] = request.model.split('/');
    const adapter = this.adapters.get(providerName ?? 'ollama');

    if (!adapter) {
      const errorResponse: LLMResponse = {
        sessionId: request.sessionId,
        correlationId: request.correlationId,
        content: `Error: Unknown LLM provider "${providerName}"`,
        tokensUsed: { prompt: 0, completion: 0, total: 0 },
        model: request.model,
        finishReason: 'error',
      };
      await this.redis.lpush(
        `llm:${request.sessionId}:response:${request.correlationId}`,
        JSON.stringify(errorResponse),
      );
      return;
    }

    try {
      const response = await adapter.complete(request);
      const duration = Date.now() - startTime;

      // Push response to the agent
      await this.redis.lpush(
        `llm:${request.sessionId}:response:${request.correlationId}`,
        JSON.stringify(response),
      );

      // Audit
      this.auditEmitter.emit({
        workspaceId: '00000000-0000-0000-0000-000000000000', // TODO: resolve from session
        eventType: 'llm.interaction',
        actorType: 'agent',
        sessionId: request.sessionId,
        payload: {
          model: request.model,
          tokensUsed: response.tokensUsed,
          durationMs: duration,
          finishReason: response.finishReason,
        },
      });
    } catch (err) {
      logger.error({ err, model: request.model }, 'LLM adapter error');
      const errorResponse: LLMResponse = {
        sessionId: request.sessionId,
        correlationId: request.correlationId,
        content: `LLM error: ${err instanceof Error ? err.message : 'Unknown'}`,
        tokensUsed: { prompt: 0, completion: 0, total: 0 },
        model: request.model,
        finishReason: 'error',
      };
      await this.redis.lpush(
        `llm:${request.sessionId}:response:${request.correlationId}`,
        JSON.stringify(errorResponse),
      );
    }
  }
}
