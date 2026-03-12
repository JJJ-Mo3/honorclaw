import {
  useState,
  useEffect,
  useCallback,
  type FormEvent,
  type DragEvent,
} from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../../api/client.js';

// ── Types ────────────────────────────────────────────────────────────────

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

// ── Validation ───────────────────────────────────────────────────────────

interface ValidationError {
  path: string;
  message: string;
}

function validateManifest(manifest: CapabilityManifest): ValidationError[] {
  const errors: ValidationError[] = [];

  // Session validations
  if (manifest.session.maxDurationMinutes < 1) {
    errors.push({ path: 'session.maxDurationMinutes', message: 'Must be at least 1 minute.' });
  }
  if (manifest.session.maxTokensPerSession < 1) {
    errors.push({ path: 'session.maxTokensPerSession', message: 'Must be at least 1 token.' });
  }
  if (manifest.session.maxToolCallsPerSession < 0) {
    errors.push({ path: 'session.maxToolCallsPerSession', message: 'Cannot be negative.' });
  }

  // Budget validations
  if (manifest.budget?.maxCostPerDayUsd != null && manifest.budget.maxCostPerDayUsd < 0) {
    errors.push({ path: 'budget.maxCostPerDayUsd', message: 'Cannot be negative.' });
  }

  // Egress validations
  if (manifest.egress.maxResponseSizeBytes < 0) {
    errors.push({ path: 'egress.maxResponseSizeBytes', message: 'Cannot be negative.' });
  }

  // Tool validations
  for (let i = 0; i < manifest.tools.length; i++) {
    const tool = manifest.tools[i]!;
    if (!tool.name.trim()) {
      errors.push({ path: `tools[${i}].name`, message: 'Tool name is required.' });
    }
    if (tool.rateLimit?.maxCallsPerMinute != null && tool.rateLimit.maxCallsPerMinute < 0) {
      errors.push({ path: `tools[${i}].rateLimit.maxCallsPerMinute`, message: 'Cannot be negative.' });
    }
  }

  return errors;
}

// ── YAML Preview ─────────────────────────────────────────────────────────

function manifestToYaml(manifest: CapabilityManifest): string {
  const lines: string[] = [];

  lines.push(`# HonorClaw Capability Manifest v${manifest.version}`);
  lines.push(`agentId: "${manifest.agentId}"`);
  lines.push(`workspaceId: "${manifest.workspaceId}"`);
  lines.push(`version: ${manifest.version}`);
  lines.push('');

  // Tools
  lines.push('tools:');
  for (const tool of manifest.tools) {
    lines.push(`  - name: "${tool.name}"`);
    lines.push(`    enabled: ${tool.enabled}`);
    lines.push(`    requiresApproval: ${tool.requiresApproval}`);
    if (tool.source) lines.push(`    source: "${tool.source}"`);
    if (tool.rateLimit) {
      lines.push('    rateLimit:');
      if (tool.rateLimit.maxCallsPerMinute != null) {
        lines.push(`      maxCallsPerMinute: ${tool.rateLimit.maxCallsPerMinute}`);
      }
      if (tool.rateLimit.maxCallsPerSession != null) {
        lines.push(`      maxCallsPerSession: ${tool.rateLimit.maxCallsPerSession}`);
      }
    }
    if (tool.parameters && Object.keys(tool.parameters).length > 0) {
      lines.push('    parameters:');
      for (const [name, constraint] of Object.entries(tool.parameters)) {
        lines.push(`      ${name}:`);
        lines.push(`        type: "${constraint.type}"`);
        if (constraint.maxLength != null) lines.push(`        maxLength: ${constraint.maxLength}`);
        if (constraint.min != null) lines.push(`        min: ${constraint.min}`);
        if (constraint.max != null) lines.push(`        max: ${constraint.max}`);
        if (constraint.piiFilter) lines.push(`        piiFilter: true`);
        if (constraint.allowedValues?.length) {
          lines.push(`        allowedValues: [${constraint.allowedValues.map((v) => `"${v}"`).join(', ')}]`);
        }
      }
    }
  }
  lines.push('');

  // Egress
  lines.push('egress:');
  lines.push(`  allowedDomains: [${manifest.egress.allowedDomains.map((d) => `"${d}"`).join(', ')}]`);
  lines.push(`  blockedDomains: [${manifest.egress.blockedDomains.map((d) => `"${d}"`).join(', ')}]`);
  lines.push(`  maxResponseSizeBytes: ${manifest.egress.maxResponseSizeBytes}`);
  lines.push('');

  // Session
  lines.push('session:');
  lines.push(`  maxDurationMinutes: ${manifest.session.maxDurationMinutes}`);
  lines.push(`  maxTokensPerSession: ${manifest.session.maxTokensPerSession}`);
  lines.push(`  maxToolCallsPerSession: ${manifest.session.maxToolCallsPerSession}`);
  lines.push('');

  // Budget
  if (manifest.budget) {
    lines.push('budget:');
    if (manifest.budget.maxTokensPerDay != null) lines.push(`  maxTokensPerDay: ${manifest.budget.maxTokensPerDay}`);
    if (manifest.budget.maxCostPerDayUsd != null) lines.push(`  maxCostPerDayUsd: ${manifest.budget.maxCostPerDayUsd}`);
    if (manifest.budget.maxCostPerSession != null) lines.push(`  maxCostPerSession: ${manifest.budget.maxCostPerSession}`);
    lines.push(`  hardStopOnBudgetExceeded: ${manifest.budget.hardStopOnBudgetExceeded}`);
    lines.push('');
  }

  // LLM Rate Limits
  if (manifest.llmRateLimits) {
    lines.push('llmRateLimits:');
    if (manifest.llmRateLimits.maxLlmCallsPerMinute != null) {
      lines.push(`  maxLlmCallsPerMinute: ${manifest.llmRateLimits.maxLlmCallsPerMinute}`);
    }
    if (manifest.llmRateLimits.maxTokensPerMinute != null) {
      lines.push(`  maxTokensPerMinute: ${manifest.llmRateLimits.maxTokensPerMinute}`);
    }
  }

  return lines.join('\n');
}

