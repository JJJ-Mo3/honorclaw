import chalk from 'chalk';
import ora from 'ora';
import type { Command } from 'commander';
import { cliApi, CliApiError } from '../api.js';

// ── Types ───────────────────────────────────────────────────────────────

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  isDefault: boolean;
  status: 'available' | 'pulling' | 'not_pulled';
  sizeBytes?: number;
  parameters?: string;
  quantization?: string;
}

interface AvailableModel {
  id: string;
  name: string;
  provider: string;
  description?: string;
  sizeBytes?: number;
  parameters?: string;
}

interface ModelDetail extends ModelInfo {
  description?: string;
  contextLength?: number;
  costPerMillionInput?: number;
  costPerMillionOutput?: number;
  capabilities: string[];
}

// ── Register subcommands ────────────────────────────────────────────────

export function registerModelsCommand(program: Command): void {
  const models = program
    .command('models')
    .description('Manage LLM models');

  // ── list ────────────────────────────────────────────────────────────
  models
    .command('list')
    .description('List models currently available (Ollama + configured providers)')
    .action(async () => {
      const spinner = ora('Loading models...').start();
      try {
        const modelList = await cliApi.get<ModelInfo[]>('/models');
        spinner.stop();

        if (modelList.length === 0) {
          console.log(chalk.dim('No models available. Run `honorclaw models pull <name>` to add one.'));
          return;
        }

        console.log(chalk.bold('\nAvailable Models\n'));

        // Group by provider
        const byProvider = new Map<string, ModelInfo[]>();
        for (const model of modelList) {
          const list = byProvider.get(model.provider) ?? [];
          list.push(model);
          byProvider.set(model.provider, list);
        }

        for (const [provider, providerModels] of Array.from(byProvider.entries())) {
          console.log(`  ${chalk.bold.underline(provider)}`);
          for (const model of providerModels) {
            const defaultTag = model.isDefault ? chalk.cyan(' (default)') : '';
            const sizeStr = model.sizeBytes
              ? chalk.dim(` ${(model.sizeBytes / 1e9).toFixed(1)}GB`)
              : '';
            const statusStr = model.status === 'pulling'
              ? chalk.yellow(' [pulling...]')
              : model.status === 'not_pulled'
                ? chalk.dim(' [not pulled]')
                : '';

            console.log(`    ${model.name}${defaultTag}${sizeStr}${statusStr}`);
          }
          console.log('');
        }
      } catch (err) {
        spinner.fail('Failed to list models');
        handleError(err);
      }
    });

  // ── available ───────────────────────────────────────────────────────
  models
    .command('available')
    .description('List models that can be pulled from registries')
    .option('-p, --provider <provider>', 'Filter by provider (ollama, openai, anthropic, etc.)')
    .action(async (opts: { provider?: string }) => {
      const spinner = ora('Fetching available models...').start();
      try {
        const params: Record<string, string> = {};
        if (opts.provider) params['provider'] = opts.provider;

        const available = await cliApi.get<AvailableModel[]>('/models/available', params);
        spinner.stop();

        if (available.length === 0) {
          console.log(chalk.dim('No models found.'));
          return;
        }

        console.log(chalk.bold('\nAvailable for Pull\n'));
        for (const model of available) {
          const size = model.sizeBytes ? chalk.dim(` (${(model.sizeBytes / 1e9).toFixed(1)}GB)`) : '';
          console.log(`  ${chalk.bold(model.name)}${size} [${model.provider}]`);
          if (model.description) {
            console.log(`    ${chalk.dim(model.description)}`);
          }
        }
        console.log('');
      } catch (err) {
        spinner.fail('Failed to fetch available models');
        handleError(err);
      }
    });

  // ── pull ────────────────────────────────────────────────────────────
  models
    .command('pull <name>')
    .description('Pull a model (e.g. ollama/llama3.2, openai/gpt-4o)')
    .action(async (name: string) => {
      const spinner = ora(`Pulling ${chalk.bold(name)}...`).start();
      try {
        const result = await cliApi.post<ModelInfo>('/models/pull', { name });
        if (result.status === 'pulling') {
          spinner.info(`Pull started for ${chalk.bold(name)}. This may take a while.`);
          console.log(chalk.dim('  Run `honorclaw models list` to check progress.'));
        } else {
          spinner.succeed(`Pulled ${chalk.bold(result.name)}`);
        }
      } catch (err) {
        spinner.fail(`Failed to pull ${name}`);
        handleError(err);
      }
    });

  // ── set-default ─────────────────────────────────────────────────────
  models
    .command('set-default <name>')
    .description('Set the default model for new agents')
    .action(async (name: string) => {
      try {
        await cliApi.post('/models/default', { name });
        console.log(chalk.green(`Default model set to ${chalk.bold(name)}`));
      } catch (err) {
        handleError(err);
      }
    });

  // ── remove ──────────────────────────────────────────────────────────
  models
    .command('remove <name>')
    .description('Remove a locally pulled model')
    .action(async (name: string) => {
      const spinner = ora(`Removing ${chalk.bold(name)}...`).start();
      try {
        await cliApi.delete(`/models/${encodeURIComponent(name)}`);
        spinner.succeed(`Removed ${name}`);
      } catch (err) {
        spinner.fail(`Failed to remove ${name}`);
        handleError(err);
      }
    });

  // ── info ────────────────────────────────────────────────────────────
  models
    .command('info <name>')
    .description('Show detailed information about a model')
    .action(async (name: string) => {
      try {
        const model = await cliApi.get<ModelDetail>(`/models/${encodeURIComponent(name)}`);

        console.log(chalk.bold(`\n${model.name}\n`));
        if (model.description) console.log(`  ${model.description}\n`);
        console.log(`  Provider:        ${model.provider}`);
        console.log(`  Status:          ${model.status}`);
        console.log(`  Default:         ${model.isDefault ? chalk.cyan('yes') : 'no'}`);
        if (model.parameters) console.log(`  Parameters:      ${model.parameters}`);
        if (model.quantization) console.log(`  Quantization:    ${model.quantization}`);
        if (model.sizeBytes) console.log(`  Size:            ${(model.sizeBytes / 1e9).toFixed(1)} GB`);
        if (model.contextLength) console.log(`  Context Length:  ${model.contextLength.toLocaleString()} tokens`);
        if (model.costPerMillionInput != null) {
          console.log(`  Cost (input):    $${model.costPerMillionInput.toFixed(2)} / 1M tokens`);
        }
        if (model.costPerMillionOutput != null) {
          console.log(`  Cost (output):   $${model.costPerMillionOutput.toFixed(2)} / 1M tokens`);
        }
        if (model.capabilities.length > 0) {
          console.log(`  Capabilities:    ${model.capabilities.join(', ')}`);
        }
        console.log('');
      } catch (err) {
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
