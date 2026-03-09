import { describe, it, expect, vi } from 'vitest';
import { requireRoles, requireWorkspace } from './rbac.js';

function createMockRequest(overrides: {
  roles?: string[];
  isDeploymentAdmin?: boolean;
  workspaceId?: string;
} = {}) {
  return {
    roles: overrides.roles ?? [],
    isDeploymentAdmin: overrides.isDeploymentAdmin ?? false,
    workspaceId: overrides.workspaceId,
  } as any;
}

function createMockReply() {
  const reply: any = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
}

describe('requireRoles', () => {
  it('allows deployment admin regardless of role', async () => {
    const handler = requireRoles('workspace_admin');
    const request = createMockRequest({ isDeploymentAdmin: true, roles: [] });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it('allows user with matching role', async () => {
    const handler = requireRoles('workspace_admin');
    const request = createMockRequest({ roles: ['workspace_admin'] });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
  });

  it('allows user with any matching role from multiple', async () => {
    const handler = requireRoles('auditor', 'workspace_admin');
    const request = createMockRequest({ roles: ['auditor'] });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
  });

  it('rejects user without matching role', async () => {
    const handler = requireRoles('workspace_admin');
    const request = createMockRequest({ roles: ['agent_user'] });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Insufficient permissions' });
  });

  it('rejects user with no roles', async () => {
    const handler = requireRoles('workspace_admin');
    const request = createMockRequest({ roles: [] });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it('rejects user with undefined roles', async () => {
    const handler = requireRoles('workspace_admin');
    const request = createMockRequest();
    (request as any).roles = undefined;
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.code).toHaveBeenCalledWith(403);
  });
});

describe('requireWorkspace', () => {
  it('allows request with workspaceId', async () => {
    const handler = requireWorkspace();
    const request = createMockRequest({ workspaceId: 'ws-123' });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
  });

  it('rejects request without workspaceId', async () => {
    const handler = requireWorkspace();
    const request = createMockRequest();
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Workspace context required' });
  });

  it('rejects request with undefined workspaceId', async () => {
    const handler = requireWorkspace();
    const request = createMockRequest({ workspaceId: undefined });
    const reply = createMockReply();

    await handler(request, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
  });
});
