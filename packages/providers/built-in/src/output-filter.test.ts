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
});
