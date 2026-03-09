import { describe, it, expect } from 'vitest';
import {
  CapabilityManifestSchema,
  validateManifest,
  ToolCapabilitySchema,
  EgressConfigSchema,
  InputGuardrailsSchema,
  OutputFiltersSchema,
  SessionConfigSchema,
  BudgetConfigSchema,
  ParameterConstraintSchema,
} from './manifest.js';

describe('CapabilityManifestSchema', () => {
  const validManifest = {
    agentId: 'agent-1',
    workspaceId: 'ws-1',
    version: 1,
    tools: [
      { name: 'web_search', enabled: true },
      { name: 'file_ops', enabled: false, requiresApproval: true },
    ],
    egress: { allowedDomains: ['*.google.com'], blockedDomains: [] },
    inputGuardrails: { injectionDetection: true, maxMessageLength: 2000 },
    outputFilters: { piiDetection: true },
    session: { maxDurationMinutes: 60 },
  };

  it('validates a complete manifest', () => {
    const result = CapabilityManifestSchema.safeParse(validManifest);
    expect(result.success).toBe(true);
  });

  it('rejects manifest without agentId', () => {
    const noAgent = { ...validManifest };
    delete (noAgent as Record<string, unknown>).agentId;
    const result = CapabilityManifestSchema.safeParse(noAgent);
    expect(result.success).toBe(false);
  });

  it('rejects manifest without workspaceId', () => {
    const noWs = { ...validManifest };
    delete (noWs as Record<string, unknown>).workspaceId;
    const result = CapabilityManifestSchema.safeParse(noWs);
    expect(result.success).toBe(false);
  });

  it('rejects manifest with non-positive version', () => {
    const result = CapabilityManifestSchema.safeParse({ ...validManifest, version: 0 });
    expect(result.success).toBe(false);
  });

  it('applies defaults for optional sections', () => {
    const minimal = { agentId: 'a', workspaceId: 'w', version: 1 };
    const result = CapabilityManifestSchema.parse(minimal);
    expect(result.tools).toEqual([]);
    expect(result.egress.allowedDomains).toEqual([]);
    expect(result.inputGuardrails.injectionDetection).toBe(true);
    expect(result.inputGuardrails.maxMessageLength).toBe(4000);
    expect(result.outputFilters.piiDetection).toBe(true);
    expect(result.session.maxDurationMinutes).toBe(120);
    expect(result.session.maxToolCallsPerSession).toBe(500);
    expect(result.approvalRules).toEqual([]);
  });

  it('validates approval rules', () => {
    const withRules = {
      ...validManifest,
      approvalRules: [
        { tool: 'file_ops', condition: 'always', timeoutMinutes: 15 },
      ],
    };
    const result = CapabilityManifestSchema.parse(withRules);
    expect(result.approvalRules).toHaveLength(1);
    expect(result.approvalRules[0]!.tool).toBe('file_ops');
  });
});

describe('validateManifest', () => {
  it('returns parsed manifest for valid input', () => {
    const result = validateManifest({
      agentId: 'a', workspaceId: 'w', version: 1,
    });
    expect(result.agentId).toBe('a');
    expect(result.tools).toEqual([]);
  });

  it('throws for invalid input', () => {
    expect(() => validateManifest({})).toThrow();
    expect(() => validateManifest({ agentId: 'a' })).toThrow();
    expect(() => validateManifest(null)).toThrow();
  });
});

