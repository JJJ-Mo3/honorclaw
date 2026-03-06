import crypto from 'node:crypto';
import { Command } from 'commander';

/**
 * Register key rotation CLI commands with full audit trail.
 *
 * honorclaw key-rotation rotate-master   — Rotate the master encryption key
 * honorclaw key-rotation rotate-jwt      — Rotate the JWT signing key
 * honorclaw key-rotation rotate-tool-signing — Rotate tool signing keys
 */
export function registerKeyRotationCommands(program: Command): void {
  const keyCmd = program
    .command('key-rotation')
    .description('Key rotation with audit trail');

  // ── rotate-master ───────────────────────────────────────────────────
  keyCmd
    .command('rotate-master')
    .description('Rotate the master encryption key')
    .option('--api-url <url>', 'Control Plane API URL', 'http://localhost:3000')
    .option('--api-key <key>', 'API key for authentication')
    .option('--dry-run', 'Show what would happen without making changes', false)
    .action(async (options: Record<string, string | boolean>) => {
      const apiUrl = options['api-url'] as string;
      const apiKey = (options['api-key'] as string) ?? process.env['HONORCLAW_API_KEY'] ?? '';
      const dryRun = options['dry-run'] as boolean;

      console.log('Rotating master encryption key...');

      // Generate new key
      const newKey = crypto.randomBytes(32);
      const newFingerprint = computeFingerprint(newKey);

      if (dryRun) {
        console.log(`  [DRY RUN] Would generate new master key with fingerprint: ${newFingerprint}`);
        console.log('  [DRY RUN] Would re-encrypt all secrets with the new key.');
        return;
      }

      try {
        const result = await callApi(apiUrl, apiKey, '/admin/keys/rotate-master', {
          newKeyFingerprint: newFingerprint,
        });

        const audit: AuditEntry = {
          action: 'rotate_master_key',
          timestamp: new Date().toISOString(),
          beforeFingerprint: result.previousFingerprint ?? 'unknown',
          afterFingerprint: newFingerprint,
          affectedSecrets: result.reEncryptedCount ?? 0,
          performedBy: result.performedBy ?? 'cli',
        };

        printAuditEntry(audit);
        console.log('\nMaster key rotation complete.');
        console.log('IMPORTANT: Store the new key securely. The old key is no longer valid.');
      } catch (err) {
        console.error('Failed to rotate master key:', err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  // ── rotate-jwt ──────────────────────────────────────────────────────
  keyCmd
    .command('rotate-jwt')
    .description('Rotate the JWT signing key')
    .option('--api-url <url>', 'Control Plane API URL', 'http://localhost:3000')
    .option('--api-key <key>', 'API key for authentication')
    .option('--algorithm <alg>', 'JWT signing algorithm', 'ES256')
    .option('--grace-period <seconds>', 'Grace period for old key validity (seconds)', '3600')
    .option('--dry-run', 'Show what would happen without making changes', false)
    .action(async (options: Record<string, string | boolean>) => {
      const apiUrl = options['api-url'] as string;
      const apiKey = (options['api-key'] as string) ?? process.env['HONORCLAW_API_KEY'] ?? '';
      const algorithm = options.algorithm as string;
      const gracePeriod = Number(options['grace-period']) || 3600;
      const dryRun = options['dry-run'] as boolean;

      console.log('Rotating JWT signing key...');
      console.log(`  Algorithm: ${algorithm}`);
      console.log(`  Grace period: ${gracePeriod}s`);

      // Generate a new key pair based on the algorithm
      const keyPair = generateKeyPair(algorithm);
      const newFingerprint = computeFingerprint(Buffer.from(keyPair.publicKey));

      if (dryRun) {
        console.log(`  [DRY RUN] Would generate new JWT key with fingerprint: ${newFingerprint}`);
        console.log(`  [DRY RUN] Old key would remain valid for ${gracePeriod}s.`);
        return;
      }

      try {
        const result = await callApi(apiUrl, apiKey, '/admin/keys/rotate-jwt', {
          algorithm,
          gracePeriodSeconds: gracePeriod,
          newKeyFingerprint: newFingerprint,
        });

        const audit: AuditEntry = {
          action: 'rotate_jwt_key',
          timestamp: new Date().toISOString(),
          beforeFingerprint: result.previousFingerprint ?? 'unknown',
          afterFingerprint: newFingerprint,
          affectedSecrets: 0,
          performedBy: result.performedBy ?? 'cli',
          metadata: { algorithm, gracePeriodSeconds: gracePeriod },
        };

        printAuditEntry(audit);
        console.log(`\nJWT key rotation complete. Old key valid for ${gracePeriod}s.`);
      } catch (err) {
        console.error('Failed to rotate JWT key:', err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  // ── rotate-tool-signing ─────────────────────────────────────────────
  keyCmd
    .command('rotate-tool-signing')
    .description('Rotate tool signing keys')
    .option('--api-url <url>', 'Control Plane API URL', 'http://localhost:3000')
    .option('--api-key <key>', 'API key for authentication')
    .option('--tool <name>', 'Rotate key for a specific tool only')
    .option('--dry-run', 'Show what would happen without making changes', false)
    .action(async (options: Record<string, string | boolean>) => {
      const apiUrl = options['api-url'] as string;
      const apiKey = (options['api-key'] as string) ?? process.env['HONORCLAW_API_KEY'] ?? '';
      const toolName = options.tool as string | undefined;
      const dryRun = options['dry-run'] as boolean;

      console.log('Rotating tool signing keys...');
      if (toolName) {
        console.log(`  Target: ${toolName}`);
      } else {
        console.log('  Target: ALL tool signing keys');
      }

      // Generate new signing key
      const newKey = crypto.randomBytes(32);
      const newFingerprint = computeFingerprint(newKey);

      if (dryRun) {
        console.log(`  [DRY RUN] Would generate new signing key with fingerprint: ${newFingerprint}`);
        console.log('  [DRY RUN] Would re-sign all affected tool packages.');
        return;
      }

      try {
        const result = await callApi(apiUrl, apiKey, '/admin/keys/rotate-tool-signing', {
          toolName: toolName ?? null,
          newKeyFingerprint: newFingerprint,
        });

        const audit: AuditEntry = {
          action: 'rotate_tool_signing_key',
          timestamp: new Date().toISOString(),
          beforeFingerprint: result.previousFingerprint ?? 'unknown',
          afterFingerprint: newFingerprint,
          affectedSecrets: result.reSignedCount ?? 0,
          performedBy: result.performedBy ?? 'cli',
          metadata: { toolName: toolName ?? 'all' },
        };

        printAuditEntry(audit);
        console.log('\nTool signing key rotation complete.');
        console.log(`  Re-signed ${result.reSignedCount ?? 0} tool package(s).`);
      } catch (err) {
        console.error('Failed to rotate tool signing keys:', err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });
}

// ── Types ────────────────────────────────────────────────────────────────

interface AuditEntry {
  action: string;
  timestamp: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  affectedSecrets: number;
  performedBy: string;
  metadata?: Record<string, unknown>;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 fingerprint for a key buffer.
 */
function computeFingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * Generate a key pair for JWT signing.
 */
function generateKeyPair(algorithm: string): { publicKey: string; privateKey: string } {
  switch (algorithm) {
    case 'ES256':
      return crypto.generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
    case 'ES384':
      return crypto.generateKeyPairSync('ec', {
        namedCurve: 'P-384',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
    case 'RS256':
    case 'RS384':
    case 'RS512':
      return crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
    default:
      return crypto.generateKeyPairSync('ec', {
        namedCurve: 'P-256',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
  }
}

/**
 * Call the Control Plane API.
 */
async function callApi(
  baseUrl: string,
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error (${response.status}): ${text}`);
  }

  return response.json() as Promise<Record<string, any>>;
}

/**
 * Print a formatted audit entry to the console.
 */
function printAuditEntry(audit: AuditEntry): void {
  console.log('\n--- Audit Trail ---');
  console.log(`  Action:       ${audit.action}`);
  console.log(`  Timestamp:    ${audit.timestamp}`);
  console.log(`  Before (fp):  ${audit.beforeFingerprint}`);
  console.log(`  After (fp):   ${audit.afterFingerprint}`);
  console.log(`  Affected:     ${audit.affectedSecrets} secret(s)`);
  console.log(`  Performed by: ${audit.performedBy}`);
  if (audit.metadata) {
    console.log(`  Metadata:     ${JSON.stringify(audit.metadata)}`);
  }
  console.log('-------------------');
}
