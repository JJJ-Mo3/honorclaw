import { describe, it, expect } from 'vitest';
import { RegexOutputFilterProvider } from './output-filter.js';
import type { FilterContext } from '@honorclaw/core';

function makeContext(overrides: Partial<FilterContext> = {}): FilterContext {
  return {
    workspaceId: 'test-ws',
    agentId: 'test-agent',
    ...overrides,
  };
}

describe('RegexOutputFilterProvider', () => {
  const provider = new RegexOutputFilterProvider();

  describe('blockedOutputPatterns', () => {
    it('redacts matching content with [BLOCKED]', async () => {
      const context = makeContext({
        blockedOutputPatterns: ['secret\\s+project', 'classified'],
      });
      const text = 'The secret project codename is classified information.';
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).toContain('[BLOCKED]');
      expect(filtered).not.toContain('secret project');
      expect(filtered).not.toContain('classified');
      const blockedFindings = findings.filter(f => f.type === 'blocked_pattern');
      expect(blockedFindings.length).toBeGreaterThanOrEqual(2);
    });

    it('skips invalid regex patterns gracefully', async () => {
      const context = makeContext({
        blockedOutputPatterns: ['[invalid regex', 'valid-pattern'],
      });
      const text = 'This has a valid-pattern inside.';
      const { filtered, findings } = await provider.filter(text, context);

      // The valid pattern should still be applied
      expect(filtered).toContain('[BLOCKED]');
      expect(filtered).not.toContain('valid-pattern');
      // The invalid regex should not cause an error
      const blockedFindings = findings.filter(f => f.type === 'blocked_pattern');
      expect(blockedFindings.length).toBeGreaterThanOrEqual(1);
    });

    it('does not block when blockedOutputPatterns is empty', async () => {
      const context = makeContext({ blockedOutputPatterns: [] });
      const text = 'Nothing should be blocked here.';
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).toBe(text);
      const blockedFindings = findings.filter(f => f.type === 'blocked_pattern');
      expect(blockedFindings).toHaveLength(0);
    });

    it('does not block when blockedOutputPatterns is undefined', async () => {
      const context = makeContext();
      const text = 'Nothing should be blocked here either.';
      const { findings } = await provider.filter(text, context);

      // Only PII/credential findings could appear, no blocked_pattern findings
      const blockedFindings = findings.filter(f => f.type === 'blocked_pattern');
      expect(blockedFindings).toHaveLength(0);
    });
  });

  describe('maxResponseTokens', () => {
    it('truncates long responses that exceed the token limit', async () => {
      const context = makeContext({ maxResponseTokens: 10 });
      // 10 tokens * 4 chars = 40 chars max
      const text = 'A'.repeat(100);
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered.length).toBeLessThan(100);
      expect(filtered).toContain('[Response truncated: exceeded token limit]');
      // The content portion should be 40 chars
      const contentPortion = filtered.split('\n[Response truncated: exceeded token limit]')[0];
      expect(contentPortion).toHaveLength(40);

      const truncationFindings = findings.filter(f => f.type === 'token_limit_exceeded');
      expect(truncationFindings).toHaveLength(1);
      expect(truncationFindings[0]!.start).toBe(40);
      expect(truncationFindings[0]!.end).toBe(100);
    });

    it('does not truncate responses within the token limit', async () => {
      const context = makeContext({ maxResponseTokens: 100 });
      // 100 tokens * 4 = 400 chars; text is only 50 chars
      const text = 'A'.repeat(50);
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).toBe(text);
      const truncationFindings = findings.filter(f => f.type === 'token_limit_exceeded');
      expect(truncationFindings).toHaveLength(0);
    });

    it('does not truncate when maxResponseTokens is undefined', async () => {
      const context = makeContext();
      const text = 'A'.repeat(10000);
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).toBe(text);
      const truncationFindings = findings.filter(f => f.type === 'token_limit_exceeded');
      expect(truncationFindings).toHaveLength(0);
    });
  });

  describe('PII detection alongside new features', () => {
    it('redacts PII and applies blocked patterns together', async () => {
      const context = makeContext({
        blockedOutputPatterns: ['internal-code-\\d+'],
      });
      const text = 'Contact user@example.com about internal-code-42 and SSN 123-45-6789.';
      const { filtered, findings } = await provider.filter(text, context);

      // PII redaction
      expect(filtered).not.toContain('user@example.com');
      expect(filtered).toContain('[REDACTED-EMAIL]');
      expect(filtered).not.toContain('123-45-6789');
      expect(filtered).toContain('[REDACTED-SSN]');

      // Blocked pattern
      expect(filtered).not.toContain('internal-code-42');
      expect(filtered).toContain('[BLOCKED]');

      // Verify findings include both PII and blocked pattern types
      const piiFindings = findings.filter(f => f.type.startsWith('pii:'));
      const blockedFindings = findings.filter(f => f.type === 'blocked_pattern');
      expect(piiFindings.length).toBeGreaterThanOrEqual(2);
      expect(blockedFindings.length).toBeGreaterThanOrEqual(1);
    });

    it('redacts PII and enforces token limit together', async () => {
      const context = makeContext({ maxResponseTokens: 20 });
      // 20 tokens * 4 = 80 chars max
      const text = 'My email is user@example.com. ' + 'A'.repeat(200);
      const { filtered, findings } = await provider.filter(text, context);

      // PII should be redacted
      expect(filtered).not.toContain('user@example.com');
      // Token limit should be enforced
      expect(filtered).toContain('[Response truncated: exceeded token limit]');

      const piiFindings = findings.filter(f => f.type.startsWith('pii:'));
      const truncationFindings = findings.filter(f => f.type === 'token_limit_exceeded');
      expect(piiFindings.length).toBeGreaterThanOrEqual(1);
      expect(truncationFindings).toHaveLength(1);
    });
  });

  // ── PII Pattern Detection ────────────────────────────────────────────

  describe('PII pattern detection', () => {
    it('detects and redacts SSN patterns', async () => {
      const context = makeContext();
      const text = 'SSN: 123-45-6789 and another 987-65-4321.';
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).not.toContain('123-45-6789');
      expect(filtered).not.toContain('987-65-4321');
      expect(filtered).toContain('[REDACTED-SSN]');
      const ssnFindings = findings.filter(f => f.type === 'pii:ssn');
      expect(ssnFindings).toHaveLength(2);
    });

    it('detects and redacts credit card numbers', async () => {
      const context = makeContext();
      const text = 'Card: 4111 1111 1111 1111 is on file.';
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).not.toContain('4111 1111 1111 1111');
      expect(filtered).toContain('[REDACTED-CC]');
      const ccFindings = findings.filter(f => f.type === 'pii:credit_card');
      expect(ccFindings.length).toBeGreaterThanOrEqual(1);
    });

    it('detects and redacts email addresses', async () => {
      const context = makeContext();
      const text = 'Reach out to alice@company.io or bob.smith@example.com for details.';
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).not.toContain('alice@company.io');
      expect(filtered).not.toContain('bob.smith@example.com');
      expect(filtered).toContain('[REDACTED-EMAIL]');
      const emailFindings = findings.filter(f => f.type === 'pii:email');
      expect(emailFindings).toHaveLength(2);
    });

    it('detects and redacts US phone numbers', async () => {
      const context = makeContext();
      const text = 'Call us at 555-123-4567 or +1-800-555-0199.';
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).not.toContain('555-123-4567');
      expect(filtered).not.toContain('+1-800-555-0199');
      expect(filtered).toContain('[REDACTED-PHONE]');
      const phoneFindings = findings.filter(f => f.type === 'pii:us_phone');
      expect(phoneFindings.length).toBeGreaterThanOrEqual(2);
    });

    it('detects and redacts IPv4 addresses', async () => {
      const context = makeContext();
      const text = 'Server is at 192.168.1.100 and backup at 10.0.0.1.';
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).not.toContain('192.168.1.100');
      expect(filtered).not.toContain('10.0.0.1');
      expect(filtered).toContain('[REDACTED-IP]');
      const ipFindings = findings.filter(f => f.type === 'pii:ipv4');
      expect(ipFindings).toHaveLength(2);
    });
  });

  // ── Credential Pattern Detection ──────────────────────────────────────

  describe('credential pattern detection', () => {
    it('detects and redacts AWS access keys', async () => {
      const context = makeContext();
      const text = 'AWS key: AKIAIOSFODNN7EXAMPLE is exposed.';
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(filtered).toContain('[REDACTED-AWS-ACCESS-KEY]');
      const awsFindings = findings.filter(f => f.type === 'credential:aws_access_key');
      expect(awsFindings).toHaveLength(1);
    });

    it('detects and redacts OpenAI API keys', async () => {
      const context = makeContext();
      const fakeKey = 'sk-' + 'a'.repeat(48);
      const text = `Use this key: ${fakeKey} for access.`;
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).not.toContain(fakeKey);
      expect(filtered).toContain('[REDACTED-OPENAI-KEY]');
      const openaiFindings = findings.filter(f => f.type === 'credential:openai_key');
      expect(openaiFindings).toHaveLength(1);
    });

    it('detects and redacts bearer tokens', async () => {
      const context = makeContext();
      const token = 'Bearer ' + 'x'.repeat(50);
      const text = `Authorization: ${token}`;
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).not.toContain(token);
      expect(filtered).toContain('[REDACTED-BEARER-TOKEN]');
      const bearerFindings = findings.filter(f => f.type === 'credential:bearer_token');
      expect(bearerFindings).toHaveLength(1);
    });

    it('detects and redacts private keys', async () => {
      const context = makeContext();
      const text = [
        'Here is the key:',
        '-----BEGIN RSA PRIVATE KEY-----',
        'MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF3PBBMKb',
        '-----END RSA PRIVATE KEY-----',
        'Do not share it.',
      ].join('\n');
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
      expect(filtered).not.toContain('-----END RSA PRIVATE KEY-----');
      expect(filtered).toContain('[REDACTED-PRIVATE-KEY]');
      const pkFindings = findings.filter(f => f.type === 'credential:private_key');
      expect(pkFindings).toHaveLength(1);
    });

    it('detects and redacts generic API keys', async () => {
      const context = makeContext();
      const text = 'api_key=abcdefghijklmnopqrstuvwxyz1234567890 is set.';
      const { filtered, findings } = await provider.filter(text, context);

      expect(filtered).not.toContain('abcdefghijklmnopqrstuvwxyz1234567890');
      expect(filtered).toContain('[REDACTED-API-KEY]');
      const apiKeyFindings = findings.filter(f => f.type === 'credential:generic_api_key');
      expect(apiKeyFindings).toHaveLength(1);
    });
  });

  // ── Combined: PII + Blocked Patterns + Token Limit ─────────────────────

  describe('combined PII + blocked patterns + token limit', () => {
    it('applies all three filter layers together', async () => {
      const context = makeContext({
        blockedOutputPatterns: ['PROJECT-ALPHA'],
        maxResponseTokens: 50,
      });
      // 50 tokens * 4 = 200 chars max
      const text =
        'Contact admin@corp.com about PROJECT-ALPHA. ' +
        'SSN is 111-22-3333. ' +
        'A'.repeat(300);

      const { filtered, findings } = await provider.filter(text, context);

      // PII redacted
      expect(filtered).not.toContain('admin@corp.com');
      expect(filtered).not.toContain('111-22-3333');
      expect(filtered).toContain('[REDACTED-EMAIL]');
      expect(filtered).toContain('[REDACTED-SSN]');

      // Blocked pattern redacted
      expect(filtered).not.toContain('PROJECT-ALPHA');
      expect(filtered).toContain('[BLOCKED]');

      // Token limit enforced
      expect(filtered).toContain('[Response truncated: exceeded token limit]');

      // All three finding types present
      const piiFindings = findings.filter(f => f.type.startsWith('pii:'));
      const blockedFindings = findings.filter(f => f.type === 'blocked_pattern');
      const truncFindings = findings.filter(f => f.type === 'token_limit_exceeded');

      expect(piiFindings.length).toBeGreaterThanOrEqual(2);
      expect(blockedFindings.length).toBeGreaterThanOrEqual(1);
      expect(truncFindings).toHaveLength(1);
    });
  });
});
