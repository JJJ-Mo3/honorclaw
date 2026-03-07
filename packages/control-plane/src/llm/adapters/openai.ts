import type { LLMAdapter } from './base.js';
import type { LLMRequest, LLMResponse, ToolCallRequest } from '@honorclaw/core';

/**
 * Adapter for the OpenAI Chat Completions API.
 *
 * Also supports Azure OpenAI by providing an Azure-specific endpoint and API key.
 * Uses native fetch() — no SDK dependency required.
 *
 * OpenAI:  POST https://api.openai.com/v1/chat/completions
 * Azure:   POST https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=2024-02-01
 */
export class OpenAIAdapter implements LLMAdapter {
  name = 'openai';
  private apiKey: string;
  private baseUrl: string;
  private isAzure: boolean;
  private azureApiVersion: string;

  constructor(options: {
    apiKey: string;
    baseUrl?: string;
    isAzure?: boolean;
    azureApiVersion?: string;
  }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.isAzure = options.isAzure ?? false;
    this.azureApiVersion = options.azureApiVersion ?? '2024-02-01';
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    // Strip provider prefix: "openai/gpt-4o" -> "gpt-4o"
    const modelName = request.model.includes('/')
      ? request.model.split('/').slice(1).join('/')
      : request.model;

    // Map HonorClaw messages to OpenAI format
    const messages = request.messages.map((msg) => {
      const textContent =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('');

      if (msg.role === 'tool') {
        return {
          role: 'tool' as const,
          content: textContent,
          tool_call_id: msg.toolCallId ?? 'unknown',
        };
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        return {
          role: 'assistant' as const,
          content: textContent || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.tool_name,
              arguments: JSON.stringify(tc.parameters),
            },
          })),
        };
      }

      return {
        role: msg.role as 'system' | 'user' | 'assistant',
        content: textContent,
      };
    });

    // Build request body
    const body: Record<string, unknown> = {
      model: modelName,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    };

    // Map tools to OpenAI function-calling format
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.parameters ?? { type: 'object', properties: {} },
        },
      }));
    }

    // Determine endpoint URL
    let url: string;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };

    if (this.isAzure) {
      // Azure OpenAI uses a different URL pattern and auth header
      url = `${this.baseUrl}/chat/completions?api-version=${this.azureApiVersion}`;
      headers['api-key'] = this.apiKey;
    } else {
      url = `${this.baseUrl}/chat/completions`;
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const status = response.status;

      if (status === 429) {
        throw new Error(`OpenAI rate limit exceeded: ${errorBody}`);
      }
      if (status === 401) {
        throw new Error(`OpenAI authentication failed: invalid API key`);
      }
      if (status === 400) {
        throw new Error(`OpenAI bad request: ${errorBody}`);
      }
      throw new Error(`OpenAI API error ${status}: ${errorBody}`);
    }

    const data = (await response.json()) as OpenAIChatResponse;
    const choice = data.choices?.[0];

    if (!choice) {
      throw new Error('OpenAI returned no choices in response');
    }

    // Parse tool calls from the response
    const toolCalls: ToolCallRequest[] = (choice.message?.tool_calls ?? []).map(
      (tc) => ({
        id: tc.id,
        tool_name: tc.function.name,
        parameters: safeJsonParse(tc.function.arguments),
      }),
    );

    // Map OpenAI finish reasons to HonorClaw finish reasons
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';
    if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
      finishReason = 'tool_calls';
    } else if (choice.finish_reason === 'length') {
      finishReason = 'length';
    }

    return {
      sessionId: request.sessionId,
      correlationId: request.correlationId,
      content: choice.message?.content ?? null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed: {
        prompt: data.usage?.prompt_tokens ?? 0,
        completion: data.usage?.completion_tokens ?? 0,
        total: data.usage?.total_tokens ?? 0,
      },
      model: request.model,
      finishReason,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function safeJsonParse(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return { _raw: str };
  }
}

/* ------------------------------------------------------------------ */
/*  OpenAI API response types (subset)                                */
/* ------------------------------------------------------------------ */

interface OpenAIToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIChatChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string;
}

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenAIChatResponse {
  id: string;
  object: string;
  choices: OpenAIChatChoice[];
  usage: OpenAIUsage;
}
