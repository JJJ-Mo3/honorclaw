import type { OutputFilterProvider, FilterFinding, FilterContext } from '@honorclaw/core';

// PII patterns compiled once at module load
const PII_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  { name: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED-SSN]' },
  { name: 'credit_card', regex: /\b(?:\d[ -]*?){13,19}\b/g, replacement: '[REDACTED-CC]' },
  { name: 'email', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[REDACTED-EMAIL]' },
  { name: 'us_phone', regex: /\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: '[REDACTED-PHONE]' },
  { name: 'ipv4', regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, replacement: '[REDACTED-IP]' },
];

// Credential patterns
const CREDENTIAL_PATTERNS: Array<{ name: string; regex: RegExp; replacement: string }> = [
  { name: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/g, replacement: '[REDACTED-AWS-ACCESS-KEY]' },
  { name: 'aws_secret_key', regex: /(?:aws_secret_access_key|AWS_SECRET)\s*[:=]\s*[A-Za-z0-9/+=]{40}/gi, replacement: '[REDACTED-AWS-SECRET]' },
  { name: 'openai_key', regex: /sk-[a-zA-Z0-9]{48,}/g, replacement: '[REDACTED-OPENAI-KEY]' },
  { name: 'anthropic_key', regex: /sk-ant-[a-zA-Z0-9\-_]{90,}/g, replacement: '[REDACTED-ANTHROPIC-KEY]' },
  { name: 'bearer_token', regex: /Bearer\s+[a-zA-Z0-9\-_.]{40,}/g, replacement: '[REDACTED-BEARER-TOKEN]' },
  { name: 'generic_api_key', regex: /(?:api[_-]?key|apikey|api[_-]?secret)\s*[:=]\s*\S{16,}/gi, replacement: '[REDACTED-API-KEY]' },
  { name: 'private_key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED-PRIVATE-KEY]' },
];

export class RegexOutputFilterProvider implements OutputFilterProvider {
  async filter(text: string, _context: FilterContext): Promise<{ filtered: string; findings: FilterFinding[] }> {
    let filtered = text;
    const findings: FilterFinding[] = [];

    // Check PII patterns
    for (const pattern of PII_PATTERNS) {
      let match: RegExpExecArray | null;
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      while ((match = regex.exec(text)) !== null) {
        findings.push({
          type: `pii:${pattern.name}`,
          pattern: pattern.name,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
      filtered = filtered.replace(new RegExp(pattern.regex.source, pattern.regex.flags), pattern.replacement);
    }

    // Check credential patterns
    for (const pattern of CREDENTIAL_PATTERNS) {
      let match: RegExpExecArray | null;
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      while ((match = regex.exec(text)) !== null) {
        findings.push({
          type: `credential:${pattern.name}`,
          pattern: pattern.name,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
      filtered = filtered.replace(new RegExp(pattern.regex.source, pattern.regex.flags), pattern.replacement);
    }

    return { filtered, findings };
  }
}
