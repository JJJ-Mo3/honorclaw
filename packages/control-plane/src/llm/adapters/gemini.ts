import type { LLMAdapter } from './base.js';
import type { LLMRequest, LLMResponse, ToolCallRequest } from '@honorclaw/core';

/**
 * Adapter for the Google Gemini (Generative Language) REST API.
 *
 * Uses native fetch() — no SDK dependency required.
 * API reference: https://ai.google.dev/api/generate-content
 *
 * Endpoint pattern:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}
 */
export class GeminiAdapter implements LLMAdapter {
  name = 'gemini';
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl =
      baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    // Strip provider prefix: "gemini/gemini-1.5-pro" -> "gemini-1.5-pro"
    const modelName = request.model.includes('/')
      ? request.model.split('/').slice(1).join('/')
      : request.model;

    // Build Gemini "contents" array.
    // Gemini uses "user" and "model" roles (not "assistant").
    // System instructions go into a separate top-level field.
    const systemParts: string[] = [];
    const contents: GeminiContent[] = [];

    for (const msg of request.messages) {
      const textContent =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('');

      if (msg.role === 'system') {
        systemParts.push(textContent);
        continue;
      }

      if (msg.role === 'tool') {
        // Tool results are returned as functionResponse parts
        contents.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: msg.toolCallId ?? 'unknown',
                response: { result: textContent },
              },
            },
          ],
        });
        continue;
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        // Assistant message with tool calls -> functionCall parts
        const parts: GeminiPart[] = [];
        if (textContent) {
          parts.push({ text: textContent });
        }
        for (const tc of msg.toolCalls) {
          parts.push({
            functionCall: {
              name: tc.tool_name,
              args: tc.parameters,
            },
          });
        }
        contents.push({ role: 'model', parts });
        continue;
      }

      const role = msg.role === 'assistant' ? 'model' : 'user';
      contents.push({
        role,
        parts: [{ text: textContent }],
      });
    }

    // Build request body
    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? 4096,
      },
    };

    if (systemParts.length > 0) {
      body.systemInstruction = {
        parts: systemParts.map((text) => ({ text })),
      };
    }

    // Map tools to Gemini function declarations
    if (request.tools?.length) {
      body.tools = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.name,
            description: t.description ?? '',
            parameters: t.parameters ?? { type: 'object', properties: {} },
          })),
        },
      ];
    }

    const url = `${this.baseUrl}/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const status = response.status;

      if (status === 429) {
        throw new Error(`Gemini rate limit exceeded: ${errorBody}`);
      }
      if (status === 401 || status === 403) {
        throw new Error(`Gemini authentication failed: ${errorBody}`);
      }
      if (status === 400) {
        throw new Error(`Gemini bad request: ${errorBody}`);
      }
      throw new Error(`Gemini API error ${status}: ${errorBody}`);
    }

    const data = (await response.json()) as GeminiResponse;

    // Extract the first candidate
    const candidate = data.candidates?.[0];
    if (!candidate) {
      throw new Error('Gemini returned no candidates in response');
    }

    // Parse text content and function calls from parts
    let textContent = '';
    const toolCalls: ToolCallRequest[] = [];

    for (const part of candidate.content?.parts ?? []) {
      if (part.text) {
        textContent += part.text;
      }
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Date.now()}_${toolCalls.length}`,
          tool_name: part.functionCall.name,
          parameters: (part.functionCall.args as Record<string, unknown>) ?? {},
        });
      }
    }

    // Map Gemini finish reasons to HonorClaw finish reasons
    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';
    const geminiReason = candidate.finishReason;
    if (toolCalls.length > 0) {
      finishReason = 'tool_calls';
    } else if (geminiReason === 'MAX_TOKENS') {
      finishReason = 'length';
    } else if (geminiReason === 'SAFETY' || geminiReason === 'RECITATION') {
      finishReason = 'error';
    }

    // Gemini provides token counts in usageMetadata
    const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      sessionId: request.sessionId,
      correlationId: request.correlationId,
      content: textContent || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      },
      model: request.model,
      finishReason,
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Gemini API types (subset relevant to this adapter)                */
/* ------------------------------------------------------------------ */

interface GeminiPart {
  text?: string;
  functionCall?: {
    name: string;
    args: unknown;
  };
  functionResponse?: {
    name: string;
    response: unknown;
  };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: {
    parts: GeminiPart[];
    role: string;
  };
  finishReason?: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsageMetadata;
}
