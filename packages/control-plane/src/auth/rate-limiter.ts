// In-memory rate limiter for auth endpoints
import type { FastifyRequest, FastifyReply } from 'fastify';

const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60_000; // 15 minutes

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// Periodic cleanup of expired entries to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (entry.resetAt <= now) {
      rateLimitMap.delete(key);
    }
  }
}, 60_000).unref();

function getClientIP(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0]!.trim();
  }
  return request.ip ?? 'unknown';
}

/**
 * Check if the IP has exceeded the rate limit. Returns false and sends
 * a 429 response if the limit is exceeded.
 */
export function checkRateLimit(request: FastifyRequest, reply: FastifyReply): boolean {
  const ip = getClientIP(request);
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (entry) {
    if (entry.resetAt <= now) {
      // Window expired, reset
      rateLimitMap.delete(ip);
    } else if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      reply
        .code(429)
        .header('Retry-After', String(retryAfterSec))
        .send({ error: 'Too many attempts. Please try again later.' });
      return false;
    }
  }

  return true;
}

export function recordFailedAttempt(request: FastifyRequest): void {
  const ip = getClientIP(request);
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (entry && entry.resetAt > now) {
    entry.count += 1;
  } else {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  }
}

export function clearRateLimit(request: FastifyRequest): void {
  const ip = getClientIP(request);
  rateLimitMap.delete(ip);
}
