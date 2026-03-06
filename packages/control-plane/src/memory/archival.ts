import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { RedisChannels } from '@honorclaw/core';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArchivalOptions {
  redis: Redis;
  pool: Pool;
  /** If provided, generate an LLM summary of the conversation */
  summarize?: (messages: unknown[]) => Promise<string>;
}

export interface ArchivalResult {
  archiveId: string;
  messagesCount: number;
  summary?: string;
}

// ---------------------------------------------------------------------------
// Session archival
// ---------------------------------------------------------------------------

/**
 * On session end: read conversation from Redis, INSERT into session_archives,
 * optionally generate an LLM summary and ingest as memory,
 * then DELETE Redis keys.
 */
export async function archiveSession(
  sessionId: string,
  workspaceId: string,
  agentId: string,
  opts: ArchivalOptions,
): Promise<ArchivalResult> {
  const { redis, pool, summarize } = opts;

  // 1. Read conversation state from Redis
  const stateKey = RedisChannels.sessionState(sessionId);
  const raw = await redis.get(stateKey);

  if (!raw) {
    logger.warn({ sessionId }, 'No session state found in Redis — nothing to archive');
    throw new Error(`No session state found for session ${sessionId}`);
  }

  const state = JSON.parse(raw) as { messages?: unknown[] };
  const messages = state.messages ?? [];

  // 2. Optionally generate LLM summary
  let summary: string | undefined;
  if (summarize && messages.length > 0) {
    try {
      summary = await summarize(messages);
    } catch (err) {
      logger.warn({ err, sessionId }, 'Summary generation failed — archiving without summary');
    }
  }

  // 3. INSERT into session_archives
  const result = await pool.query(
    `INSERT INTO session_archives (session_id, workspace_id, agent_id, messages, summary)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [sessionId, workspaceId, agentId, JSON.stringify(messages), summary ?? null],
  );

  const archiveId = result.rows[0]?.id as string;

  // 4. DELETE Redis keys after successful archival
  const keysToDelete = [
    stateKey,
    `session:${sessionId}:context`,
    RedisChannels.sessionTokens(sessionId),
  ];

  const pipeline = redis.pipeline();
  for (const key of keysToDelete) {
    pipeline.del(key);
  }
  await pipeline.exec();

  logger.info({ sessionId, archiveId, messagesCount: messages.length }, 'Session archived');

  return {
    archiveId,
    messagesCount: messages.length,
    summary,
  };
}
