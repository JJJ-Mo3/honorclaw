import { useState, useEffect } from 'react';
import { api } from '../../api/client.js';

// ── Types ───────────────────────────────────────────────────────────────

type ConnectionStatus = 'connected' | 'disconnected' | 'error' | 'pending';
type AuthMode = 'oauth2' | 'service_account' | 'api_key' | 'none';

interface IntegrationInfo {
  id: string;
  name: string;
  status: ConnectionStatus;
  authMode: AuthMode;
  lastChecked?: string;
  errorMessage?: string;
}

// ── Component ───────────────────────────────────────────────────────────

export function IntegrationsPage() {
  const [integrations, setIntegrations] = useState<IntegrationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const data = await api.get<IntegrationInfo[]>('/integrations');
        setIntegrations(data);
      } catch {
        // Fallback: show default integration cards even if API fails
        setIntegrations([
          {
            id: 'google-workspace',
            name: 'Google Workspace',
            status: 'disconnected',
            authMode: 'none',
          },
          {
            id: 'microsoft-365',
            name: 'Microsoft 365',
            status: 'disconnected',
            authMode: 'none',
          },
        ]);
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

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-sm text-gray-500">Loading integrations...</div>
      </div>
    );
  }

  const googleWorkspace = integrations.find((i) => i.id === 'google-workspace');
  const microsoft365 = integrations.find((i) => i.id === 'microsoft-365');

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-xl font-bold text-gray-900">Integrations</h1>
        <p className="mt-1 text-sm text-gray-500">Manage external service connections</p>
      </header>

      <div className="max-w-4xl mx-auto px-6 py-6 grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Google Workspace Card */}
        {googleWorkspace && (
          <IntegrationCard
            integration={googleWorkspace}
            icon={
              <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
            }
            testing={testingId === 'google-workspace'}
            onTestConnection={() => testConnection('google-workspace')}
          />
        )}

        {/* Microsoft 365 Card */}
        {microsoft365 && (
          <IntegrationCard
            integration={microsoft365}
            icon={
              <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none">
                <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
                <rect x="13" y="1" width="10" height="10" fill="#7FBA00"/>
                <rect x="1" y="13" width="10" height="10" fill="#00A4EF"/>
                <rect x="13" y="13" width="10" height="10" fill="#FFB900"/>
              </svg>
            }
            testing={testingId === 'microsoft-365'}
            onTestConnection={() => testConnection('microsoft-365')}
          />
        )}
      </div>
    </div>
  );
}

// ── Integration Card ────────────────────────────────────────────────────

interface IntegrationCardProps {
  integration: IntegrationInfo;
  icon: React.ReactNode;
  testing: boolean;
  onTestConnection: () => void;
}

function IntegrationCard({ integration, icon, testing, onTestConnection }: IntegrationCardProps) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-gray-900">{integration.name}</h3>
            <StatusIndicator status={integration.status} />
          </div>

          <div className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-gray-500">Auth Mode</span>
              <span className="text-gray-900 font-medium">
                {authModeLabel(integration.authMode)}
              </span>
            </div>

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

          <div className="mt-4">
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

function authModeLabel(mode: AuthMode): string {
  const labels: Record<AuthMode, string> = {
    oauth2: 'OAuth 2.0',
    service_account: 'Service Account',
    api_key: 'API Key',
    none: 'Not Configured',
  };
  return labels[mode];
}

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
