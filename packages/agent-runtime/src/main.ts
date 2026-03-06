import { runtime } from './runtime.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const sessionId = process.env.SESSION_ID;
const redisUrl = process.env.REDIS_URL;

if (!sessionId || !redisUrl) {
  logger.fatal('SESSION_ID and REDIS_URL environment variables are required');
  process.exit(1);
}

logger.info({ sessionId }, 'Agent runtime starting');

runtime({ sessionId, redisUrl, logger }).catch((err) => {
  logger.fatal({ err }, 'Agent runtime fatal error');
  process.exit(1);
});
