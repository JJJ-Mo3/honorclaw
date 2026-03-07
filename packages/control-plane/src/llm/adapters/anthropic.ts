import type { LLMAdapter } from './base.js';
import type { LLMRequest, LLMResponse, ToolCallRequest } from '@honorclaw/core';

/**
 * Adapter for the Anthropic Messages API (Claude models).
 *
 * Uses native fetch() — no SDK dependency required.
 * API reference: https://docs.anthropic.com/en/api/messages
 */
export class AnthropicAdapter implements LLMAdapter {
  name = 'anthropic';
  private apiKey: string;
  private baseUrl: string;
  private anthropicVersion: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? 'https://api.anthropic.com';
    this.anthropicVersion = '2023-06-01';
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    // Strip provider prefix: "anthropic/claude-sonnet-4-20250514" -> "claude-sonnet-4-20250514"
    const modelName = request.model.includes('/')
      ? request.model.split('/').slice(1).join('/')
      : request.model;

    // Separate system messages from conversation messages.
    // Anthropic expects system as a top-level parameter, not in the messages array.
    const systemParts: string[] = [];
    const conversationMessages: Array<{
      role: 'user' | 'assistant';
      content: string | Array<Record<string, unknown>>;
    }> = [];

    for (const msg of request.messages) {
      const textContent =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('');

      if (msg.role === 'system') {
        systemParts.push(textContent);
        continue;
      }

      // Anthropic only accepts "user" and "assistant" roles in messages.
      // Tool results are sent as "user" messages with tool_result content blocks.
      if (msg.role === 'tool') {
        conversationMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId ?? 'unknown',
              content: textContent,
            },
          ],
        });
        continue;
      }

      // Handle assistant messages with tool calls
      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const contentBlocks: Array<Record<string, unknown>> = [];
        if (textContent) {
          contentBlocks.push({ type: 'text', text: textContent });
        }
        for (const tc of msg.toolCalls) {
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.tool_name,
            input: tc.parameters,
          });
        }
        conversationMessages.push({
          role: 'assistant',
          content: contentBlocks,
        });
        continue;
      }

      // Plain user or assistant message
      const role = msg.role === 'user' ? 'user' : 'assistant';
      conversationMessages.push({ role, content: textContent });
    }

    // Build request body
    const body: Record<string, unknown> = {
      model: modelName,
      max_tokens: request.maxTokens ?? 4096,
      messages: conversationMessages,
    };

    if (systemParts.length > 0) {
      body.system = systemParts.join('\n\n');
    }

    // Map tools to Anthropic tool format
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.parameters ?? { type: 'object', properties: {} },
      }));
    }

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.anthropicVersion,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const status = response.status;

      if (status === 429) {
        throw new Error(`Anthropic rate limit exceeded: ${errorBody}`);
      }
      if (status === 401) {
        throw new Error(`Anthropic authentication failed: invalid API key`);
      }
      if (status === 400) {
        throw new Error(`Anthropic bad request: ${errorBody}`);
      }
      throw new Error(`Anthropic API error ${status}: ${errorBody}`);
    }

    const data = (await response.json()) as AnthropicResponse;

    // Extract text content and tool use blocks from the response
    let textContent = '';
    const toolCalls: ToolCallRequest[] = [];

    for (const block of data.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? `call_${Date.now()}_${toolCalls.length}`,
          tool_name: block.name ?? 'unknown',
          parameters: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    // Map Anthropic stop reasons to HonorClaw finish reasons
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';
    if (data.stop_reason === 'tool_use') {
      finishReason = 'tool_calls';
    } else if (data.stop_reason === 'max_tokens') {
      finishReason = 'length';
    }

    return {
      sessionId: request.sessionId,
      correlationId: request.correlationId,
      content: textContent || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed: {
        prompt: data.usage?.input_tokens ?? 0,
        completion: data.usage?.output_tokens ?? 0,
        total: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
      model: request.model,
      finishReason,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Anthropic API response types (subset relevant to this adapter)    */
/* ------------------------------------------------------------------ */

interface AnthropicContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  usage: AnthropicUsage;
}
