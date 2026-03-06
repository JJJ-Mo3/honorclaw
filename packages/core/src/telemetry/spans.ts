import { trace, type Span, SpanStatusCode, type Tracer } from '@opentelemetry/api';

/** Default tracer name for HonorClaw spans. */
const TRACER_NAME = 'honorclaw';

function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

// ── Span Attribute Constants ────────────────────────────────────────────

export const HonorClawAttributes = {
  // Session attributes
  SESSION_ID: 'honorclaw.session.id',
  SESSION_TYPE: 'honorclaw.session.type',
  WORKSPACE_ID: 'honorclaw.workspace.id',
  AGENT_ID: 'honorclaw.agent.id',
  USER_ID: 'honorclaw.user.id',

  // Tool attributes
  TOOL_NAME: 'honorclaw.tool.name',
  TOOL_SOURCE: 'honorclaw.tool.source',
  TOOL_APPROVED: 'honorclaw.tool.approved',
  TOOL_PARAMETERS: 'honorclaw.tool.parameters',

  // LLM attributes
  LLM_MODEL: 'honorclaw.llm.model',
  LLM_PROVIDER: 'honorclaw.llm.provider',
  LLM_PROMPT_TOKENS: 'honorclaw.llm.prompt_tokens',
  LLM_COMPLETION_TOKENS: 'honorclaw.llm.completion_tokens',
  LLM_TOTAL_TOKENS: 'honorclaw.llm.total_tokens',
  LLM_COST_USD: 'honorclaw.llm.cost_usd',

  // Guardrail attributes
  GUARDRAIL_TYPE: 'honorclaw.guardrail.type',
  GUARDRAIL_RESULT: 'honorclaw.guardrail.result',
  GUARDRAIL_DENIED_REASON: 'honorclaw.guardrail.denied_reason',
} as const;

// ── Span Helpers ────────────────────────────────────────────────────────

export interface SessionSpanOptions {
  sessionId: string;
  sessionType: string;
  workspaceId: string;
  agentId: string;
  userId?: string;
}

/**
 * Start a root span for an agent session.
 */
export function startSessionSpan(
  options: SessionSpanOptions,
  fn: (span: Span) => Promise<void>,
): Promise<void> {
  return getTracer().startActiveSpan('session', async (span: Span) => {
    span.setAttributes({
      [HonorClawAttributes.SESSION_ID]: options.sessionId,
      [HonorClawAttributes.SESSION_TYPE]: options.sessionType,
      [HonorClawAttributes.WORKSPACE_ID]: options.workspaceId,
      [HonorClawAttributes.AGENT_ID]: options.agentId,
      ...(options.userId ? { [HonorClawAttributes.USER_ID]: options.userId } : {}),
    });

    try {
      await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

export interface ToolSpanOptions {
  toolName: string;
  source?: string;
  parameters?: Record<string, unknown>;
  approved?: boolean;
}

/**
 * Start a child span for a tool execution.
 */
export function startToolSpan(
  options: ToolSpanOptions,
  fn: (span: Span) => Promise<void>,
): Promise<void> {
  return getTracer().startActiveSpan(`tool:${options.toolName}`, async (span: Span) => {
    span.setAttributes({
      [HonorClawAttributes.TOOL_NAME]: options.toolName,
      ...(options.source ? { [HonorClawAttributes.TOOL_SOURCE]: options.source } : {}),
      ...(options.parameters ? { [HonorClawAttributes.TOOL_PARAMETERS]: JSON.stringify(options.parameters) } : {}),
      ...(options.approved != null ? { [HonorClawAttributes.TOOL_APPROVED]: options.approved } : {}),
    });

    try {
      await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

export interface LlmSpanOptions {
  model: string;
  provider: string;
}

/**
 * Start a child span for an LLM API call.
 *
 * Token counts and cost should be set on the span after the call completes
 * using `span.setAttributes(...)`.
 */
export function startLlmSpan(
  options: LlmSpanOptions,
  fn: (span: Span) => Promise<void>,
): Promise<void> {
  return getTracer().startActiveSpan(`llm:${options.model}`, async (span: Span) => {
    span.setAttributes({
      [HonorClawAttributes.LLM_MODEL]: options.model,
      [HonorClawAttributes.LLM_PROVIDER]: options.provider,
    });

    try {
      await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

export interface GuardrailSpanOptions {
  type: string;
}

/**
 * Start a child span for a guardrail check.
 */
export function startGuardrailSpan(
  options: GuardrailSpanOptions,
  fn: (span: Span) => Promise<void>,
): Promise<void> {
  return getTracer().startActiveSpan(`guardrail:${options.type}`, async (span: Span) => {
    span.setAttributes({
      [HonorClawAttributes.GUARDRAIL_TYPE]: options.type,
    });

    try {
      await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}
