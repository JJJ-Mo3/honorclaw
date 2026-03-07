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
  .action(async () => {
    await runInit();
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
        workspace_id: string;
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
        console.log(`    ${chalk.dim(`id: ${agent.id}  workspace: ${agent.workspace_id.slice(0, 8)}`)}`);
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
  .option('-m, --model <model>', 'Model to use', 'ollama/llama3.2')
  .option('-w, --workspace <id>', 'Workspace ID')
  .option('-p, --prompt <prompt>', 'System prompt')
  .action(async (opts: { name: string; model: string; workspace?: string; prompt?: string }) => {
    const spinner = ora(`Creating agent ${chalk.bold(opts.name)}...`).start();
    try {
      const { agent } = await cliApi.post<{ agent: { id: string; name: string } }>('/agents', {
        name: opts.name,
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
        workspace_id: string;
        system_prompt?: string;
        created_at: string;
      } }>(`/agents/${id}`);

      console.log(chalk.bold(`\n${agent.name}\n`));
      console.log(`  ID:             ${agent.id}`);
      console.log(`  Model:          ${agent.model}`);
      console.log(`  Status:         ${statusColor(agent.status)}`);
      console.log(`  Workspace:      ${agent.workspace_id}`);
      console.log(`  Created:        ${new Date(agent.created_at).toLocaleString()}`);
      if (agent.system_prompt) {
        console.log(`  System Prompt:  ${chalk.dim(agent.system_prompt.slice(0, 100))}${agent.system_prompt.length > 100 ? '...' : ''}`);
      }
      console.log('');
    } catch (err) {
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
          created_at: string;
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
        manifest: { version: number; agent_id: string };
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
          created_at: string;
          created_by: string;
        }>;
      }>(`/manifests/${agentId}`);
      spinner.stop();

      if (manifests.length === 0) {
        console.log(chalk.dim('No manifest versions found.'));
        return;
      }

      console.log(chalk.bold(`\nManifest Versions for ${agentId}\n`));
      for (const m of manifests) {
        const ts = new Date(m.created_at).toLocaleString();
        const latest = m === manifests[0] ? chalk.green(' (current)') : '';
        console.log(`  v${m.version}${latest}  ${chalk.dim(ts)}  ${chalk.dim(m.created_by ?? '')}`);
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
  .description('Scaffold a new skill project')
  .action(async (name: string) => {
    const spinner = ora(`Scaffolding skill ${chalk.bold(name)}...`).start();
    try {
      await cliApi.post('/skills/scaffold', { name });
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
      const { skill } = await cliApi.get<{ skill: { name: string; version: string; description: string; tools?: string[]; manifest_yaml?: string } }>(
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
  .requiredOption('-u, --user <id>', 'User ID')
  .requiredOption('-w, --workspace <id>', 'Workspace ID')
  .option('-r, --role <role>', 'Role in workspace', 'member')
  .action(async (opts: { user: string; workspace: string; role: string }) => {
    try {
      await cliApi.post(`/users/${opts.user}/workspaces`, {
        workspaceId: opts.workspace,
        role: opts.role,
      });
      console.log(chalk.green(`Added user ${opts.user} to workspace ${opts.workspace}`));
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
      const list = await cliApi.get<Array<{ id: string; name: string; createdAt: string }>>('/workspaces');
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
      const ws = await cliApi.post<{ id: string; name: string }>('/workspaces', { name: opts.name });
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
  .command('ingest')
  .description('Ingest documents into an agent memory store')
  .requiredOption('-a, --agent <id>', 'Agent ID')
  .requiredOption('-f, --file <path>', 'File or directory to ingest')
  .action(async (opts: { agent: string; file: string }) => {
    const spinner = ora('Ingesting documents...').start();
    try {
      const result = await cliApi.post<{ documentsIngested: number }>(`/agents/${opts.agent}/memory/ingest`, {
        path: opts.file,
      });
      spinner.succeed(`Ingested ${result.documentsIngested} document(s)`);
    } catch (err) {
      spinner.fail('Ingestion failed');
      printError(err);
    }
  });

memory
  .command('export')
  .description('Export agent memory')
  .requiredOption('-a, --agent <id>', 'Agent ID')
  .option('-o, --output <file>', 'Output file', 'memory-export.jsonl')
  .action(async (opts: { agent: string; output: string }) => {
    const spinner = ora('Exporting memory...').start();
    try {
      await cliApi.post(`/agents/${opts.agent}/memory/export`, {
        outputPath: opts.output,
      });
      spinner.succeed(`Exported to ${chalk.bold(opts.output)}`);
    } catch (err) {
      spinner.fail('Export failed');
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
  .option('-o, --output <file>', 'Output file', 'honorclaw-export.tar.gz')
  .action(async (opts: { output: string }) => {
    const spinner = ora('Exporting...').start();
    try {
      await cliApi.post('/migrate/export', { outputPath: opts.output });
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
      await cliApi.post('/migrate/import', { inputPath: opts.file });
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
          const response = await cliApi.post<{ sent: boolean; reply?: string }>(`/sessions/${sessionId}/messages`, {
            content: trimmed,
          });

          if (response.reply) {
            console.log(chalk.cyan(`agent> ${response.reply}\n`));
          } else {
            console.log(chalk.dim('(message sent)\n'));
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
