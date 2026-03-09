// HonorClaw Tool: Claude Code — agentic coding via Anthropic Claude Code CLI
import { createTool, z } from '@honorclaw/tool-sdk';
import { spawn } from 'node:child_process';

const InputSchema = z.object({
  tool_name: z.enum([
    'claude_code_run',
    'claude_code_review',
    'claude_code_test',
    'claude_code_refactor',
  ]),
  // Common
  workspace_dir: z.string().optional(),
  // Run
  prompt: z.string().optional(),
  // Review
  files: z.array(z.string()).optional(),
  diff: z.string().optional(),
  // Test
  test_command: z.string().optional(),
  test_files: z.array(z.string()).optional(),
  // Refactor
  refactor_target: z.string().optional(),
  refactor_instructions: z.string().optional(),
  // Approval
  approved: z.boolean().optional(),
});

type Input = z.infer<typeof InputSchema>;

interface ClaudeCodeCreds {
  api_key?: string;
  access_token?: string;
  refresh_token?: string;
  model?: string;
  max_tokens?: number;
}

function getCredentials(): ClaudeCodeCreds {
  const raw = process.env.CLAUDE_CODE_CREDENTIALS;
  if (!raw) throw new Error('CLAUDE_CODE_CREDENTIALS env var is required');
  const creds = JSON.parse(raw) as ClaudeCodeCreds;
  if (!creds.api_key && !creds.access_token) {
    throw new Error('CLAUDE_CODE_CREDENTIALS must contain api_key or access_token');
  }
  return creds;
}

const MAX_OUTPUT_BYTES = 200 * 1024; // 200KB

function truncateOutput(output: string): string {
  if (Buffer.byteLength(output, 'utf-8') > MAX_OUTPUT_BYTES) {
    return output.slice(0, MAX_OUTPUT_BYTES) + '\n... [output truncated at 200KB]';
  }
  return output;
}

async function runClaudeCode(
  prompt: string,
  workspaceDir?: string,
): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  const creds = getCredentials();

  return new Promise((resolve) => {
    const args = ['--print', prompt];

    if (workspaceDir) {
      args.unshift('--cwd', workspaceDir);
    }

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 120_000,
      env: {
        ...process.env,
        ...(creds.api_key ? { ANTHROPIC_API_KEY: creds.api_key } : {}),
        ...(creds.access_token ? { CLAUDE_ACCESS_TOKEN: creds.access_token } : {}),
        ...(creds.model ? { CLAUDE_MODEL: creds.model } : {}),
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    proc.on('close', (code) => {
      resolve({
        stdout: truncateOutput(Buffer.concat(stdoutChunks).toString('utf-8')),
        stderr: truncateOutput(Buffer.concat(stderrChunks).toString('utf-8')),
        exit_code: code ?? 1,
      });
    });

    proc.on('error', (err) => {
      resolve({
        stdout: '',
        stderr: `Failed to run claude: ${err.message}`,
        exit_code: 127,
      });
    });
  });
}

// ── Run ────────────────────────────────────────────

async function claudeCodeRun(input: Input) {
  if (!input.prompt) throw new Error('prompt is required');

  if (input.approved === false) {
    return {
      status: 'requires_approval',
      message: 'Write operation requires explicit approval. Set approved: true to proceed.',
    };
  }

  const result = await runClaudeCode(input.prompt, input.workspace_dir);

  return {
    output: result.stdout,
    stderr: result.stderr,
    exit_code: result.exit_code,
    success: result.exit_code === 0,
  };
}

// ── Review ─────────────────────────────────────────

async function claudeCodeReview(input: Input) {
  let prompt = 'Review the following code changes and provide feedback on:\n- Bugs or potential issues\n- Code quality and best practices\n- Security concerns\n- Suggestions for improvement\n\n';

  if (input.diff) {
    prompt += `Diff:\n\`\`\`\n${input.diff}\n\`\`\`\n`;
  } else if (input.files?.length) {
    prompt += `Files to review: ${input.files.join(', ')}\n`;
    prompt += 'Please read these files and provide a code review.';
  } else {
    prompt += 'Review the recent changes in this workspace (git diff).';
  }

  const result = await runClaudeCode(prompt, input.workspace_dir);

  return {
    review: result.stdout,
    stderr: result.stderr,
    exit_code: result.exit_code,
    success: result.exit_code === 0,
  };
}

// ── Test ───────────────────────────────────────────

async function claudeCodeTest(input: Input) {
  let prompt: string;

  if (input.test_command) {
    prompt = `Run the following test command and report the results: ${input.test_command}`;
  } else if (input.test_files?.length) {
    prompt = `Run tests for the following files and report the results: ${input.test_files.join(', ')}`;
  } else {
    prompt = 'Find and run the test suite for this project. Report which tests pass and which fail.';
  }

  const result = await runClaudeCode(prompt, input.workspace_dir);

  return {
    test_output: result.stdout,
    stderr: result.stderr,
    exit_code: result.exit_code,
    success: result.exit_code === 0,
  };
}

// ── Refactor ───────────────────────────────────────

async function claudeCodeRefactor(input: Input) {
  if (!input.refactor_instructions) throw new Error('refactor_instructions is required');

  // Write operations require approval
  if (input.approved !== true) {
    return {
      status: 'requires_approval',
      message: 'Refactoring involves code changes and requires explicit approval. Set approved: true to proceed.',
      target: input.refactor_target,
      instructions: input.refactor_instructions,
    };
  }

  let prompt = `Refactor the code according to these instructions: ${input.refactor_instructions}`;

  if (input.refactor_target) {
    prompt += `\n\nTarget file/module: ${input.refactor_target}`;
  }

  const result = await runClaudeCode(prompt, input.workspace_dir);

  return {
    output: result.stdout,
    stderr: result.stderr,
    exit_code: result.exit_code,
    success: result.exit_code === 0,
  };
}

// ── Dispatch ───────────────────────────────────────

const handlers: Record<string, (input: Input) => Promise<unknown>> = {
  claude_code_run: claudeCodeRun,
  claude_code_review: claudeCodeReview,
  claude_code_test: claudeCodeTest,
  claude_code_refactor: claudeCodeRefactor,
};

createTool(InputSchema, async (input) => {
  const handler = handlers[input.tool_name];
  if (!handler) throw new Error(`Unknown tool: ${input.tool_name}`);
  return handler(input);
});
