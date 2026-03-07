import type { FastifyRequest, FastifyReply } from 'fastify';

export type Role = 'deployment_admin' | 'workspace_admin' | 'agent_user' | 'auditor' | 'api_service';

export function requireRoles(...allowedRoles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.isDeploymentAdmin) return; // deployment admins can do anything

    const userRoles = request.roles ?? [];
    const hasRole = allowedRoles.some(role => userRoles.includes(role));

    if (!hasRole) {
      reply.code(403).send({ error: 'Insufficient permissions' });
      return reply;
    }
  };
}

export function requireWorkspace() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.workspaceId) {
      reply.code(400).send({ error: 'Workspace context required' });
      return reply;
    }
  };
}
