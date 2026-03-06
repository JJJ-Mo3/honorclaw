/**
 * Upgrade Command
 *
 * honorclaw upgrade — Performs a rolling upgrade of the HonorClaw deployment:
 *   1. Pull latest Docker images
 *   2. Run database migrations
 *   3. Restart services (rolling)
 *   4. Health check verification
 *
 * Supports both Docker Compose (Tier 1) and Kubernetes (Tier 2-4) deployments.
 */
import { Command } from 'commander';
import { execSync, exec } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface UpgradeConfig {
  deploymentType: 'docker-compose' | 'kubernetes';
  composeFile: string;
  kubeNamespace: string;
  healthEndpoint: string;
  healthTimeout: number;
  migrationImage: string;
}

function getUpgradeConfig(): UpgradeConfig {
  return {
    deploymentType: (process.env.HONORCLAW_DEPLOYMENT_TYPE as any) ?? 'docker-compose',
    composeFile: process.env.HONORCLAW_COMPOSE_FILE ?? 'docker-compose.yml',
    kubeNamespace: process.env.HONORCLAW_NAMESPACE ?? 'honorclaw',
    healthEndpoint: process.env.HONORCLAW_HEALTH_URL ?? 'http://localhost:3000/health',
    healthTimeout: parseInt(process.env.HONORCLAW_HEALTH_TIMEOUT ?? '120', 10),
    migrationImage: process.env.HONORCLAW_MIGRATION_IMAGE ?? 'ghcr.io/honorclaw/honorclaw:latest',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.log(`[upgrade] ${message}`);
}

function logError(message: string): void {
  console.error(`[upgrade] ERROR: ${message}`);
}

function logStep(step: number, total: number, message: string): void {
  console.log(`[upgrade] [${step}/${total}] ${message}`);
}

async function waitForHealth(endpoint: string, timeoutSeconds: number): Promise<boolean> {
  const start = Date.now();
  const timeoutMs = timeoutSeconds * 1000;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const body = await response.json() as any;
        if (body.status === 'healthy' || body.status === 'ok') {
          return true;
        }
      }
    } catch {
      // Service not ready yet
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  return false;
}

function getCurrentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Docker Compose Upgrade
// ---------------------------------------------------------------------------

