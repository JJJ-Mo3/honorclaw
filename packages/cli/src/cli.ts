#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { registerToolsCommand } from './commands/tools.js';
import { registerModelsCommand } from './commands/models.js';
import { registerEvalCommands } from './commands/eval.js';
import { registerCertsCommands } from './commands/certs.js';
import { registerBackupCommands } from './commands/backup.js';
import { registerKeyRotationCommands } from './commands/key-rotation.js';
import { registerBundleCommands } from './commands/bundle.js';
import { registerMigrateModelCommand } from './commands/migrate-model.js';
import { registerUpgradeCommand } from './commands/upgrade.js';
import { registerServerCommands } from './commands/server.js';
import path from 'node:path';
import { cliApi, CliApiError } from './api.js';

const program = new Command();

program
  .name('honorclaw')
  .description('HonorClaw — Enterprise AI Agent Platform')
  .version('0.1.0');

// ═══════════════════════════════════════════════════════════════════════
//  Core Commands
// ═══════════════════════════════════════════════════════════════════════

program
  .command('init')
  .description('Initialize a new HonorClaw deployment')
  .option('-y, --yes', 'Non-interactive mode with defaults')
  .option('--email <email>', 'Admin email (non-interactive)')
  .option('--password <password>', 'Admin password (non-interactive)')
  .option('--workspace <name>', 'Workspace name', 'default')
  .option('--data-dir <dir>', 'Data directory', '/data/honorclaw')
  .action(async (opts: { yes?: boolean; email?: string; password?: string; workspace?: string; dataDir?: string }) => {
    await runInit(opts);
  });

program
  .command('doctor')
  .description('Run diagnostic checks')
  .action(async () => {
    await runDoctor();
  });

program
  .command('status')
  .description('Show deployment status')
  .action(async () => {
    const spinner = ora('Checking status...').start();
    try {
      const status = await cliApi.get<{
        version: string;
        uptime: number;
        agents: number;
        activeSessions: number;
        database: string;
        redis: string;
      }>('/status');
      spinner.stop();

      console.log(chalk.bold('\nHonorClaw Status\n'));
      console.log(`  Version:          ${status.version}`);
      console.log(`  Uptime:           ${formatUptime(status.uptime)}`);
      console.log(`  Agents:           ${status.agents}`);
      console.log(`  Active Sessions:  ${status.activeSessions}`);
      console.log(`  Database:         ${statusColor(status.database)}`);
      console.log(`  Redis:            ${statusColor(status.redis)}`);
      console.log('');
    } catch (err) {
      spinner.fail('Could not reach HonorClaw');
      printError(err);
    }
  });

registerUpgradeCommand(program);
registerServerCommands(program);

// ═══════════════════════════════════════════════════════════════════════
//  Authentication
// ═══════════════════════════════════════════════════════════════════════

program
  .command('login')
  .description('Authenticate with a HonorClaw server')
  .option('-s, --server <url>', 'Server URL (overrides HONORCLAW_API_URL)')
  .action(async (opts: { server?: string }) => {
    const readline = await import('node:readline');

    const serverUrl = opts.server ?? cliApi.getBaseUrl();
    console.log(chalk.bold(`\nLogging in to ${serverUrl}\n`));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const question = (prompt: string): Promise<string> =>
      new Promise((resolve) => {
        rl.question(prompt, (answer: string) => resolve(answer));
      });

    try {
      const email = await question('  Email: ');
      // Hide password input by writing to stderr and reading raw stdin
      const password = await new Promise<string>((resolve) => {
        const stdin = process.stdin;
        const wasRaw = stdin.isRaw;
        if (stdin.isTTY) stdin.setRawMode(true);
        process.stdout.write('  Password: ');
        let pw = '';
        const onData = (data: Buffer) => {
          const ch = data.toString('utf-8');
          if (ch === '\n' || ch === '\r') {
            stdin.removeListener('data', onData);
            if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
            process.stdout.write('\n');
            resolve(pw);
          } else if (ch === '\u007f' || ch === '\b') {
            // backspace
            pw = pw.slice(0, -1);
          } else if (ch === '\u0003') {
            // Ctrl+C
            process.stdout.write('\n');
            process.exit(1);
          } else {
            pw += ch;
          }
        };
        stdin.on('data', onData);
        stdin.resume();
      });

      rl.close();

      if (!email || !password) {
        console.error(chalk.red('  Email and password are required.'));
        return;
      }

      const spinner = ora('Authenticating...').start();

      // Call the login endpoint directly (not through cliApi which adds /api prefix)
      const url = `${serverUrl}/api/auth/login`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        const body = await response.text();
        let msg = `Login failed (HTTP ${response.status})`;
        try {
          const parsed = JSON.parse(body) as { error?: string };
          if (parsed.error) msg = parsed.error;
        } catch { /* not JSON */ }
        spinner.fail(msg);
        return;
      }

      const data = await response.json() as {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: string;
        requiresMfa?: boolean;
        user?: { id: string; email: string };
      };

      if (data.requiresMfa) {
        spinner.warn('MFA is required. Please complete MFA verification through the web UI.');
        return;
      }

      if (!data.accessToken) {
        spinner.fail('Login succeeded but no access token was returned. Server may need to be updated.');
        return;
      }

      cliApi.saveToken({
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: data.expiresAt ?? new Date(Date.now() + 3600 * 1000).toISOString(),
      });

      spinner.succeed(`Logged in as ${chalk.bold(data.user?.email ?? email)}`);
      console.log(chalk.dim(`  Token saved to ~/.honorclaw/token.json\n`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`  Login failed: ${msg}`));
    }
  });

