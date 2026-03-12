import { useState, useEffect, type FormEvent } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../../api/client.js';

// ── Types (mirroring @honorclaw/core manifest types) ────────────────────

interface ParameterConstraint {
  type: 'string' | 'integer' | 'boolean' | 'array' | 'object';
  maxLength?: number;
  min?: number;
  max?: number;
  allowedValues?: string[];
  allowedPatterns?: string[];
  blockedPatterns?: string[];
  piiFilter?: boolean;
}

interface RateLimit {
  maxCallsPerMinute?: number;
  maxCallsPerSession?: number;
}

interface ToolCapability {
  name: string;
  source?: string;
  enabled: boolean;
  parameters?: Record<string, ParameterConstraint>;
  rateLimit?: RateLimit;
  requiresApproval: boolean;
}

interface EgressConfig {
  allowedDomains: string[];
  blockedDomains: string[];
  maxResponseSizeBytes: number;
}

interface SessionConfig {
  maxDurationMinutes: number;
  maxTokensPerSession: number;
  maxToolCallsPerSession: number;
}

interface BudgetConfig {
  maxTokensPerDay?: number;
  maxCostPerDayUsd?: number;
  maxCostPerSession?: number;
  hardStopOnBudgetExceeded: boolean;
}

interface LlmRateLimits {
  maxLlmCallsPerMinute?: number;
  maxTokensPerMinute?: number;
}

interface CapabilityManifest {
  agentId: string;
  workspaceId: string;
  version: number;
  tools: ToolCapability[];
  egress: EgressConfig;
  session: SessionConfig;
  budget?: BudgetConfig;
  llmRateLimits?: LlmRateLimits;
}

// ── Component ───────────────────────────────────────────────────────────

