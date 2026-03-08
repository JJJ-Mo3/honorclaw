import { useState, useEffect } from 'react';
import { api } from '../../api/client.js';
import { useAuth } from '../../auth/useAuth.js';

// ── Types ───────────────────────────────────────────────────────────────

interface Skill {
  name: string;
  version: string;
  description: string;
  systemPrompt?: string;
  installedAt?: string;
}

interface Agent {
  id: string;
  name: string;
}

// ── Component ───────────────────────────────────────────────────────────

export function SkillsPage() {
  const { roles } = useAuth();
  const isAdmin = roles.includes('workspace_admin');

  const [available, setAvailable] = useState<Skill[]>([]);
  const [installed, setInstalled] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'available' | 'installed'>('available');
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [avail, inst, agentResp] = await Promise.all([
          api.get<{ skills: Skill[] }>('/skills/available'),
          api.get<{ skills: Skill[] }>('/skills'),
          api.get<{ agents: Agent[] }>('/agents'),
        ]);
        setAvailable(avail.skills ?? []);
        setInstalled(inst.skills ?? []);
        setAgents(agentResp.agents ?? []);
      } catch {
        // handled by global error
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  const installedNames = new Set(installed.map((s) => s.name));

  async function handleInstall(name: string) {
    setInstalling(name);
    try {
      await api.post('/skills/install', { name });
      const resp = await api.get<{ skills: Skill[] }>('/skills');
      setInstalled(resp.skills ?? []);
    } catch {
      // handled by global error
    } finally {
      setInstalling(null);
    }
  }

  async function handleRemove(name: string) {
    try {
      await api.delete(`/skills/${name}`);
      setInstalled((prev) => prev.filter((s) => s.name !== name));
    } catch {
      // handled by global error
    }
  }

  async function handleApplyToAgent(skillName: string, agentId: string) {
    try {
      await api.post(`/skills/agents/${agentId}`, { skillName });
    } catch {
      // handled by global error
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-sm text-gray-500">Loading skills...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-xl font-bold text-gray-900">Skills</h1>
        <p className="mt-1 text-sm text-gray-500">
          Browse, install, and apply pre-built agent skill bundles
        </p>
        <nav className="mt-4 flex gap-4">
          <button
            onClick={() => setTab('available')}
            className={`pb-2 text-sm font-medium ${
              tab === 'available'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Available ({available.length})
          </button>
          <button
            onClick={() => setTab('installed')}
            className={`pb-2 text-sm font-medium ${
              tab === 'installed'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Installed ({installed.length})
          </button>
        </nav>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-6">
        {tab === 'available' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {available.map((skill) => (
              <div
                key={skill.name}
                className="bg-white rounded-lg border border-gray-200 p-5"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">
                      {skill.name}
                    </h3>
                    <p className="mt-1 text-xs text-gray-500">v{skill.version}</p>
                  </div>
                  {installedNames.has(skill.name) ? (
                    <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
                      Installed
                    </span>
                  ) : isAdmin ? (
                    <button
                      onClick={() => handleInstall(skill.name)}
                      disabled={installing === skill.name}
                      className="rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {installing === skill.name ? 'Installing...' : 'Install'}
                    </button>
                  ) : null}
                </div>
                <p className="mt-2 text-sm text-gray-600">
                  {skill.description || 'No description available.'}
                </p>
              </div>
            ))}
            {available.length === 0 && (
              <div className="col-span-2 text-center text-sm text-gray-500 py-8">
                No skill bundles found.
              </div>
            )}
          </div>
        )}

        {tab === 'installed' && (
          <div className="space-y-4">
            {installed.map((skill) => (
              <div
                key={skill.name}
                className="bg-white rounded-lg border border-gray-200 p-5"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900">
                      {skill.name}
                    </h3>
                    <p className="mt-1 text-xs text-gray-500">
                      v{skill.version}
                      {skill.installedAt &&
                        ` \u00b7 Installed ${new Date(skill.installedAt).toLocaleDateString()}`}
                    </p>
                    <p className="mt-2 text-sm text-gray-600">
                      {skill.description || 'No description available.'}
                    </p>
                  </div>
                  {isAdmin && (
                    <button
                      onClick={() => handleRemove(skill.name)}
                      className="rounded-md border border-red-300 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                    >
                      Remove
                    </button>
                  )}
                </div>

                {/* Apply to agent */}
                {isAdmin && agents.length > 0 && (
                  <div className="mt-3 flex items-center gap-2 border-t border-gray-100 pt-3">
                    <span className="text-xs text-gray-500">Apply to:</span>
                    {agents.map((agent) => (
                      <button
                        key={agent.id}
                        onClick={() => handleApplyToAgent(skill.name, agent.id)}
                        className="rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                      >
                        {agent.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {installed.length === 0 && (
              <div className="text-center text-sm text-gray-500 py-8">
                No skills installed yet. Browse the Available tab to get started.
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