program
  .command('logout')
  .description('Remove stored authentication credentials')
  .action(() => {
    cliApi.clearToken();
    console.log(chalk.green('  Logged out. Token removed from ~/.honorclaw/token.json'));
  });

// ═══════════════════════════════════════════════════════════════════════
//  Agents
// ═══════════════════════════════════════════════════════════════════════

const agents = program.command('agents').description('Manage agents');

agents
  .command('list')
  .description('List all agents')
  .action(async () => {
    const spinner = ora('Loading agents...').start();
    try {
      const { agents: list } = await cliApi.get<{ agents: Array<{
        id: string;
        name: string;
        model: string;
        status: string;
        workspaceId: string;
      }> }>('/agents');
      spinner.stop();

      if (list.length === 0) {
        console.log(chalk.dim('No agents configured.'));
        return;
      }

      console.log(chalk.bold('\nAgents\n'));
      for (const agent of list) {
        const status = agent.status === 'active'
          ? chalk.green(agent.status)
          : chalk.yellow(agent.status);
        console.log(`  ${chalk.bold(agent.name)} [${status}] — ${agent.model}`);
        console.log(`    ${chalk.dim(`id: ${agent.id}  workspace: ${agent.workspaceId?.slice(0, 8) ?? 'N/A'}`)}`);
      }
      console.log('');
    } catch (err) {
      spinner.fail('Failed to list agents');
      printError(err);
    }
  });

agents
  .command('create')
  .description('Create a new agent')
  .requiredOption('-n, --name <name>', 'Agent name')
  .option('-d, --display-name <displayName>', 'Display name')
  .option('-m, --model <model>', 'Model to use', 'ollama/llama3.2')
  .option('-w, --workspace <id>', 'Workspace ID')
  .option('-p, --prompt <prompt>', 'System prompt')
  .action(async (opts: { name: string; displayName?: string; model: string; workspace?: string; prompt?: string }) => {
    const spinner = ora(`Creating agent ${chalk.bold(opts.name)}...`).start();
    try {
      const { agent } = await cliApi.post<{ agent: { id: string; name: string } }>('/agents', {
        name: opts.name,
        displayName: opts.displayName,
        model: opts.model,
        systemPrompt: opts.prompt,
      });
      spinner.succeed(`Created agent ${chalk.bold(agent.name)} (${agent.id})`);
    } catch (err) {
      spinner.fail('Failed to create agent');
      printError(err);
    }
  });

agents
  .command('get <id>')
  .description('Get agent details')
  .action(async (id: string) => {
    try {
      const { agent } = await cliApi.get<{ agent: {
        id: string;
        name: string;
        model: string;
        status: string;
        workspaceId: string;
        systemPrompt?: string;
        createdAt: string;
      } }>(`/agents/${id}`);

      console.log(chalk.bold(`\n${agent.name}\n`));
      console.log(`  ID:             ${agent.id}`);
      console.log(`  Model:          ${agent.model}`);
      console.log(`  Status:         ${statusColor(agent.status)}`);
      console.log(`  Workspace:      ${agent.workspaceId}`);
      console.log(`  Created:        ${new Date(agent.createdAt).toLocaleString()}`);
      if (agent.systemPrompt) {
        console.log(`  System Prompt:  ${chalk.dim(agent.systemPrompt.slice(0, 100))}${agent.systemPrompt.length > 100 ? '...' : ''}`);
      }
      console.log('');
    } catch (err) {
      printError(err);
    }
  });

agents
  .command('update <id>')
  .description('Update an agent')
  .option('-n, --name <name>', 'New name')
  .option('-m, --model <model>', 'New model')
  .option('-p, --prompt <prompt>', 'New system prompt')
  .option('-s, --status <status>', 'New status (active, inactive, archived)')
  .action(async (id: string, opts: { name?: string; model?: string; prompt?: string; status?: string }) => {
    const spinner = ora(`Updating agent ${chalk.bold(id)}...`).start();
    try {
      const body: Record<string, string> = {};
      if (opts.name) body.name = opts.name;
      if (opts.model) body.model = opts.model;
      if (opts.prompt) body.systemPrompt = opts.prompt;
      if (opts.status) body.status = opts.status;

      if (Object.keys(body).length === 0) {
        spinner.fail('No fields to update. Use --name, --model, --prompt, or --status.');
        return;
      }

      const { agent } = await cliApi.put<{ agent: { id: string; name: string; status: string } }>(`/agents/${id}`, body);
      spinner.succeed(`Updated agent ${chalk.bold(agent.name)} (${agent.id})`);
    } catch (err) {
      spinner.fail('Failed to update agent');
      printError(err);
    }
  });

agents
  .command('delete <id>')
  .description('Archive (soft-delete) an agent')
  .action(async (id: string) => {
    const spinner = ora(`Deleting agent ${chalk.bold(id)}...`).start();
    try {
      const result = await cliApi.delete<{ agent: { id: string; name: string }; archived: boolean }>(`/agents/${id}`);
      spinner.succeed(`Archived agent ${chalk.bold(result.agent.name)} (${result.agent.id})`);
    } catch (err) {
      spinner.fail('Failed to delete agent');
      printError(err);
    }
  });

