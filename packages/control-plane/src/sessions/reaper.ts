import type { Redis } from 'ioredis';
import type { Database } from '../db/index.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

/**
 * SessionReaper periodically scans for expired sessions and archives/ends them.
 * A session is expired when started_at + maxDurationMinutes < now().
 */
export class SessionReaper {
  private redis: Redis;
  private db: Database;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(redis: Redis, db: Database, intervalMs = 5 * 60_000) {
    this.redis = redis;
    this.db = db;
    this.intervalMs = intervalMs;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.reap().catch(err => logger.error({ err }, 'Session reaper error'));
    }, this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, 'Session reaper started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Session reaper stopped');
  }

  /**
   * Find and expire active sessions that have exceeded their max duration.
   * Default max duration is 120 minutes when no manifest is found.
   */
  async reap(): Promise<number> {
    // Join sessions with their latest manifest to get maxDurationMinutes.
    // Sessions without a manifest use the default 120-minute limit.
    const result = await this.db.query(`
      SELECT s.id AS session_id, s.workspace_id, s.agent_id
      FROM sessions s
      LEFT JOIN LATERAL (
        SELECT (manifest->'session'->>'maxDurationMinutes')::int AS max_dur
        FROM capability_manifests cm
        WHERE cm.agent_id = s.agent_id
        ORDER BY cm.version DESC LIMIT 1
      ) m ON true
      WHERE s.status = 'active'
        AND s.started_at + make_interval(mins => COALESCE(m.max_dur, 120)) < now()
    `);

    const expired = result.rows as { session_id: string; workspace_id: string; agent_id: string }[];
    if (expired.length === 0) return 0;

    logger.info({ count: expired.length }, 'Reaping expired sessions');

    let reaped = 0;
    for (const row of expired) {
      try {
        // Archive conversation history
        await this.db.query(`
          INSERT INTO session_archives (session_id, workspace_id, agent_id, messages)
          SELECT $1, $2, $3, COALESCE(jsonb_agg(jsonb_build_object(
            'role', sm.role, 'content', sm.content, 'created_at', sm.created_at
          ) ORDER BY sm.created_at), '[]'::jsonb)
          FROM session_messages sm
          WHERE sm.session_id = $1
        `, [row.session_id, row.workspace_id, row.agent_id]);

        // End the session
        await this.db.query(
          `UPDATE sessions SET status = 'ended', ended_at = now() WHERE id = $1`,
          [row.session_id],
        );

        // Clean up Redis keys
        await this.redis.del(
          `session:${row.session_id}:context`,
          `honorclaw:session:${row.session_id}:state`,
        );

        reaped++;
      } catch (err) {
        logger.error({ err, sessionId: row.session_id }, 'Failed to reap session');
      }
    }

    logger.info({ reaped, total: expired.length }, 'Session reaping complete');
    return reaped;
  }
}
