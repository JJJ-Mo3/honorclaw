import type { FastifyInstance } from 'fastify';
import { requireWorkspace } from '../middleware/rbac.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

interface ModelInfo {
  name: string;
  provider: string;
  size?: number;
  modified?: string;
}

export async function modelRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  // GET /models — list available local + frontier models
  app.get('/', async () => {
    const local = await fetchOllamaModels();
    const frontier = getFrontierModels();
    return { local, frontier };
  });

  // POST /models/pull — pull an Ollama model by name
  app.post<{ Body: { name: string } }>('/pull', async (request, reply) => {
    const { name } = request.body ?? {};
    if (!name || typeof name !== 'string') {
      return reply.status(400).send({ error: 'Model name is required' });
    }

    // Only allow pulling Ollama models (local)
    const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    try {
      const resp = await fetch(`${baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, stream: false }),
      });

      if (!resp.ok) {
        const text = await resp.text();
        logger.warn({ model: name, status: resp.status }, 'Ollama pull failed');
        return reply.status(502).send({ error: `Ollama pull failed: ${text}` });
      }

      const data = await resp.json();
      logger.info({ model: name }, 'Model pulled successfully');
      return { status: 'ok', model: name, details: data };
    } catch (err) {
      logger.error({ err, model: name }, 'Failed to reach Ollama for model pull');
      return reply.status(502).send({ error: 'Ollama is not reachable' });
    }
  });

  // GET /models/status — check if the default model is ready
  app.get('/status', async () => {
    const defaultModel = process.env.HONORCLAW_DEFAULT_MODEL ?? 'llama3.2';
    const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

    let ollamaReachable = false;
    let defaultModelReady = false;
    let installedModels: string[] = [];

    try {
      const resp = await fetch(`${baseUrl}/api/tags`);
      if (resp.ok) {
        ollamaReachable = true;
        const data = await resp.json() as { models?: { name: string }[] };
        installedModels = (data.models ?? []).map(m => m.name);
        defaultModelReady = installedModels.some(
          m => m === defaultModel || m.startsWith(`${defaultModel}:`),
        );
      }
    } catch {
      // Ollama not reachable
    }

    return {
      ollamaReachable,
      defaultModel,
      defaultModelReady,
      installedModels,
    };
  });
}

async function fetchOllamaModels(): Promise<ModelInfo[]> {
  try {
    const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json() as any;
    return (data.models ?? []).map((m: any) => ({
      name: m.name,
      provider: 'ollama',
      size: m.size,
      modified: m.modified_at,
    }));
  } catch {
    return [];
  }
}

function getFrontierModels(): ModelInfo[] {
  const models: ModelInfo[] = [];

  if (process.env.ANTHROPIC_API_KEY) {
    models.push(
      { name: 'claude-sonnet-4-20250514', provider: 'anthropic' },
      { name: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
    );
  }

  if (process.env.OPENAI_API_KEY) {
    models.push(
      { name: 'gpt-4o', provider: 'openai' },
      { name: 'gpt-4-turbo', provider: 'openai' },
      { name: 'gpt-3.5-turbo', provider: 'openai' },
    );
  }

  if (process.env.GOOGLE_AI_API_KEY) {
    models.push(
      { name: 'gemini-1.5-pro', provider: 'google' },
      { name: 'gemini-1.5-flash', provider: 'google' },
    );
  }

  if (process.env.MISTRAL_API_KEY) {
    models.push(
      { name: 'mistral-large-latest', provider: 'mistral' },
      { name: 'mistral-medium-latest', provider: 'mistral' },
    );
  }

  return models;
}
