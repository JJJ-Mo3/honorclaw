// Prompt injection detection patterns — compiled at module load
// Version tracked for updates
export const INJECTION_PATTERNS_VERSION = '1.0.0';

export const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:previous|all|prior)\s+instructions?/i,
  /you\s+are\s+now\s+(?:a|an|the)\b/i,
  /(?:new|updated?)\s+(?:system\s+)?(?:prompt|directive|instruction)/i,
  /forget\s+(?:everything|all|your\s+instructions)/i,
  /(?:override|bypass|disable)\s+(?:your\s+)?(?:safety|guardrails?|restrictions?|rules?)/i,
  /(?:jailbreak|DAN|do\s+anything\s+now)/i,
  /act\s+as\s+(?:if\s+)?you\s+(?:have\s+no|without\s+any)\s+restrictions/i,
  /pretend\s+you\s+(?:are|were|have\s+no)/i,
  /you\s+(?:must|should|will)\s+comply/i,
  /disregard\s+(?:your|all|any)\s+(?:previous\s+)?(?:instructions?|rules?|guidelines?)/i,
];