agents
  .command('rollback <agent-id>')
  .description('Roll back an agent to a previous manifest version')
  .requiredOption('--to <version>', 'Target manifest version to roll back to')
  .action(async (agentId: string, opts: { to: string }) => {
    const targetVersion = parseInt(opts.to, 10);
    if (Number.isNaN(targetVersion) || targetVersion < 1) {
      console.error(chalk.red('  Error: --to must be a positive integer version number.'));
      return;
    }

    const spinner = ora(
      `Rolling back agent ${chalk.bold(agentId)} to version ${targetVersion}...`,
    ).start();

    try {
      // Fetch all manifest versions for this agent
      const { manifests } = await cliApi.get<{
        manifests: Array<{
          version: number;
          manifest: unknown;
          createdAt: string;
        }>;
      }>(`/manifests/${agentId}`);

      const target = manifests.find((m) => m.version === targetVersion);
      if (!target) {
        spinner.fail(
          `Version ${targetVersion} not found. Available versions: ${manifests.map((m) => m.version).join(', ') || 'none'}`,
        );
        return;
      }

      // Post the old manifest as a new version (rollback = re-deploy old config)
      const result = await cliApi.post<{
        manifest: { version: number; agentId: string };
      }>(`/manifests/${agentId}`, {
        manifest: target.manifest,
      });

      spinner.succeed(
        `Rolled back agent ${chalk.bold(agentId)} to version ${targetVersion} ` +
        `(new manifest version: ${result.manifest.version})`,
      );
    } catch (err) {
      spinner.fail('Rollback failed');
      printError(err);
    }
  });

agents
  .command('versions <agent-id>')
  .description('List manifest versions for an agent')
  .action(async (agentId: string) => {
    const spinner = ora('Loading manifest versions...').start();
    try {
      const { manifests } = await cliApi.get<{
        manifests: Array<{
          version: number;
          createdAt: string;
          createdBy: string;
        }>;
      }>(`/manifests/${agentId}`);
      spinner.stop();

      if (manifests.length === 0) {
        console.log(chalk.dim('No manifest versions found.'));
        return;
      }

      console.log(chalk.bold(`\nManifest Versions for ${agentId}\n`));
      for (const m of manifests) {
        const ts = new Date(m.createdAt).toLocaleString();
        const latest = m === manifests[0] ? chalk.green(' (current)') : '';
        console.log(`  v${m.version}${latest}  ${chalk.dim(ts)}  ${chalk.dim(m.createdBy ?? '')}`);
      }
      console.log('');
    } catch (err) {
      spinner.fail('Failed to load versions');
      printError(err);
    }
  });

// ═══════════════════════════════════════════════════════════════════════
//  Tools & Models (delegated to subcommand modules)
// ═══════════════════════════════════════════════════════════════════════

registerToolsCommand(program);
registerModelsCommand(program);
registerEvalCommands(program);
registerCertsCommands(program);
registerBackupCommands(program);
registerKeyRotationCommands(program);
registerBundleCommands(program);
registerMigrateModelCommand(program);

// ═══════════════════════════════════════════════════════════════════════
//  Skills
// ═══════════════════════════════════════════════════════════════════════

const skills = program.command('skills').description('Manage skills');

skills
  .command('list')
  .description('List installed skills')
  .action(async () => {
    const spinner = ora('Loading skills...').start();
    try {
      const { skills: list } = await cliApi.get<{ skills: Array<{ name: string; version: string; description: string }> }>('/skills');
      spinner.stop();
      if (list.length === 0) {
        console.log(chalk.dim('No skills installed.'));
        return;
      }
      console.log(chalk.bold('\nInstalled Skills\n'));
      for (const skill of list) {
        console.log(`  ${chalk.bold(skill.name)} ${chalk.dim(`v${skill.version}`)}`);
        if (skill.description) console.log(`    ${chalk.dim(skill.description)}`);
      }
      console.log('');
    } catch (err) {
      spinner.fail('Failed to list skills');
      printError(err);
    }
  });

skills
  .command('available')
  .description('List all available skill bundles')
  .action(async () => {
    const spinner = ora('Loading available skills...').start();
    try {
      const { skills: list } = await cliApi.get<{ skills: Array<{ name: string; version: string; description: string; source: string }> }>('/skills/available');
      spinner.stop();
      if (list.length === 0) {
        console.log(chalk.dim('No skill bundles found.'));
        return;
      }
      console.log(chalk.bold('\nAvailable Skills\n'));
      for (const skill of list) {
        console.log(`  ${chalk.bold(skill.name)} ${chalk.dim(`v${skill.version}`)}`);
        if (skill.description) console.log(`    ${chalk.dim(skill.description)}`);
      }
      console.log(chalk.dim(`\n  Install with: honorclaw skills install <name>\n`));
    } catch (err) {
      spinner.fail('Failed to list available skills');
      printError(err);
    }
  });

skills
  .command('install <name>')
  .description('Install a skill')
  .option('-v, --version <version>', 'Specific version')
  .action(async (name: string, opts: { version?: string }) => {
    const spinner = ora(`Installing skill ${chalk.bold(name)}...`).start();
    try {
      await cliApi.post('/skills/install', { name, version: opts.version });
      spinner.succeed(`Installed skill ${chalk.bold(name)}`);
    } catch (err) {
      spinner.fail('Failed to install skill');
      printError(err);
    }
  });

