import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import yaml from 'js-yaml';
import { MODEL_FAMILIES, getModelFamily, type ModelFamily } from '../migrate/model-families.js';

/**
 * Register the model migration CLI command.
 *
 * honorclaw migrate-model --from <model> --to <model> --manifest <path>
 *
 * Generates a compatibility report and manifest diff.
 * Does NOT auto-apply changes — the operator must review and apply manually.
 */
export function registerMigrateModelCommand(program: Command): void {
  program
    .command('migrate-model')
    .description('Generate a model migration compatibility report')
    .requiredOption('--from <model>', 'Source model identifier (e.g., gpt-4o)')
    .requiredOption('--to <model>', 'Target model identifier (e.g., claude-3-5-sonnet)')
    .option('--manifest <path>', 'Path to the agent manifest YAML')
    .option('--eval <path>', 'Path to eval suite to run after migration analysis')
    .option('--output <format>', 'Output format: text, json, yaml', 'text')
    .action(async (options: Record<string, string>) => {
      const fromModel = options.from!;
      const toModel = options.to!;

      const fromFamily = getModelFamily(fromModel);
      const toFamily = getModelFamily(toModel);

      if (!fromFamily) {
        console.error(`Unknown model: ${fromModel}. Known families: ${Object.keys(MODEL_FAMILIES).join(', ')}`);
        process.exit(1);
      }
      if (!toFamily) {
        console.error(`Unknown model: ${toModel}. Known families: ${Object.keys(MODEL_FAMILIES).join(', ')}`);
        process.exit(1);
      }

      // ── Compatibility Report ────────────────────────────────────────
      const report = generateCompatibilityReport(fromModel, fromFamily, toModel, toFamily);

      // ── Manifest Diff ───────────────────────────────────────────────
      let manifestDiff: ManifestDiff | null = null;
      if (options.manifest) {
        const manifestPath = resolve(options.manifest);
        const raw = readFileSync(manifestPath, 'utf-8');
        const manifest = yaml.load(raw) as Record<string, unknown>;
        manifestDiff = generateManifestDiff(manifest, fromFamily, toFamily);
      }

      // ── Output ──────────────────────────────────────────────────────
      switch (options.output) {
        case 'json':
          console.log(JSON.stringify({ report, manifestDiff }, null, 2));
          break;
        case 'yaml':
          console.log(yaml.dump({ report, manifestDiff }));
          break;
        case 'text':
        default:
          printTextReport(fromModel, toModel, report, manifestDiff);
          break;
      }

      // ── Eval Integration ────────────────────────────────────────────
      if (options.eval) {
        console.log('\n--- Eval Integration ---');
        console.log(`To validate migration, run:`);
        console.log(`  honorclaw eval run ${options.eval} --baseline-version ${fromModel}`);
        console.log('');
        console.log('This is NOT auto-applied. Review the report above and update your manifest manually.');
      }

      // Always remind the operator
      if (report.issues.length > 0) {
        console.log(`\nWARNING: ${report.issues.length} compatibility issue(s) found. Review before migrating.`);
        process.exit(1);
      }
    });
}

// ── Types ────────────────────────────────────────────────────────────────

interface CompatibilityIssue {
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  recommendation?: string;
}

interface CompatibilityReport {
  compatible: boolean;
  issues: CompatibilityIssue[];
  contextWindowChange: { from: number; to: number; delta: number };
  toolCallFormatChange: boolean;
  knownSensitivities: string[];
}

interface ManifestDiff {
  changes: Array<{
    path: string;
    from: unknown;
    to: unknown;
    reason: string;
  }>;
}

// ── Report Generation ────────────────────────────────────────────────────

