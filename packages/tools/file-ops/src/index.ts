// HonorClaw Tool: File Operations — read, write, and list files in agent workspace
import { createTool, z } from '@honorclaw/tool-sdk';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';

const InputSchema = z.object({
  tool_name: z.enum(['read_file', 'write_file', 'list_directory']),
  path: z.string(),
  content: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;

const MAX_READ_BYTES = 500 * 1024; // 500KB

function getWorkspaceRoot(): string {
  return process.env.HONORCLAW_WORKSPACE ?? process.env.HOME ?? '/tmp';
}

function resolveSafePath(inputPath: string): string {
  const root = getWorkspaceRoot();
  const resolved = resolve(root, inputPath);

  // Prevent path traversal outside workspace
  if (!resolved.startsWith(root)) {
    throw new Error(`Path traversal detected: path must be within workspace root ${root}`);
  }

  return resolved;
}

// ── Read File ──────────────────────────────────────

async function readFileHandler(input: Input) {
  const filePath = resolveSafePath(input.path);

  const stats = await stat(filePath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${input.path}`);
  }

  const buffer = await readFile(filePath);
  let content = buffer.toString('utf-8');
  let truncated = false;

  if (buffer.byteLength > MAX_READ_BYTES) {
    content = buffer.subarray(0, MAX_READ_BYTES).toString('utf-8');
    truncated = true;
  }

  return {
    path: input.path,
    content,
    size: stats.size,
    truncated,
    modified: stats.mtime.toISOString(),
  };
}

// ── Write File ─────────────────────────────────────

async function writeFileHandler(input: Input) {
  if (input.content === undefined) throw new Error('content is required');

  const filePath = resolveSafePath(input.path);

  // Ensure parent directory exists
  await mkdir(dirname(filePath), { recursive: true });

  await writeFile(filePath, input.content, 'utf-8');

  const stats = await stat(filePath);

  return {
    success: true,
    path: input.path,
    size: stats.size,
    modified: stats.mtime.toISOString(),
  };
}

// ── List Directory ─────────────────────────────────

async function listDirectoryHandler(input: Input) {
  const dirPath = resolveSafePath(input.path);

  const stats = await stat(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${input.path}`);
  }

  const entries = await readdir(dirPath, { withFileTypes: true });

  const results = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(dirPath, entry.name);
      try {
        const entryStat = await stat(entryPath);
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' as const : 'file' as const,
          size: entryStat.size,
          modified: entryStat.mtime.toISOString(),
        };
      } catch {
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' as const : 'file' as const,
          size: 0,
        };
      }
    }),
  );

  return {
    path: input.path,
    entries: results,
    count: results.length,
  };
}

// ── Dispatch ───────────────────────────────────────

const handlers: Record<string, (input: Input) => Promise<unknown>> = {
  read_file: readFileHandler,
  write_file: writeFileHandler,
  list_directory: listDirectoryHandler,
};

createTool(InputSchema, async (input) => {
  const handler = handlers[input.tool_name];
  if (!handler) throw new Error(`Unknown tool: ${input.tool_name}`);
  return handler(input);
});
