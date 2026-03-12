import { useState, useEffect, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/useAuth.js';

// ── Types ───────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  model: string;
  status: 'active' | 'inactive' | 'archived';
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
          <div>
            <h1 className="text-xl font-bold text-gray-900">Admin Panel</h1>
            <p className="mt-1 text-sm text-gray-500">Create and configure agents, models, and platform settings</p>
          </div>
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
                    onClick={() => navigate(`/admin/agents/${agent.id}/manifest/visual`)}
                    className="text-gray-600 hover:text-gray-700"
                  >
                    Manifest
                  </button>
                  {agent.status !== 'archived' && (
                    <button
                      onClick={async () => {
                        if (!confirm(`Archive agent "${agent.name}"?`)) return;
                        try {
                          await api.delete(`/agents/${agent.id}`);
                          setAgents((prev) => prev.map((a) =>
                            a.id === agent.id ? { ...a, status: 'archived' as const } : a
                          ));
                        } catch {
                          // handled by global error
                        }
                      }}
                      className="text-red-600 hover:text-red-700"
                    >
                      Archive
                    </button>
                  )}
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

interface AgentSkill {
  skillName: string;
  enabled: boolean;
  description?: string;
}

interface InstalledSkill {
  name: string;
  version: string;
  description: string;
}

interface WorkspaceIntegration {
  id: string;
  name: string;
  status: string;
  description?: string;
}

interface AgentEditorProps {
  workspaceId: string | null;
  agent?: Agent;
  appliedSkills?: AgentSkill[];
  installedSkills?: InstalledSkill[];
  integrations?: WorkspaceIntegration[];
  onSave: (agent: Agent) => void;
  onCancel: () => void;
}

interface ModelOption {
  value: string;
  label: string;
  provider: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  ollama: 'Ollama (Installed)',
  ollama_available: 'Ollama (Available to Pull)',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex AI',
  azure: 'Azure OpenAI',
  google: 'Google',
  mistral: 'Mistral',
};

function humanModelName(fullName: string): string {
  // "ollama/llama3.2:latest" → "llama3.2:latest"
  const name = fullName.includes('/') ? fullName.split('/').slice(1).join('/') : fullName;
  return name.replace(/:latest$/, '');
}

export function AgentEditor({ workspaceId, agent, appliedSkills: initialSkills, installedSkills, integrations, onSave, onCancel }: AgentEditorProps) {
  const [name, setName] = useState(agent?.name ?? '');
  const [model, setModel] = useState(agent?.model ?? '');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [skills, setSkills] = useState<AgentSkill[]>(initialSkills ?? []);
  const [addingSkill, setAddingSkill] = useState(false);

  // Load available models and resolve the default model from the backend
  useEffect(() => {
    async function loadModels() {
      try {
        // Fetch models and default model status in parallel
        const [modelsData, statusData] = await Promise.all([
          api.get<{
            local: { name: string; provider: string }[];
            available: { name: string; provider: string }[];
            frontier: { name: string; provider: string }[];
          }>('/models'),
          api.get<{ defaultModel: string }>('/models/status').catch(() => null),
        ]);

        // If creating a new agent and no model selected yet, use the server's default
        if (!agent && !model && statusData?.defaultModel) {
          setModel(`ollama/${statusData.defaultModel}`);
        }

        const models: ModelOption[] = [];

        // Local Ollama models (actually installed)
        for (const m of modelsData.local ?? []) {
          const value = `ollama/${m.name}`;
          models.push({ value, label: humanModelName(m.name), provider: 'ollama' });
        }

        // Available Ollama models (not yet pulled — will auto-pull on use)
        for (const m of modelsData.available ?? []) {
          const value = `ollama/${m.name}`;
          models.push({ value, label: `${m.name} (pull on use)`, provider: 'ollama_available' });
        }

        // Frontier models (based on configured API keys)
        for (const m of modelsData.frontier ?? []) {
          const value = `${m.provider}/${m.name}`;
          models.push({ value, label: m.name, provider: m.provider });
        }

        setAvailableModels(models);
      } catch {
        // Fall back to empty — the select will still show the current value
      } finally {
        setModelsLoading(false);
      }
    }
    void loadModels();
  }, []);

  // Load existing system prompt if editing
  useEffect(() => {
    if (!agent) return;
    async function loadPrompt() {
      try {
        const data = await api.get<{ agent: { systemPrompt: string; name: string; model: string } }>(`/agents/${agent!.id}`);
        setSystemPrompt(data.agent?.systemPrompt ?? '');
        if (data.agent?.name) setName(data.agent.name);
        if (data.agent?.model) setModel(data.agent.model);
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
    <>
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
          <select
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            {modelsLoading && <option value={model}>{model} (loading...)</option>}
            {!modelsLoading && (() => {
              // Group models by provider
              const groups = new Map<string, ModelOption[]>();
              for (const m of availableModels) {
                const list = groups.get(m.provider) ?? [];
                list.push(m);
                groups.set(m.provider, list);
              }

              // Ensure the current model value is always selectable
              const currentInList = availableModels.some(m => m.value === model);

              const elements: React.ReactNode[] = [];

              if (!currentInList && model) {
                elements.push(
                  <option key={model} value={model}>{model} (current)</option>
                );
              }

              if (groups.size === 0) {
                elements.push(
                  <option key="__none" value="" disabled>No models available — check Ollama or API keys</option>
                );
              }

              for (const [provider, models] of groups) {
                elements.push(
                  <optgroup key={provider} label={PROVIDER_LABELS[provider] ?? provider}>
                    {models.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </optgroup>
                );
              }

              return elements;
            })()}
          </select>
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

    {/* ── Skills (only when editing) ─────────────────────────── */}
    {agent && installedSkills && (
      <div className="bg-white rounded-lg border border-gray-200 p-4 mt-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Skills</h3>
        {skills.length > 0 ? (
          <ul className="divide-y divide-gray-100 mb-3">
            {skills.map((s) => (
              <li key={s.skillName} className="flex items-center justify-between py-2">
                <div>
                  <span className="text-sm font-medium text-gray-800">{s.skillName}</span>
                  {s.description && (
                    <span className="ml-2 text-xs text-gray-500">{s.description}</span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await api.delete(`/skills/agents/${agent.id}/${s.skillName}`);
                      setSkills((prev) => prev.filter((sk) => sk.skillName !== s.skillName));
                    } catch {
                      // handled by global error
                    }
                  }}
                  className="text-xs text-red-600 hover:text-red-700"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-500 mb-3">No skills applied to this agent.</p>
        )}

        {(() => {
          const appliedNames = new Set(skills.map((s) => s.skillName));
          const available = installedSkills.filter((s) => !appliedNames.has(s.name));
          if (available.length === 0) return null;
          return (
            <div className="flex gap-2 items-center">
              <select
                id="add-skill-select"
                defaultValue=""
                className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm"
              >
                <option value="" disabled>Add a skill...</option>
                {available.map((s) => (
                  <option key={s.name} value={s.name}>{s.name}{s.description ? ` — ${s.description}` : ''}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={addingSkill}
                onClick={async () => {
                  const select = document.getElementById('add-skill-select') as HTMLSelectElement;
                  const skillName = select.value;
                  if (!skillName) return;
                  setAddingSkill(true);
                  try {
                    await api.post(`/skills/agents/${agent.id}`, { skillName });
                    const matched = installedSkills.find((s) => s.name === skillName);
                    setSkills((prev) => [...prev, { skillName, enabled: true, description: matched?.description }]);
                    select.value = '';
                  } catch {
                    // handled by global error
                  } finally {
                    setAddingSkill(false);
                  }
                }}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {addingSkill ? 'Adding...' : 'Add'}
              </button>
            </div>
          );
        })()}
      </div>
    )}

    {/* ── Integrations (only when editing) ────────────────────── */}
    {agent && integrations && (
      <div className="bg-white rounded-lg border border-gray-200 p-4 mt-4">
        <h3 className="text-sm font-semibold text-gray-900 mb-3">Workspace Integrations</h3>
        {(() => {
          const connected = integrations.filter((i) => i.status === 'connected');
          if (connected.length === 0) {
            return <p className="text-sm text-gray-500">No integrations configured in this workspace.</p>;
          }
          return (
            <ul className="divide-y divide-gray-100">
              {connected.map((i) => (
                <li key={i.id} className="flex items-center justify-between py-2">
                  <div>
                    <span className="text-sm font-medium text-gray-800">{i.name}</span>
                    {i.description && (
                      <span className="ml-2 text-xs text-gray-500">{i.description}</span>
                    )}
                  </div>
                  <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                    Connected
                  </span>
                </li>
              ))}
            </ul>
          );
        })()}
        <p className="mt-3 text-xs text-gray-500">
          Integrations are shared across all agents in the workspace.{' '}
          <a href="/integrations" className="text-blue-600 hover:text-blue-700">Manage integrations</a>
        </p>
      </div>
    )}
    </>
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
      const resp = await api.post<{ user: { id: string; email: string } }>('/users', {
        email: inviteEmail,
        role: inviteRole,
      });
      setUsers((prev) => [...prev, {
        id: resp.user.id,
        email: resp.user.email,
        displayName: resp.user.email,
        role: inviteRole,
        createdAt: new Date().toISOString(),
      }]);
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
    inactive: 'bg-yellow-100 text-yellow-800',
    archived: 'bg-gray-100 text-gray-600',
  };

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-800'}`}>
      {status}
    </span>
  );
}
