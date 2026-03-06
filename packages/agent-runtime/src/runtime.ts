import { RedisChannels } from '@honorclaw/core';
import type { LLMRequest, LLMResponse, ToolCallResult } from '@honorclaw/core';
import { AgentInputMessageSchema, LLMResponseSchema, ToolCallResultSchema, SessionControlSchema } from '@honorclaw/core';
import { Transport } from './transport.js';
import { SessionState } from './session.js';
import { NaiveContextManager } from './context-manager.js';
import type { Logger } from 'pino';
import crypto from 'node:crypto';

interface RuntimeConfig {
  sessionId: string;
  redisUrl: string;
  logger: Logger;
}

export async function runtime(config: RuntimeConfig): Promise<void> {
  const { sessionId, redisUrl, logger } = config;
  const transport = new Transport(redisUrl, logger);
  await transport.connect();

  const session = new SessionState(sessionId);
  const contextManager = new NaiveContextManager();
  let draining = false;

  // Listen for control commands
  transport.subscribe(RedisChannels.sessionControl(sessionId), async (data) => {
    const control = SessionControlSchema.parse(data);
    if (control.command === 'drain' || control.command === 'terminate') {
      logger.info({ command: control.command }, 'Received control command');
      draining = true;
    }
  });

  // Main message loop
  transport.subscribe(RedisChannels.agentInput(sessionId), async (data) => {
    if (draining) {
      logger.warn('Draining — ignoring new input');
      return;
    }

    try {
      const input = AgentInputMessageSchema.parse(data);
      logger.info({ senderId: input.senderId }, 'Received user message');

      session.addMessage({ role: 'user', content: input.content });

      // Get session context from Redis (set by Control Plane at session start)
      const sessionContext = await transport.getSessionContext(sessionId);
      const tokenBudget = sessionContext?.maxTokens ?? 100_000;

      // Prepare messages within token budget
      const messages = await contextManager.prepare(session.messages, tokenBudget);

      // Build tools list from session context
      const tools = sessionContext?.tools ?? [];

      let continueLoop = true;
      while (continueLoop) {
        const correlationId = crypto.randomUUID();

        // Send LLM request
        const llmRequest: LLMRequest = {
          sessionId,
          correlationId,
          messages: messages.map(m => ({
            role: m.role,
            content: m.content,
            toolCalls: m.tool_calls,
            toolCallId: m.tool_call_id,
          })),
          tools,
          model: sessionContext?.model ?? 'ollama/llama3.2',
          maxTokens: Math.min(4096, tokenBudget),
        };

        await transport.publish(RedisChannels.llmRequest(sessionId), llmRequest);

        // Wait for LLM response (blocking pop)
        const llmResponseRaw = await transport.blpop(
          `llm:${sessionId}:response:${correlationId}`,
          sessionContext?.toolTimeoutSeconds ?? 60,
        );

        if (!llmResponseRaw) {
          logger.error('LLM response timeout');
          await transport.publish(RedisChannels.agentError(sessionId), {
            sessionId,
            error: { code: 'llm_timeout', message: 'LLM response timed out' },
          });
          continueLoop = false;
          break;
        }

        const llmResponse = LLMResponseSchema.parse(llmResponseRaw);

        // Handle tool calls
        if (llmResponse.finishReason === 'tool_calls' && llmResponse.toolCalls?.length) {
          // Add assistant message with tool calls
          const assistantContent = llmResponse.content ?? '';
          session.addMessage({
            role: 'assistant',
            content: typeof assistantContent === 'string' ? assistantContent : assistantContent,
            tool_calls: llmResponse.toolCalls,
          });

          // Execute each tool call
          for (const toolCall of llmResponse.toolCalls) {
            await transport.publish(
              RedisChannels.toolRequest(sessionId, toolCall.id),
              { sessionId, callId: toolCall.id, toolName: toolCall.tool_name, parameters: toolCall.parameters },
            );

            // Wait for tool result (blocking pop)
            const resultRaw = await transport.blpop(
              RedisChannels.toolResult(sessionId, toolCall.id),
              sessionContext?.toolTimeoutSeconds ?? 60,
            );

            const result: ToolCallResult = resultRaw
              ? ToolCallResultSchema.parse(resultRaw)
              : { sessionId, callId: toolCall.id, status: 'timeout' as const, error: { code: 'tool_timeout', message: `Tool call timed out` } };

            const toolContent = typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result ?? result.error);

            session.addMessage({
              role: 'tool',
              content: toolContent,
              tool_call_id: toolCall.id,
            });

            messages.push({
              role: 'tool' as const,
              content: toolContent,
              tool_call_id: toolCall.id,
            });
          }

          // Continue loop to get final response after tool calls
          continue;
        }

        // Final response — no tool calls
        if (llmResponse.content) {
          session.addMessage({ role: 'assistant', content: llmResponse.content });
          await transport.publish(RedisChannels.agentOutput(sessionId), {
            sessionId,
            content: llmResponse.content,
            timestamp: new Date().toISOString(),
          });
        }

        continueLoop = false;
      }

      // Checkpoint state
      await transport.set(
        RedisChannels.sessionState(sessionId),
        JSON.stringify({ messages: session.messages }),
      );
    } catch (err) {
      logger.error({ err }, 'Error processing message');
      await transport.publish(RedisChannels.agentError(sessionId), {
        sessionId,
        error: { code: 'runtime_error', message: err instanceof Error ? err.message : 'Unknown error' },
      });
    }
  });

  logger.info({ sessionId }, 'Agent runtime ready');

  // Keep alive
  await new Promise<void>((resolve) => {
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down');
      draining = true;
      await transport.disconnect();
      resolve();
    });
  });
}
