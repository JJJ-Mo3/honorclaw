import type { LLMAdapter, StreamChunkCallback } from './base.js';
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
      // Auto-pull the model on 404 and retry once
      if (response.status === 404) {
        const pulled = await this.autoPull(modelName!);
        if (pulled) {
          const retry = await fetch(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (retry.ok) {
            const retryData = await retry.json() as any;
            return this.parseNonStreamingResponse(retryData, request);
          }
        }
      }
      throw new Error(`Ollama API error: ${response.status} ${await response.text()}`);
    }

    const data = await response.json() as any;
    return this.parseNonStreamingResponse(data, request);
  }

  async completeStream(
    request: LLMRequest,
    onChunk: StreamChunkCallback,
  ): Promise<LLMResponse> {
    const modelName = request.model.includes('/') ? request.model.split('/')[1] : request.model;

    const messages = request.messages.map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    const body: Record<string, unknown> = {
      model: modelName,
      messages,
      stream: true,
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

    if (!response.body) {
      throw new Error('Ollama streaming response has no body');
    }

    // Parse the NDJSON stream from Ollama
    let accumulatedContent = '';
    let lastData: any = null;
    const allToolCalls: any[] = [];

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines from the buffer (NDJSON: one JSON object per line)
        const lines = buffer.split('\n');
        // Keep the last partial line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let chunk: any;
          try {
            chunk = JSON.parse(trimmed);
          } catch {
            // Skip malformed lines
            continue;
          }

          lastData = chunk;

          // Emit text content chunks
          const chunkContent = chunk.message?.content ?? '';
          if (chunkContent) {
            accumulatedContent += chunkContent;
            onChunk(chunkContent);
          }

          // Collect tool calls from the final message
          if (chunk.message?.tool_calls?.length) {
            allToolCalls.push(...chunk.message.tool_calls);
          }
        }
      }

      // Process any remaining buffer content
      if (buffer.trim()) {
        try {
          const chunk = JSON.parse(buffer.trim());
          lastData = chunk;
          const chunkContent = chunk.message?.content ?? '';
          if (chunkContent) {
            accumulatedContent += chunkContent;
            onChunk(chunkContent);
          }
          if (chunk.message?.tool_calls?.length) {
            allToolCalls.push(...chunk.message.tool_calls);
          }
        } catch {
          // Ignore trailing partial data
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Parse tool calls
    const toolCalls: ToolCallRequest[] = allToolCalls.map((tc: any, i: number) => ({
      id: `call_${Date.now()}_${i}`,
      tool_name: tc.function?.name ?? 'unknown',
      parameters: tc.function?.arguments ?? {},
    }));

    const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';

    return {
      sessionId: request.sessionId,
      correlationId: request.correlationId,
      content: accumulatedContent || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed: {
        prompt: lastData?.prompt_eval_count ?? 0,
        completion: lastData?.eval_count ?? 0,
        total: (lastData?.prompt_eval_count ?? 0) + (lastData?.eval_count ?? 0),
      },
      model: request.model,
      finishReason: finishReason as 'stop' | 'tool_calls',
    };
  }

  /** Pull a model from the Ollama registry. Returns true on success. */
  private async autoPull(modelName: string): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName, stream: false }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  private parseNonStreamingResponse(data: any, request: LLMRequest): LLMResponse {
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
