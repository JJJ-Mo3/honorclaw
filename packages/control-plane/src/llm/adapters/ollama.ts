import type { LLMAdapter } from './base.js';
import type { LLMRequest, LLMResponse, ToolCallRequest } from '@honorclaw/core';

export class OllamaAdapter implements LLMAdapter {
  name = 'ollama';
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const modelName = request.model.includes('/') ? request.model.split('/')[1] : request.model;

    const messages = request.messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    const body: Record<string, unknown> = {
      model: modelName,
      messages,
      stream: false,
      options: { num_predict: request.maxTokens ?? 4096 },
    };

    // Add tools if present
    if (request.tools?.length) {
      body.tools = request.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.parameters ?? { type: 'object', properties: {} },
        },
      }));
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as any;
    const assistantMessage = data.message;

    // Parse tool calls
    const toolCalls: ToolCallRequest[] = (assistantMessage?.tool_calls ?? []).map((tc: any, i: number) => ({
      id: `call_${Date.now()}_${i}`,
      tool_name: tc.function?.name ?? 'unknown',
      parameters: tc.function?.arguments ?? {},
    }));

    const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';

    return {
      sessionId: request.sessionId,
      correlationId: request.correlationId,
      content: assistantMessage?.content ?? null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed: {
        prompt: data.prompt_eval_count ?? 0,
        completion: data.eval_count ?? 0,
        total: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
      model: request.model,
      finishReason: finishReason as 'stop' | 'tool_calls',
    };
  }
}
