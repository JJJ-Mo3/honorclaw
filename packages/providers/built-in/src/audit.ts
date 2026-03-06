import type { AuditSink, AuditEvent, AuditQueryFilter, AuditQueryResult } from '@honorclaw/core';
import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export class PostgresAuditSink implements AuditSink {
  private pool: Pool;
  private buffer: AuditEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
    this.flushTimer = setInterval(() => this.flush().catch(() => {}), 2000);
  }

  emit(event: AuditEvent): void {
    this.buffer.push(event);
    if (this.buffer.length >= 100) {
      this.flush().catch(() => {});
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);

    try {
      const values: unknown[] = [];
      const placeholders: string[] = [];

      batch.forEach((event, i) => {
        const o = i * 7;
        placeholders.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7})`);
        values.push(
          event.workspaceId, event.eventType, event.actorType,
          event.actorId ?? null, event.agentId ?? null, event.sessionId ?? null,
          JSON.stringify(event.payload ?? {}),
        );
      });

      await this.pool.query(
        `INSERT INTO audit_events (workspace_id, event_type, actor_type, actor_id, agent_id, session_id, payload) VALUES ${placeholders.join(', ')}`,
        values,
      );
    } catch (err) {
      logger.error({ err, count: batch.length }, 'Audit flush failed');
    }
  }

  async query(filter: AuditQueryFilter): Promise<AuditQueryResult> {
    const params: unknown[] = [filter.workspaceId];
    let sql = 'SELECT * FROM audit_events WHERE workspace_id = $1';
    let idx = 2;

    if (filter.eventType) { sql += ` AND event_type = $${idx++}`; params.push(filter.eventType); }
    if (filter.actorId) { sql += ` AND actor_id = $${idx++}`; params.push(filter.actorId); }
    if (filter.agentId) { sql += ` AND agent_id = $${idx++}`; params.push(filter.agentId); }
    if (filter.sessionId) { sql += ` AND session_id = $${idx++}`; params.push(filter.sessionId); }
    if (filter.startDate) { sql += ` AND created_at >= $${idx++}`; params.push(filter.startDate); }
    if (filter.endDate) { sql += ` AND created_at <= $${idx++}`; params.push(filter.endDate); }
    if (filter.cursor) { sql += ` AND id > $${idx++}`; params.push(filter.cursor); }

    sql += ` ORDER BY created_at DESC LIMIT $${idx}`;
    params.push(Math.min(filter.limit ?? 50, 100));

    const result = await this.pool.query(sql, params);
    return {
      events: result.rows,
      nextCursor: result.rows.length > 0 ? result.rows[result.rows.length - 1].id : undefined,
    };
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}
