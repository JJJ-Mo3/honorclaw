import type { Redis } from 'ioredis';
import type { Database } from '../db/index.js';
import type { AuditEmitter } from '../audit/emitter.js';
import type { CapabilityManifest } from '@honorclaw/core';
import { narrowCapabilities } from './capability-narrowing.js';
import crypto from 'node:crypto';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DelegationRequest {
  /** The session making the delegation request */
  parentSessionId: string;
  /** Workspace the agents belong to */
  workspaceId: string;
  /** Agent A (the delegator) */
  parentAgentId: string;
  /** Agent B (the delegate) */
  targetAgentId: string;
  /** Message / task to pass to Agent B */
  task: string;
  /** User who owns the parent session */
  userId: string;
}

export interface DelegationResult {
  status: 'success' | 'error';
  childSessionId?: string;
  result?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// AgentDelegator
// ---------------------------------------------------------------------------

export class AgentDelegator {
  private redis: Redis;
  private db: Database;
  private auditEmitter: AuditEmitter;

  constructor(redis: Redis, db: Database, auditEmitter: AuditEmitter) {
    this.redis = redis;
    this.db = db;
    this.auditEmitter = auditEmitter;
  }

  /**
   * Agent A requests delegation to Agent B via tool call.
   *
   * Validates:
   * - B exists in the same workspace
   * - A's manifest allows delegation
   * - B's capabilities are a subset of (narrowed by) A's
   *
   * Spawns a new session for B, linked via parent_session_id.
   * Returns result to A as tool call result.
   */
  async delegate(request: DelegationRequest): Promise<DelegationResult> {
    const { parentSessionId, workspaceId, parentAgentId, targetAgentId, task, userId } = request;

    try {
      // 1. Validate target agent exists in the same workspace
      const targetAgentResult = await this.db.query(
        `SELECT id, name, model, system_prompt, status FROM agents
         WHERE id = $1 AND workspace_id = $2`,
        [targetAgentId, workspaceId],
      );
      const targetAgent = targetAgentResult.rows[0];
      if (!targetAgent) {
        return { status: 'error', error: `Target agent ${targetAgentId} not found in workspace` };
      }
      if (targetAgent.status !== 'active') {
        return { status: 'error', error: `Target agent ${targetAgentId} is not active` };
      }

      // 2. Get parent agent's latest manifest
      const parentManifestResult = await this.db.query(
        `SELECT manifest FROM capability_manifests
         WHERE agent_id = $1 AND workspace_id = $2
         ORDER BY version DESC LIMIT 1`,
        [parentAgentId, workspaceId],
      );
      const parentManifest = parentManifestResult.rows[0]?.manifest as CapabilityManifest | undefined;
      if (!parentManifest) {
        return { status: 'error', error: 'Parent agent has no capability manifest' };
      }

      // 3. Check if parent manifest allows delegation
      const delegateTool = parentManifest.tools.find(t => t.name === 'delegate' || t.name === 'agent_delegate');
      if (!delegateTool?.enabled) {
        return { status: 'error', error: 'Parent agent manifest does not allow delegation' };
      }

      // 4. Get target agent's latest manifest
      const childManifestResult = await this.db.query(
        `SELECT manifest FROM capability_manifests
         WHERE agent_id = $1 AND workspace_id = $2
         ORDER BY version DESC LIMIT 1`,
        [targetAgentId, workspaceId],
      );
      const childManifest = childManifestResult.rows[0]?.manifest as CapabilityManifest | undefined;
      if (!childManifest) {
        return { status: 'error', error: 'Target agent has no capability manifest' };
      }

      // 5. Narrow capabilities: B's effective manifest = intersection(A, B)
      const effectiveManifest = narrowCapabilities(parentManifest, childManifest);

      // 6. Spawn new session for B, linked via parent_session_id
      const childSessionId = crypto.randomUUID();

      await this.db.query(
        `INSERT INTO sessions (id, workspace_id, agent_id, user_id, channel, metadata)
         VALUES ($1, $2, $3, $4, 'delegation', $5)`,
        [
          childSessionId,
          workspaceId,
          targetAgentId,
          userId,
          JSON.stringify({ parent_session_id: parentSessionId, parent_agent_id: parentAgentId }),
        ],
      );

      // 7. Set session context in Redis with narrowed manifest
      const narrowedTools = effectiveManifest.tools
        .filter(t => t.enabled && t.name !== 'delegate' && t.name !== 'agent_delegate')
        .map(t => ({
          name: t.name,
          description: `Tool: ${t.name}`,
          parameters: t.parameters,
        }));

      await this.redis.set(
        `session:${childSessionId}:context`,
        JSON.stringify({
          model: targetAgent.model,
          tools: narrowedTools,
          maxTokens: effectiveManifest.session.maxTokensPerSession,
          toolTimeoutSeconds: 60,
          workspaceId,
          agentId: targetAgentId,
          systemPrompt: targetAgent.system_prompt,
          parentSessionId,
          effectiveManifest,
        }),
      );

      // 8. Set initial state with task message
      await this.redis.set(
        `session:${childSessionId}:state`,
        JSON.stringify({
          messages: [
            ...(targetAgent.system_prompt ? [{ role: 'system', content: targetAgent.system_prompt }] : []),
            { role: 'user', content: task },
          ],
        }),
      );

      // 9. Audit
      this.auditEmitter.emit({
        workspaceId,
        eventType: 'session.start',
        actorType: 'agent',
        actorId: parentAgentId,
        agentId: targetAgentId,
        sessionId: childSessionId,
        payload: {
          channel: 'delegation',
          parentSessionId,
          parentAgentId,
          task: task.slice(0, 200), // Truncate for audit
        },
      });

      logger.info({
        parentSessionId,
        childSessionId,
        parentAgentId,
        targetAgentId,
        narrowedToolCount: narrowedTools.length,
      }, 'Agent delegation session created');

      return { status: 'success', childSessionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown delegation error';
      logger.error({ err, parentSessionId, targetAgentId }, 'Delegation failed');
      return { status: 'error', error: message };
    }
  }
}
