import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { NotificationDispatcher } from '../notifications/dispatcher.js';
import type { AuditEmitter } from '../audit/emitter.js';
import { guardrailViolationsTotal, securityAlertsTotal } from '../api/metrics.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * SecurityMonitor tracks guardrail violation rates, tool-call anomalies,
 * and approval timeouts. Dispatches notifications when thresholds are exceeded.
 */
export class SecurityMonitor {
  private redis: Redis;
  private db: Pool;
  private notifications: NotificationDispatcher;
  private auditEmitter: AuditEmitter;

  /** Violations per (workspace, agent, type) trigger at this threshold. */
  private violationThreshold: number;
  /** Rolling window in seconds for violation counting. */
  private windowSeconds: number;
  /** Periodic check interval in ms. */
  private checkIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    redis: Redis;
    db: Pool;
    notifications: NotificationDispatcher;
    auditEmitter: AuditEmitter;
    violationThreshold?: number;
    windowSeconds?: number;
    checkIntervalMs?: number;
  }) {
    this.redis = opts.redis;
    this.db = opts.db;
    this.notifications = opts.notifications;
    this.auditEmitter = opts.auditEmitter;
    this.violationThreshold = opts.violationThreshold ?? 10;
    this.windowSeconds = opts.windowSeconds ?? 300;
    this.checkIntervalMs = opts.checkIntervalMs ?? 60_000;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.periodicCheck().catch(err => logger.error({ err }, 'SecurityMonitor periodic check error'));
    }, this.checkIntervalMs);
    logger.info('SecurityMonitor started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('SecurityMonitor stopped');
  }

  // ── Violation tracking ─────────────────────────────────────────────────

  /**
   * Record a guardrail violation. When the count exceeds the threshold
   * within the rolling window, dispatches a security_violation notification.
   */
  async recordViolation(
    workspaceId: string,
    agentId: string,
    violationType: string,
  ): Promise<void> {
    const key = `honorclaw:security:violations:${workspaceId}:${agentId}:${violationType}`;
    const count = await this.redis.incr(key);

    // Set expiry only on the first increment
    if (count === 1) {
      await this.redis.expire(key, this.windowSeconds);
    }

    // Prometheus counter
    guardrailViolationsTotal.inc({
      workspace_id: workspaceId,
      agent_id: agentId,
      violation_type: violationType,
    });

    if (count === this.violationThreshold) {
      securityAlertsTotal.inc({ workspace_id: workspaceId, alert_type: 'violation_threshold' });
      await this.notifications.dispatch({
        trigger: 'security_violation',
        workspaceId,
        agentId,
        title: `Guardrail violation spike: ${violationType}`,
        body: `Agent ${agentId} has triggered ${count} ${violationType} violations in the last ${this.windowSeconds}s.`,
        severity: 'critical',
        channels: ['in_app', 'slack'],
      });
    }
  }

  // ── Tool call tracking ─────────────────────────────────────────────────

  /**
   * Record a tool call for per-minute anomaly detection.
   * Uses per-minute Redis buckets with 1-hour TTL.
   */
  async recordToolCall(workspaceId: string, agentId: string): Promise<void> {
    const minuteBucket = Math.floor(Date.now() / 60_000);
    const key = `honorclaw:security:toolcalls:${workspaceId}:${agentId}:${minuteBucket}`;
    await this.redis.incr(key);
    await this.redis.expire(key, 3600); // 1-hour TTL
  }

  // ── Periodic checks ────────────────────────────────────────────────────

  private async periodicCheck(): Promise<void> {
    await this.checkApprovalTimeouts();
    await this.checkToolCallAnomalies();
  }

  /**
   * Find timed-out approval requests and update/notify.
   */
  private async checkApprovalTimeouts(): Promise<void> {
    const result = await this.db.query(`
      UPDATE approval_requests
      SET status = 'timeout', resolved_at = now()
      WHERE status = 'pending' AND timeout_at < now()
      RETURNING id, workspace_id, agent_id, session_id, tool_name
    `);

    for (const row of result.rows) {
      securityAlertsTotal.inc({ workspace_id: row.workspace_id, alert_type: 'approval_timeout' });
      this.auditEmitter.emit({
        workspaceId: row.workspace_id,
        eventType: 'tool.timeout',
        actorType: 'system',
        agentId: row.agent_id,
        sessionId: row.session_id,
        payload: { approvalId: row.id, toolName: row.tool_name },
      });

      await this.notifications.dispatch({
        trigger: 'approval_timeout',
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        sessionId: row.session_id,
        title: `Approval timed out: ${row.tool_name}`,
        body: `Approval request for tool "${row.tool_name}" on agent ${row.agent_id} was not resolved before the deadline.`,
        severity: 'warning',
        channels: ['in_app'],
      });
    }
  }

  /**
   * Detect tool-call anomalies by comparing the current minute to the historical mean.
   * Alert when current > mean + 3 * stddev.
   */
  private async checkToolCallAnomalies(): Promise<void> {
    // Get all active agents for anomaly checking
    const agentsResult = await this.db.query(
      `SELECT DISTINCT agent_id, workspace_id FROM sessions WHERE status = 'active'`,
    );

    const currentMinute = Math.floor(Date.now() / 60_000);

    for (const row of agentsResult.rows) {
      const { agent_id: agentId, workspace_id: workspaceId } = row as {
        agent_id: string;
        workspace_id: string;
      };

      // Collect the last 60 minutes of tool call counts
      const counts: number[] = [];
      for (let i = 1; i <= 60; i++) {
        const key = `honorclaw:security:toolcalls:${workspaceId}:${agentId}:${currentMinute - i}`;
        const val = await this.redis.get(key);
        counts.push(val ? parseInt(val, 10) : 0);
      }

      // Current minute count
      const currentKey = `honorclaw:security:toolcalls:${workspaceId}:${agentId}:${currentMinute}`;
      const currentVal = await this.redis.get(currentKey);
      const currentCount = currentVal ? parseInt(currentVal, 10) : 0;

      // Compute mean and stddev (skip if no historical data)
      const nonZero = counts.filter(c => c > 0);
      if (nonZero.length < 5) continue; // not enough data

      const mean = nonZero.reduce((a, b) => a + b, 0) / nonZero.length;
      const variance = nonZero.reduce((sum, c) => sum + (c - mean) ** 2, 0) / nonZero.length;
      const stddev = Math.sqrt(variance);

      const threshold = mean + 3 * stddev;
      if (currentCount > threshold && threshold > 0) {
        securityAlertsTotal.inc({ workspace_id: workspaceId, alert_type: 'tool_call_anomaly' });
        await this.notifications.dispatch({
          trigger: 'anomaly_detected',
          workspaceId,
          agentId,
          title: `Tool call spike detected`,
          body: `Agent ${agentId} made ${currentCount} tool calls this minute (mean=${mean.toFixed(1)}, threshold=${threshold.toFixed(1)}).`,
          severity: 'warning',
          channels: ['in_app', 'slack'],
        });
      }
    }
  }
}