skills
  .command('init <name>')
  .description('Scaffold a new skill project locally')
  .action(async (name: string) => {
    const spinner = ora(`Scaffolding skill ${chalk.bold(name)}...`).start();
    try {
      const fs = await import('node:fs');
      const skillDir = path.resolve(process.cwd(), name);
      if (fs.existsSync(skillDir)) {
        spinner.fail(`Directory ${name}/ already exists`);
        return;
      }
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'skill.yaml'),
        `name: ${name}\nversion: 0.1.0\ndescription: A new HonorClaw skill\ntools: []\n`,
      );
      fs.writeFileSync(
        path.join(skillDir, 'system-prompt.md'),
        `# ${name}\n\nDescribe the skill's system prompt here.\n`,
      );
      spinner.succeed(`Skill project created at ./${name}/`);
    } catch (err) {
      spinner.fail('Failed to scaffold skill');
      printError(err);
    }
  });

skills
  .command('search <query>')
  .description('Search the skill registry')
  .action(async (query: string) => {
    const spinner = ora('Searching...').start();
    try {
      const { skills: results } = await cliApi.get<{ skills: Array<{ name: string; description: string; version: string }> }>('/skills/search', { q: query });
      spinner.stop();
      if (results.length === 0) {
        console.log(chalk.dim('No skills found.'));
        return;
      }
      console.log(chalk.bold(`\nSkill Results for "${query}"\n`));
      for (const s of results) {
        console.log(`  ${chalk.bold(s.name)} ${chalk.dim(`v${s.version}`)}`);
        if (s.description) console.log(`    ${chalk.dim(s.description)}`);
      }
      console.log('');
    } catch (err) {
      spinner.fail('Search failed');
      printError(err);
    }
  });

skills
  .command('inspect <name>')
  .description('Show details for a skill')
  .action(async (name: string) => {
    try {
      const { skill } = await cliApi.get<{ skill: { name: string; version: string; description: string; tools?: string[]; manifestYaml?: string } }>(
        `/skills/${encodeURIComponent(name)}`,
      );
      console.log(chalk.bold(`\n${skill.name} v${skill.version}\n`));
      if (skill.description) console.log(`  ${skill.description}\n`);
      if (skill.tools && skill.tools.length > 0) {
        console.log('  Tools:');
        for (const t of skill.tools) console.log(`    - ${t}`);
      }
      console.log('');
    } catch (err) {
      printError(err);
    }
  });

skills
  .command('remove <name>')
  .description('Remove an installed skill')
  .action(async (name: string) => {
    const spinner = ora(`Removing ${chalk.bold(name)}...`).start();
    try {
      await cliApi.delete(`/skills/${encodeURIComponent(name)}`);
      spinner.succeed(`Removed skill ${name}`);
    } catch (err) {
      spinner.fail('Failed to remove skill');
      printError(err);
    }
  });

skills
  .command('apply <skill-name>')
  .description('Apply a skill to an agent')
  .requiredOption('-a, --agent <id>', 'Agent ID')
  .action(async (skillName: string, opts: { agent: string }) => {
    const spinner = ora(`Applying ${chalk.bold(skillName)} to agent...`).start();
    try {
      await cliApi.post(`/skills/agents/${opts.agent}`, { skillName });
      spinner.succeed(`Applied skill ${chalk.bold(skillName)} to agent ${opts.agent.slice(0, 8)}`);
    } catch (err) {
      spinner.fail('Failed to apply skill');
      printError(err);
    }
  });

skills
  .command('detach <skill-name>')
  .description('Remove a skill from an agent')
  .requiredOption('-a, --agent <id>', 'Agent ID')
  .action(async (skillName: string, opts: { agent: string }) => {
    try {
      await cliApi.delete(`/skills/agents/${opts.agent}/${encodeURIComponent(skillName)}`);
      console.log(chalk.green(`Removed skill ${skillName} from agent ${opts.agent.slice(0, 8)}`));
    } catch (err) {
      printError(err);
    }
  });

skills
  .command('agent-skills <agent-id>')
  .description('List skills applied to an agent')
  .action(async (agentId: string) => {
    try {
      const { skills: list } = await cliApi.get<{ skills: Array<{ skillName: string; enabled: boolean; description?: string }> }>(
        `/skills/agents/${agentId}`,
      );
      if (list.length === 0) {
        console.log(chalk.dim('No skills applied to this agent.'));
        return;
      }
      console.log(chalk.bold(`\nSkills for agent ${agentId.slice(0, 8)}\n`));
      for (const s of list) {
        const status = s.enabled ? chalk.green('enabled') : chalk.dim('disabled');
        console.log(`  ${chalk.bold(s.skillName)} [${status}]`);
        if (s.description) console.log(`    ${chalk.dim(s.description)}`);
      }
      console.log('');
    } catch (err) {
      printError(err);
    }
  });

// ═══════════════════════════════════════════════════════════════════════
//  Users
// ═══════════════════════════════════════════════════════════════════════

const users = program.command('users').description('Manage users');

users
  .command('list')
  .description('List users')
  .action(async () => {
    const spinner = ora('Loading users...').start();
    try {
      const { users: list } = await cliApi.get<{ users: Array<{ id: string; email: string; displayName: string; role: string }> }>('/users');
      spinner.stop();
      if (list.length === 0) {
        console.log(chalk.dim('No users.'));
        return;
      }
      console.log(chalk.bold('\nUsers\n'));
      for (const user of list) {
        console.log(`  ${chalk.bold(user.displayName)} <${user.email}> [${user.role}]`);
        console.log(`    ${chalk.dim(`id: ${user.id}`)}`);
      }
      console.log('');
    } catch (err) {
      spinner.fail('Failed to list users');
      printError(err);
    }
  });