describe('ToolCapabilitySchema', () => {
  it('validates basic tool', () => {
    const result = ToolCapabilitySchema.parse({ name: 'web_search' });
    expect(result.name).toBe('web_search');
    expect(result.enabled).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it('validates tool with parameters', () => {
    const tool = {
      name: 'file_ops',
      parameters: {
        path: { type: 'string', maxLength: 255, allowedPatterns: ['^/workspace/'] },
        operation: { type: 'string', allowedValues: ['read', 'write'] },
      },
      rateLimit: { maxCallsPerMinute: 10, maxCallsPerSession: 100 },
      requiresApproval: true,
    };
    const result = ToolCapabilitySchema.parse(tool);
    expect(result.requiresApproval).toBe(true);
    expect(result.rateLimit?.maxCallsPerMinute).toBe(10);
  });

  it('rejects tool without name', () => {
    const result = ToolCapabilitySchema.safeParse({ enabled: true });
    expect(result.success).toBe(false);
  });
});

describe('ParameterConstraintSchema', () => {
  it('validates string parameter', () => {
    const result = ParameterConstraintSchema.parse({
      type: 'string', maxLength: 100, blockedPatterns: ['DROP TABLE'],
    });
    expect(result.type).toBe('string');
    expect(result.blockedPatterns).toEqual(['DROP TABLE']);
  });

  it('validates integer parameter', () => {
    const result = ParameterConstraintSchema.parse({
      type: 'integer', min: 1, max: 100,
    });
    expect(result.min).toBe(1);
    expect(result.max).toBe(100);
  });

  it('rejects unknown type', () => {
    const result = ParameterConstraintSchema.safeParse({ type: 'unknown' });
    expect(result.success).toBe(false);
  });
});

describe('EgressConfigSchema', () => {
  it('applies defaults', () => {
    const result = EgressConfigSchema.parse({});
    expect(result.allowedDomains).toEqual([]);
    expect(result.blockedDomains).toEqual([]);
    expect(result.maxResponseSizeBytes).toBe(10_485_760);
  });

  it('validates custom config', () => {
    const result = EgressConfigSchema.parse({
      allowedDomains: ['api.example.com'],
      blockedDomains: ['*.internal.corp'],
      maxResponseSizeBytes: 5_242_880,
    });
    expect(result.allowedDomains).toEqual(['api.example.com']);
    expect(result.maxResponseSizeBytes).toBe(5_242_880);
  });
});

describe('InputGuardrailsSchema', () => {
  it('applies defaults', () => {
    const result = InputGuardrailsSchema.parse({});
    expect(result.injectionDetection).toBe(true);
    expect(result.blockToolDiscovery).toBe(true);
    expect(result.blockPromptExtraction).toBe(true);
    expect(result.maxMessageLength).toBe(4000);
    expect(result.piiFilterInputs).toBe(false);
  });

  it('validates custom guardrails', () => {
    const result = InputGuardrailsSchema.parse({
      injectionDetection: false,
      maxMessageLength: 1000,
      blockedTopics: ['competitor pricing'],
      blockedInputPatterns: ['DROP TABLE'],
    });
    expect(result.injectionDetection).toBe(false);
    expect(result.maxMessageLength).toBe(1000);
    expect(result.blockedTopics).toEqual(['competitor pricing']);
  });
});

describe('OutputFiltersSchema', () => {
  it('applies defaults', () => {
    const result = OutputFiltersSchema.parse({});
    expect(result.piiDetection).toBe(true);
    expect(result.maxResponseTokens).toBe(4096);
    expect(result.blockedOutputPatterns).toEqual([]);
  });
});

describe('SessionConfigSchema', () => {
  it('applies defaults', () => {
    const result = SessionConfigSchema.parse({});
    expect(result.maxDurationMinutes).toBe(120);
    expect(result.maxTokensPerSession).toBe(100_000);
    expect(result.maxToolCallsPerSession).toBe(500);
  });
});

describe('BudgetConfigSchema', () => {
  it('validates budget config', () => {
    const result = BudgetConfigSchema.parse({
      maxTokensPerDay: 500_000,
      maxCostPerDayUsd: 10.0,
      hardStopOnBudgetExceeded: true,
    });
    expect(result.maxTokensPerDay).toBe(500_000);
    expect(result.hardStopOnBudgetExceeded).toBe(true);
  });

  it('applies defaults', () => {
    const result = BudgetConfigSchema.parse({});
    expect(result.hardStopOnBudgetExceeded).toBe(false);
  });
});
