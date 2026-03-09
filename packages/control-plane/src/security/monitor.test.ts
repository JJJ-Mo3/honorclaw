import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SecurityMonitor } from './monitor.js';

// ── Mock Prometheus counters before importing the module ──────────────────
vi.mock('../api/metrics.js', () => ({
  guardrailViolationsTotal: { inc: vi.fn() },
  securityAlertsTotal: { inc: vi.fn() },
}));

import { guardrailViolationsTotal, securityAlertsTotal } from '../api/metrics.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMockRedis() {
  return {
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  };
}

function makeMockDb() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };
}

function makeMockNotifications() {
  return {
    dispatch: vi.fn().mockResolvedValue('notif-1'),
  };
}

function makeMockAuditEmitter() {
  return {
    emit: vi.fn(),
  };
}

describe('SecurityMonitor', () => {
  let redis: ReturnType<typeof makeMockRedis>;
  let db: ReturnType<typeof makeMockDb>;
  let notifications: ReturnType<typeof makeMockNotifications>;
  let auditEmitter: ReturnType<typeof makeMockAuditEmitter>;
  let monitor: SecurityMonitor;

  beforeEach(() => {
    redis = makeMockRedis();
    db = makeMockDb();
    notifications = makeMockNotifications();
    auditEmitter = makeMockAuditEmitter();
    monitor = new SecurityMonitor({
      redis: redis as any,
      db: db as any,
      notifications: notifications as any,
      auditEmitter: auditEmitter as any,
      violationThreshold: 5,
      windowSeconds: 300,
      checkIntervalMs: 60_000,
    });

    vi.clearAllMocks();
  });

  afterEach(() => {
    monitor.stop();
  });

  // ── recordViolation() ────────────────────────────────────────────────

  describe('recordViolation()', () => {
    it('increments the Redis counter for the violation key', async () => {
      redis.incr.mockResolvedValue(1);

      await monitor.recordViolation('ws-1', 'agent-1', 'prompt_injection');

      expect(redis.incr).toHaveBeenCalledWith(
        'honorclaw:security:violations:ws-1:agent-1:prompt_injection',
      );
    });

    it('sets expiry on the first increment (count === 1)', async () => {
      redis.incr.mockResolvedValue(1);

      await monitor.recordViolation('ws-1', 'agent-1', 'prompt_injection');

      expect(redis.expire).toHaveBeenCalledWith(
        'honorclaw:security:violations:ws-1:agent-1:prompt_injection',
        300,
      );
    });

    it('does not set expiry on subsequent increments', async () => {
      redis.incr.mockResolvedValue(3);

      await monitor.recordViolation('ws-1', 'agent-1', 'prompt_injection');

      expect(redis.expire).not.toHaveBeenCalled();
    });

    it('increments the Prometheus counter', async () => {
      redis.incr.mockResolvedValue(1);

      await monitor.recordViolation('ws-1', 'agent-1', 'pii_leak');

      expect(guardrailViolationsTotal.inc).toHaveBeenCalledWith({
        workspace_id: 'ws-1',
        agent_id: 'agent-1',
        violation_type: 'pii_leak',
      });
    });

    it('dispatches a notification when violation count reaches the threshold', async () => {
      redis.incr.mockResolvedValue(5); // threshold = 5

      await monitor.recordViolation('ws-1', 'agent-1', 'prompt_injection');

      expect(notifications.dispatch).toHaveBeenCalledTimes(1);
      expect(notifications.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: 'security_violation',
          workspaceId: 'ws-1',
          agentId: 'agent-1',
          severity: 'critical',
          channels: ['in_app', 'slack'],
        }),
      );

      expect(securityAlertsTotal.inc).toHaveBeenCalledWith({
        workspace_id: 'ws-1',
        alert_type: 'violation_threshold',
      });
    });

    it('does not dispatch a notification below the threshold', async () => {
      redis.incr.mockResolvedValue(4);

      await monitor.recordViolation('ws-1', 'agent-1', 'prompt_injection');

      expect(notifications.dispatch).not.toHaveBeenCalled();
    });

    it('does not dispatch a notification above the threshold (only at exact threshold)', async () => {
      redis.incr.mockResolvedValue(6);

      await monitor.recordViolation('ws-1', 'agent-1', 'prompt_injection');

      expect(notifications.dispatch).not.toHaveBeenCalled();
    });
  });

  // ── recordToolCall() ─────────────────────────────────────────────────

  describe('recordToolCall()', () => {
    it('creates a per-minute bucket key in Redis', async () => {
      const before = Math.floor(Date.now() / 60_000);

      await monitor.recordToolCall('ws-1', 'agent-1');

      const after = Math.floor(Date.now() / 60_000);

      expect(redis.incr).toHaveBeenCalledTimes(1);
      const key = redis.incr.mock.calls[0]![0] as string;
      expect(key).toMatch(/^honorclaw:security:toolcalls:ws-1:agent-1:\d+$/);

      // Verify the minute bucket is within range
      const minuteBucket = parseInt(key.split(':').pop()!, 10);
      expect(minuteBucket).toBeGreaterThanOrEqual(before);
      expect(minuteBucket).toBeLessThanOrEqual(after);
    });

    it('sets a 1-hour TTL on the bucket key', async () => {
      await monitor.recordToolCall('ws-1', 'agent-1');

      expect(redis.expire).toHaveBeenCalledTimes(1);
      const [key, ttl] = redis.expire.mock.calls[0]!;
      expect(key).toContain('honorclaw:security:toolcalls:ws-1:agent-1:');
      expect(ttl).toBe(3600);
    });
  });

  // ── checkApprovalTimeouts() (via periodicCheck) ──────────────────────

  describe('checkApprovalTimeouts()', () => {
    it('updates timed-out approvals and emits audit events + notifications', async () => {
      const timedOutRows = [
        {
          id: 'approval-1',
          workspace_id: 'ws-1',
          agent_id: 'agent-1',
          session_id: 'sess-1',
          tool_name: 'deploy',
        },
      ];

      // First query: UPDATE approval_requests (checkApprovalTimeouts)
      // Second query: SELECT active agents (checkToolCallAnomalies)
      db.query
        .mockResolvedValueOnce({ rows: timedOutRows })
        .mockResolvedValueOnce({ rows: [] });

      // Invoke the private periodicCheck indirectly by calling it
      await (monitor as any).periodicCheck();

      // Verify audit event emitted
      expect(auditEmitter.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-1',
          eventType: 'tool.timeout',
          actorType: 'system',
          agentId: 'agent-1',
          sessionId: 'sess-1',
          payload: { approvalId: 'approval-1', toolName: 'deploy' },
        }),
      );

      // Verify notification dispatched
      expect(notifications.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          trigger: 'approval_timeout',
          workspaceId: 'ws-1',
          title: 'Approval timed out: deploy',
          severity: 'warning',
        }),
      );

      // Verify Prometheus counter
      expect(securityAlertsTotal.inc).toHaveBeenCalledWith({
        workspace_id: 'ws-1',
        alert_type: 'approval_timeout',
      });
    });

    it('does nothing when there are no timed-out approvals', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [] })  // No timed-out approvals
        .mockResolvedValueOnce({ rows: [] }); // No active agents

      await (monitor as any).periodicCheck();

      expect(auditEmitter.emit).not.toHaveBeenCalled();
      expect(notifications.dispatch).not.toHaveBeenCalled();
    });
  });

  // ── start() / stop() ────────────────────────────────────────────────

  describe('start() / stop()', () => {
    it('starts and stops the periodic check interval', () => {
      vi.useFakeTimers();

      const periodicSpy = vi.spyOn(monitor as any, 'periodicCheck').mockResolvedValue(undefined);

      monitor.start();

      vi.advanceTimersByTime(60_000);
      expect(periodicSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_000);
      expect(periodicSpy).toHaveBeenCalledTimes(2);

      monitor.stop();

      vi.advanceTimersByTime(60_000);
      expect(periodicSpy).toHaveBeenCalledTimes(2); // no new calls after stop

      vi.useRealTimers();
    });

    it('stop() is safe to call when not started', () => {
      expect(() => monitor.stop()).not.toThrow();
    });
  });
});
