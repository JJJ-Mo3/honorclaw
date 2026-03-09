import type { Redis } from 'ioredis';
import type { LLMRequest, LLMResponse, OutputFilterProvider } from '@honorclaw/core';
import { LLMRequestSchema } from '@honorclaw/core';
import type { AuditEmitter } from '../audit/emitter.js';
import type { LlmConfig } from '@honorclaw/core';
import { OllamaAdapter } from './adapters/ollama.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { GeminiAdapter } from './adapters/gemini.js';
import type { LLMAdapter } from './adapters/base.js';
import { RegexOutputFilterProvider } from '@honorclaw/providers-built-in';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export class LLMRouter {
  private adapters = new Map<string, LLMAdapter>();
  private redis: Redis;
  private auditEmitter: AuditEmitter;
  private outputFilter: OutputFilterProvider;

  constructor(config: LlmConfig, redis: Redis, auditEmitter: AuditEmitter) {
    this.redis = redis;
    this.auditEmitter = auditEmitter;
    this.outputFilter = new RegexOutputFilterProvider();

    // Register adapters based on available configuration / credentials.
    // Each adapter is only registered when credentials are present or when
    // it does not require credentials (Ollama).

    // Ollama — always registered (local, no API key needed)
    this.adapters.set('ollama', new OllamaAdapter(
      config.providers?.ollama?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    ));

    // Anthropic (supports API key or OAuth access token)
    const anthropicConfig = config.providers?.anthropic;
    const anthropicKey =
      anthropicConfig?.apiKeySecret ?? process.env.ANTHROPIC_API_KEY;
    const anthropicAccessToken =
      anthropicConfig?.accessTokenSecret ?? process.env.CLAUDE_ACCESS_TOKEN;
    if ((anthropicKey || anthropicAccessToken) && anthropicConfig?.enabled !== false) {
      this.adapters.set('anthropic', new AnthropicAdapter({
        apiKey: anthropicKey,
        accessToken: anthropicAccessToken,
        baseUrl: anthropicConfig?.baseUrl,
      }));
      logger.info({ authMode: anthropicAccessToken ? 'oauth' : 'api_key' }, 'Registered LLM adapter: anthropic');
    }

    // OpenAI
    const openaiKey =
      config.providers?.openai?.apiKeySecret ?? process.env.OPENAI_API_KEY;
    if (openaiKey && config.providers?.openai?.enabled !== false) {
      this.adapters.set('openai', new OpenAIAdapter({
        apiKey: openaiKey,
        baseUrl: config.providers?.openai?.baseUrl,
      }));
      logger.info('Registered LLM adapter: openai');
    }

    // Azure OpenAI — registered under the "azure" provider prefix
    const azureKey =
      config.providers?.azure?.apiKeySecret ?? process.env.AZURE_OPENAI_API_KEY;
    const azureEndpoint =
      config.providers?.azure?.baseUrl ?? process.env.AZURE_OPENAI_ENDPOINT;
    if (azureKey && azureEndpoint && config.providers?.azure?.enabled !== false) {
      this.adapters.set('azure', new OpenAIAdapter({
        apiKey: azureKey,
        baseUrl: azureEndpoint,
        isAzure: true,
      }));
      logger.info('Registered LLM adapter: azure (OpenAI)');
    }

    // Google Gemini
    const geminiKey =
      config.providers?.gemini?.apiKeySecret ?? process.env.GOOGLE_AI_API_KEY;
    if (geminiKey && config.providers?.gemini?.enabled !== false) {
      this.adapters.set('gemini', new GeminiAdapter(
        geminiKey,
        config.providers?.gemini?.baseUrl,
      ));
      logger.info('Registered LLM adapter: gemini');
    }
  }

  async start(): Promise<void> {
    // Subscribe to LLM request channels
    const sub = this.redis.duplicate();
    await sub.psubscribe('llm:*:request');

    sub.on('pmessage', async (_pattern: string, channel: string, message: string) => {
      try {
        const request = LLMRequestSchema.parse(JSON.parse(message));
        await this.handleRequest(request);
      } catch (err) {
        logger.error({ err, channel }, 'LLM request handling error');
      }
    });
  }

  async handleRequest(request: LLMRequest): Promise<void> {
    const startTime = Date.now();
    const [providerName] = request.model.split('/');
    const adapter = this.adapters.get(providerName ?? 'ollama');

    if (!adapter) {
      const errorResponse: LLMResponse = {
        sessionId: request.sessionId,
        correlationId: request.correlationId,
        content: `Error: Unknown LLM provider "${providerName}"`,
        tokensUsed: { prompt: 0, completion: 0, total: 0 },
        model: request.model,
        finishReason: 'error',
      };
      await this.redis.lpush(
        `llm:${request.sessionId}:response:${request.correlationId}`,
        JSON.stringify(errorResponse),
      );
      return;
    }

    try {
      let response: LLMResponse;

      if (request.stream && adapter.completeStream) {
        // Streaming mode: push intermediate chunks to a dedicated Redis list
        const streamChannel = `llm:${request.sessionId}:stream:${request.correlationId}`;
        response = await adapter.completeStream(request, async (chunk: string) => {
          await this.redis.lpush(streamChannel, JSON.stringify({ chunk, done: false }));
        });
        // Signal end of stream
        await this.redis.lpush(streamChannel, JSON.stringify({ chunk: '', done: true }));
      } else {
        response = await adapter.complete(request);
      }

      const duration = Date.now() - startTime;

      // Apply output filter to redact PII / credentials from LLM response
      const filteredResponse = await this.applyOutputFilter(request.sessionId, response);

      // Push response to the agent
      await this.redis.lpush(
        `llm:${request.sessionId}:response:${request.correlationId}`,
        JSON.stringify(filteredResponse),
      );

      // Audit
      this.auditEmitter.emit({
        workspaceId: '00000000-0000-0000-0000-000000000000', // TODO: resolve from session
        eventType: 'llm.interaction',
        actorType: 'agent',
        sessionId: request.sessionId,
        payload: {
          model: request.model,
          tokensUsed: filteredResponse.tokensUsed,
          durationMs: duration,
          finishReason: filteredResponse.finishReason,
        },
      });
    } catch (err) {
      logger.error({ err, model: request.model }, 'LLM adapter error');
      const errorResponse: LLMResponse = {
        sessionId: request.sessionId,
        correlationId: request.correlationId,
        content: `LLM error: ${err instanceof Error ? err.message : 'Unknown'}`,
        tokensUsed: { prompt: 0, completion: 0, total: 0 },
        model: request.model,
        finishReason: 'error',
      };
      await this.redis.lpush(
        `llm:${request.sessionId}:response:${request.correlationId}`,
        JSON.stringify(errorResponse),
      );
    }
  }

  /**
   * Apply the output filter to an LLM response, redacting PII and credentials
   * from text content. Returns a new response object with filtered content.
   */
  private async applyOutputFilter(sessionId: string, response: LLMResponse): Promise<LLMResponse> {
    if (response.content == null) {
      return response;
    }

    // Resolve context for the filter (best-effort from session context)
    let workspaceId = '00000000-0000-0000-0000-000000000000';
    let agentId = 'unknown';
    try {
      const contextRaw = await this.redis.get(`session:${sessionId}:context`);
      if (contextRaw) {
        const ctx = JSON.parse(contextRaw) as { workspaceId?: string; agentId?: string };
        workspaceId = ctx.workspaceId ?? workspaceId;
        agentId = ctx.agentId ?? agentId;
      }
    } catch {
      // Non-fatal: use defaults
    }

    const filterContext = { workspaceId, agentId };

    if (typeof response.content === 'string') {
      const { filtered, findings } = await this.outputFilter.filter(response.content, filterContext);
      if (findings.length > 0) {
        logger.warn({ sessionId, findingCount: findings.length, types: findings.map(f => f.type) }, 'Output filter redacted content');
      }
      return { ...response, content: filtered };
    }

    // Handle array content (ContentPart[])
    if (Array.isArray(response.content)) {
      const filteredParts = await Promise.all(
        response.content.map(async (part) => {
          if (part.type === 'text') {
            const { filtered, findings } = await this.outputFilter.filter(part.text, filterContext);
            if (findings.length > 0) {
              logger.warn({ sessionId, findingCount: findings.length, types: findings.map(f => f.type) }, 'Output filter redacted content part');
            }
            return { ...part, text: filtered };
          }
          return part;
        }),
      );
      return { ...response, content: filteredParts };
    }

    return response;
  }
}