function generateCompatibilityReport(
  fromModel: string,
  fromFamily: ModelFamily,
  toModel: string,
  toFamily: ModelFamily,
): CompatibilityReport {
  const issues: CompatibilityIssue[] = [];

  // Context window comparison
  const contextDelta = toFamily.contextWindow - fromFamily.contextWindow;
  if (contextDelta < 0) {
    issues.push({
      severity: 'warning',
      category: 'context_window',
      message: `Context window shrinks from ${fromFamily.contextWindow.toLocaleString()} to ${toFamily.contextWindow.toLocaleString()} tokens (${contextDelta.toLocaleString()}).`,
      recommendation: 'Review sessions with large context. Consider summarization or context truncation strategies.',
    });
  }

  // Tool call format differences
  const toolCallFormatChange = fromFamily.toolCallFormat !== toFamily.toolCallFormat;
  if (toolCallFormatChange) {
    issues.push({
      severity: 'warning',
      category: 'tool_call_format',
      message: `Tool call format changes from "${fromFamily.toolCallFormat}" to "${toFamily.toolCallFormat}".`,
      recommendation: 'HonorClaw normalizes tool call formats. Verify tool handlers work correctly with the new format.',
    });
  }

  // Known sensitivities of the target model
  for (const sensitivity of toFamily.knownSensitivities) {
    issues.push({
      severity: 'info',
      category: 'known_sensitivity',
      message: sensitivity,
    });
  }

  // Max output token differences
  if (fromFamily.maxOutputTokens && toFamily.maxOutputTokens) {
    if (toFamily.maxOutputTokens < fromFamily.maxOutputTokens) {
      issues.push({
        severity: 'warning',
        category: 'output_tokens',
        message: `Max output tokens decreases from ${fromFamily.maxOutputTokens.toLocaleString()} to ${toFamily.maxOutputTokens.toLocaleString()}.`,
        recommendation: 'Verify that agent responses do not exceed the new limit.',
      });
    }
  }

  // Structured output support
  if (fromFamily.supportsStructuredOutput && !toFamily.supportsStructuredOutput) {
    issues.push({
      severity: 'error',
      category: 'structured_output',
      message: 'Target model does not support structured output (JSON mode), but source model does.',
      recommendation: 'Implement output parsing/validation in the tool layer instead of relying on model JSON mode.',
    });
  }

  return {
    compatible: !issues.some((i) => i.severity === 'error'),
    issues,
    contextWindowChange: {
      from: fromFamily.contextWindow,
      to: toFamily.contextWindow,
      delta: contextDelta,
    },
    toolCallFormatChange,
    knownSensitivities: toFamily.knownSensitivities,
  };
}

function generateManifestDiff(
  manifest: Record<string, unknown>,
  fromFamily: ModelFamily,
  toFamily: ModelFamily,
): ManifestDiff {
  const changes: ManifestDiff['changes'] = [];

  // Suggest context window adjustments
  const session = manifest['session'] as Record<string, unknown> | undefined;
  if (session?.['maxTokensPerSession']) {
    const currentMax = Number(session['maxTokensPerSession']);
    if (currentMax > toFamily.contextWindow) {
      changes.push({
        path: 'session.maxTokensPerSession',
        from: currentMax,
        to: toFamily.contextWindow,
        reason: `Exceeds target model context window of ${toFamily.contextWindow.toLocaleString()} tokens.`,
      });
    }
  }

  // Suggest LLM rate limit adjustments
  const llmRateLimits = manifest['llmRateLimits'] as Record<string, unknown> | undefined;
  if (llmRateLimits?.['maxTokensPerMinute']) {
    const currentRate = Number(llmRateLimits['maxTokensPerMinute']);
    // If switching to a model family with known lower throughput, suggest reduction
    if (toFamily.typicalRpmLimit && currentRate > toFamily.typicalRpmLimit) {
      changes.push({
        path: 'llmRateLimits.maxTokensPerMinute',
        from: currentRate,
        to: toFamily.typicalRpmLimit,
        reason: `Target model family typically supports ~${toFamily.typicalRpmLimit.toLocaleString()} tokens/min.`,
      });
    }
  }

  return { changes };
}

// ── Output ───────────────────────────────────────────────────────────────

function printTextReport(
  fromModel: string,
  toModel: string,
  report: CompatibilityReport,
  diff: ManifestDiff | null,
): void {
  console.log('='.repeat(60));
  console.log(`Model Migration Report: ${fromModel} -> ${toModel}`);
  console.log('='.repeat(60));
  console.log(`  Compatible: ${report.compatible ? 'YES' : 'NO'}`);
  console.log(`  Context Window: ${report.contextWindowChange.from.toLocaleString()} -> ${report.contextWindowChange.to.toLocaleString()} (${report.contextWindowChange.delta >= 0 ? '+' : ''}${report.contextWindowChange.delta.toLocaleString()})`);
  console.log(`  Tool Call Format Change: ${report.toolCallFormatChange ? 'YES' : 'NO'}`);
  console.log('');

  if (report.issues.length > 0) {
    console.log('Issues:');
    for (const issue of report.issues) {
      const icon = issue.severity === 'error' ? '[ERROR]' : issue.severity === 'warning' ? '[WARN]' : '[INFO]';
      console.log(`  ${icon} [${issue.category}] ${issue.message}`);
      if (issue.recommendation) {
        console.log(`         Recommendation: ${issue.recommendation}`);
      }
    }
  } else {
    console.log('  No compatibility issues found.');
  }

  if (diff && diff.changes.length > 0) {
    console.log('\nSuggested Manifest Changes (NOT auto-applied):');
    for (const change of diff.changes) {
      console.log(`  ${change.path}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`);
      console.log(`    Reason: ${change.reason}`);
    }
  }
}
