import type { CapabilityManifest, ToolCapability } from '@honorclaw/core';

// ---------------------------------------------------------------------------
// Capability narrowing
// ---------------------------------------------------------------------------

/**
 * Compute the effective manifest for a delegated agent (B) based on the
 * delegating agent's (A) manifest.
 *
 * B's effective manifest = intersection(A.manifest, B.manifest)
 * B cannot gain capabilities A doesn't have.
 *
 * Enforced at delegation time.
 */
export function narrowCapabilities(
  parentManifest: CapabilityManifest,
  childManifest: CapabilityManifest,
): CapabilityManifest {
  // Tool intersection: only tools present in BOTH manifests
  const parentToolNames = new Set(parentManifest.tools.map(t => t.name));
  const narrowedTools: ToolCapability[] = childManifest.tools
    .filter(t => parentToolNames.has(t.name))
    .map(childTool => {
      const parentTool = parentManifest.tools.find(pt => pt.name === childTool.name)!;
      return narrowTool(parentTool, childTool);
    });

  // Egress policy narrowing:
  // If either parent or child uses block_all, the result is block_all (stricter).
  // For block_all: domains = intersection (only domains both allow).
  // For allow_all: domains = union (both parent and child blocks apply).
  const parentPolicy = parentManifest.egress.policy ?? 'allow_all';
  const childPolicy = childManifest.egress.policy ?? 'allow_all';
  let narrowedPolicy: 'allow_all' | 'block_all';
  let narrowedDomains: string[];

  if (parentPolicy === 'block_all' || childPolicy === 'block_all') {
    narrowedPolicy = 'block_all';
    if (parentPolicy === 'block_all' && childPolicy === 'block_all') {
      // Both are allowlists — intersection (only domains both permit)
      const parentSet = new Set(parentManifest.egress.domains);
      narrowedDomains = parentSet.size > 0
        ? childManifest.egress.domains.filter(d => parentSet.has(d))
        : [];
    } else if (parentPolicy === 'block_all') {
      // Parent is allowlist, child is blocklist — use parent's allowlist minus child's blocks
      narrowedDomains = parentManifest.egress.domains.filter(
        d => !childManifest.egress.domains.some(cd => cd === d),
      );
    } else {
      // Child is allowlist, parent is blocklist — use child's allowlist minus parent's blocks
      narrowedDomains = childManifest.egress.domains.filter(
        d => !parentManifest.egress.domains.some(pd => pd === d),
      );
    }
  } else {
    // Both allow_all — union of blocked domains (most restrictive)
    narrowedPolicy = 'allow_all';
    narrowedDomains = [
      ...new Set([...parentManifest.egress.domains, ...childManifest.egress.domains]),
    ];
  }

  // Session: use the stricter (smaller) limits
  const narrowedSession = {
    maxDurationMinutes: Math.min(
      parentManifest.session.maxDurationMinutes,
      childManifest.session.maxDurationMinutes,
    ),
    maxTokensPerSession: Math.min(
      parentManifest.session.maxTokensPerSession,
      childManifest.session.maxTokensPerSession,
    ),
    maxToolCallsPerSession: Math.min(
      parentManifest.session.maxToolCallsPerSession,
      childManifest.session.maxToolCallsPerSession,
    ),
    isolateMemory: parentManifest.session.isolateMemory || childManifest.session.isolateMemory,
  };

  // Budget: use the stricter limits (if set)
  const parentBudget = parentManifest.budget;
  const childBudget = childManifest.budget;
  const narrowedBudget = parentBudget || childBudget
    ? {
        maxTokensPerDay: minOptional(parentBudget?.maxTokensPerDay, childBudget?.maxTokensPerDay),
        maxCostPerDayUsd: minOptional(parentBudget?.maxCostPerDayUsd, childBudget?.maxCostPerDayUsd),
        maxCostPerSession: minOptional(parentBudget?.maxCostPerSession, childBudget?.maxCostPerSession),
        hardStopOnBudgetExceeded: (parentBudget?.hardStopOnBudgetExceeded ?? false) || (childBudget?.hardStopOnBudgetExceeded ?? false),
      }
    : undefined;

  // Input guardrails: strictest union
  const narrowedInputGuardrails = {
    injectionDetection: parentManifest.inputGuardrails.injectionDetection || childManifest.inputGuardrails.injectionDetection,
    blockToolDiscovery: parentManifest.inputGuardrails.blockToolDiscovery || childManifest.inputGuardrails.blockToolDiscovery,
    blockPromptExtraction: parentManifest.inputGuardrails.blockPromptExtraction || childManifest.inputGuardrails.blockPromptExtraction,
    blockedInputPatterns: [
      ...new Set([...parentManifest.inputGuardrails.blockedInputPatterns, ...childManifest.inputGuardrails.blockedInputPatterns]),
    ],
    allowedTopics: intersectArrays(parentManifest.inputGuardrails.allowedTopics, childManifest.inputGuardrails.allowedTopics),
    blockedTopics: [
      ...new Set([...parentManifest.inputGuardrails.blockedTopics, ...childManifest.inputGuardrails.blockedTopics]),
    ],
    piiFilterInputs: parentManifest.inputGuardrails.piiFilterInputs || childManifest.inputGuardrails.piiFilterInputs,
    maxMessageLength: Math.min(
      parentManifest.inputGuardrails.maxMessageLength,
      childManifest.inputGuardrails.maxMessageLength,
    ),
  };

  // Output filters: strictest union
  const narrowedOutputFilters = {
    piiDetection: parentManifest.outputFilters.piiDetection || childManifest.outputFilters.piiDetection,
    blockedOutputPatterns: [
      ...new Set([...parentManifest.outputFilters.blockedOutputPatterns, ...childManifest.outputFilters.blockedOutputPatterns]),
    ],
    contentPolicy: parentManifest.outputFilters.contentPolicy ?? childManifest.outputFilters.contentPolicy,
    maxResponseTokens: Math.min(
      parentManifest.outputFilters.maxResponseTokens,
      childManifest.outputFilters.maxResponseTokens,
    ),
  };

  return {
    agentId: childManifest.agentId,
    workspaceId: childManifest.workspaceId,
    version: childManifest.version,
    tools: narrowedTools,
    egress: {
      policy: narrowedPolicy,
      domains: narrowedDomains,
      maxResponseSizeBytes: Math.min(
        parentManifest.egress.maxResponseSizeBytes,
        childManifest.egress.maxResponseSizeBytes,
      ),
    },
    dataAccess: childManifest.dataAccess,
    inputGuardrails: narrowedInputGuardrails,
    outputFilters: narrowedOutputFilters,
    session: narrowedSession,
    budget: narrowedBudget,
    llmRateLimits: parentManifest.llmRateLimits ?? childManifest.llmRateLimits,
    approvalRules: [
      ...parentManifest.approvalRules,
      ...childManifest.approvalRules.filter(
        cr => !parentManifest.approvalRules.some(pr => pr.tool === cr.tool),
      ),
    ],
    allowedSecretPaths: parentManifest.allowedSecretPaths.filter(
      p => childManifest.allowedSecretPaths.includes(p),
    ),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function narrowTool(parent: ToolCapability, child: ToolCapability): ToolCapability {
  return {
    name: child.name,
    enabled: parent.enabled && child.enabled,
    parameters: child.parameters ?? parent.parameters,
    rateLimit: parent.rateLimit && child.rateLimit
      ? {
          maxCallsPerMinute: minOptional(parent.rateLimit.maxCallsPerMinute, child.rateLimit.maxCallsPerMinute),
          maxCallsPerSession: minOptional(parent.rateLimit.maxCallsPerSession, child.rateLimit.maxCallsPerSession),
        }
      : parent.rateLimit ?? child.rateLimit,
    requiresApproval: parent.requiresApproval || child.requiresApproval,
  };
}

function minOptional(a?: number, b?: number): number | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function intersectArrays(a: string[], b: string[]): string[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const setB = new Set(b);
  return a.filter(x => setB.has(x));
}
