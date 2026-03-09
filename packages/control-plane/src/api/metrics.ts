import type { FastifyInstance } from 'fastify';
import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';

/**
 * Prometheus metrics for HonorClaw.
 *
 * Exposes a /metrics endpoint with the following:
 *
 * Counters:
 *   - honorclaw_sessions_total         — total sessions created
 *   - honorclaw_llm_tokens_total       — total LLM tokens consumed
 *   - honorclaw_tool_calls_total       — total tool calls executed
 *   - honorclaw_manifest_denials_total — total manifest-denied actions
 *
 * Gauges:
 *   - honorclaw_sessions_active        — currently active sessions
 *
 * Histograms:
 *   - honorclaw_tool_latency_ms        — tool execution latency
 */

const register = new Registry();

// Collect default Node.js metrics (event loop, memory, etc.)
collectDefaultMetrics({ register });

// ── Counters ────────────────────────────────────────────────────────────

export const sessionsTotal = new Counter({
  name: 'honorclaw_sessions_total',
  help: 'Total number of sessions created',
  labelNames: ['workspace_id', 'agent_id', 'session_type', 'channel'] as const,
  registers: [register],
});

export const llmTokensTotal = new Counter({
  name: 'honorclaw_llm_tokens_total',
  help: 'Total LLM tokens consumed',
  labelNames: ['workspace_id', 'agent_id', 'model', 'token_type'] as const,
  registers: [register],
});

export const toolCallsTotal = new Counter({
  name: 'honorclaw_tool_calls_total',
  help: 'Total tool calls executed',
  labelNames: ['workspace_id', 'agent_id', 'tool_name', 'status'] as const,
  registers: [register],
});

export const manifestDenialsTotal = new Counter({
  name: 'honorclaw_manifest_denials_total',
  help: 'Total manifest-denied actions',
  labelNames: ['workspace_id', 'agent_id', 'denial_reason'] as const,
  registers: [register],
});

export const guardrailViolationsTotal = new Counter({
  name: 'honorclaw_guardrail_violations_total',
  help: 'Total guardrail violations by type',
  labelNames: ['workspace_id', 'agent_id', 'violation_type'] as const,
  registers: [register],
});

export const securityAlertsTotal = new Counter({
  name: 'honorclaw_security_alerts_total',
  help: 'Total security alerts dispatched',
  labelNames: ['workspace_id', 'alert_type'] as const,
  registers: [register],
});

// ── Gauges ──────────────────────────────────────────────────────────────

export const sessionsActive = new Gauge({
  name: 'honorclaw_sessions_active',
  help: 'Number of currently active sessions',
  labelNames: ['workspace_id', 'agent_id'] as const,
  registers: [register],
});

// ── Histograms ──────────────────────────────────────────────────────────

export const toolLatencyMs = new Histogram({
  name: 'honorclaw_tool_latency_ms',
  help: 'Tool execution latency in milliseconds',
  labelNames: ['workspace_id', 'agent_id', 'tool_name'] as const,
  buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  registers: [register],
});

// ── Route Registration ──────────────────────────────────────────────────

/**
 * Register the /metrics endpoint on a Fastify instance.
 */
export async function metricsRoutes(app: FastifyInstance) {
  const { requireWorkspace, requireRoles } = await import('../middleware/rbac.js');
  app.addHook('onRequest', requireWorkspace());
  app.addHook('onRequest', requireRoles('workspace_admin', 'auditor'));

  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', register.contentType);
    const metrics = await register.metrics();
    reply.send(metrics);
  });
}

// ── Helper Functions ────────────────────────────────────────────────────

export function recordSessionCreated(
  workspaceId: string,
  agentId: string,
  sessionType: string,
  channel: string,
): void {
  sessionsTotal.inc({ workspace_id: workspaceId, agent_id: agentId, session_type: sessionType, channel });
  sessionsActive.inc({ workspace_id: workspaceId, agent_id: agentId });
}

export function recordSessionEnded(workspaceId: string, agentId: string): void {
  sessionsActive.dec({ workspace_id: workspaceId, agent_id: agentId });
}

export function recordLlmTokens(
  workspaceId: string,
  agentId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): void {
  llmTokensTotal.inc({ workspace_id: workspaceId, agent_id: agentId, model, token_type: 'prompt' }, promptTokens);
  llmTokensTotal.inc({ workspace_id: workspaceId, agent_id: agentId, model, token_type: 'completion' }, completionTokens);
}

export function recordToolCall(
  workspaceId: string,
  agentId: string,
  toolName: string,
  status: 'success' | 'error' | 'denied',
  latencyMs: number,
): void {
  toolCallsTotal.inc({ workspace_id: workspaceId, agent_id: agentId, tool_name: toolName, status });
  toolLatencyMs.observe({ workspace_id: workspaceId, agent_id: agentId, tool_name: toolName }, latencyMs);
}

export function recordManifestDenial(
  workspaceId: string,
  agentId: string,
  reason: string,
): void {
  manifestDenialsTotal.inc({ workspace_id: workspaceId, agent_id: agentId, denial_reason: reason });
}
