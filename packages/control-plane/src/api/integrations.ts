import type { FastifyInstance } from 'fastify';
import { requireWorkspace, requireRoles } from '../middleware/rbac.js';

interface IntegrationDef {
  id: string;
  name: string;
  secretPath: string;
  description: string;
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

    // Check which integrations have credentials stored
    const { rows } = await db.query(
      `SELECT path FROM secrets WHERE workspace_id = $1 AND path LIKE 'integrations/%/credentials'`,
      [workspaceId],
    );
    const configuredPaths = new Set(rows.map((r: { path: string }) => r.path));

    return KNOWN_INTEGRATIONS.map((def) => ({
      id: def.id,
      name: def.name,
      description: def.description,
      status: configuredPaths.has(def.secretPath) ? 'connected' : 'disconnected',
      authMode: configuredPaths.has(def.secretPath) ? 'credentials' : 'none',
    }));
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

      // Check if credentials exist
      const { rows } = await db.query(
        `SELECT id FROM secrets WHERE workspace_id = $1 AND path = $2`,
        [workspaceId, def.secretPath],
      );

      if (rows.length === 0) {
        return {
          status: 'disconnected',
          errorMessage: `${def.name} is not configured. Store credentials with: honorclaw secrets set ${def.secretPath} '{...}'`,
        };
      }

      return {
        status: 'connected',
        message: `${def.name} credentials are configured. Tools using this integration will authenticate at runtime.`,
      };
    },
  );
}
