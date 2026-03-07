import type { FastifyInstance } from 'fastify';
import { requireWorkspace } from '../middleware/rbac.js';

export async function skillRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  // List installed skills
  app.get('/', async (request) => {
    const db = (app as any).db;
    const result = await db.query(
      'SELECT id, name, version, manifest_yaml, installed_at, updated_at FROM skills WHERE workspace_id = $1 ORDER BY name',
      [request.workspaceId]
    );
    return { skills: result.rows };
  });

  // Search available skills
  app.get('/search', async (request) => {
    const { q } = request.query as { q?: string };
    const db = (app as any).db;

    if (!q || q.trim().length === 0) {
      return { skills: [] };
    }

    const result = await db.query(
      `SELECT id, name, version, manifest_yaml, installed_at, updated_at
       FROM skills
       WHERE workspace_id = $1 AND name ILIKE $2
       ORDER BY name`,
      [request.workspaceId, `%${q}%`]
    );
    return { skills: result.rows };
  });

  // Get skill details by name
  app.get('/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const db = (app as any).db;

    const result = await db.query(
      'SELECT * FROM skills WHERE workspace_id = $1 AND name = $2',
      [request.workspaceId, name]
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'Skill not found' });
      return;
    }

    return { skill: result.rows[0] };
  });

  // Install a skill
  app.post('/install', async (request, reply) => {
    const { name, version } = request.body as { name: string; version?: string };
    const db = (app as any).db;

    if (!name) {
      reply.code(400).send({ error: 'Skill name is required' });
      return;
    }

    const skillVersion = version ?? 'latest';

    try {
      const result = await db.query(
        `INSERT INTO skills (workspace_id, name, version, manifest_yaml)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, name) DO UPDATE SET version = $3, manifest_yaml = $4, updated_at = now()
         RETURNING *`,
        [request.workspaceId, name, skillVersion, '{}']
      );

      reply.code(201).send({ skill: result.rows[0] });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        reply.code(409).send({ error: 'Skill already installed' });
        return;
      }
      throw err;
    }
  });

  // Scaffold a new skill template
  app.post('/scaffold', async (request, reply) => {
    const { name } = request.body as { name: string };

    if (!name) {
      reply.code(400).send({ error: 'Skill name is required' });
      return;
    }

    // Return a scaffold template structure
    const template = {
      name,
      files: {
        'manifest.yaml': `name: ${name}\nversion: 0.1.0\ndescription: A new HonorClaw skill\ntools: []\n`,
        'index.ts': `// ${name} skill entry point\nexport default function setup() {\n  // Skill initialization\n}\n`,
      },
    };

    reply.code(201).send({ scaffold: template });
  });

  // Remove a skill
  app.delete('/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const db = (app as any).db;

    const result = await db.query(
      'DELETE FROM skills WHERE workspace_id = $1 AND name = $2 RETURNING id',
      [request.workspaceId, name]
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'Skill not found' });
      return;
    }

    reply.code(204).send();
  });
}
