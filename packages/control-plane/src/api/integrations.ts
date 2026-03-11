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

/**
 * Integrations API routes.
 *
 * GET  /integrations            — list configured integrations with connection status
 * POST /integrations/:id/test   — test connection to an integration
 */
export async function integrationRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  const db = (app as any).db as import('pg').Pool;

  // GET /integrations — list integrations with status derived from stored secrets
  app.get('/', async (request) => {
    const workspaceId = request.workspaceId;

    // Collect all known secret paths to check in one query
    const allKnownPaths: string[] = [];
    for (const def of KNOWN_INTEGRATIONS) {
      allKnownPaths.push(def.secretPath);
      if (def.secretFields) {
        for (const f of def.secretFields) {
          allKnownPaths.push(f.path);
        }
      }
    }

    const { rows } = await db.query(
      `SELECT path FROM secrets WHERE workspace_id = $1 AND path = ANY($2)`,
      [workspaceId, allKnownPaths],
    );
    const configuredPaths = new Set(rows.map((r: { path: string }) => r.path));

    return KNOWN_INTEGRATIONS.map((def) => {
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
      };
    });
  });

  // POST /integrations/:id/test — test connection to an integration
  app.post(
    '/:id/test',
    { preHandler: [requireRoles('workspace_admin')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const workspaceId = request.workspaceId;

      const def = KNOWN_INTEGRATIONS.find((i) => i.id === id);
      if (!def) {
        reply.code(404).send({ error: 'Integration not found' });
        return;
      }

      // Check if credentials exist (main path or per-field secrets)
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

      // For integrations with per-field secrets, check that required fields are present
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
