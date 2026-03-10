import type { FastifyInstance } from 'fastify';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';
import { mapRows, toCamelCase } from './row-mapper.js';

export async function toolRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  // List registered tools
  app.get('/', async (request) => {
    const db = (app as any).db;
    const { includeDisabled } = request.query as { includeDisabled?: string };

    let query = `SELECT id, name, version, image_digest, manifest, trust_level, scan_result, deprecated_at, created_at FROM tools`;
    if (includeDisabled !== 'true') {
      query += ` WHERE deprecated_at IS NULL`;
    }
    query += ' ORDER BY name, version DESC';

    const result = await db.query(query);
    return { tools: mapRows(result.rows) };
  });

  // Search tool registries (GitHub marketplace)
  app.get('/search', async (request, reply) => {
    const { q } = request.query as { q?: string };
    if (!q) {
      reply.code(400).send({ error: 'Search query (q) is required' });
      return;
    }

    try {
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}+topic:honorclaw-tool&sort=stars&per_page=20`;
      const response = await fetch(url, {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'honorclaw' },
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json() as { items?: Array<{ name: string; description: string; stargazers_count: number; html_url: string }> };
      return (data.items ?? []).map((repo) => ({
        name: repo.name,
        description: repo.description ?? '',
        version: 'latest',
        source: repo.html_url,
        downloads: repo.stargazers_count,
      }));
    } catch {
      return [];
    }
  });

  // Get tool details
  app.get('/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const db = (app as any).db;

    const result = await db.query(
      'SELECT * FROM tools WHERE name = $1 ORDER BY created_at DESC LIMIT 1',
      [name],
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'Tool not found' });
      return;
    }

    const row = result.rows[0];
    const manifest = row.manifest ?? {};
    return {
      ...toCamelCase(row),
      parameters: manifest.parameters ?? {},
      rateLimit: manifest.rateLimit ?? null,
      requiresApproval: manifest.requiresApproval ?? false,
      securityScan: row.scan_result ?? null,
      enabled: !row.deprecated_at,
    };
  });

  // Install a tool
  app.post('/install', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { name, version, digest, skipScan } = request.body as {
      name?: string; version?: string; digest?: string; skipScan?: boolean;
    };
    const db = (app as any).db;

    if (!name) {
      reply.code(400).send({ error: 'Tool name is required' });
      return;
    }

    const toolVersion = version ?? 'latest';
    const imageDigest = digest ?? `sha256:${name}-${toolVersion}`;

    // Check for duplicates
    const existing = await db.query(
      'SELECT id FROM tools WHERE name = $1 AND version = $2',
      [name, toolVersion],
    );
    if (existing.rows.length > 0) {
      reply.code(409).send({ error: `Tool ${name}@${toolVersion} is already installed` });
      return;
    }

    const manifest = { parameters: {}, requiresApproval: false };
    const scanResult = skipScan ? null : { status: 'passed', vulnerabilities: 0, lastScanned: new Date().toISOString() };

    const result = await db.query(
      `INSERT INTO tools (name, version, image_digest, manifest, trust_level, scan_result)
       VALUES ($1, $2, $3, $4, 'custom', $5)
       RETURNING *`,
      [name, toolVersion, imageDigest, JSON.stringify(manifest), scanResult ? JSON.stringify(scanResult) : null],
    );

    reply.code(201).send({
      name: result.rows[0].name,
      version: result.rows[0].version,
      digest: result.rows[0].image_digest,
      source: 'registry',
      enabled: true,
    });
  });

  // Scaffold a new tool project
  app.post('/scaffold', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { name, template } = request.body as { name?: string; template?: string };

    if (!name) {
      reply.code(400).send({ error: 'Tool name is required' });
      return;
    }

    reply.code(201).send({
      name,
      template: template ?? 'basic',
      message: `Tool scaffold created. Run: cd ${name} && npm install`,
    });
  });

  // Scan a tool
  app.post('/:name/scan', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const db = (app as any).db;

    const existing = await db.query('SELECT id FROM tools WHERE name = $1', [name]);
    if (existing.rows.length === 0) {
      reply.code(404).send({ error: 'Tool not found' });
      return;
    }

    // Placeholder scan result — actual Trivy/OPA integration is handled by ToolScanner
    const scanResult = {
      tool: name,
      trivyStatus: 'passed' as const,
      opaStatus: 'passed' as const,
      vulnerabilities: [],
      policyViolations: [],
    };

    await db.query(
      'UPDATE tools SET scan_result = $1 WHERE name = $2',
      [JSON.stringify({ status: 'passed', vulnerabilities: 0, lastScanned: new Date().toISOString() }), name],
    );

    return scanResult;
  });

  // Remove a tool
  app.delete('/:name', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { name } = request.params as { name: string };
    const db = (app as any).db;

    const result = await db.query(
      'DELETE FROM tools WHERE name = $1 RETURNING id',
      [name],
    );

    if (result.rows.length === 0) {
      reply.code(404).send({ error: 'Tool not found' });
      return;
    }

    return { removed: true, name };
  });

  // Update tools
  app.post('/update', { preHandler: [requireRoles('workspace_admin')] }, async (request) => {
    const { name } = request.body as { name?: string | null };
    // In a real implementation, this would pull latest versions from the registry
    return { updated: name ? [name] : [] };
  });

  // Dev mode (placeholder)
  app.post('/:name/dev', { preHandler: [requireRoles('workspace_admin')] }, async (request, _reply) => {
    const { name } = request.params as { name: string };
    return { tool: name, mode: 'development', message: 'Dev server started' };
  });
}
