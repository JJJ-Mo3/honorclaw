import { Redis } from 'ioredis';
import type { RedisConfig } from '@honorclaw/core';

export function createRedis(config: RedisConfig): Redis {
  if (config.url) {
    return new Redis(config.url);
  }
  if (config.socket) {
    // Support password auth over Unix socket
    const password = config.password ?? process.env.REDIS_PASSWORD;
    if (password) {
      return new Redis({ path: config.socket, password });
    }
    return new Redis(config.socket);
  }
  return new Redis({ host: '127.0.0.1', port: 6379, password: config.password });
}
