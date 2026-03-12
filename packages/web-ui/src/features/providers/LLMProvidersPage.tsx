import { useState, useEffect } from 'react';
import { api } from '../../api/client.js';

interface ProviderConfig {
  id: string;
  name: string;
  description: string;
  fields: { key: string; label: string; secretPath: string; multiline?: boolean }[];
}

const PROVIDERS: ProviderConfig[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models (Opus, Sonnet, Haiku)',
    fields: [{ key: 'apiKey', label: 'API Key', secretPath: 'llm/anthropic/api-key' }],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'GPT-4o, o1, o3 models',
    fields: [{ key: 'apiKey', label: 'API Key', secretPath: 'llm/openai/api-key' }],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Gemini 2.0 Flash, Pro models',
    fields: [{ key: 'apiKey', label: 'API Key', secretPath: 'llm/gemini/api-key' }],
  },
  {
    id: 'bedrock',
    name: 'AWS Bedrock',
    description: 'Claude and Nova models via AWS',
    fields: [
      { key: 'accessKeyId', label: 'Access Key ID', secretPath: 'llm/bedrock/access-key-id' },
      { key: 'secretAccessKey', label: 'Secret Access Key', secretPath: 'llm/bedrock/secret-access-key' },
    ],
  },
  {
    id: 'vertex',
    name: 'Google Vertex AI',
    description: 'Claude models via GCP',
    fields: [{ key: 'serviceAccountJson', label: 'Service Account JSON', secretPath: 'llm/vertex/service-account-json', multiline: true }],
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    description: 'GPT models via Azure',
    fields: [
      { key: 'apiKey', label: 'API Key', secretPath: 'llm/azure/api-key' },
      { key: 'endpoint', label: 'Endpoint URL', secretPath: 'llm/azure/endpoint' },
    ],
  },
];

export function LLMProvidersPage() {
  const [configuredPaths, setConfiguredPaths] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [formValues, setFormValues] = useState<Record<string, Record<string, string>>>({});

  useEffect(() => {
    api.get<{ secrets: { path: string }[] }>('/secrets', { prefix: 'llm/' })
      .then(data => {
        setConfiguredPaths(new Set(data.secrets.map(s => s.path)));
      })
      .catch(() => {});
  }, []);

  const updateField = (providerId: string, fieldKey: string, value: string) => {
    setFormValues(prev => ({
      ...prev,
      [providerId]: { ...prev[providerId], [fieldKey]: value },
    }));
  };

  const handleSave = async (provider: ProviderConfig) => {
    const values = formValues[provider.id] ?? {};
    const hasValues = provider.fields.some(f => values[f.key]?.trim());
    if (!hasValues) return;

    setSaving(provider.id);
    setMessage('');
    try {
      for (const field of provider.fields) {
        const val = values[field.key]?.trim();
        if (val) {
          await api.post('/secrets', { path: field.secretPath, value: val });
        }
      }
      await api.post('/models/reload-providers');
      const data = await api.get<{ secrets: { path: string }[] }>('/secrets', { prefix: 'llm/' });
      setConfiguredPaths(new Set(data.secrets.map(s => s.path)));
      setFormValues(prev => ({ ...prev, [provider.id]: {} }));
      setMessage(`${provider.name} configured successfully.`);
    } catch {
      setMessage(`Failed to save ${provider.name} configuration.`);
    } finally {
      setSaving(null);
    }
  };

  const handleRemove = async (provider: ProviderConfig) => {
    setSaving(provider.id);
    setMessage('');
    try {
      for (const field of provider.fields) {
        if (configuredPaths.has(field.secretPath)) {
          await api.delete(`/secrets/${encodeURIComponent(field.secretPath)}`);
        }
      }
      await api.post('/models/reload-providers');
      const data = await api.get<{ secrets: { path: string }[] }>('/secrets', { prefix: 'llm/' });
      setConfiguredPaths(new Set(data.secrets.map(s => s.path)));
      setMessage(`${provider.name} credentials removed.`);
    } catch {
      setMessage(`Failed to remove ${provider.name} credentials.`);
    } finally {
      setSaving(null);
    }
  };

  const isConfigured = (provider: ProviderConfig) =>
    provider.fields.every(f => configuredPaths.has(f.secretPath));

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <h1 className="text-2xl font-bold">LLM Providers</h1>
      <p className="mt-1 text-sm text-gray-500 mb-4">Configure API keys to enable frontier LLM providers for your agents. Keys are encrypted at rest.</p>

      {message && (
        <p className={`text-sm mb-4 ${message.includes('Failed') ? 'text-red-600' : 'text-green-600'}`}>{message}</p>
      )}

      <div className="space-y-4 max-w-lg">
        {PROVIDERS.map(provider => {
          const configured = isConfigured(provider);
          const values = formValues[provider.id] ?? {};

          return (
            <div key={provider.id} className="bg-white rounded-lg shadow p-5">
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-semibold text-base">{provider.name}</h3>
                {configured && (
                  <span className="text-xs font-medium bg-green-100 text-green-700 px-2 py-0.5 rounded">Configured</span>
                )}
              </div>
              <p className="text-sm text-gray-500 mb-3">{provider.description}</p>
              <div className="space-y-2">
                {provider.fields.map(field => (
                  <div key={field.key}>
                    <label className="block text-sm font-medium text-gray-600 mb-1">{field.label}</label>
                    {field.multiline ? (
                      <textarea
                        value={values[field.key] ?? ''}
                        onChange={e => updateField(provider.id, field.key, e.target.value)}
                        placeholder={configured ? '********' : `Enter ${field.label}`}
                        rows={3}
                        className="w-full border rounded px-3 py-2 text-sm font-mono"
                      />
                    ) : (
                      <input
                        type="password"
                        value={values[field.key] ?? ''}
                        onChange={e => updateField(provider.id, field.key, e.target.value)}
                        placeholder={configured ? '********' : `Enter ${field.label}`}
                        className="w-full border rounded px-3 py-2 text-sm"
                      />
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => { void handleSave(provider); }}
                  disabled={saving === provider.id || !provider.fields.some(f => values[f.key]?.trim())}
                  className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {saving === provider.id ? 'Saving...' : configured ? 'Update' : 'Save'}
                </button>
                {configured && (
                  <button
                    onClick={() => { void handleRemove(provider); }}
                    disabled={saving === provider.id}
                    className="px-4 py-2 text-sm text-red-600 border border-red-200 rounded hover:bg-red-50 disabled:opacity-50 transition-colors"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
