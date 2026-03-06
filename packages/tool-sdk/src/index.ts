import { z } from 'zod';

// Tool SDK Protocol
// Input: HONORCLAW_TOOL_INPUT env var (JSON) — primary
// Output: single JSON line to stdout
// Logs: stderr ONLY
// Exit: 0=success, 1=error, 2=timeout

export const ToolInputSchema = z.record(z.unknown());

export const ToolSuccessSchema = z.object({
  status: z.literal('success'),
  result: z.unknown(),
});

export const ToolErrorSchema = z.object({
  status: z.literal('error'),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const ToolOutputSchema = z.discriminatedUnion('status', [
  ToolSuccessSchema,
  ToolErrorSchema,
]);

export type ToolInput = z.infer<typeof ToolInputSchema>;
export type ToolOutput = z.infer<typeof ToolOutputSchema>;

export interface ToolHandler<TInput = Record<string, unknown>, TResult = unknown> {
  (input: TInput): Promise<TResult>;
}

export function createTool<TInput extends Record<string, unknown>, TResult>(
  schema: z.ZodType<TInput>,
  handler: ToolHandler<TInput, TResult>,
): void {
  const run = async () => {
    try {
      // Read input from env var (primary) or stdin (fallback)
      let rawInput: string | undefined = process.env.HONORCLAW_TOOL_INPUT;

      if (!rawInput) {
        // Stdin fallback for large inputs
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk as Buffer);
        }
        rawInput = Buffer.concat(chunks).toString('utf-8');
      }

      if (!rawInput) {
        writeOutput({ status: 'error', error: { code: 'no_input', message: 'No input provided' } });
        process.exit(1);
      }

      const parsed = JSON.parse(rawInput);
      const validated = schema.parse(parsed);
      const result = await handler(validated);

      writeOutput({ status: 'success', result });
      process.exit(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const code = err instanceof z.ZodError ? 'validation_error' : 'execution_error';
      writeOutput({ status: 'error', error: { code, message } });
      process.exit(1);
    }
  };

  // Set up timeout
  const timeout = parseInt(process.env.HONORCLAW_TOOL_TIMEOUT ?? '30', 10) * 1000;
  const timer = setTimeout(() => {
    writeOutput({ status: 'error', error: { code: 'timeout', message: 'Tool execution timed out' } });
    process.exit(2);
  }, timeout);
  timer.unref();

  run();
}

function writeOutput(output: ToolOutput): void {
  process.stdout.write(JSON.stringify(output) + '\n');
}

export { z } from 'zod';
