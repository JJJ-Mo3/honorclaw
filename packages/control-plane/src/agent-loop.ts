import type { Redis } from 'ioredis';
import type { Database } from './db/index.js';
import type { HonorClawConfig, LLMRequest } from '@honorclaw/core';
import type { z } from 'zod';
import { RedisChannels, CapabilityManifestSchema } from '@honorclaw/core';
import { checkInput } from './guardrails/input-guardrail.js';
import { checkMultiTurnInjection } from './guardrails/multi-turn-detector.js';
import type { AuditEmitter } from './audit/emitter.js';
import crypto from 'node:crypto';
import pino from 'pino';

type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const MAX_TOOL_ITERATIONS = 10;
const MAX_HISTORY_MESSAGES = 100;

interface ToolCall {
  id: string;
  tool_name: string;
  parameters: Record<string, unknown>;
}

interface LLMResponseParsed {
  sessionId: string;
  correlationId: string;
  content: string | null;
  toolCalls?: ToolCall[];
  tokensUsed: { prompt: number; completion: number; total: number };
  model: string;
  finishReason: string;
}

interface MessageEntry {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

/**
 * AgentLoop bridges user messages (agent:*:input) and the LLM Router (llm:*:request).
 *
 * Flow: user message → guardrail check → LLM request → (tool call loop) → final reply.
 *
 * When the LLM responds with finishReason: 'tool_calls', the AgentLoop dispatches
 * each tool call via Redis, waits for results, appends them
 * as 'tool' role messages, and re-invokes the LLM — up to MAX_TOOL_ITERATIONS.
 */
export class AgentLoop {
  private db: Database;
  private redis: Redis;
  /** Dedicated connection for blocking commands (brpop) so they don't stall the shared connection. */
  private blockingRedis: Redis;
  private config: HonorClawConfig;
  private auditEmitter?: AuditEmitter;

  constructor(db: Database, redis: Redis, config: HonorClawConfig, auditEmitter?: AuditEmitter) {
    this.db = db;
    this.redis = redis;
    this.blockingRedis = redis.duplicate();
    this.config = config;
    this.auditEmitter = auditEmitter;
  }

  async start(): Promise<void> {
    const sub = this.redis.duplicate();
    await sub.psubscribe('agent:*:input');

    sub.on('pmessage', async (_pattern: string, channel: string, message: string) => {
      try {
        const input = JSON.parse(message) as {
          sessionId: string;
          content: string;
          senderId: string;
          timestamp: string;
        };

        await this.handleMessage(input.sessionId, input.content, input.senderId);
      } catch (err) {
        logger.error({ err, channel }, 'AgentLoop: error handling input message');
      }
    });

    logger.info('AgentLoop started — listening on agent:*:input');
  }

