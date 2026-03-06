import * as cron from 'node-cron';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { createHeadlessSession, type HeadlessSessionOptions } from './headless-session.js';

export interface SchedulerOptions {
  redis: Redis;
  db: Pool;
  /** Prefix for Redis distributed lock keys. */
  lockPrefix?: string;
  /** Lock TTL in seconds (default: 300). */
  lockTtlSeconds?: number;
}

interface ScheduleEntry {
  agentId: string;
  workspaceId: string;
  cronExpression: string;
  timezone?: string;
  input?: string;
  enabled: boolean;
}

interface ScheduledTask {
  agentId: string;
  task: cron.ScheduledTask;
}

/**
 * Cron scheduler for HonorClaw agents.
 *
 * - node-cron based scheduling
 * - Reads schedule definitions from agent manifests
 * - Creates headless sessions on trigger
 * - Distributed lock via Redis SETNX to prevent duplicate execution
 * - Missed schedule handling (skip + warn)
 */
export class AgentScheduler {
  private readonly redis: Redis;
  private readonly db: Pool;
  private readonly lockPrefix: string;
  private readonly lockTtlSeconds: number;
  private readonly tasks: ScheduledTask[] = [];
  private running = false;

  constructor(options: SchedulerOptions) {
    this.redis = options.redis;
    this.db = options.db;
    this.lockPrefix = options.lockPrefix ?? 'honorclaw:schedule:lock:';
    this.lockTtlSeconds = options.lockTtlSeconds ?? 300;
  }

  /**
   * Load schedules from the database and start all cron tasks.
   */
  async start(): Promise<void> {
    this.running = true;
    const schedules = await this.loadSchedules();

    for (const entry of schedules) {
      if (!entry.enabled) continue;

      if (!cron.validate(entry.cronExpression)) {
        console.warn(
          `[Scheduler] Invalid cron expression for agent ${entry.agentId}: "${entry.cronExpression}" — skipping.`,
        );
        continue;
      }

      const task = cron.schedule(
        entry.cronExpression,
        () => {
          void this.executeSchedule(entry);
        },
        {
          timezone: entry.timezone ?? 'UTC',
        },
      );

      this.tasks.push({ agentId: entry.agentId, task });
    }

    console.log(`[Scheduler] Started ${this.tasks.length} scheduled tasks.`);
  }

  /**
   * Stop all cron tasks and release resources.
   */
  async stop(): Promise<void> {
    this.running = false;

    for (const { task } of this.tasks) {
      task.stop();
    }
    this.tasks.length = 0;
  }

  /**
   * Reload schedules from the database (e.g., after manifest update).
   */
  async reload(): Promise<void> {
    await this.stop();
    await this.start();
  }

  // ── Internal ──────────────────────────────────────────────────────────

  /**
   * Load schedule entries from agent manifests in the database.
   */
  private async loadSchedules(): Promise<ScheduleEntry[]> {
    const result = await this.db.query<{
      agent_id: string;
      workspace_id: string;
      manifest: any;
    }>(
      `SELECT cm.agent_id, cm.workspace_id, cm.manifest
       FROM capability_manifests cm
       INNER JOIN (
         SELECT agent_id, MAX(version) as max_version
         FROM capability_manifests
         GROUP BY agent_id
       ) latest ON cm.agent_id = latest.agent_id AND cm.version = latest.max_version
       WHERE cm.manifest->'schedule' IS NOT NULL`,
    );

    const entries: ScheduleEntry[] = [];
    for (const row of result.rows) {
      const schedule = row.manifest?.schedule;
      if (!schedule?.cron) continue;

      entries.push({
        agentId: row.agent_id,
        workspaceId: row.workspace_id,
        cronExpression: schedule.cron as string,
        timezone: schedule.timezone as string | undefined,
        input: schedule.input as string | undefined,
        enabled: schedule.enabled !== false,
      });
    }
    return entries;
  }

  /**
   * Execute a single schedule entry with distributed locking.
   */
  private async executeSchedule(entry: ScheduleEntry): Promise<void> {
    if (!this.running) return;

    const lockKey = `${this.lockPrefix}${entry.agentId}`;
    const lockValue = `${process.pid}:${Date.now()}`;

    // Acquire distributed lock via SETNX
    const acquired = await this.redis.set(
      lockKey,
      lockValue,
      'EX',
      this.lockTtlSeconds,
      'NX',
    );

    if (!acquired) {
      // Another instance already claimed this schedule tick — skip
      console.warn(
        `[Scheduler] Missed schedule for agent ${entry.agentId} — another instance holds the lock. Skipping.`,
      );
      return;
    }

    try {
      console.log(`[Scheduler] Triggering scheduled run for agent ${entry.agentId}`);

      const sessionOptions: HeadlessSessionOptions = {
        agentId: entry.agentId,
        workspaceId: entry.workspaceId,
        sessionType: 'scheduled',
        input: entry.input ?? 'Scheduled execution triggered.',
        db: this.db,
        redis: this.redis,
      };

      const result = await createHeadlessSession(sessionOptions);

      console.log(
        `[Scheduler] Scheduled run complete for agent ${entry.agentId}: session=${result.sessionId}, status=${result.status}`,
      );

      // Record the run in the database
      await this.db.query(
        `INSERT INTO scheduled_runs (agent_id, workspace_id, session_id, status, started_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [entry.agentId, entry.workspaceId, result.sessionId, result.status, result.startedAt],
      );
    } catch (err) {
      console.error(
        `[Scheduler] Error executing schedule for agent ${entry.agentId}:`,
        err,
      );
    } finally {
      // Release the lock (only if we still own it)
      const currentValue = await this.redis.get(lockKey);
      if (currentValue === lockValue) {
        await this.redis.del(lockKey);
      }
    }
  }
}
