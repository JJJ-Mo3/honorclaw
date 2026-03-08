import type { Redis } from 'ioredis';
import type { Database } from '../db/index.js';
import type { LLMRouter } from '../llm/router.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { AuditEmitter } from '../audit/emitter.js';
import type { HonorClawConfig } from '@honorclaw/core';
import { RedisChannels } from '@honorclaw/core';
import crypto from 'node:crypto';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

interface CreateSessionOpts {
  workspaceId: string;
  agentId: string;
  userId: string;
  channel: string;
}

export class SessionManager {
  private redis: Redis;
  private db: Database;
  private llmRouter: LLMRouter;
  private toolExecutor: ToolExecutor;
  private auditEmitter: AuditEmitter;
  private config: HonorClawConfig;
  private activeSessions = new Set<string>();

  constructor(redis: Redis, db: Database, llmRouter: LLMRouter, toolExecutor: ToolExecutor, auditEmitter: AuditEmitter, config: HonorClawConfig) {
    this.redis = redis;
    this.db = db;
    this.llmRouter = llmRouter;
    this.toolExecutor = toolExecutor;
    this.auditEmitter = auditEmitter;
    this.config = config;
  }

  async create(opts: CreateSessionOpts) {
    const sessionId = crypto.randomUUID();

    // Get agent config
    const agentResult = await this.db.query(
      'SELECT * FROM agents WHERE id = $1 AND workspace_id = $2',
      [opts.agentId, opts.workspaceId],
    );
    const agent = agentResult.rows[0];
    if (!agent) throw new Error('Agent not found');

    // Get latest manifest
    const manifestResult = await this.db.query(
      'SELECT manifest FROM capability_manifests WHERE agent_id = $1 ORDER BY version DESC LIMIT 1',
      [opts.agentId],
    );
    const manifest = manifestResult.rows[0]?.manifest;

    // Create session in DB
    await this.db.query(
      'INSERT INTO sessions (id, workspace_id, agent_id, user_id, channel) VALUES ($1, $2, $3, $4, $5)',
      [sessionId, opts.workspaceId, opts.agentId, opts.userId, opts.channel],
    );

    // Set session context in Redis
    const tools = manifest?.tools?.filter((t: any) => t.enabled).map((t: any) => ({
      name: t.name,
      description: `Tool: ${t.name}`,
      parameters: t.parameters,
    })) ?? [];

    await this.redis.set(
      `session:${sessionId}:context`,
      JSON.stringify({
        model: agent.model,
        tools,
        maxTokens: manifest?.session?.maxTokensPerSession ?? 100_000,
        toolTimeoutSeconds: 60,
        workspaceId: opts.workspaceId,
        agentId: opts.agentId,
        systemPrompt: agent.system_prompt,
      }),
    );

    // Set system prompt
    if (agent.system_prompt) {
      await this.redis.set(
        RedisChannels.sessionState(sessionId),
        JSON.stringify({ messages: [{ role: 'system', content: agent.system_prompt }] }),
      );
    }

    this.activeSessions.add(sessionId);

    this.auditEmitter.emit({
      workspaceId: opts.workspaceId,
      eventType: 'session.start',
      actorType: 'user',
      actorId: opts.userId,
      agentId: opts.agentId,
      sessionId,
      payload: { channel: opts.channel, model: agent.model },
    });

    logger.info({ sessionId, agentId: opts.agentId }, 'Session created');
    return { id: sessionId, agentId: opts.agentId, status: 'active' };
  }

  async sendMessage(sessionId: string, content: string, userId: string): Promise<void> {
    // Store the user message in the database for history
    await this.db.query(
      'INSERT INTO session_messages (session_id, role, content, metadata) VALUES ($1, $2, $3, $4)',
      [sessionId, 'user', content, JSON.stringify({ senderId: userId })],
    );

    // Publish to the agent input channel so the AgentLoop picks it up
    await this.redis.publish(RedisChannels.agentInput(sessionId), JSON.stringify({
      sessionId,
      content,
      senderId: userId,
      timestamp: new Date().toISOString(),
    }));
  }

  async end(sessionId: string): Promise<void> {
    // Send drain command
    await this.redis.publish(RedisChannels.sessionControl(sessionId), JSON.stringify({
      sessionId,
      command: 'drain',
    }));

    // Update DB
    await this.db.query(
      'UPDATE sessions SET status = $1, ended_at = now() WHERE id = $2',
      ['ended', sessionId],
    );

    this.activeSessions.delete(sessionId);
    logger.info({ sessionId }, 'Session ended');
  }

  async drainAll(): Promise<void> {
    logger.info({ count: this.activeSessions.size }, 'Draining all sessions');
    const promises = [...this.activeSessions].map(id => this.end(id));
    await Promise.allSettled(promises);
  }
}
