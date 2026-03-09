import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';

interface User {
  id: string;
  email: string;
  displayName: string;
  isDeploymentAdmin: boolean;
  totpEnabled: boolean;
  role: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('agent_user');
  const [creating, setCreating] = useState(false);

  const loadUsers = useCallback(async () => {
    try {
      const data = await api.get<{ users: User[] }>('/users');
      setUsers(data.users);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadUsers(); }, [loadUsers]);

  const handleCreate = async () => {
    setCreating(true);
    try {
      await api.post('/users', { email: newEmail, password: newPassword || undefined, role: newRole });
      setShowCreate(false);
      setNewEmail('');
      setNewPassword('');
      setNewRole('agent_user');
      void loadUsers();
    } catch {
      // Ignore
    } finally {
      setCreating(false);
    }
  };

  const handleRoleChange = async (userId: string, role: string) => {
    await api.patch(`/users/${userId}/role`, { role });
    void loadUsers();
  };

  if (loading) return <div className="min-h-screen bg-gray-50 p-6"><p className="text-sm text-gray-500">Loading users...</p></div>;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Users</h1>
        <button onClick={() => setShowCreate(!showCreate)} className="px-4 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 transition-colors">
          {showCreate ? 'Cancel' : 'Create User'}
        </button>
      </div>

      {showCreate && (
        <div className="bg-white rounded-lg shadow p-4 border border-gray-200 mb-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input type="email" placeholder="Email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="border rounded px-3 py-2 text-sm" />
            <input type="password" placeholder="Password (auto-generated if empty)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="border rounded px-3 py-2 text-sm" />
            <select value={newRole} onChange={(e) => setNewRole(e.target.value)} className="border rounded px-3 py-2 text-sm">
              <option value="agent_user">Agent User</option>
              <option value="workspace_admin">Workspace Admin</option>
              <option value="auditor">Auditor</option>
              <option value="api_service">API Service</option>
            </select>
          </div>
          <button onClick={() => { void handleCreate(); }} disabled={creating || !newEmail} className="mt-3 px-4 py-2 bg-green-600 text-white text-sm rounded hover:bg-green-700 disabled:opacity-50 transition-colors">
            {creating ? 'Creating...' : 'Create'}
          </button>
        </div>
      )}

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Email</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Role</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">MFA</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Created</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Last Login</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-4 py-3">
                  {u.email}
                  {u.isDeploymentAdmin && <span className="ml-2 text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">Admin</span>}
                </td>
                <td className="px-4 py-3">
                  <select value={u.role} onChange={(e) => { void handleRoleChange(u.id, e.target.value); }} className="border rounded px-2 py-1 text-xs">
                    <option value="agent_user">agent_user</option>
                    <option value="workspace_admin">workspace_admin</option>
                    <option value="auditor">auditor</option>
                    <option value="api_service">api_service</option>
                  </select>
                </td>
                <td className="px-4 py-3">{u.totpEnabled ? <span className="text-green-600">Enabled</span> : <span className="text-gray-400">Off</span>}</td>
                <td className="px-4 py-3 text-gray-500">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-gray-500">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
