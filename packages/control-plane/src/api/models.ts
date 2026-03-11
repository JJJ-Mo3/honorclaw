import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { requireWorkspace } from '../middleware/rbac.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const LLAMA_CANDIDATES = ['llama4', 'llama3.3', 'llama3.2', 'llama3.1', 'llama3'];

/**
 * Resolve the default Ollama model name. Priority:
 * 1. HONORCLAW_DEFAULT_MODEL env var (explicit override)
 * 2. /data/ollama/default-model file (written by s6 startup)
 * 3. Registry probe for the latest Llama release
 * 4. Hardcoded fallback
 */
async function resolveDefaultModel(): Promise<string> {
  if (process.env.HONORCLAW_DEFAULT_MODEL) return process.env.HONORCLAW_DEFAULT_MODEL;

  try {
    const persisted = readFileSync('/data/ollama/default-model', 'utf-8').trim();
    if (persisted) return persisted;
  } catch { /* not written yet */ }

  for (const candidate of LLAMA_CANDIDATES) {
    try {
      const resp = await fetch(
        `https://registry.ollama.ai/v2/library/${candidate}/tags/list`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (resp.ok) return candidate;
    } catch { /* try next */ }
  }

  return 'llama3.2';
}

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
    const { installed, available } = await fetchOllamaModels();
    const frontier = getFrontierModels();
    return { local: installed, available, frontier };
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
    const defaultModel = await resolveDefaultModel();
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

/** Popular Ollama models shown as available options even when not yet pulled. */
const POPULAR_OLLAMA_MODELS = [
  'llama3.2', 'llama3.2:1b', 'llama3.1', 'llama3.1:70b',
  'llama3.3', 'llama3.3:70b',
  'mistral', 'mistral-nemo', 'mixtral',
  'gemma2', 'gemma2:27b',
  'phi4', 'phi3',
  'qwen2.5', 'qwen2.5:14b', 'qwen2.5-coder',
  'deepseek-r1:7b', 'deepseek-r1:14b',
  'codellama', 'command-r',
];

async function fetchOllamaModels(): Promise<{ installed: ModelInfo[]; available: ModelInfo[] }> {
  const installed: ModelInfo[] = [];
  const installedNames = new Set<string>();

  try {
    const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    const response = await fetch(`${baseUrl}/api/tags`);
    if (response.ok) {
      const data = await response.json() as any;
      for (const m of data.models ?? []) {
        installed.push({
          name: m.name,
          provider: 'ollama',
          size: m.size,
          modified: m.modified_at,
        });
        installedNames.add(m.name);
        // Also track without :latest so we don't duplicate
        installedNames.add(m.name.replace(/:latest$/, ''));
      }
    }
  } catch {
    // Ollama not reachable
  }

  // Add popular models that aren't already installed
  const available: ModelInfo[] = [];
  for (const name of POPULAR_OLLAMA_MODELS) {
    if (!installedNames.has(name) && !installedNames.has(`${name}:latest`)) {
      available.push({ name, provider: 'ollama' });
    }
  }

  return { installed, available };
}

function getFrontierModels(): ModelInfo[] {
  const models: ModelInfo[] = [];

  if (process.env.ANTHROPIC_API_KEY) {
    models.push(
      { name: 'claude-sonnet-4-20250514', provider: 'anthropic' },
      { name: 'claude-opus-4-20250514', provider: 'anthropic' },
      { name: 'claude-haiku-4-5-20251001', provider: 'anthropic' },
      { name: 'claude-3-5-sonnet-20241022', provider: 'anthropic' },
      { name: 'claude-3-5-haiku-20241022', provider: 'anthropic' },
    );
  }

  if (process.env.OPENAI_API_KEY) {
    models.push(
      { name: 'gpt-4o', provider: 'openai' },
      { name: 'gpt-4o-mini', provider: 'openai' },
      { name: 'gpt-4-turbo', provider: 'openai' },
      { name: 'o1', provider: 'openai' },
      { name: 'o1-mini', provider: 'openai' },
      { name: 'o3-mini', provider: 'openai' },
    );
  }

  if (process.env.GOOGLE_AI_API_KEY) {
    models.push(
      { name: 'gemini-2.0-flash', provider: 'gemini' },
      { name: 'gemini-2.0-pro', provider: 'gemini' },
      { name: 'gemini-1.5-pro', provider: 'gemini' },
      { name: 'gemini-1.5-flash', provider: 'gemini' },
    );
  }

  const bedrockKey = process.env.AWS_ACCESS_KEY_ID;
  const bedrockSecret = process.env.AWS_SECRET_ACCESS_KEY;
  if (bedrockKey && bedrockSecret) {
    models.push(
      { name: 'anthropic.claude-sonnet-4-20250514-v1:0', provider: 'bedrock' },
      { name: 'anthropic.claude-opus-4-20250514-v1:0', provider: 'bedrock' },
      { name: 'anthropic.claude-3-5-sonnet-20241022-v2:0', provider: 'bedrock' },
      { name: 'anthropic.claude-3-5-haiku-20241022-v1:0', provider: 'bedrock' },
      { name: 'amazon.nova-pro-v1:0', provider: 'bedrock' },
      { name: 'amazon.nova-lite-v1:0', provider: 'bedrock' },
    );
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    models.push(
      { name: 'claude-sonnet-4@20250514', provider: 'vertex' },
      { name: 'claude-opus-4@20250514', provider: 'vertex' },
      { name: 'claude-3-5-sonnet@20241022', provider: 'vertex' },
    );
  }

  const azureKey = process.env.AZURE_OPENAI_API_KEY;
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  if (azureKey && azureEndpoint) {
    models.push(
      { name: 'gpt-4o', provider: 'azure' },
      { name: 'gpt-4o-mini', provider: 'azure' },
      { name: 'gpt-4-turbo', provider: 'azure' },
    );
  }

  return models;
}
