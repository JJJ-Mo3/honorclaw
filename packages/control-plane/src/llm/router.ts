import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { LLMRequest, LLMResponse, OutputFilterProvider } from '@honorclaw/core';
import { LLMRequestSchema } from '@honorclaw/core';
import type { AuditEmitter } from '../audit/emitter.js';
import type { LlmConfig } from '@honorclaw/core';
import { OllamaAdapter } from './adapters/ollama.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { OpenAIAdapter } from './adapters/openai.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { BedrockAdapter } from './adapters/bedrock.js';
import { VertexAdapter } from './adapters/vertex.js';
import type { LLMAdapter } from './adapters/base.js';
import { RegexOutputFilterProvider } from '@honorclaw/providers-built-in';
import { decryptSecret } from '../auth/crypto.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export class LLMRouter {
  private adapters = new Map<string, LLMAdapter>();
  private redis: Redis;
  private db: Pool;
  private auditEmitter: AuditEmitter;
  private outputFilter: OutputFilterProvider;
  private config: LlmConfig;

  constructor(config: LlmConfig, redis: Redis, auditEmitter: AuditEmitter, db: Pool) {
    this.redis = redis;
    this.db = db;
    this.auditEmitter = auditEmitter;
    this.config = config;
    this.outputFilter = new RegexOutputFilterProvider();

    // Register adapters based on available configuration / credentials.
    // Each adapter is only registered when credentials are present or when
    // it does not require credentials (Ollama).

    // Ollama — always registered (local, no API key needed)
    this.adapters.set('ollama', new OllamaAdapter(
      config.providers?.ollama?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    ));

    // Anthropic (direct API key)
    const anthropicKey =
      config.providers?.anthropic?.apiKeySecret ?? process.env.ANTHROPIC_API_KEY;
    if (anthropicKey && config.providers?.anthropic?.enabled !== false) {
      this.adapters.set('anthropic', new AnthropicAdapter({
        apiKey: anthropicKey,
        baseUrl: config.providers?.anthropic?.baseUrl,
      }));
      logger.info('Registered LLM adapter: anthropic');
    }

    // AWS Bedrock (Claude via IAM credentials — no Anthropic API key needed)
    const bedrockAccessKeyId =
      config.providers?.bedrock?.apiKeySecret ?? process.env.AWS_ACCESS_KEY_ID;
    const bedrockSecretKey =
      config.providers?.bedrock?.accessTokenSecret ?? process.env.AWS_SECRET_ACCESS_KEY;
    if (bedrockAccessKeyId && bedrockSecretKey && config.providers?.bedrock?.enabled !== false) {
      this.adapters.set('bedrock', new BedrockAdapter({
        accessKeyId: bedrockAccessKeyId,
        secretAccessKey: bedrockSecretKey,
        sessionToken: process.env.AWS_SESSION_TOKEN,
        region: config.providers?.bedrock?.baseUrl ?? process.env.AWS_REGION ?? 'us-east-1',
      }));
      logger.info('Registered LLM adapter: bedrock');
    }

    // Google Vertex AI (Claude via GCP service account — no Anthropic API key needed)
    const vertexServiceAccountJson =
      config.providers?.vertex?.apiKeySecret ?? process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (vertexServiceAccountJson && config.providers?.vertex?.enabled !== false) {
      this.adapters.set('vertex', new VertexAdapter({
        serviceAccountJson: vertexServiceAccountJson,
        region: config.providers?.vertex?.baseUrl ?? process.env.GOOGLE_CLOUD_REGION ?? 'us-central1',
      }));
      logger.info('Registered LLM adapter: vertex');
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

  /** Get the set of registered provider names. */
  getRegisteredProviders(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * Load LLM provider API keys from the secrets table and register/replace
   * adapters. Call after construction and again when keys change via the UI.
   */
  async loadProviders(): Promise<void> {
    try {
      const result = await this.db.query(
        "SELECT path, encrypted_value FROM secrets WHERE path LIKE 'llm/%' LIMIT 100",
      );

      const secrets = new Map<string, string>();
      for (const row of result.rows as { path: string; encrypted_value: Buffer }[]) {
        try {
          secrets.set(row.path, decryptSecret(row.encrypted_value.toString('utf-8')));
        } catch {
          logger.warn({ path: row.path }, 'Failed to decrypt provider secret');
        }
      }

      // Anthropic
      const anthropicKey = secrets.get('llm/anthropic/api-key');
      if (anthropicKey) {
        this.adapters.set('anthropic', new AnthropicAdapter({
          apiKey: anthropicKey,
          baseUrl: this.config.providers?.anthropic?.baseUrl,
        }));
        logger.info('Loaded LLM adapter from secrets: anthropic');
      }

      // OpenAI
      const openaiKey = secrets.get('llm/openai/api-key');
      if (openaiKey) {
        this.adapters.set('openai', new OpenAIAdapter({
          apiKey: openaiKey,
          baseUrl: this.config.providers?.openai?.baseUrl,
        }));
        logger.info('Loaded LLM adapter from secrets: openai');
      }

      // Gemini
      const geminiKey = secrets.get('llm/gemini/api-key');
      if (geminiKey) {
        this.adapters.set('gemini', new GeminiAdapter(
          geminiKey,
          this.config.providers?.gemini?.baseUrl,
        ));
        logger.info('Loaded LLM adapter from secrets: gemini');
      }

      // AWS Bedrock
      const bedrockAccessKeyId = secrets.get('llm/bedrock/access-key-id');
      const bedrockSecretKey = secrets.get('llm/bedrock/secret-access-key');
      if (bedrockAccessKeyId && bedrockSecretKey) {
        this.adapters.set('bedrock', new BedrockAdapter({
          accessKeyId: bedrockAccessKeyId,
          secretAccessKey: bedrockSecretKey,
          region: this.config.providers?.bedrock?.baseUrl ?? process.env.AWS_REGION ?? 'us-east-1',
        }));
        logger.info('Loaded LLM adapter from secrets: bedrock');
      }

      // Google Vertex AI
      const vertexJson = secrets.get('llm/vertex/service-account-json');
      if (vertexJson) {
        this.adapters.set('vertex', new VertexAdapter({
          serviceAccountJson: vertexJson,
          region: this.config.providers?.vertex?.baseUrl ?? process.env.GOOGLE_CLOUD_REGION ?? 'us-central1',
        }));
        logger.info('Loaded LLM adapter from secrets: vertex');
      }

      // Azure OpenAI
      const azureKey = secrets.get('llm/azure/api-key');
      const azureEndpoint = secrets.get('llm/azure/endpoint');
      if (azureKey && azureEndpoint) {
        this.adapters.set('azure', new OpenAIAdapter({
          apiKey: azureKey,
          baseUrl: azureEndpoint,
          isAzure: true,
        }));
        logger.info('Loaded LLM adapter from secrets: azure');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load provider secrets from DB (non-fatal)');
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
      // Resolve workspaceId from session context stored in Redis
      let workspaceId = '00000000-0000-0000-0000-000000000000';
      try {
        const contextRaw = await this.redis.get(`session:${request.sessionId}:context`);
        if (contextRaw) {
          const ctx = JSON.parse(contextRaw) as { workspaceId?: string };
          workspaceId = ctx.workspaceId ?? workspaceId;
        }
      } catch {
        // Non-fatal: use default
      }

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
        workspaceId,
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

    // Load output filter settings from the agent's latest capability manifest
    let blockedOutputPatterns: string[] | undefined;
    let maxResponseTokens: number | undefined;
    try {
      const manifestResult = await this.db.query(
        `SELECT manifest FROM capability_manifests
         WHERE agent_id = (SELECT id FROM agents WHERE id::text = $1 LIMIT 1)
         ORDER BY version DESC LIMIT 1`,
        [agentId],
      );
      if (manifestResult.rows.length > 0) {
        const manifest = manifestResult.rows[0].manifest as Record<string, unknown>;
        const outputFilters = manifest.outputFilters as Record<string, unknown> | undefined;
        if (outputFilters) {
          if (Array.isArray(outputFilters.blockedOutputPatterns)) {
            blockedOutputPatterns = outputFilters.blockedOutputPatterns as string[];
          }
          if (typeof outputFilters.maxResponseTokens === 'number') {
            maxResponseTokens = outputFilters.maxResponseTokens;
          }
        }
      }
    } catch {
      // Non-fatal: continue with default filter context
    }

    const filterContext = { workspaceId, agentId, blockedOutputPatterns, maxResponseTokens };

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
