import { useState, useEffect } from 'react';
import { api } from '../../api/client.js';

// ── Types ───────────────────────────────────────────────────────────────

type ConnectionStatus = 'connected' | 'disconnected' | 'error' | 'pending';
type AuthMode = 'oauth2' | 'service_account' | 'api_key' | 'credentials' | 'none';

interface SecretField {
  path: string;
  label: string;
  required: boolean;
  placeholder?: string;
}

interface IntegrationInfo {
  id: string;
  name: string;
  description: string;
  status: ConnectionStatus;
  authMode: AuthMode;
  secretFields: SecretField[] | null;
  lastChecked?: string;
  errorMessage?: string;
}

// ── Icons ───────────────────────────────────────────────────────────────

const INTEGRATION_ICONS: Record<string, React.ReactNode> = {
  'google-workspace': (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  ),
  'microsoft-365': (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
      <rect x="13" y="1" width="10" height="10" fill="#7FBA00"/>
      <rect x="1" y="13" width="10" height="10" fill="#00A4EF"/>
      <rect x="13" y="13" width="10" height="10" fill="#FFB900"/>
    </svg>
  ),
  slack: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" fill="#E01E5A"/>
      <path d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" fill="#36C5F0"/>
      <path d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.163 0a2.528 2.528 0 0 1 2.523 2.522v6.312z" fill="#2EB67D"/>
      <path d="M15.163 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.163 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 0 1-2.52-2.523 2.527 2.527 0 0 1 2.52-2.52h6.315A2.528 2.528 0 0 1 24 15.163a2.528 2.528 0 0 1-2.522 2.523h-6.315z" fill="#ECB22E"/>
    </svg>
  ),
  'microsoft-teams': (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M20.625 8.25h-3.75c.207 0 .375-.168.375-.375V5.25a2.25 2.25 0 0 0-2.25-2.25h-.375a1.875 1.875 0 1 1 3.188-1.313A1.875 1.875 0 0 1 19.125 3H19.5a2.25 2.25 0 0 1 2.25 2.25v1.875a1.125 1.125 0 0 1-1.125 1.125z" fill="#5059C9"/>
      <path d="M15 3.75a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" fill="#5059C9"/>
      <path d="M11.25 5.25a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5z" fill="#7B83EB"/>
      <rect x="3" y="6.75" width="13.5" height="12" rx="1.5" fill="#7B83EB"/>
      <path d="M10.5 10.5h-3v5.25h-1.5V10.5H3V9h7.5v1.5z" fill="white"/>
      <path d="M19.5 8.25h-5.25v8.625a1.875 1.875 0 0 0 1.875 1.875H21a1.5 1.5 0 0 0 1.5-1.5v-6a3 3 0 0 0-3-3z" fill="#5059C9" opacity="0.5"/>
    </svg>
  ),
  jira: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M11.53 2c0 4.97-3.6 9-8.05 9H.53l11 11 11-11h-2.95C15.13 11 11.53 6.97 11.53 2z" fill="#2684FF"/>
      <path d="M7.28 6.56l4.25 4.25 4.25-4.25" fill="url(#jira-grad1)" opacity="0.4"/>
      <defs><linearGradient id="jira-grad1" x1="7.28" y1="6.56" x2="15.78" y2="6.56"><stop stopColor="#0052CC"/><stop offset="1" stopColor="#2684FF"/></linearGradient></defs>
    </svg>
  ),
  github: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
    </svg>
  ),
  pagerduty: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M5.06 18.846h3.108V24H5.06v-5.154zM14.217.001C10.922-.062 5.06 1.065 5.06 7.326c0 5.494 4.754 7.26 9.18 7.394h1.228V3.42c0-1.1-.218-2.003-.746-2.63C14.167.169 13.506.001 14.217.001zm3.462 3.417v8.892c2.287-.478 5.26-2.7 5.26-5.989 0-3.456-2.476-4.723-5.26-2.903z" fill="#06AC38"/>
    </svg>
  ),
  salesforce: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M10.006 4.867a4.592 4.592 0 0 1 3.402-1.51 4.614 4.614 0 0 1 4.16 2.628 5.567 5.567 0 0 1 2.31-.502C22.167 5.483 24 7.345 24 9.633a4.178 4.178 0 0 1-2.126 3.64 4.728 4.728 0 0 1-4.553 5.847 4.722 4.722 0 0 1-2.584-.77 4.957 4.957 0 0 1-8.064-.758A5.278 5.278 0 0 1 0 12.924a5.28 5.28 0 0 1 3.058-4.795 5.628 5.628 0 0 1-.149-1.286 5.59 5.59 0 0 1 7.097-5.396v3.42z" fill="#00A1E0"/>
    </svg>
  ),
  confluence: (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
      <path d="M1.637 20.367c-.2.337-.44.735-.64 1.039a.81.81 0 0 0 .261 1.113l4.664 2.836a.81.81 0 0 0 1.108-.237c.177-.278.408-.658.666-1.09 1.828-3.063 3.661-2.692 7.059-1.148l4.093 1.863a.81.81 0 0 0 1.074-.395l2.39-5.17a.81.81 0 0 0-.39-1.076c-1.202-.548-3.596-1.638-5.02-2.286-5.932-2.693-10.935-2.48-15.265 4.55z" fill="#2684FF"/>
      <path d="M22.363 3.633c.2-.337.44-.735.64-1.039A.81.81 0 0 0 22.742 1.48L18.078-1.356a.81.81 0 0 0-1.108.237c-.177.278-.408.658-.666 1.09-1.828 3.063-3.661 2.692-7.059 1.148L5.152-.744a.81.81 0 0 0-1.074.395L1.688 4.82a.81.81 0 0 0 .39 1.076c1.202.548 3.596 1.638 5.02 2.286 5.932 2.693 10.935 2.48 15.265-4.55z" fill="url(#conf-grad)" opacity="0.65"/>
      <defs><linearGradient id="conf-grad" x1="22" y1="0" x2="2" y2="10"><stop stopColor="#0052CC"/><stop offset="1" stopColor="#2684FF"/></linearGradient></defs>
    </svg>
  ),
};

