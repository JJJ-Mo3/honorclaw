import { describe, it, expect, vi } from 'vitest';
import { resolveAgentSecrets, secretPathToEnvVar } from './secret-resolver.js';

/**
 * Create a mock pg.Pool that returns the given rows from query().
 */
function mockPool(rows: Array<{ path: string; encrypted_value: Buffer }>) {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as import('pg').Pool;
}

describe('resolveAgentSecrets', () => {
  it('returns nothing when allowedSecretPaths is empty (secure-by-default)', async () => {
    const db = mockPool([
      { path: 'integrations/slack/token', encrypted_value: Buffer.from('xoxb-123') },
    ]);

    const result = await resolveAgentSecrets(db, 'ws-1', []);

    expect(result).toEqual([]);
    // Should not even query the DB
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns secrets matching an exact path', async () => {
    const db = mockPool([
      { path: 'integrations/slack/token', encrypted_value: Buffer.from('xoxb-123') },
      { path: 'integrations/github/token', encrypted_value: Buffer.from('ghp-abc') },
    ]);

    const result = await resolveAgentSecrets(db, 'ws-1', ['integrations/slack/token']);

    expect(result).toEqual([
      { path: 'integrations/slack/token', value: 'xoxb-123' },
    ]);
  });

  it('matches single glob (*) within a segment', async () => {
    const db = mockPool([
      { path: 'integrations/slack/token', encrypted_value: Buffer.from('xoxb-123') },
      { path: 'integrations/slack/webhook', encrypted_value: Buffer.from('https://hooks.slack.com/xxx') },
      { path: 'integrations/github/token', encrypted_value: Buffer.from('ghp-abc') },
    ]);

    const result = await resolveAgentSecrets(db, 'ws-1', ['integrations/slack/*']);

    expect(result).toHaveLength(2);
    expect(result.map(s => s.path)).toEqual([
      'integrations/slack/token',
      'integrations/slack/webhook',
    ]);
  });

  it('does not match across segments with single glob (*)', async () => {
    const db = mockPool([
      { path: 'integrations/slack/nested/token', encrypted_value: Buffer.from('deep') },
    ]);

    const result = await resolveAgentSecrets(db, 'ws-1', ['integrations/slack/*']);

    expect(result).toEqual([]);
  });

  it('matches across segments with double glob (**)', async () => {
    const db = mockPool([
      { path: 'integrations/slack/token', encrypted_value: Buffer.from('xoxb-123') },
      { path: 'integrations/slack/nested/deep/secret', encrypted_value: Buffer.from('deep-val') },
      { path: 'integrations/github/token', encrypted_value: Buffer.from('ghp-abc') },
      { path: 'other/path', encrypted_value: Buffer.from('nope') },
    ]);

    const result = await resolveAgentSecrets(db, 'ws-1', ['integrations/**']);

    expect(result).toHaveLength(3);
    expect(result.map(s => s.path)).toEqual([
      'integrations/slack/token',
      'integrations/slack/nested/deep/secret',
      'integrations/github/token',
    ]);
  });

  it('supports multiple patterns', async () => {
    const db = mockPool([
      { path: 'integrations/slack/token', encrypted_value: Buffer.from('xoxb-123') },
      { path: 'db/primary/password', encrypted_value: Buffer.from('s3cret') },
      { path: 'other/unmatched', encrypted_value: Buffer.from('nope') },
    ]);

    const result = await resolveAgentSecrets(db, 'ws-1', [
      'integrations/slack/token',
      'db/*/password',
    ]);

    expect(result).toHaveLength(2);
    expect(result.map(s => s.path)).toEqual([
      'integrations/slack/token',
      'db/primary/password',
    ]);
  });

  it('excludes expired secrets via SQL filter (DB returns only non-expired rows)', async () => {
    // The SQL query filters out expired secrets, so the mock only returns non-expired ones.
    // This test verifies that the function trusts the DB filter and processes all returned rows.
    const db = mockPool([
      { path: 'integrations/slack/token', encrypted_value: Buffer.from('xoxb-valid') },
      // An expired secret would NOT appear here because the SQL WHERE clause excludes it.
    ]);

    const result = await resolveAgentSecrets(db, 'ws-1', ['integrations/**']);

    expect(result).toEqual([
      { path: 'integrations/slack/token', value: 'xoxb-valid' },
    ]);

    // Verify the query was called with the correct workspace ID
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('expires_at'),
      ['ws-1'],
    );
  });
});

describe('secretPathToEnvVar', () => {
  it('converts slashes to underscores and uppercases', () => {
    expect(secretPathToEnvVar('integrations/slack/credentials')).toBe(
      'INTEGRATIONS_SLACK_CREDENTIALS',
    );
  });

  it('converts dots to underscores', () => {
    expect(secretPathToEnvVar('config.database.url')).toBe('CONFIG_DATABASE_URL');
  });

  it('converts hyphens to underscores', () => {
    expect(secretPathToEnvVar('my-service/api-key')).toBe('MY_SERVICE_API_KEY');
  });

  it('handles mixed separators', () => {
    expect(secretPathToEnvVar('integrations/slack.bot-token')).toBe(
      'INTEGRATIONS_SLACK_BOT_TOKEN',
    );
  });

  it('handles simple single-segment path', () => {
    expect(secretPathToEnvVar('TOKEN')).toBe('TOKEN');
  });
});
