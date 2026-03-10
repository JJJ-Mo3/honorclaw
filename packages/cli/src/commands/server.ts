/**
 * Server Start/Stop Commands
 *
 * honorclaw start — Starts the HonorClaw deployment (Docker Compose or Kubernetes)
 * honorclaw stop  — Stops the HonorClaw deployment
 */
import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';

interface ServerConfig {
  deploymentType: 'docker-compose' | 'kubernetes';
  composeFile: string;
  kubeNamespace: string;
  healthEndpoint: string;
}

function getServerConfig(): ServerConfig {
  return {
    deploymentType: (process.env.HONORCLAW_DEPLOYMENT_TYPE as any) ?? 'docker-compose',
    composeFile: process.env.HONORCLAW_COMPOSE_FILE ?? 'docker-compose.yml',
    kubeNamespace: process.env.HONORCLAW_NAMESPACE ?? 'honorclaw',
    healthEndpoint: process.env.HONORCLAW_HEALTH_URL ?? 'http://localhost:3000/health/ready',
  };
}

function log(message: string): void {
  console.log(`[honorclaw] ${message}`);
}

async function waitForHealthy(endpoint: string, timeoutSec: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export function registerServerCommands(program: Command): void {
  program
    .command('start')
    .description('Start the HonorClaw deployment')
    .option('-d, --detach', 'Run in detached mode (background)', true)
    .option('--no-detach', 'Run in foreground (attached)')
    .option('--wait', 'Wait for health check after start', false)
    .action(async (opts: { detach: boolean; wait: boolean }) => {
      const config = getServerConfig();

      if (config.deploymentType === 'docker-compose') {
        if (!existsSync(config.composeFile)) {
          console.error(`Docker Compose file not found: ${config.composeFile}`);
          console.error('Run "honorclaw init" to set up the deployment first.');
          process.exit(1);
        }

        log('Starting HonorClaw...');
        const detachFlag = opts.detach ? '-d' : '';
        try {
          execSync(`docker compose -f "${config.composeFile}" up ${detachFlag}`, {
            stdio: 'inherit',
          });
        } catch {
          console.error('Failed to start HonorClaw. Check Docker is running.');
          process.exit(1);
        }

        if (opts.detach && opts.wait) {
          log('Waiting for health check...');
          const healthy = await waitForHealthy(config.healthEndpoint, 60);
          if (healthy) {
            log('HonorClaw is ready!');
          } else {
            console.error('Health check timed out. Check logs with: docker compose logs');
            process.exit(1);
          }
        } else if (opts.detach) {
          log('HonorClaw started in background.');
          log(`Check status: honorclaw status`);
          log(`View logs:    docker compose -f "${config.composeFile}" logs -f`);
        }
      } else {
        // Kubernetes
        log('Starting HonorClaw on Kubernetes...');
        try {
          execSync(
            `kubectl scale deployment honorclaw --replicas=1 -n ${config.kubeNamespace}`,
            { stdio: 'inherit' },
          );
          log('Deployment scaled up. Run "honorclaw status" to check readiness.');
        } catch {
          console.error('Failed to scale deployment. Check kubectl access.');
          process.exit(1);
        }
      }
    });

  program
    .command('stop')
    .description('Stop the HonorClaw deployment')
    .option('--remove', 'Remove containers and volumes (destructive)', false)
    .action(async (opts: { remove: boolean }) => {
      const config = getServerConfig();

      if (config.deploymentType === 'docker-compose') {
        if (!existsSync(config.composeFile)) {
          console.error(`Docker Compose file not found: ${config.composeFile}`);
          process.exit(1);
        }

        if (opts.remove) {
          log('Stopping and removing HonorClaw (including volumes)...');
          try {
            execSync(`docker compose -f "${config.composeFile}" down -v`, {
              stdio: 'inherit',
            });
          } catch {
            console.error('Failed to stop HonorClaw.');
            process.exit(1);
          }
        } else {
          log('Stopping HonorClaw...');
          try {
            execSync(`docker compose -f "${config.composeFile}" down`, {
              stdio: 'inherit',
            });
          } catch {
            console.error('Failed to stop HonorClaw.');
            process.exit(1);
          }
        }
        log('HonorClaw stopped.');
      } else {
        // Kubernetes
        log('Scaling down HonorClaw on Kubernetes...');
        try {
          execSync(
            `kubectl scale deployment honorclaw --replicas=0 -n ${config.kubeNamespace}`,
            { stdio: 'inherit' },
          );
          log('Deployment scaled to 0 replicas.');
        } catch {
          console.error('Failed to scale down. Check kubectl access.');
          process.exit(1);
        }
      }
    });

  program
    .command('logs')
    .description('View HonorClaw logs')
    .option('-f, --follow', 'Follow log output', false)
    .option('-n, --tail <lines>', 'Number of lines to show', '100')
    .action(async (opts: { follow: boolean; tail: string }) => {
      const config = getServerConfig();

      if (config.deploymentType === 'docker-compose') {
        const followFlag = opts.follow ? '-f' : '';
        try {
          execSync(
            `docker compose -f "${config.composeFile}" logs ${followFlag} --tail ${opts.tail}`,
            { stdio: 'inherit' },
          );
        } catch {
          // User likely ctrl+c'd out of follow mode
        }
      } else {
        const followFlag = opts.follow ? '-f' : '';
        try {
          execSync(
            `kubectl logs deployment/honorclaw -n ${config.kubeNamespace} ${followFlag} --tail=${opts.tail}`,
            { stdio: 'inherit' },
          );
        } catch {
          // User likely ctrl+c'd out of follow mode
        }
      }
    });
}
