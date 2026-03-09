import type { FastifyInstance } from 'fastify';
import { requireRoles, requireWorkspace } from '../middleware/rbac.js';

export async function migrateRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireWorkspace());

  // Export workspace data as JSON
  app.post('/export', { preHandler: [requireRoles('workspace_admin')] }, async (request) => {
    const db = (app as any).db;
    const workspaceId = request.workspaceId;

    // Export all workspace-scoped data
    const [
      workspaces,
      agents,
      manifests,
      sessions,
      secrets,
      skills,
      approvals,
      webhooks,
      notifications,
    ] = await Promise.all([
      db.query('SELECT * FROM workspaces WHERE id = $1', [workspaceId]),
      db.query('SELECT * FROM agents WHERE workspace_id = $1', [workspaceId]),
      db.query('SELECT * FROM capability_manifests WHERE workspace_id = $1', [workspaceId]),
      db.query('SELECT id, workspace_id, agent_id, user_id, session_type, status, channel, started_at, ended_at, tokens_used, tool_calls_count, metadata FROM sessions WHERE workspace_id = $1', [workspaceId]),
      db.query('SELECT id, workspace_id, path, expires_at, created_at, updated_at FROM secrets WHERE workspace_id = $1', [workspaceId]),
      db.query('SELECT * FROM skills WHERE workspace_id = $1', [workspaceId]),
      db.query('SELECT * FROM approval_requests WHERE workspace_id = $1', [workspaceId]),
      db.query('SELECT id, workspace_id, url, event_types, active, created_at, updated_at FROM webhook_subscriptions WHERE workspace_id = $1', [workspaceId]),
      db.query('SELECT * FROM notifications WHERE workspace_id = $1', [workspaceId]),
    ]);

    return {
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      workspaceId,
      data: {
        workspaces: workspaces.rows,
        agents: agents.rows,
        manifests: manifests.rows,
        sessions: sessions.rows,
        secrets: secrets.rows,
        skills: skills.rows,
        approvals: approvals.rows,
        webhooks: webhooks.rows,
        notifications: notifications.rows,
      },
    };
  });

  // Import workspace data from JSON
  app.post('/import', { preHandler: [requireRoles('workspace_admin')] }, async (request, reply) => {
    const { data } = request.body as {
      data: {
        agents?: Array<Record<string, unknown>>;
        skills?: Array<Record<string, unknown>>;
      };
    };

    if (!data) {
      reply.code(400).send({ error: 'Import data is required' });
      return;
    }

    const db = (app as any).db;
    const workspaceId = request.workspaceId;
    let importedAgents = 0;
    let importedSkills = 0;

    const VALID_STATUSES = ['active', 'inactive', 'archived'];

    // Import agents
    if (data.agents && Array.isArray(data.agents)) {
      for (const agent of data.agents) {
        // Validate required fields and enforce length/type constraints
        if (typeof agent.name !== 'string' || agent.name.length === 0 || agent.name.length > 255) continue;
        const status = typeof agent.status === 'string' && VALID_STATUSES.includes(agent.status) ? agent.status : 'active';
        const systemPrompt = typeof agent.system_prompt === 'string' ? agent.system_prompt.slice(0, 100_000) : '';

        try {
          await db.query(
            `INSERT INTO agents (workspace_id, name, display_name, model, system_prompt, status, settings)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (workspace_id, name) DO UPDATE
               SET display_name = $3, model = $4, system_prompt = $5, status = $6, settings = $7, updated_at = now()`,
            [
              workspaceId,
              agent.name,
              typeof agent.display_name === 'string' ? agent.display_name.slice(0, 255) : null,
              typeof agent.model === 'string' ? agent.model.slice(0, 255) : 'ollama/llama3.2',
              systemPrompt,
              status,
              JSON.stringify(agent.settings ?? {}),
            ]
          );
          importedAgents++;
        } catch {
          // Skip entries that fail to import
        }
      }
    }

    // Import skills
    if (data.skills && Array.isArray(data.skills)) {
      for (const skill of data.skills) {
        // Validate required fields and enforce length constraints
        if (typeof skill.name !== 'string' || skill.name.length === 0 || skill.name.length > 255) continue;

        try {
          await db.query(
            `INSERT INTO skills (workspace_id, name, version, manifest_yaml)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (workspace_id, name) DO UPDATE
               SET version = $3, manifest_yaml = $4, updated_at = now()`,
            [
              workspaceId,
              skill.name,
              typeof skill.version === 'string' ? skill.version.slice(0, 50) : 'latest',
              typeof skill.manifest_yaml === 'string' ? skill.manifest_yaml.slice(0, 100_000) : '{}',
            ]
          );
          importedSkills++;
        } catch {
          // Skip entries that fail to import
        }
      }
    }

    return {
      imported: true,
      counts: {
        agents: importedAgents,
        skills: importedSkills,
      },
    };
  });
}
