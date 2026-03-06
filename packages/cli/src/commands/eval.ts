import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import yaml from 'js-yaml';
import type { EvalFileSchema, EvalTestCase, EvalMock } from '@honorclaw/core';

/**
 * Register eval CLI commands.
 *
 * - honorclaw eval run <path>    — run eval suite
 * - honorclaw eval report        — generate eval report
 */
export function registerEvalCommands(program: Command): void {
  const evalCmd = program
    .command('eval')
    .description('Evaluation framework for agent testing');

  // ── eval run ────────────────────────────────────────────────────────
  evalCmd
    .command('run <path>')
    .description('Run an eval suite from a HonorClaw YAML file')
    .option('--api-url <url>', 'Control Plane API URL', 'http://localhost:3000')
    .option('--api-key <key>', 'API key for authentication')
    .option('--max-cost <usd>', 'Maximum total cost in USD', parseFloat)
    .option('--baseline-version <version>', 'Baseline version for diff mode')
    .option('--tag <tag>', 'Only run tests with this tag')
    .option('--output <path>', 'Output file for results (JSON)')
    .option('--concurrency <n>', 'Number of parallel test cases', parseInt, 1)
    .action(async (filePath: string, options: Record<string, any>) => {
      const absolutePath = resolve(filePath);
      const raw = readFileSync(absolutePath, 'utf-8');
      const evalFile = yaml.load(raw) as EvalFileSchema;

      if (!evalFile?.tests?.length) {
        console.error('No test cases found in eval file.');
        process.exit(1);
      }

      console.log(`Running eval suite: ${evalFile.metadata?.name ?? absolutePath}`);
      console.log(`  Tests: ${evalFile.tests.length}`);

      // Apply defaults to each test case
      const tests = evalFile.tests.map((test) => ({
        ...test,
        agentId: test.agentId ?? evalFile.defaults?.agentId ?? '',
        maxCostUsd: test.maxCostUsd ?? evalFile.defaults?.maxCostUsd,
        timeoutSeconds: test.timeoutSeconds ?? evalFile.defaults?.timeoutSeconds,
      }));

      // Filter by tag if specified
      const filteredTests = options.tag
        ? tests.filter((t) => t.tags?.includes(options.tag))
        : tests;

      if (filteredTests.length === 0) {
        console.error('No tests match the specified filters.');
        process.exit(1);
      }

      // Translate to promptfoo config
      const promptfooConfig = translateToPromptfoo(filteredTests, {
        apiUrl: options.apiUrl,
        apiKey: options.apiKey ?? process.env['HONORCLAW_API_KEY'] ?? '',
        maxCost: options.maxCost,
        baselineVersion: options.baselineVersion,
      });

      // Write the generated promptfoo config for inspection
      const configPath = absolutePath.replace(/\.ya?ml$/, '.promptfoo.yaml');
      writeFileSync(configPath, yaml.dump(promptfooConfig), 'utf-8');
      console.log(`  Generated promptfoo config: ${configPath}`);

      // Execute via promptfoo
      try {
        // @ts-expect-error -- promptfoo is an optional runtime dependency
        const { default: promptfoo } = await import('promptfoo');
        const results = await (promptfoo as any).evaluate(promptfooConfig);

        console.log('\nEval Results:');
        console.log(`  Passed: ${results.stats?.successes ?? 0}`);
        console.log(`  Failed: ${results.stats?.failures ?? 0}`);
        console.log(`  Total Cost: $${(results.stats?.totalCost ?? 0).toFixed(4)}`);

        if (options.output) {
          writeFileSync(resolve(options.output), JSON.stringify(results, null, 2), 'utf-8');
          console.log(`  Results written to: ${options.output}`);
        }

        // Diff mode: compare against baseline
        if (options.baselineVersion) {
          console.log(`\n  Diff against baseline version: ${options.baselineVersion}`);
          console.log('  (Diff analysis requires stored baseline results — not yet implemented)');
        }

        // Budget control
        if (options.maxCost && (results.stats?.totalCost ?? 0) > options.maxCost) {
          console.error(`\n  Budget exceeded: $${results.stats.totalCost.toFixed(4)} > $${options.maxCost}`);
          process.exit(2);
        }
      } catch (err) {
        console.error('Failed to run eval:', err instanceof Error ? err.message : err);
        process.exit(1);
      }
    });

  // ── eval report ─────────────────────────────────────────────────────
  evalCmd
    .command('report')
    .description('Generate an eval report from previous results')
    .option('--input <path>', 'Input results JSON file')
    .option('--format <format>', 'Output format: text, json, html', 'text')
    .action(async (options: Record<string, any>) => {
      if (!options.input) {
        console.error('--input is required for report generation.');
        process.exit(1);
      }

      const raw = readFileSync(resolve(options.input), 'utf-8');
      const results = JSON.parse(raw);

      switch (options.format) {
        case 'json':
          console.log(JSON.stringify(results, null, 2));
          break;
        case 'html':
          console.log('HTML report generation not yet implemented.');
          break;
        case 'text':
        default:
          printTextReport(results);
          break;
      }
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────

interface TranslateOptions {
  apiUrl: string;
  apiKey: string;
  maxCost?: number;
  baselineVersion?: string;
}

/**
 * Translate HonorClaw eval test cases to a promptfoo configuration object.
 */
function translateToPromptfoo(
  tests: EvalTestCase[],
  options: TranslateOptions,
): Record<string, unknown> {
  return {
    providers: [
      {
        id: 'honorclaw',
        config: {
          apiBaseUrl: options.apiUrl,
          apiKey: options.apiKey,
        },
      },
    ],
    prompts: tests.map((test) => ({
      raw: test.turns.map((t) => t.content).join('\n'),
    })),
    tests: tests.map((test) => ({
      description: test.description,
      vars: {
        agentId: test.agentId,
        mocks: test.mocks ?? [],
      },
      assert: test.expectations.map((exp) => ({
        type: mapExpectationType(exp.type),
        value: exp.value,
        weight: exp.weight ?? 1,
      })),
    })),
    ...(options.maxCost != null ? { maxConcurrency: 1 } : {}),
  };
}

function mapExpectationType(type: string): string {
  const mapping: Record<string, string> = {
    contains: 'contains',
    not_contains: 'not-contains',
    regex: 'regex',
    tool_called: 'contains',
    tool_not_called: 'not-contains',
    json_schema: 'is-json',
    llm_rubric: 'llm-rubric',
    cost_under: 'cost',
    latency_under_ms: 'latency',
  };
  return mapping[type] ?? type;
}

function printTextReport(results: any): void {
  console.log('='.repeat(60));
  console.log('HonorClaw Eval Report');
  console.log('='.repeat(60));
  console.log(`  Total Tests: ${results.stats?.total ?? 0}`);
  console.log(`  Passed:      ${results.stats?.successes ?? 0}`);
  console.log(`  Failed:      ${results.stats?.failures ?? 0}`);
  console.log(`  Total Cost:  $${(results.stats?.totalCost ?? 0).toFixed(4)}`);
  console.log('='.repeat(60));

  if (results.results) {
    for (const r of results.results) {
      const status = r.success ? 'PASS' : 'FAIL';
      console.log(`  [${status}] ${r.description ?? r.testIdx}`);
      if (!r.success && r.error) {
        console.log(`         ${r.error}`);
      }
    }
  }
}
