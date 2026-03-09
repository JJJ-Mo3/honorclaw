import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkRateLimit, recordFailedAttempt, clearRateLimit } from './rate-limiter.js';

function createMockRequest(ip = '127.0.0.1') {
  return { ip } as any;
}

function createMockReply() {
  const reply: any = {
    code: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
}

describe('rate-limiter', () => {
  // Use a unique IP for each test to avoid inter-test interference
  let testIp: string;
  let counter = 0;

  beforeEach(() => {
    testIp = `10.0.0.${++counter}`;
  });

  describe('checkRateLimit', () => {
    it('allows first request from a new IP', () => {
      const request = createMockRequest(testIp);
      const reply = createMockReply();

      const result = checkRateLimit(request, reply);

      expect(result).toBe(true);
      expect(reply.code).not.toHaveBeenCalled();
    });

    it('allows requests below the rate limit', () => {
      const request = createMockRequest(testIp);
      const reply = createMockReply();

      // Record 4 failed attempts (limit is 5)
      for (let i = 0; i < 4; i++) {
        recordFailedAttempt(request);
      }

      const result = checkRateLimit(request, reply);
      expect(result).toBe(true);
    });

    it('blocks requests at the rate limit', () => {
      const request = createMockRequest(testIp);
      const reply = createMockReply();

      // Record 5 failed attempts (at limit)
      for (let i = 0; i < 5; i++) {
        recordFailedAttempt(request);
      }

      const result = checkRateLimit(request, reply);

      expect(result).toBe(false);
      expect(reply.code).toHaveBeenCalledWith(429);
      expect(reply.header).toHaveBeenCalledWith('Retry-After', expect.any(String));
      expect(reply.send).toHaveBeenCalledWith({ error: 'Too many attempts. Please try again later.' });
    });
  });

  describe('recordFailedAttempt', () => {
    it('increments the counter', () => {
      const request = createMockRequest(testIp);
      const reply = createMockReply();

      recordFailedAttempt(request);
      recordFailedAttempt(request);

      // Should still be allowed (2 < 5)
      const result = checkRateLimit(request, reply);
      expect(result).toBe(true);
    });
  });

  describe('clearRateLimit', () => {
    it('clears the rate limit for an IP', () => {
      const request = createMockRequest(testIp);
      const reply = createMockReply();

      // Record 5 failed attempts
      for (let i = 0; i < 5; i++) {
        recordFailedAttempt(request);
      }

      // Should be blocked
      expect(checkRateLimit(request, createMockReply())).toBe(false);

      // Clear the rate limit
      clearRateLimit(request);

      // Should be allowed again
      const resultAfterClear = checkRateLimit(request, reply);
      expect(resultAfterClear).toBe(true);
    });
  });
});