// ── Component ────────────────────────────────────────────────────────────

export function VisualManifestEditor() {
  const { id: agentId } = useParams<{ id: string }>();
  const [manifest, setManifest] = useState<CapabilityManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [showYamlPreview, setShowYamlPreview] = useState(false);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'tools' | 'egress' | 'session' | 'budget' | 'limits'>('tools');

  // ── Load manifest ───────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const data = await api.get<{ manifests: Array<{ manifest: CapabilityManifest } & Record<string, unknown>> }>(`/manifests/${agentId}`);
        if (data.manifests.length > 0) {
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

  // ── Live validation ─────────────────────────────────────────────────
  useEffect(() => {
    if (manifest) {
      setValidationErrors(validateManifest(manifest));
    }
  }, [manifest]);

  // ── Save manifest ───────────────────────────────────────────────────
  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (!manifest) return;

    const errors = validateManifest(manifest);
    if (errors.length > 0) {
      setValidationErrors(errors);
      setError(`Cannot save: ${errors.length} validation error(s).`);
      return;
    }

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

  // ── Drag & Drop tool reordering ─────────────────────────────────────
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const handleDragStart = useCallback((index: number) => {
    setDraggedIndex(index);
  }, []);

  const handleDragOver = useCallback((e: DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback(
    (index: number) => {
      if (draggedIndex == null || !manifest) return;

      const tools = [...manifest.tools];
      const [moved] = tools.splice(draggedIndex, 1);
      if (moved) {
        tools.splice(index, 0, moved);
        setManifest({ ...manifest, tools });
      }
      setDraggedIndex(null);
      setDragOverIndex(null);
    },
    [draggedIndex, manifest],
  );

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

  // ── Egress mutations ────────────────────────────────────────────────
  function addAllowedDomain(domain: string) {
    if (!manifest || !domain.trim()) return;
    const trimmed = domain.trim().toLowerCase();
    if (manifest.egress.allowedDomains.includes(trimmed)) return;
    setManifest({
      ...manifest,
      egress: {
        ...manifest.egress,
        allowedDomains: [...manifest.egress.allowedDomains, trimmed],
      },
    });
  }

  function removeAllowedDomain(index: number) {
    if (!manifest) return;
    const allowedDomains = manifest.egress.allowedDomains.filter((_, i) => i !== index);
    setManifest({ ...manifest, egress: { ...manifest.egress, allowedDomains } });
  }

  function addBlockedDomain(domain: string) {
    if (!manifest || !domain.trim()) return;
    const trimmed = domain.trim().toLowerCase();
    if (manifest.egress.blockedDomains.includes(trimmed)) return;
    setManifest({
      ...manifest,
      egress: {
        ...manifest.egress,
        blockedDomains: [...manifest.egress.blockedDomains, trimmed],
      },
    });
  }

  function removeBlockedDomain(index: number) {
    if (!manifest) return;
    const blockedDomains = manifest.egress.blockedDomains.filter((_, i) => i !== index);
    setManifest({ ...manifest, egress: { ...manifest.egress, blockedDomains } });
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

  const hasErrors = validationErrors.length > 0;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <Link to="/admin" className="text-sm text-blue-600 hover:text-blue-700">Admin</Link>
              <span className="mx-2 text-gray-400">/</span>
              <span className="text-sm font-medium text-gray-900">Visual Manifest Editor</span>
            </div>
            <span className="text-xs text-gray-400">v{manifest.version}</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowYamlPreview(!showYamlPreview)}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              {showYamlPreview ? 'Hide YAML' : 'Preview YAML'}
            </button>
            {hasErrors && (
              <span className="text-xs text-red-600">
                {validationErrors.length} validation error(s)
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Main Editor */}
        <form onSubmit={handleSave} className="flex-1 max-w-4xl mx-auto px-6 py-6 space-y-6">
          {error && <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>}
          {successMsg && <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">{successMsg}</div>}

          {/* Tab Navigation */}
          <nav className="flex gap-1 border-b border-gray-200">
            {(['tools', 'egress', 'session', 'budget', 'limits'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab
                    ? 'border-blue-500 text-blue-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab === 'limits' ? 'LLM Rate Limits' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </nav>

          {/* ── Tools Tab ────────────────────────────────────────────── */}
          {activeTab === 'tools' && (
            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">Tools (drag to reorder)</h2>
              <div className="space-y-4">
                {manifest.tools.map((tool, i) => (
                  <div
                    key={tool.name}
                    draggable
                    onDragStart={() => handleDragStart(i)}
                    onDragOver={(e) => handleDragOver(e, i)}
                    onDrop={() => handleDrop(i)}
                    className={`bg-white rounded-lg border p-4 cursor-move transition-all ${
                      dragOverIndex === i
                        ? 'border-blue-400 shadow-md'
                        : 'border-gray-200'
                    } ${!tool.enabled ? 'opacity-60' : ''}`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        {/* Drag handle */}
                        <span className="text-gray-300 cursor-move" title="Drag to reorder">
                          &#x2630;
                        </span>
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
                          <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded">{tool.source}</span>
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
          )}

          {/* ── Egress Tab ───────────────────────────────────────────── */}
          {activeTab === 'egress' && (
            <section>
              <h2 className="text-lg font-semibold text-gray-900 mb-3">Egress Allowlist</h2>
              <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
                {/* Allowed domains */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Allowed Domains</label>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {manifest.egress.allowedDomains.map((domain, i) => (
                      <span key={domain} className="inline-flex items-center gap-1 bg-green-50 text-green-700 px-2 py-1 rounded text-xs">
                        {domain}
                        <button
                          type="button"
                          onClick={() => removeAllowedDomain(i)}
                          className="text-green-400 hover:text-green-600"
                        >
                          x
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="api.example.com"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addAllowedDomain((e.target as HTMLInputElement).value);
                          (e.target as HTMLInputElement).value = '';
                        }
                      }}
                      className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={(e) => {
                        const input = (e.target as HTMLElement).previousElementSibling as HTMLInputElement;
                        addAllowedDomain(input.value);
                        input.value = '';
                      }}
                      className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
                    >
                      Add
                    </button>
                  </div>
                </div>

                {/* Blocked domains */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Blocked Domains</label>
                  <div className="flex flex-wrap gap-2 mb-2">
                    {manifest.egress.blockedDomains.map((domain, i) => (
                      <span key={domain} className="inline-flex items-center gap-1 bg-red-50 text-red-700 px-2 py-1 rounded text-xs">
                        {domain}
                        <button
                          type="button"
                          onClick={() => removeBlockedDomain(i)}
                          className="text-red-400 hover:text-red-600"
                        >
                          x
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="evil.example.com"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addBlockedDomain((e.target as HTMLInputElement).value);
                          (e.target as HTMLInputElement).value = '';
                        }
                      }}
                      className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={(e) => {
                        const input = (e.target as HTMLElement).previousElementSibling as HTMLInputElement;
                        addBlockedDomain(input.value);
                        input.value = '';
                      }}
                      className="rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
                    >
                      Add
                    </button>
                  </div>
                </div>

                {/* Max response size */}
                <div>
                  <label className="block text-sm font-medium text-gray-700">Max Response Size (bytes)</label>
                  <input
                    type="number"
                    min={0}
                    value={manifest.egress.maxResponseSizeBytes}
                    onChange={(e) =>
                      setManifest({
                        ...manifest,
                        egress: { ...manifest.egress, maxResponseSizeBytes: Number(e.target.value) },
                      })
                    }
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>
            </section>
          )}

          {/* ── Session Tab ──────────────────────────────────────────── */}
          {activeTab === 'session' && (
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
          )}

          {/* ── Budget Tab ───────────────────────────────────────────── */}
          {activeTab === 'budget' && (
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
          )}

          {/* ── LLM Rate Limits Tab ──────────────────────────────────── */}
          {activeTab === 'limits' && (
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
          )}

          {/* ── Save Bar ─────────────────────────────────────────────── */}
          <div className="flex justify-between items-center pt-4 border-t border-gray-200">
            <div>
              {validationErrors.length > 0 && (
                <ul className="text-xs text-red-600 space-y-0.5">
                  {validationErrors.slice(0, 3).map((err) => (
                    <li key={err.path}>{err.path}: {err.message}</li>
                  ))}
                  {validationErrors.length > 3 && (
                    <li>...and {validationErrors.length - 3} more</li>
                  )}
                </ul>
              )}
            </div>
            <div className="flex gap-3">
              <Link
                to="/admin"
                className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </Link>
              <button
                type="submit"
                disabled={saving || hasErrors}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Manifest'}
              </button>
            </div>
          </div>
        </form>

        {/* YAML Preview Panel */}
        {showYamlPreview && (
          <aside className="w-96 border-l border-gray-200 bg-gray-900 text-gray-100 p-4 overflow-auto">
            <h3 className="text-xs font-medium text-gray-400 mb-3 uppercase tracking-wider">Generated YAML Preview</h3>
            <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed">
              {manifestToYaml(manifest)}
            </pre>
          </aside>
        )}
      </div>
    </div>
  );
}