users
  .command('create')
  .description('Create a new user')
  .requiredOption('-e, --email <email>', 'User email')
  .requiredOption('-p, --password <password>', 'User password')
  .option('-r, --role <role>', 'Role', 'agent_user')
  .option('-w, --workspace <id>', 'Workspace ID')
  .action(async (opts: { email: string; password: string; role: string; workspace?: string }) => {
    const spinner = ora(`Creating user ${chalk.bold(opts.email)}...`).start();
    try {
      const { user } = await cliApi.post<{ user: { id: string; email: string } }>('/users', {
        email: opts.email,
        password: opts.password,
        role: opts.role,
        workspaceId: opts.workspace,
      });
      spinner.succeed(`Created user ${user.email} (${user.id})`);
    } catch (err) {
      spinner.fail('Failed to create user');
      printError(err);
    }
  });

users
  .command('add-workspace')
  .description('Add a user to a workspace')
  .requiredOption('-u, --user <email>', 'User email')
  .requiredOption('-w, --workspace <id>', 'Workspace ID')
  .option('-r, --role <role>', 'Role in workspace (workspace_admin, agent_user, auditor, api_service)', 'agent_user')
  .action(async (opts: { user: string; workspace: string; role: string }) => {
    try {
      await cliApi.post('/users', {
        email: opts.user,
        workspaceId: opts.workspace,
        role: opts.role,
      });
      console.log(chalk.green(`Added user ${opts.user} to workspace ${opts.workspace} with role ${opts.role}`));
    } catch (err) {
      printError(err);
    }
  });

// ═══════════════════════════════════════════════════════════════════════
//  Workspaces
// ═══════════════════════════════════════════════════════════════════════

const workspaces = program.command('workspaces').description('Manage workspaces');

workspaces
  .command('list')
  .description('List workspaces')
  .action(async () => {
    const spinner = ora('Loading workspaces...').start();
    try {
      const resp = await cliApi.get<{ workspaces: Array<{ id: string; name: string; createdAt: string }> }>('/workspaces');
      const list = resp.workspaces ?? [];
      spinner.stop();
      if (list.length === 0) {
        console.log(chalk.dim('No workspaces.'));
        return;
      }
      console.log(chalk.bold('\nWorkspaces\n'));
      for (const ws of list) {
        console.log(`  ${chalk.bold(ws.name)} ${chalk.dim(`(${ws.id})`)}`);
      }
      console.log('');
    } catch (err) {
      spinner.fail('Failed to list workspaces');
      printError(err);
    }
  });

workspaces
  .command('create')
  .description('Create a new workspace')
  .requiredOption('-n, --name <name>', 'Workspace name')
  .action(async (opts: { name: string }) => {
    const spinner = ora(`Creating workspace ${chalk.bold(opts.name)}...`).start();
    try {
      const resp = await cliApi.post<{ workspace: { id: string; name: string } }>('/workspaces', { name: opts.name });
      const ws = resp.workspace;
      spinner.succeed(`Created workspace ${chalk.bold(ws.name)} (${ws.id})`);
    } catch (err) {
      spinner.fail('Failed to create workspace');
      printError(err);
    }
  });

// ═══════════════════════════════════════════════════════════════════════
//  Audit
// ═══════════════════════════════════════════════════════════════════════

const audit = program.command('audit').description('Query and export audit logs');

audit
  .command('query')
  .description('Query audit events')
  .option('-t, --type <eventType>', 'Filter by event type')
  .option('-a, --actor <actorId>', 'Filter by actor ID')
  .option('-s, --session <sessionId>', 'Filter by session ID')
  .option('--start <date>', 'Start date (ISO 8601)')
  .option('--end <date>', 'End date (ISO 8601)')
  .option('-l, --limit <n>', 'Max events to return', '25')
  .action(async (opts: {
    type?: string;
    actor?: string;
    session?: string;
    start?: string;
    end?: string;
    limit: string;
  }) => {
    const spinner = ora('Querying audit events...').start();
    try {
      const params: Record<string, string> = { limit: opts.limit };
      if (opts.type) params['eventType'] = opts.type;
      if (opts.actor) params['actorId'] = opts.actor;
      if (opts.session) params['sessionId'] = opts.session;
      if (opts.start) params['startDate'] = opts.start;
      if (opts.end) params['endDate'] = opts.end;

      const result = await cliApi.get<{
        events: Array<{
          id: string;
          eventType: string;
          actorType: string;
          actorId?: string;
          createdAt: string;
        }>;
        totalCount?: number;
      }>('/audit/events', params);
      spinner.stop();

      if (result.events.length === 0) {
        console.log(chalk.dim('No events found.'));
        return;
      }

      if (result.totalCount != null) {
        console.log(chalk.dim(`  ${result.totalCount} total events`));
      }

      console.log(chalk.bold('\nAudit Events\n'));
      for (const event of result.events) {
        const ts = new Date(event.createdAt).toLocaleString();
        console.log(`  ${chalk.dim(ts)} ${chalk.bold(event.eventType)} [${event.actorType}${event.actorId ? `:${event.actorId.slice(0, 8)}` : ''}]`);
      }
      console.log('');
    } catch (err) {
      spinner.fail('Query failed');
      printError(err);
    }
  });

