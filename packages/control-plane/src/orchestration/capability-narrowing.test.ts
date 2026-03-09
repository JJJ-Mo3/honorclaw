import { describe, it, expect } from 'vitest';
import { narrowCapabilities } from './capability-narrowing.js';
import type { CapabilityManifest } from '@honorclaw/core';

/** Helper to build a full CapabilityManifest with sensible defaults. */
function makeManifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    agentId: 'agent-1',
    workspaceId: 'ws-1',
    version: 1,
    tools: [],
    egress: {
      allowedDomains: [],
      blockedDomains: [],
      maxResponseSizeBytes: 10_485_760,
    },
    dataAccess: undefined,
    inputGuardrails: {
      injectionDetection: false,
      blockToolDiscovery: false,
      blockPromptExtraction: false,
      blockedInputPatterns: [],
      allowedTopics: [],
      blockedTopics: [],
      piiFilterInputs: false,
      maxMessageLength: 4000,
    },
    outputFilters: {
      piiDetection: false,
      blockedOutputPatterns: [],
      contentPolicy: undefined,
      maxResponseTokens: 4096,
    },
    session: {
      maxDurationMinutes: 120,
      maxTokensPerSession: 100_000,
      maxToolCallsPerSession: 500,
      isolateMemory: false,
    },
    budget: undefined,
    llmRateLimits: undefined,
    approvalRules: [],
    allowedSecretPaths: [],
    ...overrides,
  };
}

