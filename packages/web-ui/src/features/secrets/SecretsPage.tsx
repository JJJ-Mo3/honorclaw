import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';

interface Secret {
  path: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function SecretsPage() {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [loading, setLoading] = useState(true);
  const [prefix, setPrefix] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [newValue, setNewValue] = useState('');
  const [newExpiry, setNewExpiry] = useState('');
  const [saving, setSaving] = useState(false);
  const [rotatingPath, setRotatingPath] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadSecrets = useCallback(async () => {
    try {
      const params: Record<string, string> = {};
      if (prefix) params.prefix = prefix;
      const data = await api.get<{ secrets: Secret[] }>('/secrets', params);
      setSecrets(data.secrets);
    } catch {
      setError('Failed to load secrets');
    } finally {
      setLoading(false);
    }
  }, [prefix]);

  useEffect(() => { void loadSecrets(); }, [loadSecrets]);

  const handleCreate = async () => {
    if (!newPath || !newValue) return;
    setSaving(true);
    setError('');
    try {
      await api.post('/secrets', {
        path: newPath,
        value: newValue,
        expires_at: newExpiry || undefined,
      });
      setShowCreate(false);
      setNewPath('');
      setNewValue('');
      setNewExpiry('');
      void loadSecrets();
    } catch {
      setError('Failed to create secret');
    } finally {
      setSaving(false);
    }
  };

  const handleRotate = async (path: string) => {
    setRotatingPath(path);
    setError('');
    try {
      await api.post('/secrets/rotate', { path });
      void loadSecrets();
    } catch {
      setError('Failed to rotate secret');
    } finally {
      setRotatingPath(null);
    }
  };

  if (loading) return <div className="min-h-screen bg-gray-50 p-6"><p className="text-sm text-gray-500">Loading secrets...</p></div>;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Secrets</h1>
          <p className="mt-1 text-sm text-gray-500">Manage encrypted secrets available to agents at runtime</p>
        </div>
        <button onClick={() => setShowCreate(!showCreate)} className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition-colors">
          {showCreate ? 'Cancel' : 'Add Secret'}
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded">{error}</div>
      )}

      {showCreate && (
        <div className="bg-white rounded-lg shadow p-4 border border-gray-200 mb-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Create or Update Secret</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input type="text" placeholder="Path (e.g. integrations/slack/token)" value={newPath} onChange={(e) => setNewPath(e.target.value)} className="border rounded px-3 py-2 text-sm" />
            <input type="password" placeholder="Value" value={newValue} onChange={(e) => setNewValue(e.target.value)} className="border rounded px-3 py-2 text-sm" />
            <input type="datetime-local" placeholder="Expiry (optional)" value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)} className="border rounded px-3 py-2 text-sm" />
          </div>
          <p className="text-xs text-gray-500 mt-2">If a secret with this path already exists, it will be updated.</p>
          <button onClick={() => { void handleCreate(); }} disabled={saving || !newPath || !newValue} className="mt-3 px-4 py-2 bg-green-600 text-white text-sm rounded hover:bg-green-700 disabled:opacity-50 transition-colors">
            {saving ? 'Saving...' : 'Save Secret'}
          </button>
        </div>
      )}

      <div className="mb-4">
        <input type="text" placeholder="Filter by prefix..." value={prefix} onChange={(e) => setPrefix(e.target.value)} className="border rounded px-3 py-2 text-sm w-64" />
      </div>

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Path</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Created</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Updated</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Expires</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {secrets.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No secrets found</td></tr>
            )}
            {secrets.map((s) => (
              <tr key={s.path} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs">{s.path}</td>
                <td className="px-4 py-3 text-gray-500">{new Date(s.createdAt).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-gray-500">{new Date(s.updatedAt).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-gray-500">{s.expiresAt ? new Date(s.expiresAt).toLocaleString() : 'Never'}</td>
                <td className="px-4 py-3">
                  <button onClick={() => { void handleRotate(s.path); }} disabled={rotatingPath === s.path} className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50">
                    {rotatingPath === s.path ? 'Rotating...' : 'Rotate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
