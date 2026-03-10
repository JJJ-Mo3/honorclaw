import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

/** The type of headless session. */
export type SessionType = 'interactive' | 'scheduled' | 'webhook';

export interface HeadlessSessionOptions {
  agentId: string;
  workspaceId: string;
  sessionType: SessionType;
  input: string;
  db: Pool;
  redis: Redis;
  /** Optional user ID that triggered the session (null for scheduled/webhook). */
  userId?: string;
  /** Optional metadata attached to the session. */
  metadata?: Record<string, unknown>;
}

export interface HeadlessSessionResult {
  sessionId: string;
  status: 'ended' | 'error' | 'timeout';
  output: string;
  startedAt: Date;
  completedAt: Date;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Create and execute a headless session.
 *
 * Headless sessions differ from interactive sessions:
 * - session_type: "scheduled" | "webhook" (not "interactive")
 * - No inactivity timeout — runs to completion
 * - Full response returned on completion
 * - Output is always archived in session_archives
 */
export async function createHeadlessSession(
  options: HeadlessSessionOptions,
): Promise<HeadlessSessionResult> {
  const sessionId = crypto.randomUUID();
  const startedAt = new Date();

  // Insert session record
  await options.db.query(
    `INSERT INTO sessions (id, agent_id, workspace_id, user_id, session_type, status, metadata)
     VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
    [
      sessionId,
      options.agentId,
      options.workspaceId,
      options.userId ?? null,
      options.sessionType,
      JSON.stringify(options.metadata ?? {}),
    ],
  );

  // Publish session start event to Redis for the orchestration layer to pick up
  await options.redis.publish(
    `honorclaw:sessions:${sessionId}`,
    JSON.stringify({
      type: 'session.start',
      sessionId,
      agentId: options.agentId,
      workspaceId: options.workspaceId,
      sessionType: options.sessionType,
      input: options.input,
    }),
  );

  // Wait for session completion by subscribing to the completion event
  const output = await waitForCompletion(options.redis, sessionId);
  const completedAt = new Date();

  const status = output.error ? 'error' : 'ended';

  // Update session record
  await options.db.query(
    `UPDATE sessions SET status = $1, ended_at = $2, tokens_used = $3 WHERE id = $4`,
    [status, completedAt, output.tokenUsage.totalTokens, sessionId],
  );

  // Archive the full session output
  await options.db.query(
    `INSERT INTO session_archives (session_id, agent_id, workspace_id, messages, summary, archived_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      sessionId,
      options.agentId,
      options.workspaceId,
      JSON.stringify([
        { role: 'user', content: options.input },
        { role: 'assistant', content: output.text },
      ]),
      output.text.slice(0, 500),
      completedAt,
    ],
  );

  return {
    sessionId,
    status,
    output: output.text,
    startedAt,
    completedAt,
    tokenUsage: output.tokenUsage,
  };
}

// ── Internal ────────────────────────────────────────────────────────────

interface CompletionResult {
  text: string;
  error?: string;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Subscribe to Redis and wait for the session completion event.
 * No inactivity timeout — headless sessions run to full completion.
 */
async function waitForCompletion(
  redis: Redis,
  sessionId: string,
): Promise<CompletionResult> {
  return new Promise((resolve, reject) => {
    const channel = `honorclaw:sessions:${sessionId}:complete`;
    const subscriber = redis.duplicate();

    // Hard timeout of 30 minutes for headless sessions
    const timeout = setTimeout(() => {
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.disconnect();
      resolve({
        text: '',
        error: 'Session timed out after 30 minutes',
        tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      });
    }, 30 * 60 * 1000);

    subscriber.subscribe(channel).then(() => {
      subscriber.on('message', (_ch: string, message: string) => {
        clearTimeout(timeout);
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.disconnect();

        try {
          const data = JSON.parse(message);
          resolve({
            text: data.output ?? '',
            error: data.error,
            tokenUsage: data.tokenUsage ?? {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
            },
          });
        } catch {
          resolve({
            text: message,
            tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          });
        }
      });
    }).catch(reject);
  });
}
