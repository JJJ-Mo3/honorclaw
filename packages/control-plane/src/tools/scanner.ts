import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pino from 'pino';

const execFileAsync = promisify(execFile);
const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolManifestForScan {
  name: string;
  version: string;
  /** Container user — must NOT be root */
  user?: string;
  /** Whether root filesystem is read-only */
  readOnlyRootFilesystem?: boolean;
  /** Egress rules */
  egress?: {
    allowedDomains?: string[];
  };
  /** Resource limits */
  resources?: {
    cpuLimit?: string;
    memoryLimit?: string;
  };
}

export interface CveResult {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  package: string;
  installedVersion: string;
  fixedVersion?: string;
  title?: string;
}

export interface PolicyViolation {
  rule: string;
  message: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

export interface ScanResult {
  passed: boolean;
  imageRef: string;
  cves: CveResult[];
  policyViolations: PolicyViolation[];
  sbom?: Record<string, unknown>;
  scannedAt: string;
  /** If not passed, the blocking reasons */
  blockReasons: string[];
}

// ---------------------------------------------------------------------------
// Security scanner
// ---------------------------------------------------------------------------

/**
 * Scan a container image for CVEs and policy compliance.
 *
 * - Runs Trivy subprocess for CVE detection
 * - OPA policy checks: non-root, read-only root, no wildcard egress, resource limits
 * - Generates SBOM via Syft
 * - CRITICAL CVE or OPA violation blocks registration
 */
export async function scan(
  imageRef: string,
  manifest: ToolManifestForScan,
): Promise<ScanResult> {
  const blockReasons: string[] = [];
  let cves: CveResult[] = [];
  let sbom: Record<string, unknown> | undefined;

  // -----------------------------------------------------------------------
  // 1. CVE scan via Trivy
  // -----------------------------------------------------------------------
  try {
    const { stdout } = await execFileAsync('trivy', [
      'image',
      '--format', 'json',
      '--severity', 'CRITICAL,HIGH,MEDIUM,LOW',
      '--quiet',
      imageRef,
    ], { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 });

    const trivyReport = JSON.parse(stdout) as {
      Results?: Array<{
        Vulnerabilities?: Array<{
          VulnerabilityID: string;
          Severity: string;
          PkgName: string;
          InstalledVersion: string;
          FixedVersion?: string;
          Title?: string;
        }>;
      }>;
    };

    for (const result of trivyReport.Results ?? []) {
      for (const vuln of result.Vulnerabilities ?? []) {
        cves.push({
          id: vuln.VulnerabilityID,
          severity: vuln.Severity as CveResult['severity'],
          package: vuln.PkgName,
          installedVersion: vuln.InstalledVersion,
          fixedVersion: vuln.FixedVersion,
          title: vuln.Title,
        });
      }
    }

    // Block on CRITICAL CVEs
    const criticals = cves.filter(c => c.severity === 'CRITICAL');
    if (criticals.length > 0) {
      blockReasons.push(`${criticals.length} CRITICAL CVE(s) found: ${criticals.map(c => c.id).join(', ')}`);
    }
  } catch (err) {
    logger.error({ err, imageRef }, 'Trivy scan failed — treating as scan failure');
    blockReasons.push(`CVE scan failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  }

  // -----------------------------------------------------------------------
  // 2. OPA policy checks (evaluated locally, no OPA server required)
  // -----------------------------------------------------------------------
  const policyViolations: PolicyViolation[] = [];

  // Rule: non-root
  if (!manifest.user || manifest.user === 'root' || manifest.user === '0') {
    policyViolations.push({
      rule: 'non-root',
      message: 'Container must run as a non-root user. Set user in manifest.',
      severity: 'critical',
    });
  }

  // Rule: read-only root filesystem
  if (!manifest.readOnlyRootFilesystem) {
    policyViolations.push({
      rule: 'read-only-root',
      message: 'Container root filesystem must be read-only.',
      severity: 'critical',
    });
  }

  // Rule: no wildcard egress
  if (manifest.egress?.allowedDomains?.includes('*')) {
    policyViolations.push({
      rule: 'no-wildcard-egress',
      message: 'Wildcard (*) egress is not permitted. Specify explicit domains.',
      severity: 'critical',
    });
  }

  // Rule: resource limits must be set
  if (!manifest.resources?.cpuLimit || !manifest.resources?.memoryLimit) {
    policyViolations.push({
      rule: 'resource-limits',
      message: 'CPU and memory limits must be set in manifest.',
      severity: 'high',
    });
  }

  // Block on critical policy violations
  const criticalPolicyViolations = policyViolations.filter(v => v.severity === 'critical');
  if (criticalPolicyViolations.length > 0) {
    blockReasons.push(
      `${criticalPolicyViolations.length} critical policy violation(s): ${criticalPolicyViolations.map(v => v.rule).join(', ')}`,
    );
  }

  // -----------------------------------------------------------------------
  // 3. SBOM generation via Syft
  // -----------------------------------------------------------------------
  try {
    const { stdout: syftOut } = await execFileAsync('syft', [
      imageRef,
      '-o', 'spdx-json',
    ], { timeout: 120_000, maxBuffer: 50 * 1024 * 1024 });

    sbom = JSON.parse(syftOut) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err, imageRef }, 'Syft SBOM generation failed — continuing without SBOM');
  }

  // -----------------------------------------------------------------------
  // Result
  // -----------------------------------------------------------------------
  const passed = blockReasons.length === 0;

  const result: ScanResult = {
    passed,
    imageRef,
    cves,
    policyViolations,
    sbom,
    scannedAt: new Date().toISOString(),
    blockReasons,
  };

  if (passed) {
    logger.info({ imageRef, cveCount: cves.length, policyViolations: policyViolations.length }, 'Scan passed');
  } else {
    logger.warn({ imageRef, blockReasons }, 'Scan BLOCKED — registration will be denied');
  }

  return result;
}