export function ManifestEditor() {
  const { id: agentId } = useParams<{ id: string }>();
  const [manifest, setManifest] = useState<CapabilityManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // ── Load manifest ───────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const data = await api.get<{ manifests: Array<{ manifest: CapabilityManifest } & Record<string, unknown>> }>(`/manifests/${agentId}`);
        if (data.manifests.length > 0) {
          // Extract the latest manifest (first entry, ordered by version DESC)
          const latest = data.manifests[0]!;
          const parsed = typeof latest.manifest === 'string' ? JSON.parse(latest.manifest) as CapabilityManifest : latest.manifest;
          setManifest(parsed);
        } else {
          // No manifest yet — initialize a default so the user can configure and save
          const agentData = await api.get<{ agent: { workspaceId: string } }>(`/agents/${agentId}`);
          setManifest({
            agentId: agentId!,
            workspaceId: agentData.agent.workspaceId,
            version: 0,
            tools: [],
            egress: { allowedDomains: [], blockedDomains: [], maxResponseSizeBytes: 10_485_760 },
            session: { maxDurationMinutes: 60, maxTokensPerSession: 100_000, maxToolCallsPerSession: 1000 },
          });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load manifest');
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [agentId]);

  // ── Save manifest ───────────────────────────────────────────────────
  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!manifest) return;
    setError(null);
    setSuccessMsg(null);
    setSaving(true);

    try {
      const saved = await api.post<{ manifest: { manifest: CapabilityManifest } & Record<string, unknown> }>(
        `/manifests/${agentId}`,
        { manifest },
      );
      const parsedManifest = typeof saved.manifest.manifest === 'string'
        ? JSON.parse(saved.manifest.manifest) as CapabilityManifest
        : saved.manifest.manifest;
      setManifest(parsedManifest);
      setSuccessMsg('Manifest saved successfully');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save manifest');
    } finally {
      setSaving(false);
    }
  }

  // ── Tool mutations ──────────────────────────────────────────────────
  function toggleTool(index: number) {
    if (!manifest) return;
    const tools = [...manifest.tools];
    const tool = tools[index];
    if (!tool) return;
    tools[index] = { ...tool, enabled: !tool.enabled };
    setManifest({ ...manifest, tools });
  }

  function toggleApproval(index: number) {
    if (!manifest) return;
    const tools = [...manifest.tools];
    const tool = tools[index];
    if (!tool) return;
    tools[index] = { ...tool, requiresApproval: !tool.requiresApproval };
    setManifest({ ...manifest, tools });
  }

  function updateToolRateLimit(index: number, field: keyof RateLimit, value: string) {
    if (!manifest) return;
    const tools = [...manifest.tools];
    const tool = tools[index];
    if (!tool) return;
    const rateLimit = { ...tool.rateLimit };
    const numValue = value === '' ? undefined : Number(value);
    (rateLimit as Record<string, number | undefined>)[field] = numValue;
    tools[index] = { ...tool, rateLimit };
    setManifest({ ...manifest, tools });
  }

  function updateParamConstraint(
    toolIndex: number,
    paramName: string,
    field: keyof ParameterConstraint,
    value: string | boolean,
  ) {
    if (!manifest) return;
    const tools = [...manifest.tools];
    const tool = tools[toolIndex];
    if (!tool) return;
    const parameters = { ...tool.parameters };
    const param = { ...(parameters[paramName] ?? { type: 'string' as const }) };
    if (field === 'piiFilter') {
      param.piiFilter = value as boolean;
    } else if (field === 'type') {
      param.type = value as ParameterConstraint['type'];
    } else if (field === 'maxLength' || field === 'min' || field === 'max') {
      (param as Record<string, unknown>)[field] = value === '' ? undefined : Number(value);
    } else if (field === 'allowedValues' || field === 'allowedPatterns' || field === 'blockedPatterns') {
      (param as Record<string, unknown>)[field] = (value as string).split(',').map((s) => s.trim()).filter(Boolean);
    }
    parameters[paramName] = param;
    tools[toolIndex] = { ...tool, parameters };
    setManifest({ ...manifest, tools });
  }

  // ── Render ──────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-sm text-gray-500">Loading manifest...</div>
      </div>
    );
  }

  if (!manifest) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="text-red-600">{error ?? 'Manifest not found'}</div>
        <Link to="/admin" className="text-sm text-blue-600 mt-2 inline-block">Back to Admin</Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <Link to="/admin" className="text-sm text-blue-600 hover:text-blue-700">Admin</Link>
            <span className="mx-2 text-gray-400">/</span>
            <span className="text-sm font-medium text-gray-900">Manifest Editor</span>
          </div>
          <span className="text-xs text-gray-400">Version {manifest.version}</span>
        </div>
      </header>

      <form onSubmit={handleSave} className="max-w-4xl mx-auto px-6 py-6 space-y-8">
        {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        {successMsg && <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">{successMsg}</div>}

        {/* ── Tools ──────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Tools</h2>
          <div className="space-y-4">
            {manifest.tools.map((tool, i) => (
              <div key={tool.name} className="bg-white rounded-lg border border-gray-200 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={tool.enabled}
                        onChange={() => toggleTool(i)}
                        className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm font-medium text-gray-900">{tool.name}</span>
                    </label>
                    {tool.source && (
                      <span className="text-xs text-gray-400">{tool.source}</span>
                    )}
                  </div>
                  <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={tool.requiresApproval}
                      onChange={() => toggleApproval(i)}
                      className="rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                    />
                    Requires Approval
                  </label>
                </div>

                {/* Rate limits */}
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <label className="block text-xs text-gray-500">Max calls/min</label>
                    <input
                      type="number"
                      min={0}
                      value={tool.rateLimit?.maxCallsPerMinute ?? ''}
                      onChange={(e) => updateToolRateLimit(i, 'maxCallsPerMinute', e.target.value)}
                      className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500">Max calls/session</label>
                    <input
                      type="number"
                      min={0}
                      value={tool.rateLimit?.maxCallsPerSession ?? ''}
                      onChange={(e) => updateToolRateLimit(i, 'maxCallsPerSession', e.target.value)}
                      className="mt-1 block w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                </div>

                {/* Parameter constraints */}
                {tool.parameters && Object.keys(tool.parameters).length > 0 && (
                  <div className="border-t border-gray-100 pt-3">
                    <h4 className="text-xs font-medium text-gray-500 mb-2">Parameter Constraints</h4>
                    {Object.entries(tool.parameters).map(([paramName, constraint]) => (
                      <div key={paramName} className="grid grid-cols-5 gap-2 mb-2 items-end">
                        <div>
                          <label className="block text-xs text-gray-400">{paramName}</label>
                          <select
                            value={constraint.type}
                            onChange={(e) => updateParamConstraint(i, paramName, 'type', e.target.value)}
                            className="mt-1 block w-full rounded border border-gray-300 px-1 py-1 text-xs"
                          >
                            <option value="string">string</option>
                            <option value="integer">integer</option>
                            <option value="boolean">boolean</option>
                            <option value="array">array</option>
                            <option value="object">object</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-400">Max Length</label>
                          <input
                            type="number"
                            value={constraint.maxLength ?? ''}
                            onChange={(e) => updateParamConstraint(i, paramName, 'maxLength', e.target.value)}
                            className="mt-1 block w-full rounded border border-gray-300 px-1 py-1 text-xs"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-400">Min</label>
                          <input
                            type="number"
                            value={constraint.min ?? ''}
                            onChange={(e) => updateParamConstraint(i, paramName, 'min', e.target.value)}
                            className="mt-1 block w-full rounded border border-gray-300 px-1 py-1 text-xs"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-400">Max</label>
                          <input
                            type="number"
                            value={constraint.max ?? ''}
                            onChange={(e) => updateParamConstraint(i, paramName, 'max', e.target.value)}
                            className="mt-1 block w-full rounded border border-gray-300 px-1 py-1 text-xs"
                          />
                        </div>
                        <div>
                          <label className="flex items-center gap-1 text-xs text-gray-400 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={constraint.piiFilter ?? false}
                              onChange={(e) => updateParamConstraint(i, paramName, 'piiFilter', e.target.checked)}
                              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            />
                            PII filter
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {manifest.tools.length === 0 && (
              <div className="text-sm text-gray-500 py-4 text-center bg-white rounded-lg border border-gray-200">
                No tools configured.
              </div>
            )}
          </div>
        </section>

        {/* ── Rate Limits ────────────────────────────────────────────── */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">LLM Rate Limits</h2>
          <div className="bg-white rounded-lg border border-gray-200 p-4 grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-700">Max LLM calls/min</label>
              <input
                type="number"
                min={0}
                value={manifest.llmRateLimits?.maxLlmCallsPerMinute ?? ''}
                onChange={(e) =>
                  setManifest({
                    ...manifest,
                    llmRateLimits: {
                      ...manifest.llmRateLimits,
                      maxLlmCallsPerMinute: e.target.value === '' ? undefined : Number(e.target.value),
                    },
                  })
                }
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Max tokens/min</label>
              <input
                type="number"
                min={0}
                value={manifest.llmRateLimits?.maxTokensPerMinute ?? ''}
                onChange={(e) =>
                  setManifest({
                    ...manifest,
                    llmRateLimits: {
                      ...manifest.llmRateLimits,
                      maxTokensPerMinute: e.target.value === '' ? undefined : Number(e.target.value),
                    },
                  })
                }
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
        </section>

        {/* ── Session Config ─────────────────────────────────────────── */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Session Limits</h2>
          <div className="bg-white rounded-lg border border-gray-200 p-4 grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm text-gray-700">Max duration (min)</label>
              <input
                type="number"
                min={1}
                value={manifest.session.maxDurationMinutes}
                onChange={(e) =>
                  setManifest({
                    ...manifest,
                    session: { ...manifest.session, maxDurationMinutes: Number(e.target.value) },
                  })
                }
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Max tokens/session</label>
              <input
                type="number"
                min={1}
                value={manifest.session.maxTokensPerSession}
                onChange={(e) =>
                  setManifest({
                    ...manifest,
                    session: { ...manifest.session, maxTokensPerSession: Number(e.target.value) },
                  })
                }
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Max tool calls/session</label>
              <input
                type="number"
                min={1}
                value={manifest.session.maxToolCallsPerSession}
                onChange={(e) =>
                  setManifest({
                    ...manifest,
                    session: { ...manifest.session, maxToolCallsPerSession: Number(e.target.value) },
                  })
                }
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
        </section>

        {/* ── Budget Config ──────────────────────────────────────────── */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Budget</h2>
          <div className="bg-white rounded-lg border border-gray-200 p-4 grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-700">Max tokens/day</label>
              <input
                type="number"
                min={0}
                value={manifest.budget?.maxTokensPerDay ?? ''}
                onChange={(e) =>
                  setManifest({
                    ...manifest,
                    budget: {
                      ...manifest.budget,
                      hardStopOnBudgetExceeded: manifest.budget?.hardStopOnBudgetExceeded ?? false,
                      maxTokensPerDay: e.target.value === '' ? undefined : Number(e.target.value),
                    },
                  })
                }
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Max cost/day (USD)</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={manifest.budget?.maxCostPerDayUsd ?? ''}
                onChange={(e) =>
                  setManifest({
                    ...manifest,
                    budget: {
                      ...manifest.budget,
                      hardStopOnBudgetExceeded: manifest.budget?.hardStopOnBudgetExceeded ?? false,
                      maxCostPerDayUsd: e.target.value === '' ? undefined : Number(e.target.value),
                    },
                  })
                }
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Max cost/session (USD)</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={manifest.budget?.maxCostPerSession ?? ''}
                onChange={(e) =>
                  setManifest({
                    ...manifest,
                    budget: {
                      ...manifest.budget,
                      hardStopOnBudgetExceeded: manifest.budget?.hardStopOnBudgetExceeded ?? false,
                      maxCostPerSession: e.target.value === '' ? undefined : Number(e.target.value),
                    },
                  })
                }
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer pb-2">
                <input
                  type="checkbox"
                  checked={manifest.budget?.hardStopOnBudgetExceeded ?? false}
                  onChange={(e) =>
                    setManifest({
                      ...manifest,
                      budget: {
                        ...manifest.budget,
                        hardStopOnBudgetExceeded: e.target.checked,
                      },
                    })
                  }
                  className="rounded border-gray-300 text-red-600 focus:ring-red-500"
                />
                <span className="text-sm text-gray-700">Hard stop on budget exceeded</span>
              </label>
            </div>
          </div>
        </section>

        {/* ── Egress ─────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-lg font-semibold text-gray-900 mb-3">Egress</h2>
          <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
            <div>
              <label className="block text-sm text-gray-700">Allowed Domains (comma-separated)</label>
              <input
                type="text"
                value={manifest.egress.allowedDomains.join(', ')}
                onChange={(e) =>
                  setManifest({
                    ...manifest,
                    egress: {
                      ...manifest.egress,
                      allowedDomains: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                    },
                  })
                }
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Blocked Domains (comma-separated)</label>
              <input
                type="text"
                value={manifest.egress.blockedDomains.join(', ')}
                onChange={(e) =>
                  setManifest({
                    ...manifest,
                    egress: {
                      ...manifest.egress,
                      blockedDomains: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                    },
                  })
                }
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-700">Max Response Size (bytes)</label>
              <input
                type="number"
                min={0}
                value={manifest.egress.maxResponseSizeBytes}
                onChange={(e) =>
                  setManifest({
                    ...manifest,
                    egress: {
                      ...manifest.egress,
                      maxResponseSizeBytes: Number(e.target.value),
                    },
                  })
                }
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
        </section>

        {/* ── Save ───────────────────────────────────────────────────── */}
        <div className="flex justify-end gap-3">
          <Link
            to="/admin"
            className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Manifest'}
          </button>
        </div>
      </form>
    </div>
  );
}
