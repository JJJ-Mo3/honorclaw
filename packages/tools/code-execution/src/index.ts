// HonorClaw Tool: Code Execution — sandboxed code runner
import { createTool, z } from '@honorclaw/tool-sdk';
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const InputSchema = z.object({
  language: z.enum(['python', 'javascript', 'typescript']),
  code: z.string(),
  timeout_ms: z.number().optional(),
});

type Input = z.infer<typeof InputSchema>;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB

function truncateOutput(output: string): string {
  if (Buffer.byteLength(output, 'utf-8') > MAX_OUTPUT_BYTES) {
    return output.slice(0, MAX_OUTPUT_BYTES) + '\n... [output truncated at 100KB]';
  }
  return output;
}

async function executeInProcess(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: {
        ...process.env,
        // Minimal env for sandboxed execution
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: 'en_US.UTF-8',
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk);
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk);
      }
    });

    proc.on('close', (code, signal) => {
      const stdout = truncateOutput(Buffer.concat(stdoutChunks).toString('utf-8'));
      const stderr = truncateOutput(Buffer.concat(stderrChunks).toString('utf-8'));

      if (signal === 'SIGTERM') {
        resolve({
          stdout,
          stderr: stderr + '\n[Process killed: timeout exceeded]',
          exit_code: 124, // standard timeout exit code
        });
      } else {
        resolve({ stdout, stderr, exit_code: code ?? 1 });
      }
    });

    proc.on('error', (err) => {
      resolve({
        stdout: '',
        stderr: `Failed to spawn process: ${err.message}`,
        exit_code: 127,
      });
    });
  });
}

createTool(InputSchema, async (input: Input) => {
  const timeoutMs = Math.min(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

  // Create a temporary directory for the code file
  const tempDir = await mkdtemp(join(tmpdir(), 'honorclaw-exec-'));

  try {
    let command: string;
    let args: string[];
    let filename: string;

    switch (input.language) {
      case 'python': {
        filename = 'script.py';
        command = 'python3';
        args = [join(tempDir, filename)];
        break;
      }
      case 'javascript': {
        filename = 'script.mjs';
        command = 'node';
        args = ['--experimental-vm-modules', join(tempDir, filename)];
        break;
      }
      case 'typescript': {
        filename = 'script.ts';
        // Use tsx or ts-node for TypeScript execution
        command = 'npx';
        args = ['tsx', join(tempDir, filename)];
        break;
      }
    }

    await writeFile(join(tempDir, filename), input.code, 'utf-8');

    const result = await executeInProcess(command, args, timeoutMs);

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exit_code: result.exit_code,
      language: input.language,
      timed_out: result.exit_code === 124,
    };
  } finally {
    // Cleanup temp directory
    await rm(tempDir, { recursive: true, force: true }).catch(() => { /* ignore cleanup errors */ });
  }
});
