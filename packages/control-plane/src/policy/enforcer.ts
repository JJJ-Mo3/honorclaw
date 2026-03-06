import type { CapabilityManifest, ToolCapability } from '@honorclaw/core';

export interface ToolCallRequest {
  toolName: string;
  parameters: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  ruleViolated?: string;
}

export function validateToolCall(
  request: ToolCallRequest,
  manifest: CapabilityManifest,
): ValidationResult {
  // a) Is tool in manifest and enabled?
  const tool = manifest.tools.find(t => t.name === request.toolName);
  if (!tool) {
    return { valid: false, reason: `Tool "${request.toolName}" not in manifest`, ruleViolated: 'tool_not_allowed' };
  }
  if (!tool.enabled) {
    return { valid: false, reason: `Tool "${request.toolName}" is disabled`, ruleViolated: 'tool_disabled' };
  }

  // c) Validate each parameter
  if (tool.parameters) {
    for (const [paramName, constraint] of Object.entries(tool.parameters)) {
      const value = request.parameters[paramName];
      if (value === undefined) continue;

      // Type check
      const expectedType = constraint.type;
      if (expectedType === 'string' && typeof value !== 'string') {
        return { valid: false, reason: `Parameter "${paramName}": expected string`, ruleViolated: 'type_mismatch' };
      }
      if (expectedType === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) {
        return { valid: false, reason: `Parameter "${paramName}": expected integer`, ruleViolated: 'type_mismatch' };
      }
      if (expectedType === 'boolean' && typeof value !== 'boolean') {
        return { valid: false, reason: `Parameter "${paramName}": expected boolean`, ruleViolated: 'type_mismatch' };
      }

      if (typeof value === 'string') {
        // max_length
        if (constraint.maxLength && value.length > constraint.maxLength) {
          return { valid: false, reason: `Parameter "${paramName}" exceeds max length`, ruleViolated: 'max_length' };
        }

        // allowed_values
        if (constraint.allowedValues && !constraint.allowedValues.includes(value)) {
          return { valid: false, reason: `Parameter "${paramName}": value not in allowed set`, ruleViolated: 'allowed_values' };
        }

        // allowed_patterns: reject if value matches NONE
        if (constraint.allowedPatterns?.length) {
          const matchesAny = constraint.allowedPatterns.some(p => {
            try { return new RegExp(p).test(value); } catch { return false; }
          });
          if (!matchesAny) {
            return { valid: false, reason: `Parameter "${paramName}": does not match any allowed pattern`, ruleViolated: 'allowed_patterns' };
          }
        }

        // blocked_patterns: reject if value matches ANY
        if (constraint.blockedPatterns?.length) {
          for (const pattern of constraint.blockedPatterns) {
            try {
              if (new RegExp(pattern, 'i').test(value)) {
                return { valid: false, reason: `Parameter "${paramName}": matches blocked pattern`, ruleViolated: 'blocked_patterns' };
              }
            } catch { /* skip invalid */ }
          }
        }
      }

      if (typeof value === 'number') {
        if (constraint.min !== undefined && value < constraint.min) {
          return { valid: false, reason: `Parameter "${paramName}": below minimum`, ruleViolated: 'min_value' };
        }
        if (constraint.max !== undefined && value > constraint.max) {
          return { valid: false, reason: `Parameter "${paramName}": above maximum`, ruleViolated: 'max_value' };
        }
      }
    }
  }

  return { valid: true };
}
