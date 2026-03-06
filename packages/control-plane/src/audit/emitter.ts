import type { AuditEvent } from '@honorclaw/core';
import type { Database } from '../db/index.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export class AuditEmitter {
  private db: Database;
  private buffer: AuditEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(db: Database) {
    this.db = db;
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
        const offset = i * 7;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`);
        values.push(
          event.workspaceId,
          event.eventType,
          event.actorType,
          event.actorId ?? null,
          event.agentId ?? null,
          event.sessionId ?? null,
          JSON.stringify(event.payload ?? {}),
        );
      });

      await this.db.query(
        `INSERT INTO audit_events (workspace_id, event_type, actor_type, actor_id, agent_id, session_id, payload) VALUES ${placeholders.join(', ')}`,
        values,
      );
    } catch (err) {
      logger.error({ err, count: batch.length }, 'Audit flush failed — events may be lost');
    }
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    await this.flush();
  }
}