  private async handleMessage(sessionId: string, content: string, senderId: string): Promise<void> {
    // 1. Load session context from Redis (set by SessionManager.create)
    const contextRaw = await this.redis.get(`session:${sessionId}:context`);
    if (!contextRaw) {
      logger.error({ sessionId }, 'AgentLoop: no session context found');
      await this.publishError(sessionId, 'No session context found. Was the session created?');
      return;
    }

    const context = JSON.parse(contextRaw) as {
      model: string;
      tools: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>;
      maxTokens: number;
      toolTimeoutSeconds: number;
      workspaceId: string;
      agentId: string;
      systemPrompt?: string;
    };

    // 2. Run input guardrails (injection detection, topic filtering, PII redaction)
    // Always apply guardrails, even without a manifest (use a safe default)
    const manifest = await this.loadManifest(context.agentId);
    const effectiveManifest: CapabilityManifest = manifest ?? CapabilityManifestSchema.parse({
      agentId: context.agentId,
      workspaceId: context.workspaceId,
      version: 1,
    });

    const guardrailResult = checkInput(content, effectiveManifest, {
      userId: senderId,
      sessionId,
      workspaceId: context.workspaceId,
    });

    if (!guardrailResult.allowed) {
      logger.warn(
        { sessionId, violation: guardrailResult.violation },
        'AgentLoop: input blocked by guardrails',
      );
      // Store the rejection and notify the user
      const rejectionMsg = 'Your message was blocked by the security policy. Please rephrase your request.';
      await this.db.query(
        'INSERT INTO session_messages (session_id, role, content) VALUES ($1, $2, $3)',
        [sessionId, 'assistant', rejectionMsg],
      );
      await this.publishOutput(sessionId, rejectionMsg, context.model);
      return;
    }

    // Use sanitized message if PII was redacted
    if (guardrailResult.sanitizedMessage) {
      content = guardrailResult.sanitizedMessage;
    }

    // 2b. Multi-turn injection detection: score the full conversation history
    const priorHistory = await this.db.query(
      `SELECT role, content FROM session_messages WHERE session_id = $1 ORDER BY created_at`,
      [sessionId],
    );
    const conversationForCheck = [
      ...priorHistory.rows.map((r: { role: string; content: string }) => ({ role: r.role, content: r.content })),
      { role: 'user', content },
    ];
    const multiTurnResult = checkMultiTurnInjection(conversationForCheck);
    if (multiTurnResult.blocked) {
      logger.warn(
        { sessionId, score: multiTurnResult.score, indicators: multiTurnResult.indicators },
        'AgentLoop: multi-turn injection detected',
      );
      this.auditEmitter?.emit({
        workspaceId: context.workspaceId,
        eventType: 'security.violation',
        actorType: 'agent',
        actorId: context.agentId,
        sessionId,
        payload: { type: 'multi_turn_injection', score: multiTurnResult.score, indicators: multiTurnResult.indicators },
      });
      const blockMsg = 'This conversation has been flagged for security review. Please start a new session.';
      await this.db.query(
        'INSERT INTO session_messages (session_id, role, content) VALUES ($1, $2, $3)',
        [sessionId, 'assistant', blockMsg],
      );
      await this.publishOutput(sessionId, blockMsg, context.model);
      return;
    }

    // 3. Load conversation history (bounded to prevent token explosion)
    const historyResult = await this.db.query(
      `SELECT role, content, metadata FROM session_messages
       WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [sessionId, MAX_HISTORY_MESSAGES],
    );
    // Reverse to chronological order
    const historyRows = historyResult.rows.reverse();

    // 4. Build messages array (system prompt + history)
    const messages: MessageEntry[] = [];

    if (context.systemPrompt) {
      messages.push({ role: 'system', content: context.systemPrompt });
    }

    for (const row of historyRows) {
      const entry: MessageEntry = { role: row.role, content: row.content };
      // Restore tool message metadata (toolCallId) if present
      if (row.role === 'tool' && row.metadata) {
        try {
          const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
          if (meta.toolCallId) entry.toolCallId = meta.toolCallId;
        } catch { /* ignore */ }
      }
      // Restore assistant tool_calls metadata if present
      if (row.role === 'assistant' && row.metadata) {
        try {
          const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
          if (meta.toolCalls) entry.toolCalls = meta.toolCalls;
        } catch { /* ignore */ }
      }
      messages.push(entry);
    }

    // 5. Iterative LLM + tool call loop
    let totalTokens = 0;
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const correlationId = crypto.randomUUID();
      const llmRequest: LLMRequest = {
        sessionId,
        correlationId,
        messages,
        tools: context.tools.length > 0 ? context.tools : undefined,
        model: context.model ?? this.config.llm.defaultModel,
        maxTokens: Math.min(4096, context.maxTokens - totalTokens),
      };

      const requestChannel = RedisChannels.llmRequest(sessionId);
      await this.redis.publish(requestChannel, JSON.stringify(llmRequest));

      // Wait for LLM response
      const responseListKey = `llm:${sessionId}:response:${correlationId}`;
      const timeoutSeconds = context.toolTimeoutSeconds || 60;
      const result = await this.blockingRedis.brpop(responseListKey, timeoutSeconds);

      if (!result) {
        logger.error({ sessionId, correlationId }, 'AgentLoop: LLM response timed out');
        await this.publishError(sessionId, 'LLM response timed out');
        return;
      }

      const llmResponse = JSON.parse(result[1]) as LLMResponseParsed;
      totalTokens += llmResponse.tokensUsed.total;

      if (llmResponse.finishReason === 'error') {
        logger.error({ sessionId, content: llmResponse.content }, 'AgentLoop: LLM returned error');
        await this.publishError(sessionId, llmResponse.content ?? 'LLM error');
        return;
      }

      // Handle tool calls
      if (llmResponse.finishReason === 'tool_calls' && llmResponse.toolCalls?.length) {
        // Store the assistant message with tool call metadata
        const assistantContent = llmResponse.content ?? '';
        await this.db.query(
          'INSERT INTO session_messages (session_id, role, content, metadata) VALUES ($1, $2, $3, $4)',
          [sessionId, 'assistant', assistantContent, JSON.stringify({ toolCalls: llmResponse.toolCalls })],
        );
        messages.push({ role: 'assistant', content: assistantContent, toolCalls: llmResponse.toolCalls });

        // Notify the client about pending tool calls
        for (const tc of llmResponse.toolCalls) {
          const outputChannel = RedisChannels.agentOutput(sessionId);
          await this.redis.publish(outputChannel, JSON.stringify({
            sessionId,
            type: 'tool_call_pending',
            toolCallId: tc.id,
            toolName: tc.tool_name,
            toolParams: tc.parameters,
            toolStatus: 'pending_approval',
            timestamp: new Date().toISOString(),
          }));
        }

        // Execute each tool call (with approval gate if required)
        for (const tc of llmResponse.toolCalls) {
          const toolConfig = effectiveManifest.tools.find(t => t.name === tc.tool_name);
          const needsApproval = toolConfig?.requiresApproval === true;

          let toolResult: unknown;

          if (needsApproval) {
            // Create approval request
            const approvalId = crypto.randomUUID();
            const timeoutMinutes = 30;
            const timeoutAt = new Date(Date.now() + timeoutMinutes * 60 * 1000).toISOString();

            // Redact sensitive parameter values for display
            const redactedParams = JSON.stringify(tc.parameters, (_key, value) =>
              typeof value === 'string' && value.length > 100 ? value.slice(0, 100) + '...' : value
            );

            await this.db.query(
              `INSERT INTO approval_requests (id, workspace_id, session_id, agent_id, tool_name, parameters_redacted, status, timeout_at)
               VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
              [approvalId, context.workspaceId, sessionId, context.agentId, tc.tool_name, redactedParams, timeoutAt]
            );

            // Notify client about pending approval
            const outputChannel = RedisChannels.agentOutput(sessionId);
            await this.redis.publish(outputChannel, JSON.stringify({
              sessionId,
              type: 'tool_approval',
              toolCallId: tc.id,
              toolName: tc.tool_name,
              toolParams: tc.parameters,
              approvalId,
              toolStatus: 'pending_approval',
              timestamp: new Date().toISOString(),
            }));

            // Poll for approval resolution
            const POLL_INTERVAL = 1000;
            const POLL_TIMEOUT = timeoutMinutes * 60 * 1000;
            const startTime = Date.now();
            let approved = false;

            while (Date.now() - startTime < POLL_TIMEOUT) {
              await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
              const checkResult = await this.db.query(
                'SELECT status FROM approval_requests WHERE id = $1',
                [approvalId]
              );
              const row = checkResult.rows[0] as { status: string } | undefined;
              if (row?.status === 'approved') {
                approved = true;
                break;
              }
              if (row?.status === 'rejected') {
                break;
              }
            }

            if (!approved) {
              // Timed out or rejected — mark as timed out if still pending
              await this.db.query(
                `UPDATE approval_requests SET status = 'rejected', resolved_at = now()
                 WHERE id = $1 AND status = 'pending'`,
                [approvalId]
              );
              toolResult = { error: `Tool call '${tc.tool_name}' was not approved` };
            } else {
              toolResult = await this.executeToolCall(sessionId, tc, context.toolTimeoutSeconds);
            }
          } else {
            toolResult = await this.executeToolCall(sessionId, tc, context.toolTimeoutSeconds);
          }

