/**
 * HonorClaw Eval Framework types.
 *
 * Defines the YAML-based eval test format for evaluating agent behavior.
 */

// ── Eval Test Case ──────────────────────────────────────────────────────

/** A single eval test case containing one or more turns. */
export interface EvalTestCase {
  /** Unique test case identifier. */
  id?: string;
  /** Human-readable description of what this test validates. */
  description: string;
  /** Agent ID to run the eval against (can be overridden from defaults). */
  agentId?: string;
  /** Ordered list of conversation turns. */
  turns: EvalTurn[];
  /** Expectations to assert after all turns complete. */
  expectations: EvalExpectation[];
  /** Optional mock tool handlers for this test case. */
  mocks?: EvalMock[];
  /** Tags for filtering and grouping test cases. */
  tags?: string[];
  /** Maximum cost in USD for this test case (budget control). */
  maxCostUsd?: number;
  /** Timeout in seconds for the entire test case. */
  timeoutSeconds?: number;
}

// ── Eval Turn ───────────────────────────────────────────────────────────

/** A single conversation turn in an eval test case. */
export interface EvalTurn {
  /** The role sending this message. */
  role: 'user' | 'system';
  /** The message content. */
  content: string;
  /** Optional delay in milliseconds before sending this turn. */
  delayMs?: number;
}

// ── Eval Expectation ────────────────────────────────────────────────────

/** Assertion type for eval expectations. */
export type EvalExpectationType =
  | 'contains'
  | 'not_contains'
  | 'regex'
  | 'tool_called'
  | 'tool_not_called'
  | 'tool_called_with'
  | 'approval_requested'
  | 'cost_under'
  | 'latency_under_ms'
  | 'json_schema'
  | 'llm_rubric'
  | 'custom';

/** A single assertion to validate against agent output. */
export interface EvalExpectation {
  /** The type of assertion. */
  type: EvalExpectationType;
  /** The expected value (interpretation depends on type). */
  value?: string | number | Record<string, unknown>;
  /** Optional human-readable description of this expectation. */
  description?: string;
  /** Weight for scoring (default: 1.0). */
  weight?: number;
  /** Whether this expectation is critical (test fails immediately if not met). */
  critical?: boolean;
}

// ── Eval Mock ───────────────────────────────────────────────────────────

/** A mock tool handler for deterministic eval execution. */
export interface EvalMock {
  /** The tool name to mock. */
  toolName: string;
  /** Condition: only mock when parameters match this pattern. */
  when?: Record<string, unknown>;
  /** The mock response to return. */
  response: unknown;
  /** Optional delay in milliseconds to simulate tool latency. */
  delayMs?: number;
  /** If true, the mock should simulate an error. */
  simulateError?: boolean;
  /** Error message when simulateError is true. */
  errorMessage?: string;
}

// ── HonorClaw YAML Eval Format ──────────────────────────────────────────

/**
 * Top-level schema for HonorClaw YAML eval files.
 *
 * Example YAML:
 * ```yaml
 * version: "1"
 * metadata:
 *   name: "Customer Support Agent Eval"
 *   description: "Tests for the customer support agent"
 * defaults:
 *   agentId: "support-agent-v2"
 *   maxCostUsd: 0.50
 *   timeoutSeconds: 120
 * tests:
 *   - id: "refund-happy-path"
 *     description: "Agent should process a refund request"
 *     turns:
 *       - role: user
 *         content: "I'd like a refund for order #12345"
 *     expectations:
 *       - type: tool_called
 *         value: "lookup_order"
 *       - type: contains
 *         value: "refund"
 *     mocks:
 *       - toolName: lookup_order
 *         response:
 *           orderId: "12345"
 *           amount: 29.99
 *           status: "delivered"
 * ```
 */
export interface EvalFileSchema {
  /** Schema version. */
  version: string;
  /** File-level metadata. */
  metadata?: {
    name?: string;
    description?: string;
    author?: string;
  };
  /** Default values applied to all test cases. */
  defaults?: {
    agentId?: string;
    maxCostUsd?: number;
    timeoutSeconds?: number;
    tags?: string[];
  };
  /** The list of test cases. */
  tests: EvalTestCase[];
}

// ── Eval Result ─────────────────────────────────────────────────────────

/** Result of running a single eval expectation. */
export interface EvalExpectationResult {
  expectation: EvalExpectation;
  passed: boolean;
  actual?: unknown;
  message?: string;
}

/** Result of running a single eval test case. */
export interface EvalTestResult {
  testCase: EvalTestCase;
  passed: boolean;
  score: number;
  expectationResults: EvalExpectationResult[];
  output: string;
  durationMs: number;
  costUsd: number;
  tokenUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  error?: string;
}

/** Aggregated result of an entire eval run. */
export interface EvalRunResult {
  runId: string;
  startedAt: Date;
  completedAt: Date;
  testResults: EvalTestResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
    averageScore: number;
    totalCostUsd: number;
    totalDurationMs: number;
  };
}
