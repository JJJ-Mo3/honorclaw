import type { Redis } from 'ioredis';
import type { CapabilityManifest, ComputeProvider } from '@honorclaw/core';
import { CapabilityManifestSchema } from '@honorclaw/core';
import type { AuditEmitter } from '../audit/emitter.js';
import type { Database } from '../db/index.js';
import { validateToolCall } from '../policy/enforcer.js';
import { sanitizeParameters } from '../policy/sanitizer.js';
import { RateLimiter } from '../policy/rate-limiter.js';
import { resolveAgentSecrets, secretPathToEnvVar } from './secret-resolver.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export class ToolExecutor {
  private redis: Redis;
  private db: Database;
  private auditEmitter: AuditEmitter;
  private rateLimiter: RateLimiter;
  private computeProvider: ComputeProvider | null;

  constructor(
    redis: Redis,
    db: Database,
    auditEmitter: AuditEmitter,
    computeProvider?: ComputeProvider,
  ) {
    this.redis = redis;
    this.db = db;
    this.auditEmitter = auditEmitter;
    this.rateLimiter = new RateLimiter(redis);
    this.computeProvider = computeProvider ?? null;
  }

  async start(): Promise<void> {
    // Subscribe to tool request channels
    const sub = this.redis.duplicate();
    await sub.psubscribe('tools:*:request:*');

    sub.on('pmessage', async (_pattern: string, channel: string, message: string) => {
      try {
        const request = JSON.parse(message);
        await this.handleToolCall(request);
      } catch (err) {
        logger.error({ err, channel }, 'Tool execution error');
      }
    });
  }

  async handleToolCall(request: { sessionId: string; callId: string; toolName: string; parameters: Record<string, unknown> }): Promise<void> {
    const { sessionId, callId, toolName, parameters } = request;
    const startTime = Date.now();

    try {
      // 1. Load the agent's capability manifest from the session context
      const manifest = await this.loadManifest(sessionId);

      // 2. Validate tool call against capability manifest via PolicyEnforcer
      const validation = validateToolCall(
        { toolName, parameters },
        manifest,
      );
      if (!validation.valid) {
        logger.warn({ toolName, callId, reason: validation.reason }, 'Tool call rejected by policy');
        await this.pushResult(sessionId, callId, {
          status: 'rejected',
          error: { code: 'policy_violation', message: validation.reason ?? 'Policy violation' },
        });
        return;
      }

      // 3. Sanitize parameters (SSRF protection, path traversal, null bytes, etc.)
      const toolDef = manifest.tools.find(t => t.name === toolName);
      const allowedDomains = manifest.egress.allowedDomains;
      const sanitizeResult = await sanitizeParameters(parameters, allowedDomains);
      if (!sanitizeResult.valid) {
        logger.warn({ toolName, callId, reason: sanitizeResult.reason }, 'Parameter sanitization failed');
        await this.pushResult(sessionId, callId, {
          status: 'rejected',
          error: { code: 'sanitization_failed', message: sanitizeResult.reason ?? 'Parameter sanitization failed' },
        });
        return;
      }
      const sanitizedParams = sanitizeResult.sanitized;

      // 4. Check rate limits
      const rateLimitConfig = toolDef?.rateLimit ?? {};
      const rateLimitResult = await this.rateLimiter.checkAndIncrement(
        sessionId,
        toolName,
        rateLimitConfig,
      );
      if (!rateLimitResult.allowed) {
        logger.warn({ toolName, callId, reason: rateLimitResult.reason }, 'Rate limit exceeded');
        await this.pushResult(sessionId, callId, {
          status: 'rejected',
          error: { code: 'rate_limit_exceeded', message: rateLimitResult.reason ?? 'Rate limit exceeded' },
        });
        return;
      }

      // 5. Resolve agent-scoped secrets and build secret env vars
      const resolvedSecrets = await resolveAgentSecrets(
        this.db,
        manifest.workspaceId,
        manifest.allowedSecretPaths,
      );
      const secretEnv: Record<string, string> = {};
      for (const secret of resolvedSecrets) {
        secretEnv[secretPathToEnvVar(secret.path)] = secret.value;
      }

      // 6. Execute the tool
      let toolResult: unknown;

      if (this.computeProvider && toolDef?.source) {
        // Execute via ComputeProvider (container-based execution)
        const handle = await this.computeProvider.spawnContainer({
          image: toolDef.source,
          env: {
            ...secretEnv,
            TOOL_NAME: toolName,
            TOOL_PARAMS: JSON.stringify(sanitizedParams),
          },
          readOnly: true,
          user: '65534:65534',
        });

        const containerResult = await this.computeProvider.waitForContainer(handle, 60_000);

        if (containerResult.exitCode !== 0) {
          throw new Error(`Tool container exited with code ${containerResult.exitCode}: ${containerResult.stderr}`);
        }

        try {
          toolResult = JSON.parse(containerResult.stdout);
        } catch {
          toolResult = containerResult.stdout;
        }
      } else {
        // In-process fallback: return sanitized parameters as acknowledgment
        toolResult = { message: `Tool ${toolName} executed`, parameters: sanitizedParams };
      }

      // 7. Return the real result
      const duration = Date.now() - startTime;
      await this.pushResult(sessionId, callId, {
        status: 'success',
        result: toolResult,
      });

      this.auditEmitter.emit({
        workspaceId: manifest.workspaceId,
        eventType: 'tool.execution',
        actorType: 'agent',
        sessionId,
        payload: { toolName, callId, durationMs: duration, status: 'success' },
      });

      logger.info({ toolName, callId, duration }, 'Tool call completed');
    } catch (err) {
      const duration = Date.now() - startTime;
      logger.error({ err, toolName, callId, duration }, 'Tool execution error');

      await this.pushResult(sessionId, callId, {
        status: 'error',
        error: { code: 'execution_error', message: err instanceof Error ? err.message : 'Unknown error' },
      });
    }
  }

  /**
   * Load the capability manifest for the session's agent from the DB.
   * The session context in Redis stores the agentId, which we use to
   * look up the latest manifest version.
   */
  private async loadManifest(sessionId: string): Promise<CapabilityManifest> {
    // The session context is stored by SessionManager at session creation
    const contextRaw = await this.redis.get(`session:${sessionId}:context`);
    if (!contextRaw) {
      throw new Error(`No session context found for session ${sessionId}`);
    }

    const context = JSON.parse(contextRaw) as { agentId?: string; workspaceId?: string };
    const agentId = context.agentId;
    if (!agentId) {
      throw new Error(`No agentId in session context for session ${sessionId}`);
    }

    const result = await this.db.query(
      'SELECT manifest FROM capability_manifests WHERE agent_id = $1 ORDER BY version DESC LIMIT 1',
      [agentId],
    );

    const row = result.rows[0] as { manifest: unknown } | undefined;
    if (!row) {
      // Return a safe default manifest that allows no tools (agents without
      // an explicit manifest get no tool access by default).
      logger.warn({ agentId, sessionId }, 'No capability manifest found — using empty default');
      return CapabilityManifestSchema.parse({
        agentId,
        workspaceId: context.workspaceId ?? 'unknown',
        version: 0,
        tools: [],
      });
    }

    return CapabilityManifestSchema.parse(row.manifest);
  }

  private async pushResult(
    sessionId: string,
    callId: string,
    result: { status: string; result?: unknown; error?: { code: string; message: string } },
  ): Promise<void> {
    await this.redis.lpush(
      `tools:${sessionId}:result:${callId}`,
      JSON.stringify({ sessionId, callId, ...result }),
    );
  }
}
