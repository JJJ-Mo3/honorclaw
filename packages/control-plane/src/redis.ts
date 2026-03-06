import { Redis } from 'ioredis';
import type { RedisConfig } from '@honorclaw/core';

export function createRedis(config: RedisConfig): Redis {
  if (config.url) {
    return new Redis(config.url);
  }
  if (config.socket) {
    return new Redis(config.socket);
  }
  return new Redis({ host: '127.0.0.1', port: 6379, password: config.password });
}
