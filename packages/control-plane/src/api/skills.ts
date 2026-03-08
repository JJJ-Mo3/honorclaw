import type { FastifyInstance } from 'fastify';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';
import { mapRows, toCamelCase } from './row-mapper.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Skill Bundle Helpers ─────────────────────────────────────────────────

interface SkillBundle {
  name: string;
  version: string;
  description: string;
  manifestYaml: string;
  systemPrompt: string;
}

/**
 * Locate the honorclaw-skills/ directory.
 * Checks Docker path first, then relative paths from both dist and src.
 */
function findSkillsDir(): string | null {
  const candidates = [
    '/app/honorclaw-skills',
    path.resolve(__dirname, '..', '..', '..', '..', 'honorclaw-skills'),       // from dist/api/
    path.resolve(__dirname, '..', '..', '..', '..', '..', 'honorclaw-skills'), // deeper nesting
    path.resolve(__dirname, '..', '..', 'honorclaw-skills'),                   // from src/api/
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  return null;
}

/**
 * Read a single skill bundle from the honorclaw-skills directory.
 */
function readSkillBundle(skillsDir: string, name: string): SkillBundle | null {
  const skillDir = path.join(skillsDir, name);
  const yamlPath = path.join(skillDir, 'skill.yaml');

  if (!fs.existsSync(yamlPath)) {
    return null;
  }

  const manifestYaml = fs.readFileSync(yamlPath, 'utf-8');

  // Parse basic fields from YAML without a full YAML parser
  const version = extractYamlField(manifestYaml, 'version') ?? '1.0.0';
  const description = extractYamlField(manifestYaml, 'description') ?? '';

  // Read system prompt if present
  const promptPath = path.join(skillDir, 'system-prompt.md');
  const systemPrompt = fs.existsSync(promptPath)
    ? fs.readFileSync(promptPath, 'utf-8')
    : '';

  return { name, version, description, manifestYaml, systemPrompt };
}

/**
 * List all available skill bundles from the honorclaw-skills directory.
 */
function listSkillBundles(): SkillBundle[] {
  const skillsDir = findSkillsDir();
  if (!skillsDir) return [];

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const bundles: SkillBundle[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bundle = readSkillBundle(skillsDir, entry.name);
    if (bundle) bundles.push(bundle);
  }

  return bundles.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Extract a top-level scalar field from YAML without a full parser.
 * Handles both quoted and unquoted values.
 */
function extractYamlField(yaml: string, field: string): string | null {
  const regex = new RegExp(`^${field}:\\s*(?:"([^"]*?)"|'([^']*?)'|(.+?))\\s*$`, 'm');
  const match = regex.exec(yaml);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

// ── Routes ───────────────────────────────────────────────────────────────

export async function skillRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  // List installed skills
  app.get('/', async (request) => {
    const db = (app as any).db;
    const result = await db.query(
      'SELECT id, name, version, description, manifest_yaml, system_prompt, installed_at, updated_at FROM skills WHERE workspace_id = $1 ORDER BY name',
      [request.workspaceId]
    );
    return { skills: mapRows(result.rows) };
  });

  // List all available skill bundles (regardless of installation status)
  app.get('/available', async () => {
    const bundles = listSkillBundles();
    return {
      skills: bundles.map((b) => ({
        name: b.name,
        version: b.version,
        description: b.description,
        source: 'bundle',
      })),
    };
  });

  // Search available skills
  app.get('/search', async (request) => {
    const { q } = request.query as { q?: string };
    const db = (app as any).db;

    if (!q || q.trim().length === 0) {
      return { skills: [] };
    }

    const lowerQ = q.toLowerCase();

    // Escape ILIKE special characters to prevent pattern injection
    const escapedQ = q.replace(/[%_\\]/g, '\\$&');

    // First query the DB for installed skills matching the query
    const result = await db.query(
      `SELECT id, name, version, description, manifest_yaml, installed_at, updated_at
       FROM skills
       WHERE workspace_id = $1 AND name ILIKE $2
       ORDER BY name`,
      [request.workspaceId, `%${escapedQ}%`]
    );

    if (result.rows.length > 0) {
      return {
        skills: mapRows(result.rows).map((row) => ({
          ...row,
          source: 'installed',
        })),
      };
    }

    // Fallback: scan bundles for matching skills
    const bundles = listSkillBundles();
    const matching = bundles.filter(
      (b) =>
        b.name.toLowerCase().includes(lowerQ) ||
        b.description.toLowerCase().includes(lowerQ)
    );

    return {
      skills: matching.map((b) => ({
        name: b.name,
        version: b.version,
        description: b.description,
        source: 'bundle',
      })),
    };
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
      // Try to find in bundles
      const skillsDir = findSkillsDir();
      if (skillsDir) {
        const bundle = readSkillBundle(skillsDir, name);
        if (bundle) {
          return {
            skill: {
              name: bundle.name,
              version: bundle.version,
              description: bundle.description,
              manifest_yaml: bundle.manifestYaml,
              system_prompt: bundle.systemPrompt,
              source: 'bundle',
            },
          };
        }
      }
      reply.code(404).send({ error: 'Skill not found' });
      return;
    }

    return { skill: toCamelCase(result.rows[0]) };
  });

  // Install a skill
  app.post('/install', { preHandler: requireRoles('workspace_admin') }, async (request, reply) => {
    const { name, version } = request.body as { name: string; version?: string };
    const db = (app as any).db;

    if (!name) {
      reply.code(400).send({ error: 'Skill name is required' });
      return;
    }

    // Try to load from bundles first
    let manifestYaml = '{}';
    let systemPrompt = '';
    let description = '';
    let skillVersion = version ?? 'latest';

    const skillsDir = findSkillsDir();
    if (skillsDir) {
      const bundle = readSkillBundle(skillsDir, name);
      if (bundle) {
        manifestYaml = bundle.manifestYaml;
        systemPrompt = bundle.systemPrompt;
        description = bundle.description;
        // Use bundle version unless a specific version was requested
        if (!version) {
          skillVersion = bundle.version;
        }
      }
    }

    try {
      const result = await db.query(
        `INSERT INTO skills (workspace_id, name, version, manifest_yaml, system_prompt, description)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (workspace_id, name) DO UPDATE
           SET version = $3, manifest_yaml = $4, system_prompt = $5, description = $6, updated_at = now()
         RETURNING *`,
        [request.workspaceId, name, skillVersion, manifestYaml, systemPrompt, description]
      );

      reply.code(201).send({ skill: toCamelCase(result.rows[0]) });
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
  app.post('/scaffold', { preHandler: requireRoles('workspace_admin') }, async (request, reply) => {
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
  app.delete('/:name', { preHandler: requireRoles('workspace_admin') }, async (request, reply) => {
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

  // ── Agent-Skill associations ──────────────────────────────────────────

  // List skills applied to an agent
  app.get('/agents/:agentId', async (request) => {
    const { agentId } = request.params as { agentId: string };
    const db = (app as any).db;
    const result = await db.query(
      `SELECT ags.skill_name, ags.enabled, ags.installed_at, s.description, s.system_prompt
       FROM agent_skills ags
       LEFT JOIN skills s ON s.name = ags.skill_name AND s.workspace_id = ags.workspace_id
       WHERE ags.agent_id = $1 AND ags.workspace_id = $2
       ORDER BY ags.installed_at`,
      [agentId, request.workspaceId]
    );
    return { skills: mapRows(result.rows) };
  });

  // Apply a skill to an agent
  app.post('/agents/:agentId', { preHandler: requireRoles('workspace_admin') }, async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const { skillName } = request.body as { skillName: string };
    const db = (app as any).db;

    // Verify skill is installed
    const skillCheck = await db.query(
      'SELECT name FROM skills WHERE workspace_id = $1 AND name = $2',
      [request.workspaceId, skillName]
    );
    if (skillCheck.rows.length === 0) {
      reply.code(404).send({ error: 'Skill not installed in this workspace' });
      return;
    }

    await db.query(
      `INSERT INTO agent_skills (agent_id, skill_name, workspace_id)
       VALUES ($1, $2, $3) ON CONFLICT (agent_id, skill_name) DO NOTHING`,
      [agentId, skillName, request.workspaceId]
    );

    reply.code(201).send({ applied: true, agentId, skillName });
  });

  // Remove a skill from an agent
  app.delete('/agents/:agentId/:skillName', { preHandler: requireRoles('workspace_admin') }, async (request, reply) => {
    const { agentId, skillName } = request.params as { agentId: string; skillName: string };
    const db = (app as any).db;

    await db.query(
      'DELETE FROM agent_skills WHERE agent_id = $1 AND skill_name = $2 AND workspace_id = $3',
      [agentId, skillName, request.workspaceId]
    );

    reply.code(204).send();
  });
}
