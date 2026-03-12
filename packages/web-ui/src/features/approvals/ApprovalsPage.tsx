import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';

interface Approval {
  id: string;
  session_id: string;
  agent_id: string;
  tool_name: string;
  parameters_redacted: string;
  status: string;
  timeout_at: string;
  created_at: string;
}

export function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);

  const loadApprovals = useCallback(async () => {
    try {
      const data = await api.get<{ approvals: Approval[] }>('/approvals');
      setApprovals(data.approvals);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadApprovals();
    const interval = setInterval(() => { void loadApprovals(); }, 5000);
    return () => clearInterval(interval);
  }, [loadApprovals]);

  const handleApprove = async (id: string) => {
    await api.post(`/approvals/${id}/approve`);
    void loadApprovals();
  };

  const handleReject = async (id: string) => {
    await api.post(`/approvals/${id}/reject`, { reason: 'Rejected by admin' });
    void loadApprovals();
  };

  if (loading) return <div className="min-h-screen bg-gray-50 p-6"><p className="text-sm text-gray-500">Loading approvals...</p></div>;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <h1 className="text-2xl font-bold">Pending Approvals</h1>
      <p className="mt-1 text-sm text-gray-500 mb-4">Review and approve or reject agent tool-call requests that require human authorization</p>
      {approvals.length === 0 ? (
        <p className="text-gray-500">No pending approval requests.</p>
      ) : (
        <div className="space-y-4">
          {approvals.map((a) => (
            <div key={a.id} className="bg-white rounded-lg shadow p-4 border border-gray-200">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-lg">{a.tool_name}</h3>
                  <p className="text-sm text-gray-500 mt-1">
                    Session: <span className="font-mono">{a.session_id.slice(0, 8)}</span>
                    {' | '}Agent: <span className="font-mono">{a.agent_id.slice(0, 8)}</span>
                  </p>
                  <pre className="mt-2 text-xs bg-gray-50 p-2 rounded overflow-x-auto max-w-2xl">
                    {a.parameters_redacted}
                  </pre>
                  <p className="text-xs text-gray-400 mt-2">
                    Requested: {new Date(a.created_at).toLocaleString()}
                    {' | '}Expires: {new Date(a.timeout_at).toLocaleString()}
                  </p>
                </div>
                <div className="flex gap-2 ml-4 shrink-0">
                  <button
                    onClick={() => { void handleApprove(a.id); }}
                    className="px-4 py-2 bg-green-600 text-white text-sm rounded hover:bg-green-700 transition-colors"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => { void handleReject(a.id); }}
                    className="px-4 py-2 bg-red-600 text-white text-sm rounded hover:bg-red-700 transition-colors"
                  >
                    Reject
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