          const toolResultStr = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);

          // Store tool result in DB
          await this.db.query(
            'INSERT INTO session_messages (session_id, role, content, metadata) VALUES ($1, $2, $3, $4)',
            [sessionId, 'tool', toolResultStr, JSON.stringify({ toolCallId: tc.id, toolName: tc.tool_name })],
          );
          messages.push({ role: 'tool', content: toolResultStr, toolCallId: tc.id });

          // Notify client of tool result
          const outputChannel = RedisChannels.agentOutput(sessionId);
          await this.redis.publish(outputChannel, JSON.stringify({
            sessionId,
            type: 'tool_result',
            toolCallId: tc.id,
            toolName: tc.tool_name,
            toolResult,
            toolStatus: needsApproval ? 'approved_and_executed' : 'success',
            timestamp: new Date().toISOString(),
          }));
        }

        // Continue the loop — re-invoke LLM with tool results
        continue;
      }

      // Final text response (finishReason: 'stop' or 'length')
      const replyContent = typeof llmResponse.content === 'string'
        ? llmResponse.content
        : JSON.stringify(llmResponse.content);

      await this.db.query(
        'INSERT INTO session_messages (session_id, role, content) VALUES ($1, $2, $3)',
        [sessionId, 'assistant', replyContent],
      );

      // Update session token usage
      await this.db.query(
        'UPDATE sessions SET tokens_used = tokens_used + $1 WHERE id = $2',
        [totalTokens, sessionId],
      );

      await this.publishOutput(sessionId, replyContent, llmResponse.model);

      // Emit LLM response audit event
      this.auditEmitter?.emit({
        workspaceId: context.workspaceId,
        eventType: 'llm.response',
        actorType: 'agent',
        actorId: context.agentId,
        sessionId,
        payload: {
          model: llmResponse.model,
          tokensUsed: llmResponse.tokensUsed,
          contentHash: crypto.createHash('sha256').update(replyContent).digest('hex'),
          toolCallCount: 0,
          finishReason: llmResponse.finishReason,
        },
      });

      logger.info(
        { sessionId, model: llmResponse.model, tokens: totalTokens, iterations: iteration + 1 },
        'AgentLoop: message processed',
      );
      return;
    }

    // Exhausted tool call iterations
    const fallback = 'I was unable to complete the request after multiple tool call attempts. Please try a simpler request.';
    await this.db.query(
      'INSERT INTO session_messages (session_id, role, content) VALUES ($1, $2, $3)',
      [sessionId, 'assistant', fallback],
    );
    await this.db.query(
      'UPDATE sessions SET tokens_used = tokens_used + $1 WHERE id = $2',
      [totalTokens, sessionId],
    );
    await this.publishOutput(sessionId, fallback, context.model);
  }

  /**
   * Dispatch a tool call via Redis and wait for the result.
   */
  private async executeToolCall(
    sessionId: string,
    toolCall: ToolCall,
    timeoutSeconds: number,
  ): Promise<unknown> {
    const requestChannel = RedisChannels.toolRequest(sessionId, toolCall.id);
    await this.redis.publish(requestChannel, JSON.stringify({
      sessionId,
      callId: toolCall.id,
      toolName: toolCall.tool_name,
      parameters: toolCall.parameters,
    }));

    const resultKey = RedisChannels.toolResult(sessionId, toolCall.id);
    const result = await this.blockingRedis.brpop(resultKey, timeoutSeconds || 60);

    if (!result) {
      logger.warn({ sessionId, callId: toolCall.id }, 'AgentLoop: tool call timed out');
      return { error: 'Tool call timed out' };
    }

    const parsed = JSON.parse(result[1]) as { status: string; result?: unknown; error?: { message: string } };
    if (parsed.status === 'success') {
      return parsed.result ?? { success: true };
    }
    return { error: parsed.error?.message ?? `Tool call failed with status: ${parsed.status}` };
  }

  /**
   * Load the capability manifest for the agent (for guardrails).
   * Returns null if no manifest exists (guardrails will be skipped).
   */
  private async loadManifest(agentId: string) {
    try {
      const result = await this.db.query(
        'SELECT manifest FROM capability_manifests WHERE agent_id = $1 ORDER BY version DESC LIMIT 1',
        [agentId],
      );
      const row = result.rows[0] as { manifest: unknown } | undefined;
      if (!row) return null;
      return CapabilityManifestSchema.parse(row.manifest);
    } catch (err) {
      logger.warn({ err, agentId }, 'AgentLoop: failed to load manifest for guardrails');
      return null;
    }
  }

  private async publishOutput(sessionId: string, content: string, model: string): Promise<void> {
    const outputChannel = RedisChannels.agentOutput(sessionId);
    await this.redis.publish(outputChannel, JSON.stringify({
      type: 'agent_response',
      messageId: crypto.randomUUID(),
      sessionId,
      content,
      model,
      timestamp: new Date().toISOString(),
    }));
  }

  private async publishError(sessionId: string, message: string): Promise<void> {
    const errorChannel = RedisChannels.agentOutput(sessionId);
    await this.redis.publish(errorChannel, JSON.stringify({
      type: 'error',
      messageId: crypto.randomUUID(),
      sessionId,
      content: `Error: ${message}`,
      error: true,
      timestamp: new Date().toISOString(),
    }));
  }
}
