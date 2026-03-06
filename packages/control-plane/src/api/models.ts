import type { FastifyInstance } from 'fastify';

export async function modelRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    // Query Ollama for local models
    const ollamaModels = await fetchOllamaModels();
    return { local: ollamaModels, frontier: [] };
  });
}

async function fetchOllamaModels(): Promise<Array<{ name: string; size: number; modified: string }>> {
  try {
    const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
    const response = await fetch(`${baseUrl}/api/tags`);
    if (!response.ok) return [];
    const data = await response.json() as any;
    return (data.models ?? []).map((m: any) => ({
      name: m.name,
      size: m.size,
      modified: m.modified_at,
    }));
  } catch {
    return [];
  }
}
