import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as net from 'node:net';
import chalk from 'chalk';
import { cliApi } from '../api.js';

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
}

/**
 * Run all diagnostic checks and print results.
 */
export async function runDoctor(): Promise<void> {
  console.log(chalk.bold('\nHonorClaw Doctor\n'));

  const checks: CheckResult[] = [];

  checks.push(checkDockerVersion());
  checks.push(checkDockerCompose());
  checks.push(checkAvailableRam());
  checks.push(await checkPort(3000, 'API server'));
  checks.push(await checkPort(5432, 'PostgreSQL'));
  checks.push(await checkPort(6379, 'Redis'));
  checks.push(checkDockerSocket());
  checks.push(await checkHealthEndpoint());

  console.log('');
  for (const check of checks) {
    const icon = check.status === 'pass'
      ? chalk.green('\u2713 PASS')
      : check.status === 'warn'
        ? chalk.yellow('\u26A0 WARN')
        : chalk.red('\u2717 FAIL');

    console.log(`  ${icon}  ${check.name}`);
    if (check.message) {
      console.log(`         ${chalk.dim(check.message)}`);
    }
  }

  const failures = checks.filter((c) => c.status === 'fail');
  const warnings = checks.filter((c) => c.status === 'warn');
  console.log('');

  if (failures.length > 0) {
    console.log(chalk.red(`  ${failures.length} check(s) failed.`));
    process.exitCode = 1;
  } else if (warnings.length > 0) {
    console.log(chalk.yellow(`  All checks passed with ${warnings.length} warning(s).`));
  } else {
    console.log(chalk.green('  All checks passed.'));
  }

  console.log('');
}

// ── Individual checks ───────────────────────────────────────────────────

function checkDockerVersion(): CheckResult {
  try {
    const output = execSync('docker version --format "{{.Server.Version}}"', {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();

    const major = Number(output.split('.')[0]);
    if (Number.isNaN(major)) {
      return { name: 'Docker version', status: 'warn', message: `Could not parse version: ${output}` };
    }

    if (major >= 24) {
      return { name: 'Docker version', status: 'pass', message: `v${output}` };
    }

    return {
      name: 'Docker version',
      status: 'fail',
      message: `v${output} found, >= 24 required`,
    };
  } catch {
    return {
      name: 'Docker version',
      status: 'fail',
      message: 'Docker not found. Install Docker Desktop or Docker Engine.',
    };
  }
}

function checkDockerCompose(): CheckResult {
  try {
    const output = execSync('docker compose version --short', {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();

    const major = Number(output.split('.')[0]);
    if (major >= 2) {
      return { name: 'Docker Compose', status: 'pass', message: `v${output}` };
    }

    return {
      name: 'Docker Compose',
      status: 'fail',
      message: `v${output} found, >= 2 required`,
    };
  } catch {
    return {
      name: 'Docker Compose',
      status: 'fail',
      message: 'docker compose not found. Install Docker Compose v2+.',
    };
  }
}

function checkAvailableRam(): CheckResult {
  const totalBytes = os.totalmem();
  const totalGb = totalBytes / (1024 ** 3);
  const freeBytes = os.freemem();
  const freeGb = freeBytes / (1024 ** 3);

  if (totalGb >= 4) {
    return {
      name: 'Available RAM',
      status: freeGb >= 2 ? 'pass' : 'warn',
      message: `${totalGb.toFixed(1)} GB total, ${freeGb.toFixed(1)} GB free`,
    };
  }

  return {
    name: 'Available RAM',
    status: 'fail',
    message: `${totalGb.toFixed(1)} GB total (>= 4 GB required)`,
  };
}

async function checkPort(port: number, label: string): Promise<CheckResult> {
  const inUse = await isPortInUse(port);

  if (inUse) {
    return {
      name: `Port ${port} (${label})`,
      status: 'warn',
      message: 'Port is already in use — HonorClaw may already be running, or another service occupies it.',
    };
  }

  return {
    name: `Port ${port} (${label})`,
    status: 'pass',
    message: 'Available',
  };
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close(() => resolve(false));
    });
    server.listen(port, '127.0.0.1');
  });
}

function checkDockerSocket(): CheckResult {
  const socketPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\docker_engine'
    : '/var/run/docker.sock';

  try {
    if (process.platform === 'win32') {
      // On Windows, we just check if docker responds
      execSync('docker info', { encoding: 'utf-8', timeout: 10_000 });
      return { name: 'Docker socket', status: 'pass', message: socketPath };
    }

    const stat = fs.statSync(socketPath);
    if (stat.isSocket()) {
      return { name: 'Docker socket', status: 'pass', message: socketPath };
    }

    return {
      name: 'Docker socket',
      status: 'fail',
      message: `${socketPath} exists but is not a socket`,
    };
  } catch {
    return {
      name: 'Docker socket',
      status: 'fail',
      message: `${socketPath} not found. Is Docker running?`,
    };
  }
}

async function checkHealthEndpoint(): Promise<CheckResult> {
  const baseUrl = cliApi.getBaseUrl();
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      return {
        name: 'Health endpoint',
        status: 'pass',
        message: `${baseUrl}/api/health responded OK`,
      };
    }

    return {
      name: 'Health endpoint',
      status: 'warn',
      message: `${baseUrl}/api/health returned HTTP ${response.status}`,
    };
  } catch {
    return {
      name: 'Health endpoint',
      status: 'warn',
      message: `Could not reach ${baseUrl}/api/health. Is the server running?`,
    };
  }
}