audit
  .command('export')
  .description('Export audit events as JSONL')
  .option('-o, --output <file>', 'Output file', 'audit-export.jsonl')
  .option('-t, --type <eventType>', 'Filter by event type')
  .option('--start <date>', 'Start date (ISO 8601)')
  .option('--end <date>', 'End date (ISO 8601)')
  .action(async (opts: { output: string; type?: string; start?: string; end?: string }) => {
    const spinner = ora('Exporting audit events...').start();
    try {
      const params: Record<string, string> = { format: 'jsonl' };
      if (opts.type) params['eventType'] = opts.type;
      if (opts.start) params['startDate'] = opts.start;
      if (opts.end) params['endDate'] = opts.end;

      const response = await fetch(
        `${cliApi.getBaseUrl()}/api/audit/export?${new URLSearchParams(params).toString()}`,
        {
          headers: {
            ...cliApi.getAuthHeaders(),
          },
        },
      );

      if (!response.ok) {
        throw new Error(`Export failed with HTTP ${response.status}`);
      }

      const fs = await import('node:fs');
      const writer = fs.createWriteStream(opts.output);
      const reader = response.body?.getReader();

      if (reader) {
        const decoder = new TextDecoder();
        let done = false;
        while (!done) {
          const chunk = await reader.read();
          done = chunk.done;
          if (chunk.value) {
            writer.write(decoder.decode(chunk.value, { stream: !done }));
          }
        }
      }

      writer.end();
      spinner.succeed(`Exported to ${chalk.bold(opts.output)}`);
    } catch (err) {
      spinner.fail('Export failed');
      printError(err);
    }
  });

// ═══════════════════════════════════════════════════════════════════════
//  Secrets
// ═══════════════════════════════════════════════════════════════════════

const secrets = program.command('secrets').description('Manage secrets');

secrets
  .command('set <path> <value>')
  .description('Set a secret')
  .option('-w, --workspace <id>', 'Workspace ID')
  .action(async (secretPath: string, value: string, opts: { workspace?: string }) => {
    try {
      await cliApi.post('/secrets', {
        path: secretPath,
        value,
        workspaceId: opts.workspace,
      });
      console.log(chalk.green(`Secret ${chalk.bold(secretPath)} set`));
    } catch (err) {
      printError(err);
    }
  });

secrets
  .command('list')
  .description('List secret paths')
  .option('-p, --prefix <prefix>', 'Filter by prefix', '')
  .option('-w, --workspace <id>', 'Workspace ID')
  .action(async (opts: { prefix: string; workspace?: string }) => {
    try {
      const params: Record<string, string> = { prefix: opts.prefix };
      if (opts.workspace) params['workspaceId'] = opts.workspace;

      const { secrets: secretList } = await cliApi.get<{ secrets: Array<{ path: string; expiresAt: string | null; createdAt: string; updatedAt: string }> }>('/secrets', params);
      if (secretList.length === 0) {
        console.log(chalk.dim('No secrets found.'));
        return;
      }
      console.log(chalk.bold('\nSecrets\n'));
      for (const s of secretList) {
        const expires = s.expiresAt ? chalk.dim(` (expires: ${new Date(s.expiresAt).toLocaleDateString()})`) : '';
        console.log(`  ${s.path}${expires}`);
      }
      console.log('');
    } catch (err) {
      printError(err);
    }
  });

secrets
  .command('rotate <path>')
  .description('Rotate a secret (generate a new value)')
  .option('-w, --workspace <id>', 'Workspace ID')
  .action(async (secretPath: string, opts: { workspace?: string }) => {
    const spinner = ora(`Rotating ${chalk.bold(secretPath)}...`).start();
    try {
      await cliApi.post('/secrets/rotate', {
        path: secretPath,
        workspaceId: opts.workspace,
      });
      spinner.succeed(`Rotated ${chalk.bold(secretPath)}`);
    } catch (err) {
      spinner.fail('Rotation failed');
      printError(err);
    }
  });

// ═══════════════════════════════════════════════════════════════════════
//  Memory
// ═══════════════════════════════════════════════════════════════════════

const memory = program.command('memory').description('Manage agent memory');

memory
  .command('stats')
  .description('Show memory statistics for an agent')
  .requiredOption('-a, --agent <id>', 'Agent ID')
  .action(async (opts: { agent: string }) => {
    const spinner = ora('Loading memory stats...').start();
    try {
      const stats = await cliApi.get<{
        agentId: string;
        totalDocuments: number;
        totalChunks: number;
        estimatedTokens: number;
      }>(`/agents/${opts.agent}/memory/stats`);
      spinner.stop();
      console.log(chalk.bold('\nMemory Stats\n'));
      console.log(`  Documents:        ${stats.totalDocuments}`);
      console.log(`  Chunks:           ${stats.totalChunks}`);
      console.log(`  Estimated tokens: ${stats.estimatedTokens}`);
      console.log('');
    } catch (err) {
      spinner.fail('Failed to load stats');
      printError(err);
    }
  });

memory
  .command('documents')
  .description('List documents in agent memory')
  .requiredOption('-a, --agent <id>', 'Agent ID')
  .action(async (opts: { agent: string }) => {
    const spinner = ora('Loading documents...').start();
    try {
      const result = await cliApi.get<{
        documents: Array<{ sourceName: string; sourceHash: string; chunkCount: string; ingestedAt: string }>;
      }>(`/agents/${opts.agent}/memory/documents`);
      spinner.stop();
      const docs = result.documents ?? [];
      if (docs.length === 0) {
        console.log(chalk.dim('No documents in memory.'));
        return;
      }
      console.log(chalk.bold(`\nMemory Documents (${docs.length})\n`));
      for (const doc of docs) {
        console.log(`  ${chalk.bold(doc.sourceName ?? 'unknown')} ${chalk.dim(`[${doc.sourceHash?.slice(0, 8) ?? 'N/A'}]`)}`);
        console.log(`    Chunks: ${doc.chunkCount}  Ingested: ${doc.ingestedAt ? new Date(doc.ingestedAt).toLocaleString() : 'N/A'}`);
      }
      console.log('');
    } catch (err) {
      spinner.fail('Failed to list documents');
      printError(err);
    }
  });

