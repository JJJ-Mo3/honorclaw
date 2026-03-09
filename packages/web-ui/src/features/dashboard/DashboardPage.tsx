import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';

interface PlatformStatus {
  version: string;
  uptime: number;
  agents: number;
  activeSessions: number;
  database: string;
  redis: string;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function DashboardPage() {
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [statusData, approvalData] = await Promise.all([
          api.get<PlatformStatus>('/status'),
          api.get<{ approvals: unknown[] }>('/approvals').catch(() => ({ approvals: [] })),
        ]);
        setStatus(statusData);
        setPendingApprovals(approvalData.approvals.length);
      } catch {
        // Ignore
      } finally {
        setLoading(false);
      }
    }
    void load();
    const interval = setInterval(() => { void load(); }, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return <div className="min-h-screen bg-gray-50 p-6"><p className="text-sm text-gray-500">Loading dashboard...</p></div>;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>

      {status && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
            <p className="text-sm text-gray-500">Agents</p>
            <p className="text-3xl font-bold mt-1">{status.agents}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
            <p className="text-sm text-gray-500">Active Sessions</p>
            <p className="text-3xl font-bold mt-1">{status.activeSessions}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
            <p className="text-sm text-gray-500">Uptime</p>
            <p className="text-3xl font-bold mt-1">{formatUptime(status.uptime)}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
            <p className="text-sm text-gray-500">Version</p>
            <p className="text-3xl font-bold mt-1">{status.version}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <div className="bg-white rounded-lg shadow p-4 border border-gray-200">
          <h2 className="font-semibold mb-3">System Health</h2>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Database</span>
              <span className={`text-sm font-medium ${status?.database === 'ok' ? 'text-green-600' : 'text-red-600'}`}>{status?.database ?? 'Unknown'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-600">Redis</span>
              <span className={`text-sm font-medium ${status?.redis === 'ok' ? 'text-green-600' : 'text-red-600'}`}>{status?.redis ?? 'Unknown'}</span>
            </div>
          </div>
        </div>

        {pendingApprovals > 0 && (
          <Link to="/approvals" className="bg-yellow-50 rounded-lg shadow p-4 border border-yellow-200 block hover:bg-yellow-100 transition-colors">
            <h2 className="font-semibold text-yellow-800 mb-1">Pending Approvals</h2>
            <p className="text-3xl font-bold text-yellow-700">{pendingApprovals}</p>
            <p className="text-sm text-yellow-600 mt-1">Tool calls awaiting review</p>
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Link to="/admin" className="bg-white rounded-lg shadow p-4 border border-gray-200 hover:bg-gray-50 transition-colors text-center">
          <p className="font-medium">Agents</p>
          <p className="text-sm text-gray-500 mt-1">Manage agents</p>
        </Link>
        <Link to="/skills" className="bg-white rounded-lg shadow p-4 border border-gray-200 hover:bg-gray-50 transition-colors text-center">
          <p className="font-medium">Skills</p>
          <p className="text-sm text-gray-500 mt-1">Browse & install</p>
        </Link>
        <Link to="/audit" className="bg-white rounded-lg shadow p-4 border border-gray-200 hover:bg-gray-50 transition-colors text-center">
          <p className="font-medium">Audit Log</p>
          <p className="text-sm text-gray-500 mt-1">View events</p>
        </Link>
        <Link to="/" className="bg-white rounded-lg shadow p-4 border border-gray-200 hover:bg-gray-50 transition-colors text-center">
          <p className="font-medium">Chat</p>
          <p className="text-sm text-gray-500 mt-1">Talk to agents</p>
        </Link>
      </div>
    </div>
  );
}
