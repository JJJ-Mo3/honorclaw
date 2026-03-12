import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AuditEvent {
  id: string;
  eventType: string;
  actorId: string | null;
  agentId: string | null;
  sessionId: string | null;
  payload: Record<string, string> | null;
  createdAt: string;
}

interface Session {
  id: string;
  agentId: string | null;
  parentSessionId: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

interface Agent {
  id: string;
  name: string;
  tools?: string[];
}

interface DelegationRow {
  id: string;
  parentAgent: string;
  childAgent: string;
  task: string;
  status: string;
  started: string;
  duration: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatDuration(startISO: string, endISO: string | null): string {
  const start = new Date(startISO).getTime();
  const end = endISO ? new Date(endISO).getTime() : Date.now();
  const diffMs = Math.max(0, end - start);
  const seconds = Math.floor(diffMs / 1000);

  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function statusColor(status: string): string {
  switch (status) {
    case 'active':
      return 'bg-green-100 text-green-700';
    case 'completed':
      return 'bg-gray-100 text-gray-600';
    case 'error':
      return 'bg-red-100 text-red-700';
    default:
      return 'bg-gray-100 text-gray-600';
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function DelegationPage() {
  const [delegations, setDelegations] = useState<DelegationRow[]>([]);
  const [childSessions, setChildSessions] = useState<Session[]>([]);
  const [capableAgents, setCapableAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'history' | 'active' | 'agents'>('history');

  /* ---------- data loading ---------------------------------------- */

  const loadData = useCallback(async () => {
    try {
      setError('');
      setLoading(true);

      const [eventsRes, sessionsRes, agentsRes] = await Promise.all([
        api.get<{ events: AuditEvent[] }>('/audit/events', {
          event_type: 'delegation',
          limit: '200',
        }),
        api.get<{ sessions: Session[] }>('/sessions', {
          parent_session_id: '*',
          limit: '100',
        }),
        api.get<{ agents: Agent[] }>('/agents'),
      ]);

      /* Build a quick agent-name lookup */
      const agentMap = new Map<string, string>();
      for (const a of agentsRes.agents) {
        agentMap.set(a.id, a.name);
      }

      /* Map audit events into delegation rows */
      const rows: DelegationRow[] = eventsRes.events.map((e) => ({
        id: e.id,
        parentAgent: (e.actorId && agentMap.get(e.actorId)) ?? e.actorId?.slice(0, 12) ?? '-',
        childAgent: (e.agentId && agentMap.get(e.agentId)) ?? e.agentId?.slice(0, 12) ?? '-',
        task: e.payload?.['task'] ?? '-',
        status: e.payload?.['status'] ?? 'unknown',
        started: e.createdAt,
        duration: formatDuration(e.createdAt, e.payload?.['completed_at'] ?? null),
      }));

      setDelegations(rows);
      setChildSessions(sessionsRes.sessions);
      setCapableAgents(agentsRes.agents.filter((a) => a.tools && a.tools.includes('delegate')));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load delegation data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  /* ---------- render ---------------------------------------------- */

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <p className="text-sm text-gray-500">Loading delegation data...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Multi-Agent Delegation</h1>
          <p className="mt-1 text-sm text-gray-500">Track agent-to-agent task delegation, active child sessions, and delegation-capable agents</p>
        </div>
        <button
          onClick={() => { void loadData(); }}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          Refresh
        </button>
      </div>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        {(['history', 'active', 'agents'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${
              tab === t ? 'bg-blue-100 text-blue-700' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {t === 'history' && `Delegation History (${delegations.length})`}
            {t === 'active' && `Active Child Sessions (${childSessions.length})`}
            {t === 'agents' && `Capable Agents (${capableAgents.length})`}
          </button>
        ))}
      </div>

      {/* History tab */}
      {tab === 'history' && (
        <>
          {delegations.length === 0 ? (
            <p className="text-gray-500">No delegation events found.</p>
          ) : (
            <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Parent Agent</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Child Agent</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Task</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Started</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Duration</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {delegations.map((d) => (
                    <tr key={d.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3">{d.parentAgent}</td>
                      <td className="px-4 py-3">{d.childAgent}</td>
                      <td className="px-4 py-3 max-w-xs truncate" title={d.task}>{d.task}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(d.status)}`}>
                          {d.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500">{new Date(d.started).toLocaleString()}</td>
                      <td className="px-4 py-3 text-gray-500">{d.duration}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Active child sessions tab */}
      {tab === 'active' && (
        <>
          {childSessions.length === 0 ? (
            <p className="text-gray-500">No active child sessions.</p>
          ) : (
            <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Session ID</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Agent</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Parent Session</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {childSessions.map((s) => (
                    <tr key={s.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-mono text-xs">{s.id?.slice(0, 12) ?? '-'}...</td>
                      <td className="px-4 py-3 font-mono text-xs">{s.agentId?.slice(0, 12) ?? '-'}...</td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {s.parentSessionId ? `${s.parentSessionId.slice(0, 12)}...` : '-'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(s.status)}`}>
                          {s.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500">{new Date(s.startedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Capable agents tab */}
      {tab === 'agents' && (
        <>
          {capableAgents.length === 0 ? (
            <p className="text-gray-500">No agents with delegation capability found.</p>
          ) : (
            <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Agent</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">ID</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-600">Tools</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {capableAgents.map((a) => (
                    <tr key={a.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium">{a.name}</td>
                      <td className="px-4 py-3 font-mono text-xs">{a.id.slice(0, 12)}...</td>
                      <td className="px-4 py-3 text-xs">
                        {(a.tools ?? []).map((t) => (
                          <span
                            key={t}
                            className={`inline-block mr-1 mb-1 px-2 py-0.5 rounded-full ${
                              t === 'delegate' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
                            }`}
                          >
                            {t}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
