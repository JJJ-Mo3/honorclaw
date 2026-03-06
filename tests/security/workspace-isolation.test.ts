/**
 * Workspace Isolation Tests
 *
 * These tests validate that the workspace isolation boundary is enforced
 * at every layer of the Capability Sandwich. Workspace isolation is a
 * fundamental security property: data, agents, and operations in one
 * workspace MUST NOT be accessible from another workspace.
 *
 * Test categories:
 * - Audit: workspace_id is always required
 * - Memory: cross-workspace vector queries are blocked
 * - Agent: cross-workspace agent access is blocked
 * - Storage: cross-workspace storage access is blocked
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock interfaces matching the HonorClaw architecture
// ---------------------------------------------------------------------------

interface WorkspaceContext {
  workspaceId: string;
  userId: string;
  sessionId: string;
}

interface AuditEvent {
  workspaceId: string;
  action: string;
  resourceId: string;
  timestamp: Date;
}

// Simulated workspace-scoped services
class WorkspaceScopedMemory {
  private store = new Map<string, Map<string, unknown[]>>();

  async query(ctx: WorkspaceContext, collection: string, _queryVec: number[]): Promise<unknown[]> {
    if (!ctx.workspaceId) {
      throw new Error('workspace_id is required');
    }
    const wsStore = this.store.get(ctx.workspaceId);
    if (!wsStore) return [];
    return wsStore.get(collection) ?? [];
  }

  async insert(ctx: WorkspaceContext, collection: string, data: unknown): Promise<void> {
    if (!ctx.workspaceId) {
      throw new Error('workspace_id is required');
    }
    if (!this.store.has(ctx.workspaceId)) {
      this.store.set(ctx.workspaceId, new Map());
    }
    const wsStore = this.store.get(ctx.workspaceId)!;
    if (!wsStore.has(collection)) {
      wsStore.set(collection, []);
    }
    wsStore.get(collection)!.push(data);
  }
}

class WorkspaceScopedAgentRegistry {
  private agents = new Map<string, Set<string>>();

  register(workspaceId: string, agentId: string): void {
    if (!this.agents.has(workspaceId)) {
      this.agents.set(workspaceId, new Set());
    }
    this.agents.get(workspaceId)!.add(agentId);
  }

  getAgent(ctx: WorkspaceContext, agentId: string): string | null {
    if (!ctx.workspaceId) {
      throw new Error('workspace_id is required');
    }
    const wsAgents = this.agents.get(ctx.workspaceId);
    if (!wsAgents || !wsAgents.has(agentId)) return null;
    return agentId;
  }

  listAgents(ctx: WorkspaceContext): string[] {
    if (!ctx.workspaceId) {
      throw new Error('workspace_id is required');
    }
    const wsAgents = this.agents.get(ctx.workspaceId);
    return wsAgents ? Array.from(wsAgents) : [];
  }
}

class WorkspaceScopedStorage {
  private storage = new Map<string, Map<string, string>>();

  async write(ctx: WorkspaceContext, key: string, value: string): Promise<void> {
    if (!ctx.workspaceId) {
      throw new Error('workspace_id is required');
    }
    if (!this.storage.has(ctx.workspaceId)) {
      this.storage.set(ctx.workspaceId, new Map());
    }
    this.storage.get(ctx.workspaceId)!.set(key, value);
  }

  async read(ctx: WorkspaceContext, key: string): Promise<string | null> {
    if (!ctx.workspaceId) {
      throw new Error('workspace_id is required');
    }
    const wsStorage = this.storage.get(ctx.workspaceId);
    if (!wsStorage) return null;
    return wsStorage.get(key) ?? null;
  }

  async list(ctx: WorkspaceContext): Promise<string[]> {
    if (!ctx.workspaceId) {
      throw new Error('workspace_id is required');
    }
    const wsStorage = this.storage.get(ctx.workspaceId);
    return wsStorage ? Array.from(wsStorage.keys()) : [];
  }
}

class AuditLog {
  events: AuditEvent[] = [];

  record(event: AuditEvent): void {
    if (!event.workspaceId) {
      throw new Error('workspace_id is required for audit events');
    }
    this.events.push(event);
  }

  query(workspaceId: string): AuditEvent[] {
    return this.events.filter(e => e.workspaceId === workspaceId);
  }
}

// ---------------------------------------------------------------------------
// Test contexts
// ---------------------------------------------------------------------------

const wsA: WorkspaceContext = { workspaceId: 'ws-alpha', userId: 'user-a', sessionId: 'sess-a' };
const wsB: WorkspaceContext = { workspaceId: 'ws-beta', userId: 'user-b', sessionId: 'sess-b' };

// ---------------------------------------------------------------------------
// Tests: Audit workspace_id required
// ---------------------------------------------------------------------------

describe('Audit: workspace_id Required', () => {
  let auditLog: AuditLog;

  beforeEach(() => {
    auditLog = new AuditLog();
  });

  it('accepts audit event with valid workspace_id', () => {
    expect(() => {
      auditLog.record({
        workspaceId: 'ws-alpha',
        action: 'agent.created',
        resourceId: 'agent-001',
        timestamp: new Date(),
      });
    }).not.toThrow();
    expect(auditLog.events).toHaveLength(1);
  });

  it('rejects audit event with empty workspace_id', () => {
    expect(() => {
      auditLog.record({
        workspaceId: '',
        action: 'agent.created',
        resourceId: 'agent-001',
        timestamp: new Date(),
      });
    }).toThrow('workspace_id is required');
  });

  it('scopes audit queries to workspace', () => {
    auditLog.record({ workspaceId: 'ws-alpha', action: 'tool.called', resourceId: 'tool-1', timestamp: new Date() });
    auditLog.record({ workspaceId: 'ws-beta', action: 'tool.called', resourceId: 'tool-2', timestamp: new Date() });

    const alphaEvents = auditLog.query('ws-alpha');
    const betaEvents = auditLog.query('ws-beta');

    expect(alphaEvents).toHaveLength(1);
    expect(alphaEvents[0]!.resourceId).toBe('tool-1');
    expect(betaEvents).toHaveLength(1);
    expect(betaEvents[0]!.resourceId).toBe('tool-2');
  });
});

// ---------------------------------------------------------------------------
// Tests: Memory cross-workspace isolation
// ---------------------------------------------------------------------------

describe('Memory: Cross-Workspace Isolation', () => {
  let memory: WorkspaceScopedMemory;

  beforeEach(async () => {
    memory = new WorkspaceScopedMemory();
    await memory.insert(wsA, 'docs', { text: 'Alpha secret document', id: 'doc-alpha' });
    await memory.insert(wsB, 'docs', { text: 'Beta secret document', id: 'doc-beta' });
  });

  it('returns data only from the requesting workspace', async () => {
    const results = await memory.query(wsA, 'docs', [1, 0, 0]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'doc-alpha' });
  });

  it('workspace B cannot see workspace A data', async () => {
    const results = await memory.query(wsB, 'docs', [1, 0, 0]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'doc-beta' });
    // Verify no alpha data leaks
    expect(results.some((r: any) => r.id === 'doc-alpha')).toBe(false);
  });

  it('rejects query without workspace_id', async () => {
    const badCtx = { ...wsA, workspaceId: '' };
    await expect(memory.query(badCtx, 'docs', [1, 0, 0])).rejects.toThrow('workspace_id is required');
  });

  it('empty workspace returns no results', async () => {
    const emptyWs: WorkspaceContext = { workspaceId: 'ws-empty', userId: 'user-empty', sessionId: 'sess-empty' };
    const results = await memory.query(emptyWs, 'docs', [1, 0, 0]);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: Agent cross-workspace access blocked
// ---------------------------------------------------------------------------

describe('Agent: Cross-Workspace Access Blocked', () => {
  let registry: WorkspaceScopedAgentRegistry;

  beforeEach(() => {
    registry = new WorkspaceScopedAgentRegistry();
    registry.register('ws-alpha', 'agent-alpha-1');
    registry.register('ws-alpha', 'agent-alpha-2');
    registry.register('ws-beta', 'agent-beta-1');
  });

  it('workspace A can access its own agents', () => {
    const agent = registry.getAgent(wsA, 'agent-alpha-1');
    expect(agent).toBe('agent-alpha-1');
  });

  it('workspace A cannot access workspace B agents', () => {
    const agent = registry.getAgent(wsA, 'agent-beta-1');
    expect(agent).toBeNull();
  });

  it('workspace B cannot access workspace A agents', () => {
    const agent = registry.getAgent(wsB, 'agent-alpha-1');
    expect(agent).toBeNull();
  });

  it('listing agents returns only workspace-scoped results', () => {
    const alphaAgents = registry.listAgents(wsA);
    expect(alphaAgents).toHaveLength(2);
    expect(alphaAgents).toContain('agent-alpha-1');
    expect(alphaAgents).toContain('agent-alpha-2');
    expect(alphaAgents).not.toContain('agent-beta-1');
  });

  it('rejects agent access without workspace_id', () => {
    const badCtx = { ...wsA, workspaceId: '' };
    expect(() => registry.getAgent(badCtx, 'agent-alpha-1')).toThrow('workspace_id is required');
  });
});

// ---------------------------------------------------------------------------
// Tests: Storage cross-workspace access blocked
// ---------------------------------------------------------------------------

describe('Storage: Cross-Workspace Access Blocked', () => {
  let storage: WorkspaceScopedStorage;

  beforeEach(async () => {
    storage = new WorkspaceScopedStorage();
    await storage.write(wsA, 'config.json', '{"setting": "alpha"}');
    await storage.write(wsB, 'config.json', '{"setting": "beta"}');
    await storage.write(wsA, 'data.csv', 'id,name\n1,Alpha');
  });

  it('workspace A reads its own data', async () => {
    const data = await storage.read(wsA, 'config.json');
    expect(data).toBe('{"setting": "alpha"}');
  });

  it('workspace B reads its own data (same key, different content)', async () => {
    const data = await storage.read(wsB, 'config.json');
    expect(data).toBe('{"setting": "beta"}');
  });

  it('workspace B cannot read workspace A files', async () => {
    const data = await storage.read(wsB, 'data.csv');
    expect(data).toBeNull();
  });

  it('listing shows only workspace-scoped keys', async () => {
    const alphaKeys = await storage.list(wsA);
    expect(alphaKeys).toHaveLength(2);
    expect(alphaKeys).toContain('config.json');
    expect(alphaKeys).toContain('data.csv');

    const betaKeys = await storage.list(wsB);
    expect(betaKeys).toHaveLength(1);
    expect(betaKeys).toContain('config.json');
  });

  it('rejects storage access without workspace_id', async () => {
    const badCtx = { ...wsA, workspaceId: '' };
    await expect(storage.read(badCtx, 'config.json')).rejects.toThrow('workspace_id is required');
  });
});