memory
  .command('delete')
  .description('Delete a document from agent memory')
  .requiredOption('-a, --agent <id>', 'Agent ID')
  .requiredOption('-d, --doc <hash>', 'Document source hash')
  .action(async (opts: { agent: string; doc: string }) => {
    try {
      const result = await cliApi.delete<{ deleted: number }>(`/agents/${opts.agent}/memory/documents/${opts.doc}`);
      console.log(chalk.green(`Deleted ${result.deleted} chunk(s)`));
    } catch (err) {
      printError(err);
    }
  });

// ═══════════════════════════════════════════════════════════════════════
//  Sessions
// ═══════════════════════════════════════════════════════════════════════

const sessions = program.command('sessions').description('Manage chat sessions');

sessions
  .command('list')
  .description('List sessions')
  .option('-s, --status <status>', 'Filter by status (active, ended)')
  .option('-a, --agent <id>', 'Filter by agent ID')
  .option('-l, --limit <n>', 'Max results', '25')
  .action(async (opts: { status?: string; agent?: string; limit: string }) => {
    const spinner = ora('Loading sessions...').start();
    try {
      const params: Record<string, string> = { limit: opts.limit };
      if (opts.status) params['status'] = opts.status;
      if (opts.agent) params['agentId'] = opts.agent;

      const { sessions: list } = await cliApi.get<{ sessions: Array<{
        id: string;
        agentId: string;
        userId: string;
        channel: string;
        status: string;
        startedAt: string;
      }> }>('/sessions', params);
      spinner.stop();

      if (list.length === 0) {
        console.log(chalk.dim('No sessions found.'));
        return;
      }

      console.log(chalk.bold(`\nSessions (${list.length})\n`));
      for (const s of list) {
        const status = s.status === 'active' ? chalk.green(s.status) : chalk.dim(s.status);
        const ts = new Date(s.startedAt).toLocaleString();
        console.log(`  ${chalk.dim(s.id.slice(0, 8))} [${status}] agent:${s.agentId.slice(0, 8)} ${chalk.dim(ts)}`);
      }
      console.log('');
    } catch (err) {
      spinner.fail('Failed to list sessions');
      printError(err);
    }
  });

sessions
  .command('messages <session-id>')
  .description('Show messages for a session')
  .action(async (sessionId: string) => {
    try {
      const { messages } = await cliApi.get<{ messages: Array<{
        role: string; content: string; createdAt: string;
      }> }>(`/sessions/${sessionId}/messages`);

      if (messages.length === 0) {
        console.log(chalk.dim('No messages.'));
        return;
      }

      console.log(chalk.bold(`\nMessages for ${sessionId}\n`));
      for (const m of messages) {
        const ts = new Date(m.createdAt).toLocaleString();
        const role = m.role === 'user' ? chalk.bold('you') : chalk.cyan('agent');
        console.log(`  ${chalk.dim(ts)} ${role}> ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}`);
      }
      console.log('');
    } catch (err) {
      printError(err);
    }
  });

// ═══════════════════════════════════════════════════════════════════════
//  Migrate
// ═══════════════════════════════════════════════════════════════════════

const migrate = program.command('migrate').description('Import/export platform data');

migrate
  .command('export')
  .description('Export all configuration and data')
  .option('-o, --output <file>', 'Output file', 'honorclaw-export.json')
  .action(async (opts: { output: string }) => {
    const spinner = ora('Exporting...').start();
    try {
      const fs = await import('node:fs');
      const data = await cliApi.post<Record<string, unknown>>('/migrate/export');
      fs.writeFileSync(opts.output, JSON.stringify(data, null, 2), 'utf-8');
      spinner.succeed(`Exported to ${chalk.bold(opts.output)}`);
    } catch (err) {
      spinner.fail('Export failed');
      printError(err);
    }
  });

