import crypto from 'node:crypto';
import type { CapabilityManifest } from '@honorclaw/core';
import { INJECTION_PATTERNS } from './injection-patterns.js';
import { TOOL_DISCOVERY_PATTERNS } from './tool-discovery-patterns.js';
import { PROMPT_EXTRACTION_PATTERNS } from './prompt-extraction-patterns.js';

export type GuardrailViolationType =
  | 'input_too_long'
  | 'injection_attempt'
  | 'tool_discovery_attempt'
  | 'prompt_extraction_attempt'
  | 'blocked_pattern'
  | 'off_topic'
  | 'blocked_topic';

export interface GuardrailViolation {
  type: GuardrailViolationType;
  rule: string;
  inputHash: string;
}

export interface GuardrailResult {
  allowed: boolean;
  violation?: GuardrailViolation;
  sanitizedMessage?: string;
}

interface GuardrailContext {
  userId: string;
  sessionId: string;
  workspaceId: string;
}

export function checkInput(
  message: string,
  manifest: CapabilityManifest,
  _context: GuardrailContext,
): GuardrailResult {
  const guardrails = manifest.inputGuardrails;
  const inputHash = crypto.createHash('sha256').update(message).digest('hex');

  // a) Max message length (always enforced)
  const maxLength = guardrails?.maxMessageLength ?? 4000;
  if (message.length > maxLength) {
    return { allowed: false, violation: { type: 'input_too_long', rule: 'max_message_length', inputHash } };
  }

  // b) Injection detection (default: enabled)
  if (guardrails?.injectionDetection !== false) {
    for (let i = 0; i < INJECTION_PATTERNS.length; i++) {
      if (INJECTION_PATTERNS[i]!.test(message)) {
        return { allowed: false, violation: { type: 'injection_attempt', rule: `injection:pattern_${i}`, inputHash } };
      }
    }
  }

  // b2) Tool discovery blocking (default: enabled)
  if (guardrails?.blockToolDiscovery !== false) {
    for (let i = 0; i < TOOL_DISCOVERY_PATTERNS.length; i++) {
      if (TOOL_DISCOVERY_PATTERNS[i]!.test(message)) {
        return { allowed: false, violation: { type: 'tool_discovery_attempt', rule: `tool_discovery:pattern_${i}`, inputHash } };
      }
    }
  }

  // b3) Prompt extraction blocking (default: enabled)
  if (guardrails?.blockPromptExtraction !== false) {
    for (let i = 0; i < PROMPT_EXTRACTION_PATTERNS.length; i++) {
      if (PROMPT_EXTRACTION_PATTERNS[i]!.test(message)) {
        return { allowed: false, violation: { type: 'prompt_extraction_attempt', rule: `prompt_extraction:pattern_${i}`, inputHash } };
      }
    }
  }

  // c) Blocked input patterns (from manifest)
  if (guardrails?.blockedInputPatterns?.length) {
    for (let i = 0; i < guardrails.blockedInputPatterns.length; i++) {
      try {
        const regex = new RegExp(guardrails.blockedInputPatterns[i]!, 'i');
        if (regex.test(message)) {
          return { allowed: false, violation: { type: 'blocked_pattern', rule: `blocked_input:${i}`, inputHash } };
        }
      } catch {
        // Skip invalid regex patterns
      }
    }
  }

  // d) Topic restriction
  if (guardrails?.allowedTopics?.length) {
    const matchesAnyAllowed = guardrails.allowedTopics.some(topic => {
      try { return new RegExp(topic, 'i').test(message); } catch { return false; }
    });
    if (!matchesAnyAllowed) {
      return { allowed: false, violation: { type: 'off_topic', rule: 'allowed_topics', inputHash } };
    }
  }

  if (guardrails?.blockedTopics?.length) {
    for (let i = 0; i < guardrails.blockedTopics.length; i++) {
      try {
        if (new RegExp(guardrails.blockedTopics[i]!, 'i').test(message)) {
          return { allowed: false, violation: { type: 'blocked_topic', rule: `blocked_topic:${i}`, inputHash } };
        }
      } catch { /* skip invalid regex */ }
    }
  }

  // e) Input PII filtering (sanitization, not rejection)
  let sanitizedMessage: string | undefined;
  if (guardrails?.piiFilterInputs) {
    sanitizedMessage = redactPII(message);
  }

  return { allowed: true, sanitizedMessage };
}

// Simple PII redaction patterns (same as OutputFilterProvider)
const PII_REDACT_PATTERNS: Array<{ regex: RegExp; replacement: string }> = [
  { regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED-SSN]' },
  { regex: /\b(?:\d[ -]*?){13,19}\b/g, replacement: '[REDACTED-CC]' },
  { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[REDACTED-EMAIL]' },
  { regex: /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: '[REDACTED-PHONE]' },
  { regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, replacement: '[REDACTED-IP]' },
];

function redactPII(text: string): string {
  let result = text;
  for (const pattern of PII_REDACT_PATTERNS) {
    result = result.replace(new RegExp(pattern.regex.source, pattern.regex.flags), pattern.replacement);
  }
  return result;
}