describe('narrowCapabilities', () => {
  // ── Tools ──────────────────────────────────────────────────────────────

  describe('tools intersection', () => {
    it('only keeps tools present in both parent and child manifests', () => {
      const parent = makeManifest({
        tools: [
          { name: 'read', enabled: true, requiresApproval: false },
          { name: 'write', enabled: true, requiresApproval: false },
          { name: 'delete', enabled: true, requiresApproval: false },
        ],
      });
      const child = makeManifest({
        agentId: 'child-agent',
        tools: [
          { name: 'read', enabled: true, requiresApproval: false },
          { name: 'execute', enabled: true, requiresApproval: false },
          { name: 'write', enabled: true, requiresApproval: false },
        ],
      });

      const result = narrowCapabilities(parent, child);

      const toolNames = result.tools.map(t => t.name);
      expect(toolNames).toContain('read');
      expect(toolNames).toContain('write');
      expect(toolNames).not.toContain('delete');
      expect(toolNames).not.toContain('execute');
      expect(result.tools).toHaveLength(2);
    });

    it('returns empty tools when there is no overlap', () => {
      const parent = makeManifest({
        tools: [{ name: 'alpha', enabled: true, requiresApproval: false }],
      });
      const child = makeManifest({
        agentId: 'child',
        tools: [{ name: 'beta', enabled: true, requiresApproval: false }],
      });

      const result = narrowCapabilities(parent, child);
      expect(result.tools).toHaveLength(0);
    });
  });

  // ── Tool Rate Limits ───────────────────────────────────────────────────

  describe('tool rate limits', () => {
    it('narrows tool rate limits to minimum of parent and child', () => {
      const parent = makeManifest({
        tools: [
          {
            name: 'search',
            enabled: true,
            requiresApproval: false,
            rateLimit: { maxCallsPerMinute: 10, maxCallsPerSession: 100 },
          },
        ],
      });
      const child = makeManifest({
        agentId: 'child',
        tools: [
          {
            name: 'search',
            enabled: true,
            requiresApproval: false,
            rateLimit: { maxCallsPerMinute: 5, maxCallsPerSession: 200 },
          },
        ],
      });

      const result = narrowCapabilities(parent, child);
      const tool = result.tools.find(t => t.name === 'search')!;

      expect(tool.rateLimit!.maxCallsPerMinute).toBe(5);
      expect(tool.rateLimit!.maxCallsPerSession).toBe(100);
    });

    it('uses the available rate limit when only one side specifies it', () => {
      const parent = makeManifest({
        tools: [
          {
            name: 'search',
            enabled: true,
            requiresApproval: false,
            rateLimit: { maxCallsPerMinute: 10 },
          },
        ],
      });
      const child = makeManifest({
        agentId: 'child',
        tools: [
          { name: 'search', enabled: true, requiresApproval: false },
        ],
      });

      const result = narrowCapabilities(parent, child);
      const tool = result.tools.find(t => t.name === 'search')!;

      expect(tool.rateLimit!.maxCallsPerMinute).toBe(10);
    });
  });

  // ── Egress ─────────────────────────────────────────────────────────────

  describe('egress allowed domains', () => {
    it('computes intersection of parent and child allowed domains', () => {
      const parent = makeManifest({
        egress: {
          allowedDomains: ['api.example.com', 'cdn.example.com', 'data.example.com'],
          blockedDomains: [],
          maxResponseSizeBytes: 10_000_000,
        },
      });
      const child = makeManifest({
        agentId: 'child',
        egress: {
          allowedDomains: ['api.example.com', 'logs.example.com', 'data.example.com'],
          blockedDomains: [],
          maxResponseSizeBytes: 5_000_000,
        },
      });

      const result = narrowCapabilities(parent, child);
      expect(result.egress.allowedDomains).toEqual(
        expect.arrayContaining(['api.example.com', 'data.example.com']),
      );
      expect(result.egress.allowedDomains).toHaveLength(2);
    });

    it('uses child domains when parent has no allowed domains', () => {
      const parent = makeManifest({
        egress: { allowedDomains: [], blockedDomains: [], maxResponseSizeBytes: 10_000_000 },
      });
      const child = makeManifest({
        agentId: 'child',
        egress: {
          allowedDomains: ['api.example.com'],
          blockedDomains: [],
          maxResponseSizeBytes: 5_000_000,
        },
      });

      const result = narrowCapabilities(parent, child);
      expect(result.egress.allowedDomains).toEqual(['api.example.com']);
    });
  });

  describe('egress blocked domains', () => {
    it('computes union of parent and child blocked domains', () => {
      const parent = makeManifest({
        egress: {
          allowedDomains: [],
          blockedDomains: ['evil.com', 'malware.org'],
          maxResponseSizeBytes: 10_000_000,
        },
      });
      const child = makeManifest({
        agentId: 'child',
        egress: {
          allowedDomains: [],
          blockedDomains: ['malware.org', 'phishing.net'],
          maxResponseSizeBytes: 5_000_000,
        },
      });

      const result = narrowCapabilities(parent, child);
      expect(result.egress.blockedDomains).toEqual(
        expect.arrayContaining(['evil.com', 'malware.org', 'phishing.net']),
      );
      // No duplicates
      expect(result.egress.blockedDomains).toHaveLength(3);
    });
  });

  // ── Session Limits ─────────────────────────────────────────────────────

  describe('session limits', () => {
    it('takes the minimum of parent and child for all numeric limits', () => {
      const parent = makeManifest({
        session: {
          maxDurationMinutes: 60,
          maxTokensPerSession: 50_000,
          maxToolCallsPerSession: 200,
          isolateMemory: false,
        },
      });
      const child = makeManifest({
        agentId: 'child',
        session: {
          maxDurationMinutes: 120,
          maxTokensPerSession: 30_000,
          maxToolCallsPerSession: 500,
          isolateMemory: false,
        },
      });

      const result = narrowCapabilities(parent, child);
      expect(result.session.maxDurationMinutes).toBe(60);
      expect(result.session.maxTokensPerSession).toBe(30_000);
      expect(result.session.maxToolCallsPerSession).toBe(200);
    });
  });

  // ── isolateMemory ──────────────────────────────────────────────────────

  describe('isolateMemory', () => {
    it('returns true if parent isolateMemory is true', () => {
      const parent = makeManifest({
        session: {
          maxDurationMinutes: 120,
          maxTokensPerSession: 100_000,
          maxToolCallsPerSession: 500,
          isolateMemory: true,
        },
      });
      const child = makeManifest({
        agentId: 'child',
        session: {
          maxDurationMinutes: 120,
          maxTokensPerSession: 100_000,
          maxToolCallsPerSession: 500,
          isolateMemory: false,
        },
      });

      const result = narrowCapabilities(parent, child);
      expect(result.session.isolateMemory).toBe(true);
    });

    it('returns true if child isolateMemory is true', () => {
      const parent = makeManifest({
        session: {
          maxDurationMinutes: 120,
          maxTokensPerSession: 100_000,
          maxToolCallsPerSession: 500,
          isolateMemory: false,
        },
      });
      const child = makeManifest({
        agentId: 'child',
        session: {
          maxDurationMinutes: 120,
          maxTokensPerSession: 100_000,
          maxToolCallsPerSession: 500,
          isolateMemory: true,
        },
      });

      const result = narrowCapabilities(parent, child);
      expect(result.session.isolateMemory).toBe(true);
    });

    it('returns false only if both parent and child are false', () => {
      const parent = makeManifest({
        session: {
          maxDurationMinutes: 120,
          maxTokensPerSession: 100_000,
          maxToolCallsPerSession: 500,
          isolateMemory: false,
        },
      });
      const child = makeManifest({
        agentId: 'child',
        session: {
          maxDurationMinutes: 120,
          maxTokensPerSession: 100_000,
          maxToolCallsPerSession: 500,
          isolateMemory: false,
        },
      });

      const result = narrowCapabilities(parent, child);
      expect(result.session.isolateMemory).toBe(false);
    });
  });

  // ── Budget ─────────────────────────────────────────────────────────────

  describe('budget', () => {
    it('takes the stricter (smaller) limits when both specify budgets', () => {
      const parent = makeManifest({
        budget: {
          maxTokensPerDay: 1_000_000,
          maxCostPerDayUsd: 50,
          maxCostPerSession: 10,
          hardStopOnBudgetExceeded: false,
        },
      });
      const child = makeManifest({
        agentId: 'child',
        budget: {
          maxTokensPerDay: 500_000,
          maxCostPerDayUsd: 100,
          maxCostPerSession: 5,
          hardStopOnBudgetExceeded: false,
        },
      });

      const result = narrowCapabilities(parent, child);
      expect(result.budget!.maxTokensPerDay).toBe(500_000);
      expect(result.budget!.maxCostPerDayUsd).toBe(50);
      expect(result.budget!.maxCostPerSession).toBe(5);
    });

    it('hardStopOnBudgetExceeded is OR of parent and child', () => {
      const parent = makeManifest({
        budget: { hardStopOnBudgetExceeded: true },
      });
      const child = makeManifest({
        agentId: 'child',
        budget: { hardStopOnBudgetExceeded: false },
      });

      const result = narrowCapabilities(parent, child);
      expect(result.budget!.hardStopOnBudgetExceeded).toBe(true);
    });

    it('returns undefined when neither specifies a budget', () => {
      const parent = makeManifest({ budget: undefined });
      const child = makeManifest({ agentId: 'child', budget: undefined });

      const result = narrowCapabilities(parent, child);
      expect(result.budget).toBeUndefined();
    });
  });

  // ── Approval Rules ─────────────────────────────────────────────────────

  describe('approval rules', () => {
    it('unions parent and child rules, with parent taking priority for same tool', () => {
      const parent = makeManifest({
        approvalRules: [
          { tool: 'deploy', condition: 'always', approvers: ['admin'], timeoutMinutes: 30 },
        ],
      });
      const child = makeManifest({
        agentId: 'child',
        approvalRules: [
          { tool: 'deploy', condition: 'if-production', approvers: ['dev'], timeoutMinutes: 15 },
          { tool: 'delete', condition: 'always', approvers: ['ops'], timeoutMinutes: 60 },
        ],
      });

      const result = narrowCapabilities(parent, child);

      // Parent's 'deploy' rule takes priority; child's 'deploy' is dropped
      const deployRules = result.approvalRules.filter(r => r.tool === 'deploy');
      expect(deployRules).toHaveLength(1);
      expect(deployRules[0]!.condition).toBe('always');
      expect(deployRules[0]!.approvers).toEqual(['admin']);

      // Child's non-overlapping 'delete' rule is included
      const deleteRules = result.approvalRules.filter(r => r.tool === 'delete');
      expect(deleteRules).toHaveLength(1);
      expect(deleteRules[0]!.approvers).toEqual(['ops']);
    });
  });

  // ── Allowed Secret Paths ───────────────────────────────────────────────

  describe('allowedSecretPaths', () => {
    it('computes intersection of parent and child secret paths', () => {
      const parent = makeManifest({
        allowedSecretPaths: ['/secrets/db', '/secrets/api', '/secrets/cache'],
      });
      const child = makeManifest({
        agentId: 'child',
        allowedSecretPaths: ['/secrets/api', '/secrets/cache', '/secrets/logs'],
      });

      const result = narrowCapabilities(parent, child);
      expect(result.allowedSecretPaths).toEqual(
        expect.arrayContaining(['/secrets/api', '/secrets/cache']),
      );
      expect(result.allowedSecretPaths).toHaveLength(2);
    });

    it('returns empty when there is no overlap', () => {
      const parent = makeManifest({ allowedSecretPaths: ['/secrets/a'] });
      const child = makeManifest({
        agentId: 'child',
        allowedSecretPaths: ['/secrets/b'],
      });

      const result = narrowCapabilities(parent, child);
      expect(result.allowedSecretPaths).toHaveLength(0);
    });
  });

  // ── Metadata ───────────────────────────────────────────────────────────

  describe('metadata preservation', () => {
    it('uses child agentId, workspaceId, and version', () => {
      const parent = makeManifest({ agentId: 'parent', workspaceId: 'ws-parent', version: 5 });
      const child = makeManifest({ agentId: 'child', workspaceId: 'ws-child', version: 3 });

      const result = narrowCapabilities(parent, child);
      expect(result.agentId).toBe('child');
      expect(result.workspaceId).toBe('ws-child');
      expect(result.version).toBe(3);
    });
  });
});
