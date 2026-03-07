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
      db.query('SELECT * FROM webhook_subscriptions WHERE workspace_id = $1', [workspaceId]),
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

    // Import agents
    if (data.agents && Array.isArray(data.agents)) {
      for (const agent of data.agents) {
        try {
          await db.query(
            `INSERT INTO agents (workspace_id, name, display_name, model, system_prompt, status, settings)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (workspace_id, name) DO UPDATE
               SET display_name = $3, model = $4, system_prompt = $5, status = $6, settings = $7, updated_at = now()`,
            [
              workspaceId,
              agent.name,
              agent.display_name ?? null,
              agent.model ?? 'ollama/llama3.2',
              agent.system_prompt ?? '',
              agent.status ?? 'active',
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
        try {
          await db.query(
            `INSERT INTO skills (workspace_id, name, version, manifest_yaml)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (workspace_id, name) DO UPDATE
               SET version = $3, manifest_yaml = $4, updated_at = now()`,
            [
              workspaceId,
              skill.name,
              skill.version ?? 'latest',
              skill.manifest_yaml ?? '{}',
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
