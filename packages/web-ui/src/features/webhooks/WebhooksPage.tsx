import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';

interface Webhook {
  id: string;
  url: string;
  event_types: string[];
  enabled: boolean;
  created_at: string;
  last_delivered_at: string | null;
  consecutive_failures: number;
}

interface Delivery {
  id: string;
  event_id: string;
  attempt: number;
  status: string;
  response_status: number | null;
  error_message: string | null;
  delivered_at: string;
}

const EVENT_TYPE_OPTIONS = [
  'agent.created', 'agent.updated', 'agent.deleted',
  'session.started', 'session.completed', 'session.error',
  'tool.called', 'tool.approved', 'tool.rejected',
  'guardrail.triggered', 'approval.requested',
];

export function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newEvents, setNewEvents] = useState<string[]>([]);
  const [signingSecret, setSigningSecret] = useState('');
  const [deliveries, setDeliveries] = useState<Record<string, Delivery[]>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadWebhooks = useCallback(async () => {
    try {
      setError('');
      const data = await api.get<{ webhooks: Webhook[] } | Webhook[]>('/webhooks');
      setWebhooks(Array.isArray(data) ? data : data.webhooks);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load webhooks');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWebhooks();
  }, [loadWebhooks]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrl || newEvents.length === 0) return;
    try {
      setError('');
      const data = await api.post<{ id: string; signing_secret: string }>('/webhooks', {
        url: newUrl,
        event_types: newEvents,
      });
      setSigningSecret(data.signing_secret);
      setNewUrl('');
      setNewEvents([]);
      setShowCreate(false);
      void loadWebhooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create webhook');
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await api.put(`/webhooks/${id}`, { enabled: !enabled });
      void loadWebhooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update webhook');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/webhooks/${id}`);
      void loadWebhooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete webhook');
    }
  };

  const handleTest = async (id: string) => {
    try {
      setError('');
      await api.post(`/webhooks/${id}/test`);
      setError(''); // Clear any previous error
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test delivery failed');
    }
  };

  const loadDeliveries = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    try {
      const data = await api.get<{ deliveries: Delivery[] } | Delivery[]>(`/webhooks/${id}/deliveries`);
      setDeliveries((prev) => ({ ...prev, [id]: Array.isArray(data) ? data : data.deliveries }));
      setExpandedId(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deliveries');
    }
  };

  const toggleEvent = (event: string) => {
    setNewEvents((prev) =>
      prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
    );
  };

  if (loading) return <div className="min-h-screen bg-gray-50 p-6"><p className="text-sm text-gray-500">Loading webhooks...</p></div>;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Webhooks</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition-colors"
        >
          {showCreate ? 'Cancel' : 'Create Webhook'}
        </button>
      </div>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      {signingSecret && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
          <h3 className="font-semibold text-yellow-800 mb-1">Save your signing secret</h3>
          <p className="text-sm text-yellow-700 mb-2">This is shown only once. Store it securely.</p>
          <code className="block bg-yellow-100 p-2 rounded text-sm font-mono break-all">{signingSecret}</code>
          <button onClick={() => setSigningSecret('')} className="mt-2 text-xs text-yellow-600 hover:text-yellow-800">Dismiss</button>
        </div>
      )}

      {showCreate && (
        <form onSubmit={(e) => { void handleCreate(e); }} className="bg-white rounded-lg shadow border border-gray-200 p-4 mb-6">
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Payload URL</label>
            <input
              type="url"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://example.com/webhook"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              required
            />
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Event Types</label>
            <div className="flex flex-wrap gap-2">
              {EVENT_TYPE_OPTIONS.map((event) => (
                <label key={event} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={newEvents.includes(event)}
                    onChange={() => toggleEvent(event)}
                    className="rounded border-gray-300"
                  />
                  {event}
                </label>
              ))}
            </div>
          </div>
          <button
            type="submit"
            disabled={!newUrl || newEvents.length === 0}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            Create
          </button>
        </form>
      )}

      {webhooks.length === 0 ? (
        <p className="text-gray-500">No webhook subscriptions configured.</p>
      ) : (
        <div className="space-y-4">
          {webhooks.map((w) => (
            <div key={w.id} className="bg-white rounded-lg shadow border border-gray-200">
              <div className="p-4">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${w.enabled ? 'bg-green-500' : 'bg-gray-400'}`} />
                      <code className="text-sm font-mono">{w.url}</code>
                    </div>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {w.event_types.map((et) => (
                        <span key={et} className="px-2 py-0.5 bg-gray-100 rounded text-xs text-gray-600">{et}</span>
                      ))}
                    </div>
                    <p className="text-xs text-gray-400 mt-2">
                      Created: {new Date(w.created_at).toLocaleString()}
                      {w.last_delivered_at && <> | Last delivery: {new Date(w.last_delivered_at).toLocaleString()}</>}
                      {w.consecutive_failures > 0 && (
                        <span className="text-red-500 ml-2">({w.consecutive_failures} consecutive failures)</span>
                      )}
                    </p>
                  </div>
                  <div className="flex gap-2 ml-4 shrink-0">
                    <button
                      onClick={() => { void handleTest(w.id); }}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      Test
                    </button>
                    <button
                      onClick={() => { void loadDeliveries(w.id); }}
                      className="text-xs text-gray-600 hover:text-gray-800"
                    >
                      {expandedId === w.id ? 'Hide' : 'Deliveries'}
                    </button>
                    <button
                      onClick={() => { void handleToggle(w.id, w.enabled); }}
                      className={`text-xs ${w.enabled ? 'text-orange-600 hover:text-orange-800' : 'text-green-600 hover:text-green-800'}`}
                    >
                      {w.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={() => { void handleDelete(w.id); }}
                      className="text-xs text-red-600 hover:text-red-800"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>

              {expandedId === w.id && deliveries[w.id] && (
                <div className="border-t border-gray-200 p-4 bg-gray-50">
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Recent Deliveries</h4>
                  {deliveries[w.id]!.length === 0 ? (
                    <p className="text-xs text-gray-500">No deliveries yet.</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-500">
                          <th className="text-left py-1">Time</th>
                          <th className="text-left py-1">Status</th>
                          <th className="text-left py-1">HTTP</th>
                          <th className="text-left py-1">Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deliveries[w.id]!.map((d) => (
                          <tr key={d.id} className="border-t border-gray-100">
                            <td className="py-1">{new Date(d.delivered_at).toLocaleString()}</td>
                            <td className="py-1">
                              <span className={d.status === 'success' ? 'text-green-600' : 'text-red-600'}>
                                {d.status}
                              </span>
                            </td>
                            <td className="py-1">{d.response_status ?? '-'}</td>
                            <td className="py-1 text-red-500">{d.error_message ?? '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
