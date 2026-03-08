import type { FastifyInstance } from 'fastify';
import { requireWorkspace, requireRoles } from '../middleware/rbac.js';

/**
 * Integrations API routes.
 *
 * GET  /integrations            — list configured integrations
 * POST /integrations/:id/test   — test connection to an integration
 */
export async function integrationRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  // Default integration definitions
  const DEFAULT_INTEGRATIONS = [
    {
      id: 'google-workspace',
      name: 'Google Workspace',
      status: 'disconnected' as const,
      authMode: 'none' as const,
    },
    {
      id: 'microsoft-365',
      name: 'Microsoft 365',
      status: 'disconnected' as const,
      authMode: 'none' as const,
    },
  ];

  // GET /integrations — list integrations and their connection status
  app.get('/', async () => {
    // TODO: In a full implementation, read integration configs from DB
    // For now, return the default set with 'disconnected' status
    return DEFAULT_INTEGRATIONS;
  });

  // POST /integrations/:id/test — test connection to an integration
  app.post(
    '/:id/test',
    { preHandler: [requireRoles('workspace_admin')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const known = DEFAULT_INTEGRATIONS.find((i) => i.id === id);
      if (!known) {
        reply.code(404).send({ error: 'Integration not found' });
        return;
      }

      // TODO: In a full implementation, actually test the connection
      // using stored credentials. For now, report disconnected status.
      return {
        status: 'disconnected',
        errorMessage: `${known.name} is not yet configured. Add credentials in the integration settings.`,
      };
    },
  );
}
