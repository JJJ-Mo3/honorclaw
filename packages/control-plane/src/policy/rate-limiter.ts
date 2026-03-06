import type { Redis } from 'ioredis';

export interface RateLimitConfig {
  maxCallsPerMinute?: number;
  maxCallsPerSession?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  reason?: string;
}

export class RateLimiter {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async checkAndIncrement(
    sessionId: string,
    toolName: string,
    config: RateLimitConfig,
  ): Promise<RateLimitResult> {
    // Per-minute check
    if (config.maxCallsPerMinute) {
      const minuteKey = `ratelimit:${sessionId}:${toolName}:minute`;
      const minuteCount = await this.redis.incr(minuteKey);
      if (minuteCount === 1) {
        await this.redis.expire(minuteKey, 60);
      }
      if (minuteCount > config.maxCallsPerMinute) {
        return {
          allowed: false,
          remaining: 0,
          reason: `Rate limit exceeded: ${config.maxCallsPerMinute} calls per minute for ${toolName}`,
        };
      }
    }

    // Per-session check
    if (config.maxCallsPerSession) {
      const sessionKey = `ratelimit:${sessionId}:${toolName}:session`;
      const sessionCount = await this.redis.incr(sessionKey);
      if (sessionCount > config.maxCallsPerSession) {
        return {
          allowed: false,
          remaining: 0,
          reason: `Rate limit exceeded: ${config.maxCallsPerSession} calls per session for ${toolName}`,
        };
      }
      return { allowed: true, remaining: config.maxCallsPerSession - sessionCount };
    }

    return { allowed: true, remaining: -1 };
  }
}
