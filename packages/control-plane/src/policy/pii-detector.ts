export interface PIIFinding {
  type: string;
  start: number;
  end: number;
}

const PII_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  { name: 'SSN', regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED-SSN]' },
  { name: 'credit_card', regex: /\b(?:\d[ -]*?){13,19}\b/g, replacement: '[REDACTED-CC]' },
  { name: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[REDACTED-EMAIL]' },
  { name: 'us_phone', regex: /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: '[REDACTED-PHONE]' },
  { name: 'ipv4', regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, replacement: '[REDACTED-IP]' },
];

const CREDENTIAL_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  { name: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED-AWS-ACCESS-KEY]' },
  { name: 'openai_key', regex: /sk-[a-zA-Z0-9]{48,}/g, replacement: '[REDACTED-OPENAI-KEY]' },
  { name: 'anthropic_key', regex: /sk-ant-[a-zA-Z0-9\-_]{90,}/g, replacement: '[REDACTED-ANTHROPIC-KEY]' },
  { name: 'bearer_token', regex: /Bearer\s+[a-zA-Z0-9\-_.]{40,}/g, replacement: '[REDACTED-BEARER-TOKEN]' },
  { name: 'generic_api_key', regex: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*\S{16,}/gi, replacement: '[REDACTED-API-KEY]' },
  { name: 'private_key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED-PRIVATE-KEY]' },
];

export function detect(text: string): { hasPII: boolean; findings: PIIFinding[] } {
  const findings: PIIFinding[] = [];
  const allPatterns = [...PII_PATTERNS, ...CREDENTIAL_PATTERNS];

  for (const pattern of allPatterns) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      findings.push({ type: pattern.name, start: match.index, end: match.index + match[0].length });
    }
  }

  return { hasPII: findings.length > 0, findings };
}

export function redact(text: string): string {
  let result = text;
  const allPatterns = [...PII_PATTERNS, ...CREDENTIAL_PATTERNS];
  for (const pattern of allPatterns) {
    result = result.replace(new RegExp(pattern.regex.source, pattern.regex.flags), pattern.replacement);
  }
  return result;
}
