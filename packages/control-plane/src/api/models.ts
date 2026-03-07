import type { FastifyInstance } from 'fastify';
import { requireWorkspace } from '../middleware/rbac.js';

interface ModelInfo {
  name: string;
  provider: string;
  size?: number;
  modified?: string;
}

export async function modelRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  app.get('/', async () => {
    const local = await fetchOllamaModels();
    const frontier = getFrontierModels();
    return { local, frontier };
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