migrate
  .command('import')
  .description('Import configuration and data from an export')
  .requiredOption('-f, --file <path>', 'Import file')
  .action(async (opts: { file: string }) => {
    const spinner = ora('Importing...').start();
    try {
      const fs = await import('node:fs');
      const raw = fs.readFileSync(opts.file, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      await cliApi.post('/migrate/import', { data: parsed });
      spinner.succeed('Import complete');
    } catch (err) {
      spinner.fail('Import failed');
      printError(err);
    }
  });

// ═══════════════════════════════════════════════════════════════════════
//  Chat
// ═══════════════════════════════════════════════════════════════════════

program
  .command('chat <agent-name-or-id>')
  .description('Start an interactive chat session with an agent')
  .action(async (agentNameOrId: string) => {
    const readline = await import('node:readline');

    // Resolve agent — try by ID first, fall back to name lookup
    let agentId = agentNameOrId;
    try {
      const { agents: agentList } = await cliApi.get<{ agents: Array<{ id: string; name: string }> }>('/agents');
      const match = agentList.find(
        (a) => a.id === agentNameOrId || a.name === agentNameOrId,
      );
      if (match) {
        agentId = match.id;
        console.log(chalk.dim(`Resolved agent: ${match.name} (${match.id})`));
      }
    } catch {
      // Fall through — use the argument as-is
    }

    // Create a session
    const spinner = ora('Creating session...').start();
    let sessionId: string;
    try {
      const { session } = await cliApi.post<{ session: { id: string } }>('/sessions', {
        agentId,
      });
      sessionId = session.id;
      spinner.succeed(`Session started (${sessionId})`);
    } catch (err) {
      spinner.fail('Failed to create session');
      printError(err);
      return;
    }

    console.log(chalk.dim('Type a message and press Enter. Type "exit" or press Ctrl+C to quit.\n'));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = (): void => {
      rl.question(chalk.bold('you> '), async (input: string) => {
        const trimmed = input.trim();
        if (trimmed === 'exit' || trimmed === 'quit') {
          console.log(chalk.dim('\nEnding session.'));
          try {
            await cliApi.delete(`/sessions/${sessionId}`);
          } catch {
            // Best effort cleanup
          }
          rl.close();
          return;
        }

        if (trimmed.length === 0) {
          prompt();
          return;
        }

        try {
          // Send the message; the server will try to return a sync response
          const sendSpinner = ora({ text: 'Thinking...', spinner: 'dots' }).start();
          const response = await cliApi.post<{ sent: boolean; reply?: string | null; error?: boolean; message?: string }>(`/sessions/${sessionId}/messages`, {
            content: trimmed,
          });
          sendSpinner.stop();

          if (response.error) {
            console.log(chalk.red(`agent> ${response.reply ?? response.message ?? 'Unknown error'}\n`));
          } else if (response.reply) {
            console.log(chalk.cyan(`agent> ${response.reply}\n`));
          } else {
            // Sync response was null — fall back to polling the messages endpoint
            const pollSpinner = ora({ text: 'Waiting for response...', spinner: 'dots' }).start();
            const sentAt = new Date().toISOString();
            const POLL_INTERVAL = 500;
            const POLL_TIMEOUT = 30_000;
            const startTime = Date.now();
            let agentReply: string | null = null;

            while (Date.now() - startTime < POLL_TIMEOUT) {
              await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
              try {
                const { messages } = await cliApi.get<{
                  messages: Array<{ role: string; content: string; createdAt: string }>;
                }>(`/sessions/${sessionId}/messages`, { after: sentAt });

                const assistantMsg = messages.find((m) => m.role === 'assistant');
                if (assistantMsg) {
                  agentReply = assistantMsg.content;
                  break;
                }
              } catch {
                // Ignore poll errors, keep retrying
              }
            }

            pollSpinner.stop();

            if (agentReply) {
              console.log(chalk.cyan(`agent> ${agentReply}\n`));
            } else {
              console.log(chalk.dim('(no response received within timeout)\n'));
            }
          }
        } catch (err) {
          printError(err);
        }

        prompt();
      });
    };

    rl.on('close', () => {
      process.exit(0);
    });

    prompt();
  });

// ═══════════════════════════════════════════════════════════════════════
//  Agents Deploy
// ═══════════════════════════════════════════════════════════════════════

agents
  .command('deploy <path>')
  .description('Deploy an agent from a YAML manifest file')
  .action(async (manifestPath: string) => {
    const fs = await import('node:fs');
    const yaml = await import('js-yaml');

    if (!fs.existsSync(manifestPath)) {
      console.error(chalk.red(`  Error: File not found: ${manifestPath}`));
      return;
    }

    const spinner = ora(`Deploying from ${chalk.bold(manifestPath)}...`).start();
    try {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      const manifest = yaml.load(content) as Record<string, unknown>;

      if (!manifest || typeof manifest !== 'object') {
        spinner.fail('Invalid YAML manifest');
        return;
      }

      // Extract agent fields from the manifest
      const name = (manifest.name as string) ?? (manifest.agent_name as string);
      const model = (manifest.model as string) ?? undefined;
      const systemPrompt = (manifest.system_prompt as string) ?? (manifest.systemPrompt as string) ?? undefined;
      const displayName = (manifest.display_name as string) ?? (manifest.displayName as string) ?? undefined;

      if (!name) {
        spinner.fail('Manifest must contain a "name" field');
        return;
      }

      const { agent } = await cliApi.post<{ agent: { id: string; name: string; status: string } }>('/agents', {
        name,
        displayName,
        model,
        systemPrompt,
        manifest,
      });

      spinner.succeed(`Deployed agent ${chalk.bold(agent.name)} (${agent.id})`);
      console.log(`  Status: ${statusColor(agent.status ?? 'active')}`);
      console.log('');
    } catch (err) {
      spinner.fail('Deploy failed');
      printError(err);
    }
  });

// ═══════════════════════════════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════════════════════════════

function printError(err: unknown): void {
  if (err instanceof CliApiError) {
    console.error(chalk.red(`  Error: ${err.message}`));
  } else if (err instanceof Error) {
    console.error(chalk.red(`  Error: ${err.message}`));
  }
}

function statusColor(status: string): string {
  if (status === 'active' || status === 'connected' || status === 'ok' || status === 'healthy') {
    return chalk.green(status);
  }
  if (status === 'error' || status === 'failed' || status === 'unhealthy') {
    return chalk.red(status);
  }
  return chalk.yellow(status);
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);

  return parts.join(' ');
}

program.parse();
