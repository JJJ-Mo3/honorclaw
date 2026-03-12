import { execSync } from 'node:child_process';
import chalk from 'chalk';
import ora from 'ora';
import type { Command } from 'commander';
import { cliApi, CliApiError } from '../api.js';

// ── Types ───────────────────────────────────────────────────────────────

interface ToolInfo {
  name: string;
  version: string;
  source: string;
  enabled: boolean;
  digest?: string;
  description?: string;
}

interface ToolDetail extends ToolInfo {
  parameters: Record<string, unknown>;
  rateLimit?: { maxCallsPerMinute?: number; maxCallsPerSession?: number };
  requiresApproval: boolean;
  securityScan?: {
    status: 'passed' | 'failed' | 'pending';
    vulnerabilities: number;
    lastScanned?: string;
  };
}


interface ScanResult {
  tool: string;
  trivyStatus: 'passed' | 'failed' | 'skipped';
  opaStatus: 'passed' | 'failed' | 'skipped';
  vulnerabilities: Array<{ severity: string; id: string; description: string }>;
  policyViolations: string[];
}

// ── Register subcommands ────────────────────────────────────────────────

export function registerToolsCommand(program: Command): void {
  const tools = program
    .command('tools')
    .description('Manage tools');

  // ── list ────────────────────────────────────────────────────────────
  tools
    .command('list')
    .description('List installed tools')
    .option('-a, --all', 'Include disabled tools')
    .action(async (opts: { all?: boolean }) => {
      const spinner = ora('Loading tools...').start();
      try {
        const params: Record<string, string> = {};
        if (opts.all) params['includeDisabled'] = 'true';
        const toolsList = await cliApi.get<ToolInfo[]>('/tools', params);
        spinner.stop();

        if (toolsList.length === 0) {
          console.log(chalk.dim('No tools installed.'));
          return;
        }

        console.log(chalk.bold('\nInstalled Tools\n'));
        for (const tool of toolsList) {
          const status = tool.enabled ? chalk.green('enabled') : chalk.dim('disabled');
          console.log(`  ${chalk.bold(tool.name)} ${chalk.dim(`v${tool.version}`)} [${status}]`);
          if (tool.digest) {
            console.log(`    ${chalk.dim(`digest: ${tool.digest.slice(0, 16)}...`)}`);
          }
        }
        console.log('');
      } catch (err) {
        spinner.fail('Failed to list tools');
        handleError(err);
      }
    });

  // ── install ─────────────────────────────────────────────────────────
  tools
    .command('install <name>')
    .description('Install a tool from a registry')
    .option('-v, --version <version>', 'Specific version to install')
    .option('--digest <digest>', 'Pin to an OCI digest')
    .option('--skip-scan', 'Skip security scan (not recommended)')
    .action(async (name: string, opts: { version?: string; digest?: string; skipScan?: boolean }) => {
      const spinner = ora(`Installing tool ${chalk.bold(name)}...`).start();
      try {
        const result = await cliApi.post<ToolInfo>('/tools/install', {
          name,
          version: opts.version,
          digest: opts.digest,
          skipScan: opts.skipScan ?? false,
        });
        spinner.succeed(`Installed ${chalk.bold(result.name)} v${result.version}`);
        if (result.digest) {
          console.log(`  ${chalk.dim(`Pinned digest: ${result.digest}`)}`);
        }
      } catch (err) {
        spinner.fail(`Failed to install ${name}`);
        handleError(err);
      }
    });

  // ── inspect ─────────────────────────────────────────────────────────
  tools
    .command('inspect <name>')
    .description('Show detailed information about a tool')
    .action(async (name: string) => {
      try {
        const tool = await cliApi.get<ToolDetail>(`/tools/${encodeURIComponent(name)}`);

        console.log(chalk.bold(`\n${tool.name} v${tool.version}\n`));
        if (tool.description) console.log(`  ${tool.description}\n`);
        console.log(`  Source:            ${tool.source}`);
        console.log(`  Enabled:           ${tool.enabled ? chalk.green('yes') : chalk.dim('no')}`);
        console.log(`  Requires Approval: ${tool.requiresApproval ? chalk.yellow('yes') : 'no'}`);
        if (tool.digest) console.log(`  Digest:            ${tool.digest}`);
        if (tool.rateLimit) {
          console.log(`  Rate Limit:        ${tool.rateLimit.maxCallsPerMinute ?? '-'} calls/min, ${tool.rateLimit.maxCallsPerSession ?? '-'} calls/session`);
        }
        if (tool.securityScan) {
          const scanStatus = tool.securityScan.status === 'passed'
            ? chalk.green('passed')
            : chalk.red(tool.securityScan.status);
          console.log(`  Security Scan:     ${scanStatus} (${tool.securityScan.vulnerabilities} vulnerabilities)`);
        }
        if (Object.keys(tool.parameters).length > 0) {
          console.log(`\n  ${chalk.bold('Parameters:')}`);
          for (const [key, value] of Object.entries(tool.parameters)) {
            console.log(`    ${key}: ${chalk.dim(JSON.stringify(value))}`);
          }
        }
        console.log('');
      } catch (err) {
        handleError(err);
      }
    });

  // ── init ────────────────────────────────────────────────────────────
  tools
    .command('init <name>')
    .description('Scaffold a new tool project')
    .option('-t, --template <template>', 'Template to use', 'basic')
    .action(async (name: string, opts: { template: string }) => {
      const spinner = ora(`Scaffolding tool ${chalk.bold(name)}...`).start();
      try {
        await cliApi.post('/tools/scaffold', { name, template: opts.template });
        spinner.succeed(`Tool project created at ./${name}/`);
        console.log(chalk.dim(`  cd ${name} && npm install`));
      } catch (err) {
        spinner.fail('Failed to scaffold tool');
        handleError(err);
      }
    });

  // ── dev ─────────────────────────────────────────────────────────────
  tools
    .command('dev <name>')
    .description('Run a tool in development mode with hot reload')
    .action(async (name: string) => {
      console.log(chalk.bold(`\nStarting ${name} in development mode...\n`));
      try {
        await cliApi.post(`/tools/${encodeURIComponent(name)}/dev`);
        console.log(chalk.green('Dev server started. Press Ctrl+C to stop.'));
      } catch (err) {
        handleError(err);
      }
    });

  // ── scan ────────────────────────────────────────────────────────────
  tools
    .command('scan <name>')
    .description('Run security scan (Trivy + OPA) on a tool')
    .action(async (name: string) => {
      const spinner = ora(`Scanning ${chalk.bold(name)}...`).start();
      try {
        // Check that Trivy is available
        try {
          execSync('trivy --version', { encoding: 'utf-8', timeout: 5000 });
        } catch {
          spinner.warn('Trivy not found locally — using server-side scan');
        }

        const result = await cliApi.post<ScanResult>(`/tools/${encodeURIComponent(name)}/scan`);
        spinner.stop();

        console.log(chalk.bold(`\nSecurity Scan: ${result.tool}\n`));

        // Trivy results
        const trivyIcon = result.trivyStatus === 'passed' ? chalk.green('\u2713') : chalk.red('\u2717');
        console.log(`  ${trivyIcon} Trivy:  ${result.trivyStatus}`);

        // OPA policy results
        const opaIcon = result.opaStatus === 'passed' ? chalk.green('\u2713') : chalk.red('\u2717');
        console.log(`  ${opaIcon} OPA:    ${result.opaStatus}`);

        if (result.vulnerabilities.length > 0) {
          console.log(chalk.bold('\n  Vulnerabilities:'));
          for (const vuln of result.vulnerabilities) {
            const severity = vuln.severity === 'CRITICAL' || vuln.severity === 'HIGH'
              ? chalk.red(vuln.severity)
              : chalk.yellow(vuln.severity);
            console.log(`    ${severity} ${vuln.id}: ${vuln.description}`);
          }
        }

        if (result.policyViolations.length > 0) {
          console.log(chalk.bold('\n  Policy Violations:'));
          for (const violation of result.policyViolations) {
            console.log(`    ${chalk.red('\u2717')} ${violation}`);
          }
        }

        console.log('');
      } catch (err) {
        spinner.fail('Scan failed');
        handleError(err);
      }
    });

  // ── remove ──────────────────────────────────────────────────────────
  tools
    .command('remove <name>')
    .description('Remove an installed tool')
    .action(async (name: string) => {
      const spinner = ora(`Removing ${chalk.bold(name)}...`).start();
      try {
        await cliApi.delete(`/tools/${encodeURIComponent(name)}`);
        spinner.succeed(`Removed ${name}`);
      } catch (err) {
        spinner.fail(`Failed to remove ${name}`);
        handleError(err);
      }
    });

  // ── update ──────────────────────────────────────────────────────────
  tools
    .command('update [name]')
    .description('Update a tool (or all tools if no name given)')
    .action(async (name?: string) => {
      const label = name ? chalk.bold(name) : 'all tools';
      const spinner = ora(`Updating ${label}...`).start();
      try {
        const result = await cliApi.post<{ updated: string[] }>('/tools/update', {
          name: name ?? null,
        });
        spinner.succeed(`Updated: ${result.updated.join(', ') || 'everything is up to date'}`);
      } catch (err) {
        spinner.fail('Update failed');
        handleError(err);
      }
    });
}

// ── Error helper ────────────────────────────────────────────────────────

function handleError(err: unknown): void {
  if (err instanceof CliApiError) {
    console.error(chalk.red(`  Error: ${err.message}`));
  } else if (err instanceof Error) {
    console.error(chalk.red(`  Error: ${err.message}`));
  }
}