function getIcon(id: string): React.ReactNode {
  return INTEGRATION_ICONS[id] ?? (
    <div className="h-8 w-8 rounded bg-gray-200 flex items-center justify-center text-gray-500 text-xs font-bold">
      {id.charAt(0).toUpperCase()}
    </div>
  );
}

// ── Component ───────────────────────────────────────────────────────────

export function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<IntegrationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [configuringId, setConfiguringId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const data = await api.get<IntegrationInfo[]>('/integrations');
        setIntegrations(data);
      } catch {
        setIntegrations([]);
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, []);

  async function testConnection(integrationId: string) {
    setTestingId(integrationId);
    try {
      const result = await api.post<{ status: ConnectionStatus; errorMessage?: string }>(
        `/integrations/${integrationId}/test`,
      );
      setIntegrations((prev) =>
        prev.map((i) =>
          i.id === integrationId
            ? {
                ...i,
                status: result.status,
                errorMessage: result.errorMessage,
                lastChecked: new Date().toISOString(),
              }
            : i,
        ),
      );
    } catch (err) {
      setIntegrations((prev) =>
        prev.map((i) =>
          i.id === integrationId
            ? {
                ...i,
                status: 'error',
                errorMessage: err instanceof Error ? err.message : 'Connection test failed',
                lastChecked: new Date().toISOString(),
              }
            : i,
        ),
      );
    } finally {
      setTestingId(null);
    }
  }

  async function handleSaveCredentials(integrationId: string, fields: { path: string; value: string }[]) {
    for (const field of fields) {
      if (field.value) {
        await api.post('/secrets', { path: field.path, value: field.value });
      }
    }
    // Also store a marker at the main credentials path so test-connection works
    const integration = integrations.find((i) => i.id === integrationId);
    if (integration) {
      await api.post('/secrets', {
        path: `integrations/${integrationId}/credentials`,
        value: JSON.stringify({ configured: true, fields: fields.map((f) => f.path) }),
      });
    }
    setConfiguringId(null);
    // Re-test connection after saving
    await testConnection(integrationId);
    // Reload integrations to get fresh status
    try {
      const data = await api.get<IntegrationInfo[]>('/integrations');
      setIntegrations(data);
    } catch {
      // Keep existing data
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-sm text-gray-500">Loading integrations...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-xl font-bold text-gray-900">Integrations</h1>
        <p className="mt-1 text-sm text-gray-500">Manage external service connections</p>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {integrations.map((integration) => (
          <IntegrationCard
            key={integration.id}
            integration={integration}
            icon={getIcon(integration.id)}
            testing={testingId === integration.id}
            configuring={configuringId === integration.id}
            onTestConnection={() => testConnection(integration.id)}
            onConfigure={() => setConfiguringId(configuringId === integration.id ? null : integration.id)}
            onSaveCredentials={(fields) => handleSaveCredentials(integration.id, fields)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Integration Card ────────────────────────────────────────────────────

interface IntegrationCardProps {
  integration: IntegrationInfo;
  icon: React.ReactNode;
  testing: boolean;
  configuring: boolean;
  onTestConnection: () => void;
  onConfigure: () => void;
  onSaveCredentials: (fields: { path: string; value: string }[]) => Promise<void>;
}

function IntegrationCard({
  integration,
  icon,
  testing,
  configuring,
  onTestConnection,
  onConfigure,
  onSaveCredentials,
}: IntegrationCardProps) {
  const [saving, setSaving] = useState(false);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [jsonValue, setJsonValue] = useState('');

  const hasSecretFields = integration.secretFields && integration.secretFields.length > 0;

  async function handleSave() {
    setSaving(true);
    try {
      if (hasSecretFields) {
        const fields = integration.secretFields!.map((f) => ({
          path: f.path,
          value: fieldValues[f.path] ?? '',
        }));
        await onSaveCredentials(fields);
      } else if (jsonValue.trim()) {
        await onSaveCredentials([
          { path: `integrations/${integration.id}/credentials`, value: jsonValue.trim() },
        ]);
      }
      setFieldValues({});
      setJsonValue('');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-gray-900">{integration.name}</h3>
            <StatusIndicator status={integration.status} />
          </div>
          <p className="mt-1 text-xs text-gray-500">{integration.description}</p>

          <div className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-gray-500">Status</span>
              <span className={`font-medium ${statusColor(integration.status)}`}>
                {statusLabel(integration.status)}
              </span>
            </div>

            {integration.lastChecked && (
              <div className="flex items-center justify-between">
                <span className="text-gray-500">Last Checked</span>
                <span className="text-gray-700 text-xs">
                  {new Date(integration.lastChecked).toLocaleString()}
                </span>
              </div>
            )}

            {integration.errorMessage && (
              <div className="mt-2 rounded-md bg-red-50 p-2 text-xs text-red-700">
                {integration.errorMessage}
              </div>
            )}
          </div>

          {/* Configure form */}
          {configuring && (
            <div className="mt-4 space-y-3 border-t border-gray-100 pt-3">
              {hasSecretFields ? (
                integration.secretFields!.map((field) => (
                  <div key={field.path}>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      {field.label}
                      {!field.required && <span className="text-gray-400 ml-1">(optional)</span>}
                    </label>
                    <input
                      type="password"
                      placeholder={field.placeholder}
                      value={fieldValues[field.path] ?? ''}
                      onChange={(e) =>
                        setFieldValues((prev) => ({ ...prev, [field.path]: e.target.value }))
                      }
                      className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                ))
              ) : (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">
                    Credentials (JSON)
                  </label>
                  <textarea
                    rows={3}
                    placeholder='{"apiKey": "...", "secret": "..."}'
                    value={jsonValue}
                    onChange={(e) => setJsonValue(e.target.value)}
                    className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              )}
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save Credentials'}
              </button>
            </div>
          )}

          <div className="mt-4 flex gap-2">
            <button
              onClick={onConfigure}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              {configuring ? 'Cancel' : 'Configure'}
            </button>
            <button
              onClick={onTestConnection}
              disabled={testing}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {testing ? 'Testing...' : 'Test Connection'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Status Indicator ────────────────────────────────────────────────────

function StatusIndicator({ status }: { status: ConnectionStatus }) {
  const colors: Record<ConnectionStatus, string> = {
    connected: 'bg-green-500',
    disconnected: 'bg-gray-400',
    error: 'bg-red-500',
    pending: 'bg-yellow-500',
  };

  return <div className={`h-2.5 w-2.5 rounded-full ${colors[status]}`} />;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function statusLabel(status: ConnectionStatus): string {
  const labels: Record<ConnectionStatus, string> = {
    connected: 'Connected',
    disconnected: 'Disconnected',
    error: 'Error',
    pending: 'Pending',
  };
  return labels[status];
}

function statusColor(status: ConnectionStatus): string {
  const colors: Record<ConnectionStatus, string> = {
    connected: 'text-green-700',
    disconnected: 'text-gray-500',
    error: 'text-red-700',
    pending: 'text-yellow-700',
  };
  return colors[status];
}
