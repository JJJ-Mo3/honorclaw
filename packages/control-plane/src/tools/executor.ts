import type { Redis } from 'ioredis';
import type { AuditEmitter } from '../audit/emitter.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export class ToolExecutor {
  private redis: Redis;
  private auditEmitter: AuditEmitter;

  constructor(redis: Redis, auditEmitter: AuditEmitter) {
    this.redis = redis;
    this.auditEmitter = auditEmitter;
  }

  async start(): Promise<void> {
    // Subscribe to tool request channels
    const sub = this.redis.duplicate();
    await sub.psubscribe('tools:*:request:*');

    sub.on('pmessage', async (_pattern: string, channel: string, message: string) => {
      try {
        const request = JSON.parse(message);
        await this.handleToolCall(request);
      } catch (err) {
        logger.error({ err, channel }, 'Tool execution error');
      }
    });
  }

  async handleToolCall(request: { sessionId: string; callId: string; toolName: string; parameters: Record<string, unknown> }): Promise<void> {
    const { sessionId, callId, toolName, parameters } = request;
    const startTime = Date.now();

    try {
      // TODO: Load manifest and validate (Prompt 1.1)
      // TODO: Run parameter sanitizer (Prompt 1.1)
      // TODO: Check rate limits (Prompt 1.1)
      // TODO: Spawn tool container via ComputeProvider (Prompt 1.3)

      // Placeholder: echo the tool call
      const result = {
        status: 'success' as const,
        result: { message: `Tool ${toolName} executed (placeholder)`, parameters },
      };

      await this.redis.lpush(
        `tools:${sessionId}:result:${callId}`,
        JSON.stringify({ sessionId, callId, ...result }),
      );

      const duration = Date.now() - startTime;
      logger.info({ toolName, callId, duration }, 'Tool call completed');
    } catch (err) {
      await this.redis.lpush(
        `tools:${sessionId}:result:${callId}`,
        JSON.stringify({
          sessionId,
          callId,
          status: 'error',
          error: { code: 'execution_error', message: err instanceof Error ? err.message : 'Unknown error' },
        }),
      );
    }
  }
}
