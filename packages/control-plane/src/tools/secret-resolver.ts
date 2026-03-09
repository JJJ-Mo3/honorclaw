import type { Pool } from 'pg';

export interface ResolvedSecret {
  path: string;
  value: string;
}

/**
 * Resolve secrets that an agent is allowed to access based on its manifest's allowedSecretPaths.
 * Uses glob-style matching (convert * to regex).
 * Empty allowedSecretPaths → returns nothing (secure-by-default).
 */
export async function resolveAgentSecrets(
  db: Pool,
  workspaceId: string,
  allowedSecretPaths: string[],
): Promise<ResolvedSecret[]> {
  if (!allowedSecretPaths.length) return [];

  // Load all workspace secrets
  const result = await db.query(
    `SELECT path, encrypted_value FROM secrets
     WHERE workspace_id = $1
       AND (expires_at IS NULL OR expires_at > now())`,
    [workspaceId],
  );

  const secrets: ResolvedSecret[] = [];

  for (const row of result.rows) {
    const path = row.path as string;
    if (matchesAnyPattern(path, allowedSecretPaths)) {
      // encrypted_value is stored as bytea; in practice, the decryption
      // would use pgcrypto or an application-level key. For now, we
      // assume the column stores the plaintext value (encrypted at rest
      // by Postgres TDE or the secrets service layer).
      secrets.push({ path, value: row.encrypted_value.toString('utf-8') });
    }
  }

  return secrets;
}

/**
 * Convert a secret path to an environment variable name.
 * integrations/slack/credentials → INTEGRATIONS_SLACK_CREDENTIALS
 */
export function secretPathToEnvVar(path: string): string {
  return path.replace(/[/.-]/g, '_').toUpperCase();
}

/**
 * Check if a path matches any of the given glob patterns.
 * Supports * (any segment) and ** (any depth).
 */
function matchesAnyPattern(path: string, patterns: string[]): boolean {
  return patterns.some(pattern => matchGlob(pattern, path));
}

function matchGlob(pattern: string, value: string): boolean {
  // Exact match fast path
  if (pattern === value) return true;

  // Convert glob to regex:
  // - escape regex special chars (except * and ?)
  // - ** → match anything (including /)
  // - * → match anything except /
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§DOUBLESTAR§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLESTAR§/g, '.*')
    .replace(/\?/g, '[^/]');

  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(value);
}