async function upgradeDockerCompose(config: UpgradeConfig, options: UpgradeOptions): Promise<void> {
  const totalSteps = 4;

  // Step 1: Pull latest images
  logStep(1, totalSteps, 'Pulling latest Docker images...');
  try {
    const pullOutput = execSync(`docker compose -f "${config.composeFile}" pull`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    log(pullOutput.trim());
  } catch (error: any) {
    logError(`Failed to pull images: ${error.message}`);
    throw new Error('Image pull failed');
  }

  // Step 2: Run database migrations
  if (!options.skipMigrations) {
    logStep(2, totalSteps, 'Running database migrations...');
    try {
      execSync(
        `docker compose -f "${config.composeFile}" run --rm honorclaw node dist/db/migrate.js`,
        { encoding: 'utf-8', stdio: 'pipe' },
      );
      log('Migrations complete.');
    } catch (error: any) {
      logError(`Migration failed: ${error.message}`);
      if (!options.force) {
        logError('Use --force to continue despite migration failure.');
        throw new Error('Migration failed');
      }
      log('WARNING: Continuing despite migration failure (--force).');
    }
  } else {
    logStep(2, totalSteps, 'Skipping migrations (--skip-migrations)');
  }

  // Step 3: Restart services
  logStep(3, totalSteps, 'Restarting services...');
  try {
    execSync(`docker compose -f "${config.composeFile}" up -d --remove-orphans`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    log('Services restarted.');
  } catch (error: any) {
    logError(`Service restart failed: ${error.message}`);
    throw new Error('Service restart failed');
  }

  // Step 4: Health check
  logStep(4, totalSteps, `Waiting for health check (timeout: ${config.healthTimeout}s)...`);
  const healthy = await waitForHealth(config.healthEndpoint, config.healthTimeout);
  if (healthy) {
    log('Health check passed.');
  } else {
    logError('Health check failed. The service may not be fully operational.');
    logError(`Check logs: docker compose -f "${config.composeFile}" logs`);
    if (!options.force) {
      throw new Error('Health check failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Kubernetes Upgrade
// ---------------------------------------------------------------------------

async function upgradeKubernetes(config: UpgradeConfig, options: UpgradeOptions): Promise<void> {
  const totalSteps = 4;
  const ns = config.kubeNamespace;

  // Step 1: Pull latest images (trigger rollout)
  logStep(1, totalSteps, 'Updating Kubernetes deployments...');
  try {
    // Update image tags on deployments
    const deployments = execSync(
      `kubectl get deployments -n ${ns} -l app.kubernetes.io/part-of=honorclaw -o jsonpath='{.items[*].metadata.name}'`,
      { encoding: 'utf-8', stdio: 'pipe' },
    ).trim().split(/\s+/);

    for (const deployment of deployments) {
      if (!deployment) continue;
      log(`  Restarting deployment: ${deployment}`);
      execSync(`kubectl rollout restart deployment/${deployment} -n ${ns}`, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
    }
  } catch (error: any) {
    logError(`Failed to update deployments: ${error.message}`);
    throw new Error('Deployment update failed');
  }

  // Step 2: Run database migrations
  if (!options.skipMigrations) {
    logStep(2, totalSteps, 'Running database migrations...');
    try {
      execSync(
        `kubectl run honorclaw-migrate --rm -it --restart=Never ` +
        `-n ${ns} ` +
        `--image=${config.migrationImage} ` +
        `-- node dist/db/migrate.js`,
        { encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 },
      );
      log('Migrations complete.');
    } catch (error: any) {
      logError(`Migration failed: ${error.message}`);
      if (!options.force) {
        throw new Error('Migration failed');
      }
    }
  } else {
    logStep(2, totalSteps, 'Skipping migrations (--skip-migrations)');
  }

  // Step 3: Wait for rollout
  logStep(3, totalSteps, 'Waiting for rollout to complete...');
  try {
    const deployments = execSync(
      `kubectl get deployments -n ${ns} -l app.kubernetes.io/part-of=honorclaw -o jsonpath='{.items[*].metadata.name}'`,
      { encoding: 'utf-8', stdio: 'pipe' },
    ).trim().split(/\s+/);

    for (const deployment of deployments) {
      if (!deployment) continue;
      log(`  Waiting for: ${deployment}`);
      execSync(
        `kubectl rollout status deployment/${deployment} -n ${ns} --timeout=${config.healthTimeout}s`,
        { encoding: 'utf-8', stdio: 'pipe' },
      );
    }
    log('All deployments rolled out successfully.');
  } catch (error: any) {
    logError(`Rollout failed: ${error.message}`);
    logError('Consider rolling back: kubectl rollout undo deployment/<name> -n ' + ns);
    if (!options.force) {
      throw new Error('Rollout failed');
    }
  }

  // Step 4: Health check
  logStep(4, totalSteps, 'Verifying health...');
  try {
    const { stdout } = await execAsync(
      `kubectl exec -n ${ns} deploy/honorclaw-control-plane -- wget -qO- http://localhost:3000/health`,
    );
    const health = JSON.parse(stdout);
    if (health.status === 'healthy' || health.status === 'ok') {
      log('Health check passed.');
    } else {
      logError(`Health check returned: ${JSON.stringify(health)}`);
    }
  } catch {
    logError('Could not reach health endpoint inside cluster.');
    logError(`Check pod status: kubectl get pods -n ${ns}`);
  }
}

// ---------------------------------------------------------------------------
// Command Registration
// ---------------------------------------------------------------------------

interface UpgradeOptions {
  force: boolean;
  skipMigrations: boolean;
  type?: string;
}

export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Upgrade HonorClaw to the latest version')
    .option('--force', 'Continue despite errors', false)
    .option('--skip-migrations', 'Skip database migrations', false)
    .option('--type <type>', 'Deployment type: docker-compose or kubernetes')
    .action(async (options: UpgradeOptions) => {
      const config = getUpgradeConfig();

      if (options.type) {
        config.deploymentType = options.type as any;
      }

      const currentVersion = getCurrentVersion();
      log(`HonorClaw Upgrade`);
      log(`Current version: ${currentVersion}`);
      log(`Deployment type: ${config.deploymentType}`);
      log('');

      try {
        if (config.deploymentType === 'docker-compose') {
          await upgradeDockerCompose(config, options);
        } else if (config.deploymentType === 'kubernetes') {
          await upgradeKubernetes(config, options);
        } else {
          logError(`Unknown deployment type: ${config.deploymentType}`);
          logError('Set HONORCLAW_DEPLOYMENT_TYPE to "docker-compose" or "kubernetes"');
          process.exit(1);
        }

        log('');
        log('Upgrade complete!');
        log('Run "honorclaw doctor" to verify system health.');
      } catch (error: any) {
        logError(error.message);
        process.exit(1);
      }
    });
}
