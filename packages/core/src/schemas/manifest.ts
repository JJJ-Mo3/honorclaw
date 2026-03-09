import { z } from 'zod';

export const ParameterConstraintSchema = z.object({
  type: z.enum(['string', 'integer', 'boolean', 'array', 'object']),
  maxLength: z.number().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  allowedValues: z.array(z.string()).optional(),
  allowedPatterns: z.array(z.string()).optional(),
  blockedPatterns: z.array(z.string()).optional(),
  piiFilter: z.boolean().optional(),
});

export const RateLimitSchema = z.object({
  maxCallsPerMinute: z.number().positive().optional(),
  maxCallsPerSession: z.number().positive().optional(),
});

export const ToolCapabilitySchema = z.object({
  name: z.string(),
  source: z.string().optional(),
  enabled: z.boolean().default(true),
  parameters: z.record(ParameterConstraintSchema).optional(),
  rateLimit: RateLimitSchema.optional(),
  requiresApproval: z.boolean().default(false),
});

export const EgressConfigSchema = z.object({
  allowedDomains: z.array(z.string()).default([]),
  blockedDomains: z.array(z.string()).default([]),
  maxResponseSizeBytes: z.number().default(10_485_760),
});

export const InputGuardrailsSchema = z.object({
  injectionDetection: z.boolean().default(true),
  blockToolDiscovery: z.boolean().default(true),
  blockPromptExtraction: z.boolean().default(true),
  blockedInputPatterns: z.array(z.string()).default([]),
  allowedTopics: z.array(z.string()).default([]),
  blockedTopics: z.array(z.string()).default([]),
  piiFilterInputs: z.boolean().default(false),
  maxMessageLength: z.number().default(4000),
});

export const OutputFiltersSchema = z.object({
  piiDetection: z.boolean().default(true),
  blockedOutputPatterns: z.array(z.string()).default([]),
  contentPolicy: z.string().optional(),
  maxResponseTokens: z.number().default(4096),
});

export const SessionConfigSchema = z.object({
  maxDurationMinutes: z.number().default(120),
  maxTokensPerSession: z.number().default(100_000),
  maxToolCallsPerSession: z.number().default(500),
  isolateMemory: z.boolean().default(false),
});

export const BudgetConfigSchema = z.object({
  maxTokensPerDay: z.number().optional(),
  maxCostPerDayUsd: z.number().optional(),
  maxCostPerSession: z.number().optional(),
  hardStopOnBudgetExceeded: z.boolean().default(false),
});

export const LlmRateLimitsSchema = z.object({
  maxLlmCallsPerMinute: z.number().optional(),
  maxTokensPerMinute: z.number().optional(),
});

export const ApprovalRuleSchema = z.object({
  tool: z.string(),
  condition: z.string().default('always'),
  approvers: z.array(z.string()).default([]),
  timeoutMinutes: z.number().default(30),
});

export const DataAccessSchema = z.object({
  workspaceId: z.string(),
  allowedDatabases: z.array(z.string()).default([]),
  allowedStoragePrefixes: z.array(z.string()).default([]),
  piiColumnsBlocked: z.array(z.string()).default([]),
});

export const CapabilityManifestSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  version: z.number().int().positive(),
  tools: z.array(ToolCapabilitySchema).default([]),
  egress: EgressConfigSchema.default({}),
  dataAccess: DataAccessSchema.optional(),
  inputGuardrails: InputGuardrailsSchema.default({}),
  outputFilters: OutputFiltersSchema.default({}),
  session: SessionConfigSchema.default({}),
  budget: BudgetConfigSchema.optional(),
  llmRateLimits: LlmRateLimitsSchema.optional(),
  approvalRules: z.array(ApprovalRuleSchema).default([]),
  allowedSecretPaths: z.array(z.string()).default([]),
});

export type ParameterConstraint = z.infer<typeof ParameterConstraintSchema>;
export type RateLimit = z.infer<typeof RateLimitSchema>;
export type ToolCapability = z.infer<typeof ToolCapabilitySchema>;
export type EgressConfig = z.infer<typeof EgressConfigSchema>;
export type InputGuardrails = z.infer<typeof InputGuardrailsSchema>;
export type OutputFilters = z.infer<typeof OutputFiltersSchema>;
export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
export type LlmRateLimits = z.infer<typeof LlmRateLimitsSchema>;
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;
export type DataAccess = z.infer<typeof DataAccessSchema>;
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

export function validateManifest(raw: unknown): CapabilityManifest {
  return CapabilityManifestSchema.parse(raw);
}
