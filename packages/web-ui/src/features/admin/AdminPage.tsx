import { useState, useEffect, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/useAuth.js';

// ── Types ───────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  model: string;
  status: 'active' | 'paused' | 'error';
  workspaceId: string;
}

interface User {
  id: string;
  email: string;
  displayName: string;
  role: string;
  createdAt: string;
}

type AdminTab = 'agents' | 'users';

// ── Component ───────────────────────────────────────────────────────────

export function AdminPage() {
  const { workspaceId } = useAuth();
  const [tab, setTab] = useState<AdminTab>('agents');

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">Admin Panel</h1>
          <Link to="/" className="text-sm text-blue-600 hover:text-blue-700">
            Back to Chat
          </Link>
        </div>
        <nav className="mt-4 flex gap-4">
          <button
            onClick={() => setTab('agents')}
            className={`pb-2 text-sm font-medium ${
              tab === 'agents'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Agents
          </button>
          <button
            onClick={() => setTab('users')}
            className={`pb-2 text-sm font-medium ${
              tab === 'users'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Users
          </button>
        </nav>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-6">
        {tab === 'agents' && <AgentList workspaceId={workspaceId} />}
        {tab === 'users' && <UserManagement workspaceId={workspaceId} />}
      </main>
    </div>
  );
}

// ── Agent List ──────────────────────────────────────────────────────────

function AgentList({ workspaceId }: { workspaceId: string | null }) {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const data = await api.get<{ agents: Agent[] }>('/agents');
        setAgents(data.agents);
      } catch {
        // handled by global error
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  if (loading) {
    return <div className="text-sm text-gray-500 py-8 text-center">Loading agents...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Agents</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          Create Agent
        </button>
      </div>

      {showCreate && (
        <AgentEditor
          workspaceId={workspaceId}
          onSave={(agent) => {
            setAgents((prev) => [...prev, agent]);
            setShowCreate(false);
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Workspace</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {agents.map((agent) => (
              <tr key={agent.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-sm font-medium text-gray-900">{agent.name}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{agent.model}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={agent.status} />
                </td>
                <td className="px-4 py-3 text-sm text-gray-500 font-mono text-xs">
                  {agent.workspaceId.slice(0, 8)}
                </td>
                <td className="px-4 py-3 text-right text-sm space-x-2">
                  <button
                    onClick={() => navigate(`/admin/agents/${agent.id}`)}
                    className="text-blue-600 hover:text-blue-700"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => navigate(`/admin/agents/${agent.id}/manifest`)}
                    className="text-gray-600 hover:text-gray-700"
                  >
                    Manifest
                  </button>
                </td>
              </tr>
            ))}
            {agents.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-500">
                  No agents configured yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Agent Editor (inline for create / standalone for edit) ──────────────

interface AgentEditorProps {
  workspaceId: string | null;
  agent?: Agent;
  onSave: (agent: Agent) => void;
  onCancel: () => void;
}

export function AgentEditor({ workspaceId, agent, onSave, onCancel }: AgentEditorProps) {
  const [name, setName] = useState(agent?.name ?? '');
  const [model, setModel] = useState(agent?.model ?? 'ollama/llama3.2');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load existing system prompt if editing
  useEffect(() => {
    if (!agent) return;
    async function loadPrompt() {
      try {
        const data = await api.get<{ agent: { system_prompt: string } }>(`/agents/${agent!.id}`);
        setSystemPrompt(data.agent?.system_prompt ?? '');
      } catch {
        // Best effort
      }
    }
    void loadPrompt();
  }, [agent]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    try {
      const payload = {
        name,
        model,
        systemPrompt,
        workspaceId: workspaceId ?? undefined,
      };

      let result: Agent;
      if (agent) {
        const resp = await api.put<{ agent: Agent }>(`/agents/${agent.id}`, payload);
        result = resp.agent;
      } else {
        const resp = await api.post<{ agent: Agent }>('/agents', payload);
        result = resp.agent;
      }

      onSave(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save agent');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-4 mb-4 space-y-4">
      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700">Name</label>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">Model</label>
          <input
            type="text"
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700">System Prompt</label>
        <textarea
          rows={6}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? 'Saving...' : agent ? 'Update Agent' : 'Create Agent'}
        </button>
      </div>
    </form>
  );
}

// ── User Management ─────────────────────────────────────────────────────

function UserManagement({ workspaceId: _workspaceId }: { workspaceId: string | null }) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('agent_user');
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const data = await api.get<{ users: User[] }>('/users');
        setUsers(data.users);
      } catch {
        // handled by global error
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setInviting(true);
    try {
      const resp = await api.post<{ user: User }>('/users', {
        email: inviteEmail,
        role: inviteRole,
      });
      setUsers((prev) => [...prev, resp.user]);
      setInviteEmail('');
    } catch {
      // handled by global error
    } finally {
      setInviting(false);
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
    try {
      await api.patch(`/users/${userId}/role`, { role: newRole });
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)),
      );
    } catch {
      // handled by global error
    }
  }

  if (loading) {
    return <div className="text-sm text-gray-500 py-8 text-center">Loading users...</div>;
  }

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Users</h2>

      {/* Invite form */}
      <form onSubmit={handleInvite} className="flex gap-2 mb-4">
        <input
          type="email"
          required
          placeholder="Email address"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          className="flex-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <select
          value={inviteRole}
          onChange={(e) => setInviteRole(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm"
        >
          <option value="agent_user">Agent User</option>
          <option value="auditor">Auditor</option>
          <option value="workspace_admin">Admin</option>
          <option value="api_service">API Service</option>
        </select>
        <button
          type="submit"
          disabled={inviting}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {inviting ? 'Inviting...' : 'Invite'}
        </button>
      </form>

      {/* User table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Email</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Joined</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {users.map((user) => (
              <tr key={user.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 text-sm font-medium text-gray-900">{user.displayName ?? user.email}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{user.email}</td>
                <td className="px-4 py-3">
                  <select
                    value={user.role}
                    onChange={(e) => handleRoleChange(user.id, e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-xs"
                  >
                    <option value="agent_user">Agent User</option>
                    <option value="auditor">Auditor</option>
                    <option value="workspace_admin">Admin</option>
                    <option value="api_service">API Service</option>
                  </select>
                </td>
                <td className="px-4 py-3 text-sm text-gray-500">
                  {new Date(user.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-500">
                  No users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-100 text-green-800',
    paused: 'bg-yellow-100 text-yellow-800',
    error: 'bg-red-100 text-red-800',
  };

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-800'}`}>
      {status}
    </span>
  );
}
