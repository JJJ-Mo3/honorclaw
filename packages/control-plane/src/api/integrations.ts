import type { FastifyInstance } from 'fastify';
import { requireWorkspace, requireRoles } from '../middleware/rbac.js';

interface SecretFieldDef {
  path: string;
  label: string;
  required: boolean;
  placeholder?: string;
}

interface IntegrationDef {
  id: string;
  name: string;
  secretPath: string;
  description: string;
  secretFields?: SecretFieldDef[];
}

const KNOWN_INTEGRATIONS: IntegrationDef[] = [
  // ── Messaging & Collaboration ─────────────────────────────────────────
  {
    id: 'slack',
    name: 'Slack',
    secretPath: 'integrations/slack/credentials',
    description: 'Post messages, read channels, search, and manage users',
    secretFields: [
      { path: 'slack/bot-token', label: 'Bot Token', required: true, placeholder: 'xoxb-...' },
      { path: 'slack/signing-secret', label: 'Signing Secret', required: true, placeholder: 'Signing secret from Slack app settings' },
      { path: 'slack/app-token', label: 'App Token (Socket Mode)', required: false, placeholder: 'xapp-... (optional)' },
    ],
  },
  {
    id: 'microsoft-teams',
    name: 'Microsoft Teams',
    secretPath: 'integrations/microsoft-teams/credentials',
    description: 'Bot messaging, adaptive cards, and team collaboration',
    secretFields: [
      { path: 'teams/app-id', label: 'App ID', required: true, placeholder: 'Azure Bot App ID' },
      { path: 'teams/app-password', label: 'App Password', required: true, placeholder: 'Azure Bot App Password' },
    ],
  },
  {
    id: 'discord',
    name: 'Discord',
    secretPath: 'integrations/discord/credentials',
    description: 'Bot messaging, slash commands, and server management',
    secretFields: [
      { path: 'discord/bot-token', label: 'Bot Token', required: true, placeholder: 'Discord bot token from Developer Portal' },
      { path: 'discord/application-id', label: 'Application ID', required: true, placeholder: 'Discord application ID' },
    ],
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    secretPath: 'integrations/whatsapp/credentials',
    description: 'Send and receive messages via WhatsApp Business API',
    secretFields: [
      { path: 'whatsapp/access-token', label: 'Access Token', required: true, placeholder: 'Permanent access token from Meta Business' },
      { path: 'whatsapp/phone-number-id', label: 'Phone Number ID', required: true, placeholder: 'WhatsApp Business phone number ID' },
      { path: 'whatsapp/verify-token', label: 'Webhook Verify Token', required: false, placeholder: 'Custom verify token for webhook setup' },
    ],
  },
  {
    id: 'email',
    name: 'Email (SMTP)',
    secretPath: 'integrations/email/credentials',
    description: 'Send emails via SMTP relay',
    secretFields: [
      { path: 'email/smtp-host', label: 'SMTP Host', required: true, placeholder: 'smtp.example.com' },
      { path: 'email/smtp-port', label: 'SMTP Port', required: true, placeholder: '587' },
      { path: 'email/smtp-user', label: 'Username', required: false, placeholder: 'user@example.com' },
      { path: 'email/smtp-pass', label: 'Password', required: false, placeholder: 'SMTP password or app password' },
    ],
  },
  // ── Productivity Suites ───────────────────────────────────────────────
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    secretPath: 'integrations/google-workspace/credentials',
    description: 'Gmail, Calendar, Drive, Sheets, and Contacts access',
    secretFields: [
      { path: 'google-workspace/service-account-json', label: 'Service Account JSON', required: true, placeholder: '{"type":"service_account",...}' },
    ],
  },
  {
    id: 'microsoft-365',
    name: 'Microsoft 365',
    secretPath: 'integrations/microsoft-365/credentials',
    description: 'Outlook, Calendar, OneDrive, Excel, and Contacts access',
    secretFields: [
      { path: 'microsoft-365/tenant-id', label: 'Tenant ID', required: true, placeholder: 'Azure AD Tenant ID' },
      { path: 'microsoft-365/client-id', label: 'Client ID', required: true, placeholder: 'Azure App Registration Client ID' },
      { path: 'microsoft-365/client-secret', label: 'Client Secret', required: true, placeholder: 'Azure App Registration Client Secret' },
    ],
  },
  {
    id: 'notion',
    name: 'Notion',
    secretPath: 'integrations/notion/credentials',
    description: 'Pages, databases, search, and knowledge management',
    secretFields: [
      { path: 'notion/api-key', label: 'Integration Token', required: true, placeholder: 'ntn_... or secret_...' },
    ],
  },
  // ── Developer Tools ───────────────────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    secretPath: 'integrations/github/credentials',
    description: 'Repository access, pull requests, issues, and actions',
    secretFields: [
      { path: 'github/token', label: 'Personal Access Token', required: true, placeholder: 'ghp_... or github_pat_...' },
    ],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    secretPath: 'integrations/gitlab/credentials',
    description: 'Repository access, merge requests, issues, pipelines, and CI/CD',
    secretFields: [
      { path: 'gitlab/token', label: 'Personal Access Token', required: true, placeholder: 'glpat-...' },
      { path: 'gitlab/base-url', label: 'GitLab URL', required: false, placeholder: 'https://gitlab.com (default, or self-hosted URL)' },
    ],
  },
  {
    id: 'jira',
    name: 'Jira',
    secretPath: 'integrations/jira/credentials',
    description: 'Issue tracking, sprint management, and project boards',
    secretFields: [
      { path: 'jira/base-url', label: 'Jira URL', required: true, placeholder: 'https://yourorg.atlassian.net' },
      { path: 'jira/email', label: 'Email', required: true, placeholder: 'user@company.com' },
      { path: 'jira/api-token', label: 'API Token', required: true, placeholder: 'Atlassian API token' },
    ],
  },
  {
    id: 'confluence',
    name: 'Confluence',
    secretPath: 'integrations/confluence/credentials',
    description: 'Wiki pages, knowledge base, and documentation',
    secretFields: [
      { path: 'confluence/base-url', label: 'Confluence URL', required: true, placeholder: 'https://yourorg.atlassian.net/wiki' },
      { path: 'confluence/email', label: 'Email', required: true, placeholder: 'user@company.com' },
      { path: 'confluence/api-token', label: 'API Token', required: true, placeholder: 'Atlassian API token' },
    ],
  },
  // ── CRM & Business ────────────────────────────────────────────────────
  {
    id: 'salesforce',
    name: 'Salesforce',
    secretPath: 'integrations/salesforce/credentials',
    description: 'CRM queries, records, cases, and search',
    secretFields: [
      { path: 'salesforce/instance-url', label: 'Instance URL', required: true, placeholder: 'https://yourorg.my.salesforce.com' },
      { path: 'salesforce/access-token', label: 'Access Token', required: true, placeholder: 'OAuth access token or session ID' },
    ],
  },
  {
    id: 'hubspot',
    name: 'HubSpot',
    secretPath: 'integrations/hubspot/credentials',
    description: 'CRM contacts, deals, tickets, and marketing automation',
    secretFields: [
      { path: 'hubspot/access-token', label: 'Access Token', required: true, placeholder: 'Private app access token (pat-...)' },
    ],
  },
  // ── Data & Analytics ──────────────────────────────────────────────────
  {
    id: 'snowflake',
    name: 'Snowflake',
    secretPath: 'integrations/snowflake/credentials',
    description: 'Data warehouse queries, tables, and schema exploration',
    secretFields: [
      { path: 'snowflake/account', label: 'Account', required: true, placeholder: 'orgname-accountname' },
      { path: 'snowflake/username', label: 'Username', required: true, placeholder: 'ANALYTICS_USER' },
      { path: 'snowflake/password', label: 'Password', required: true, placeholder: 'Snowflake password' },
      { path: 'snowflake/warehouse', label: 'Warehouse', required: false, placeholder: 'COMPUTE_WH' },
      { path: 'snowflake/database', label: 'Database', required: false, placeholder: 'ANALYTICS_DB' },
    ],
  },
  {
    id: 'bigquery',
    name: 'BigQuery',
    secretPath: 'integrations/bigquery/credentials',
    description: 'Google Cloud data warehouse queries and table exploration',
    secretFields: [
      { path: 'bigquery/project-id', label: 'Project ID', required: true, placeholder: 'my-gcp-project' },
      { path: 'bigquery/service-account-json', label: 'Service Account JSON', required: true, placeholder: '{"type":"service_account",...}' },
    ],
  },
  // ── Ops & Monitoring ──────────────────────────────────────────────────
  {
    id: 'pagerduty',
    name: 'PagerDuty',
    secretPath: 'integrations/pagerduty/credentials',
    description: 'Incident management, on-call schedules, and alerting',
    secretFields: [
      { path: 'pagerduty/api-key', label: 'API Key', required: true, placeholder: 'PagerDuty REST API key' },
      { path: 'pagerduty/from-email', label: 'From Email', required: false, placeholder: 'user@company.com (for incident creation)' },
    ],
  },
  // ── Meeting Intelligence ────────────────────────────────────────────
  {
    id: 'fireflies',
    name: 'Fireflies.ai',
    secretPath: 'integrations/fireflies/credentials',
    description: 'Meeting transcripts, summaries, and action items via Fireflies API',
    secretFields: [
      { path: 'fireflies/api-key', label: 'API Key', required: true, placeholder: 'Fireflies API key from Settings → Integrations' },
    ],
  },
  {
    id: 'gong',
    name: 'Gong',
    secretPath: 'integrations/gong/credentials',
    description: 'Call recordings, transcripts, and revenue intelligence',
    secretFields: [
      { path: 'gong/access-key', label: 'Access Key', required: true, placeholder: 'Gong API access key' },
      { path: 'gong/access-key-secret', label: 'Access Key Secret', required: true, placeholder: 'Gong API access key secret' },
      { path: 'gong/base-url', label: 'Base URL', required: false, placeholder: 'https://api.gong.io (default)' },
    ],
  },
  // ── Search ────────────────────────────────────────────────────────────
  {
    id: 'web-search',
    name: 'Web Search',
    secretPath: 'integrations/web-search/credentials',
    description: 'Web search via Brave Search, Google, or other providers',
    secretFields: [
      { path: 'web-search/api-key', label: 'API Key', required: true, placeholder: 'Brave Search or other provider API key' },
      { path: 'web-search/provider', label: 'Provider', required: false, placeholder: 'brave (default)' },
    ],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function customDefFromRow(row: any): IntegrationDef & { source: 'custom'; category: string } {
  const slug = row.slug as string;
  return {
    id: `custom/${slug}`,
    name: row.name,
    secretPath: `integrations/custom/${slug}/credentials`,
    description: row.description ?? '',
    secretFields: row.secret_fields ?? [],
    source: 'custom' as const,
    category: row.category ?? 'Custom',
  };
}

function integrationStatus(
  def: IntegrationDef,
  configuredPaths: Set<string>,
  source: 'default' | 'custom',
) {
  const hasCredentials = configuredPaths.has(def.secretPath);
  const hasFieldSecrets = def.secretFields
    ? def.secretFields.some((f) => configuredPaths.has(f.path))
    : false;
  const isConfigured = hasCredentials || hasFieldSecrets;

  return {
    id: def.id,
    name: def.name,
    description: def.description,
    status: isConfigured ? 'connected' : 'disconnected',
    authMode: isConfigured ? 'credentials' : 'none',
    secretFields: def.secretFields ?? null,
    source,
    ...('category' in def ? { category: (def as any).category } : {}),
  };
}

/**
 * Integrations API routes.
 *
 * GET  /integrations              — list all integrations (built-in + custom)
 * POST /integrations/custom       — create a custom integration
 * GET  /integrations/custom       — list custom integrations only
 * PUT  /integrations/custom/:slug — update a custom integration
 * DELETE /integrations/custom/:slug — delete a custom integration
 * POST /integrations/:id/test     — test connection to an integration
 */
export async function integrationRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  const db = (app as any).db as import('pg').Pool;

  // ── GET / — list all integrations (built-in + custom) with status ────
  app.get('/', async (request) => {
    const workspaceId = request.workspaceId;

    // Load custom integrations for this workspace
    const { rows: customRows } = await db.query(
      `SELECT slug, name, description, category, secret_fields
       FROM custom_integrations WHERE workspace_id = $1 ORDER BY name`,
      [workspaceId],
    );
    const customDefs = customRows.map(customDefFromRow);

    // Merge all defs
    const allDefs: (IntegrationDef & { source: 'default' | 'custom' })[] = [
      ...KNOWN_INTEGRATIONS.map((d) => ({ ...d, source: 'default' as const })),
      ...customDefs,
    ];

    // Collect all secret paths to check in one query
    const allPaths: string[] = [];
    for (const def of allDefs) {
      allPaths.push(def.secretPath);
      if (def.secretFields) {
        for (const f of def.secretFields) allPaths.push(f.path);
      }
    }

    const { rows } = await db.query(
      `SELECT path FROM secrets WHERE workspace_id = $1 AND path = ANY($2)`,
      [workspaceId, allPaths],
    );
    const configuredPaths = new Set(rows.map((r: { path: string }) => r.path));

    return allDefs.map((def) => integrationStatus(def, configuredPaths, def.source));
  });

  // ── POST /custom — create a custom integration ──────────────────────
  app.post(
    '/custom',
    { preHandler: [requireRoles('workspace_admin')] },
    async (request, reply) => {
      const body = request.body as {
        name?: string;
        slug?: string;
        description?: string;
        category?: string;
        secretFields?: Array<{ label: string; required: boolean; placeholder?: string }>;
      };

      if (!body.name || !body.secretFields || body.secretFields.length === 0) {
        return reply.code(400).send({ error: 'name and secretFields (non-empty) are required' });
      }
      if (body.secretFields.length > 20) {
        return reply.code(400).send({ error: 'Maximum 20 secret fields per integration' });
      }

      const slug = body.slug ?? toSlug(body.name);
      if (!SLUG_RE.test(slug)) {
        return reply.code(400).send({
          error: 'slug must be 2-64 lowercase alphanumeric characters and hyphens, cannot start/end with hyphen',
        });
      }

      // Prevent collision with built-in IDs
      if (KNOWN_INTEGRATIONS.some((i) => i.id === slug)) {
        return reply.code(409).send({ error: `Slug "${slug}" conflicts with a built-in integration` });
      }

      // Build secret field paths
      const fieldsWithPaths: SecretFieldDef[] = body.secretFields.map((f) => ({
        path: `custom/${slug}/${toSlug(f.label)}`,
        label: f.label,
        required: f.required,
        placeholder: f.placeholder ?? '',
      }));

      try {
        const { rows } = await db.query(
          `INSERT INTO custom_integrations (workspace_id, slug, name, description, category, secret_fields)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, slug, name, description, category, secret_fields AS "secretFields", created_at AS "createdAt", updated_at AS "updatedAt"`,
          [request.workspaceId, slug, body.name, body.description ?? '', body.category ?? 'Custom', JSON.stringify(fieldsWithPaths)],
        );
        reply.code(201).send({ integration: rows[0] });
      } catch (err: any) {
        if (err.code === '23505') {
          return reply.code(409).send({ error: `Custom integration "${slug}" already exists in this workspace` });
        }
        throw err;
      }
    },
  );

  // ── GET /custom — list custom integrations only ─────────────────────
  app.get(
    '/custom',
    { preHandler: [requireRoles('workspace_admin')] },
    async (request) => {
      const { rows } = await db.query(
        `SELECT id, slug, name, description, category, secret_fields AS "secretFields",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM custom_integrations WHERE workspace_id = $1 ORDER BY name`,
        [request.workspaceId],
      );
      return { integrations: rows };
    },
  );

  // ── PUT /custom/:slug — update a custom integration ─────────────────
  app.put(
    '/custom/:slug',
    { preHandler: [requireRoles('workspace_admin')] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const body = request.body as {
        name?: string;
        description?: string;
        category?: string;
        secretFields?: Array<{ label: string; required: boolean; placeholder?: string }>;
      };

      const updates: string[] = ['updated_at = now()'];
      const params: unknown[] = [request.workspaceId, slug];
      let idx = 3;

      if (body.name !== undefined) { updates.push(`name = $${idx++}`); params.push(body.name); }
      if (body.description !== undefined) { updates.push(`description = $${idx++}`); params.push(body.description); }
      if (body.category !== undefined) { updates.push(`category = $${idx++}`); params.push(body.category); }
      if (body.secretFields !== undefined) {
        if (body.secretFields.length === 0) {
          return reply.code(400).send({ error: 'secretFields must not be empty' });
        }
        if (body.secretFields.length > 20) {
          return reply.code(400).send({ error: 'Maximum 20 secret fields per integration' });
        }
        const fieldsWithPaths: SecretFieldDef[] = body.secretFields.map((f) => ({
          path: `custom/${slug}/${toSlug(f.label)}`,
          label: f.label,
          required: f.required,
          placeholder: f.placeholder ?? '',
        }));
        updates.push(`secret_fields = $${idx++}`);
        params.push(JSON.stringify(fieldsWithPaths));
      }

      const { rows } = await db.query(
        `UPDATE custom_integrations SET ${updates.join(', ')}
         WHERE workspace_id = $1 AND slug = $2
         RETURNING id, slug, name, description, category, secret_fields AS "secretFields",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        params,
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Custom integration not found' });
      }

      return { integration: rows[0] };
    },
  );

  // ── DELETE /custom/:slug — delete a custom integration ──────────────
  app.delete(
    '/custom/:slug',
    { preHandler: [requireRoles('workspace_admin')] },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };

      const { rows } = await db.query(
        `DELETE FROM custom_integrations WHERE workspace_id = $1 AND slug = $2 RETURNING id`,
        [request.workspaceId, slug],
      );

      if (rows.length === 0) {
        return reply.code(404).send({ error: 'Custom integration not found' });
      }

      // Clean up associated secrets
      await db.query(
        `DELETE FROM secrets WHERE workspace_id = $1 AND (path LIKE $2 OR path LIKE $3)`,
        [request.workspaceId, `custom/${slug}/%`, `integrations/custom/${slug}/%`],
      );

      return { deleted: true, slug };
    },
  );

  // ── POST /:id/test — test connection to an integration ──────────────
  app.post(
    '/:id/test',
    { preHandler: [requireRoles('workspace_admin')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const workspaceId = request.workspaceId;

      // Resolve the integration definition (built-in or custom)
      let def: IntegrationDef | undefined = KNOWN_INTEGRATIONS.find((i) => i.id === id);

      if (!def && id.startsWith('custom/')) {
        const slug = id.slice('custom/'.length);
        const { rows } = await db.query(
          `SELECT slug, name, description, secret_fields
           FROM custom_integrations WHERE workspace_id = $1 AND slug = $2`,
          [workspaceId, slug],
        );
        if (rows.length > 0) {
          def = customDefFromRow(rows[0]);
        }
      }

      if (!def) {
        reply.code(404).send({ error: 'Integration not found' });
        return;
      }

      // Check if credentials exist
      const pathsToCheck = [def.secretPath];
      if (def.secretFields) {
        for (const f of def.secretFields) pathsToCheck.push(f.path);
      }

      const { rows } = await db.query(
        `SELECT path FROM secrets WHERE workspace_id = $1 AND path = ANY($2)`,
        [workspaceId, pathsToCheck],
      );

      if (rows.length === 0) {
        const hint = def.secretFields
          ? `Configure ${def.name} from the Integrations page or via CLI.`
          : `Store credentials with: honorclaw secrets set ${def.secretPath} '{...}'`;
        return { status: 'disconnected', errorMessage: `${def.name} is not configured. ${hint}` };
      }

      // Check required fields
      if (def.secretFields) {
        const storedPaths = new Set(rows.map((r: { path: string }) => r.path));
        const missing = def.secretFields.filter((f) => f.required && !storedPaths.has(f.path));
        if (missing.length > 0) {
          return {
            status: 'error',
            errorMessage: `Missing required fields: ${missing.map((f) => f.label).join(', ')}`,
          };
        }
      }

      return {
        status: 'connected',
        message: `${def.name} credentials are configured. Tools using this integration will authenticate at runtime.`,
      };
    },
  );
}
