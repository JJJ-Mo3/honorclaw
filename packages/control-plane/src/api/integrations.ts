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
  {
    id: 'google-workspace',
    name: 'Google Workspace',
    secretPath: 'integrations/google-workspace/credentials',
    description: 'Gmail, Calendar, Drive, Sheets, and Contacts access',
  },
  {
    id: 'microsoft-365',
    name: 'Microsoft 365',
    secretPath: 'integrations/microsoft-365/credentials',
    description: 'Outlook, Calendar, OneDrive, Excel, and Contacts access',
  },
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
    id: 'jira',
    name: 'Jira',
    secretPath: 'integrations/jira/credentials',
    description: 'Issue tracking, sprint management, and project boards',
  },
  {
    id: 'github',
    name: 'GitHub',
    secretPath: 'integrations/github/credentials',
    description: 'Repository access, pull requests, issues, and actions',
  },
  {
    id: 'pagerduty',
    name: 'PagerDuty',
    secretPath: 'integrations/pagerduty/credentials',
    description: 'Incident management, on-call schedules, and alerting',
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    secretPath: 'integrations/salesforce/credentials',
    description: 'CRM queries, records, cases, and search',
  },
  {
    id: 'confluence',
    name: 'Confluence',
    secretPath: 'integrations/confluence/credentials',
    description: 'Wiki pages, knowledge base, and documentation',
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
