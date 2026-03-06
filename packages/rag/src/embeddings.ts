import type { EmbeddingService } from '@honorclaw/core';

// ---------------------------------------------------------------------------
// OllamaEmbeddings (DEFAULT) — local, no data leaves the machine
// ---------------------------------------------------------------------------

export class OllamaEmbeddings implements EmbeddingService {
  private baseUrl: string;
  private model: string;
  private dim: number;
  private maxRetries: number;

  constructor(opts?: { baseUrl?: string; model?: string }) {
    this.baseUrl = opts?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    this.model = opts?.model ?? 'nomic-embed-text';
    this.dim = 768;
    this.maxRetries = 3;
  }

  dimensions(): number {
    return this.dim;
  }

  async embed(text: string): Promise<number[]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.model, prompt: text }),
        });
        if (!res.ok) {
          throw new Error(`Ollama embeddings HTTP ${res.status}: ${await res.text()}`);
        }
        const json = (await res.json()) as { embedding: number[] };
        return json.embedding;
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  }
}

// ---------------------------------------------------------------------------
// OpenAiEmbeddings — sends data to api.openai.com
// ---------------------------------------------------------------------------

export class OpenAiEmbeddings implements EmbeddingService {
  private apiKey: string;
  private model: string;
  private dim: number;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = opts?.model ?? 'text-embedding-3-small';
    this.dim = 1536;
    console.warn('OpenAI embeddings: text data will be sent to api.openai.com');
  }

  dimensions(): number {
    return this.dim;
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embeddings HTTP ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    const first = json.data[0];
    if (!first) throw new Error('OpenAI returned empty embeddings response');
    return first.embedding;
  }
}

// ---------------------------------------------------------------------------
// BedrockTitanEmbeddings — placeholder for AWS Bedrock titan-embed-text-v2
// ---------------------------------------------------------------------------

export class BedrockTitanEmbeddings implements EmbeddingService {
  private dim: number;

  constructor() {
    this.dim = 1024;
  }

  dimensions(): number {
    return this.dim;
  }

  async embed(_text: string): Promise<number[]> {
    // TODO: Implement AWS Bedrock amazon.titan-embed-text-v2 integration
    // Will use @aws-sdk/client-bedrock-runtime InvokeModelCommand
    throw new Error('BedrockTitanEmbeddings is not yet implemented — install @aws-sdk/client-bedrock-runtime');
  }
}
