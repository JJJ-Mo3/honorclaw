import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';

// ── Types ───────────────────────────────────────────────────────────────

interface AuditEvent {
  id: string;
  workspaceId: string;
  eventType: string;
  actorType: 'user' | 'agent' | 'system';
  actorId?: string;
  agentId?: string;
  sessionId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface AuditQueryResult {
  events: AuditEvent[];
  nextCursor?: string;
  totalCount?: number;
}

type SortField = 'createdAt' | 'eventType' | 'actorType';
type SortDirection = 'asc' | 'desc';

// ── Component ───────────────────────────────────────────────────────────

export function AuditViewer() {
  // ── State ───────────────────────────────────────────────────────────
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [totalCount, setTotalCount] = useState<number | undefined>();

  // Filters
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [actorIdFilter, setActorIdFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Sorting
  const [sortField, setSortField] = useState<SortField>('createdAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Detail view
  const [selectedEvent, setSelectedEvent] = useState<AuditEvent | null>(null);

  // ── Fetch events ────────────────────────────────────────────────────
  const fetchEvents = useCallback(async (cursor?: string) => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (eventTypeFilter) params['eventType'] = eventTypeFilter;
      if (actorIdFilter) params['actorId'] = actorIdFilter;
      if (startDate) params['startDate'] = new Date(startDate).toISOString();
      if (endDate) params['endDate'] = new Date(endDate).toISOString();
      if (cursor) params['cursor'] = cursor;
      params['limit'] = '50';

      const result = await api.get<AuditQueryResult>('/audit/events', params);
      if (cursor) {
        setEvents((prev) => [...prev, ...result.events]);
      } else {
        setEvents(result.events);
      }
      setNextCursor(result.nextCursor);
      if (result.totalCount != null) setTotalCount(result.totalCount);
      else if (!cursor) setTotalCount(result.events.length);
    } catch {
      // handled by global error
    } finally {
      setLoading(false);
    }
  }, [eventTypeFilter, actorIdFilter, startDate, endDate]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  // ── Sort ────────────────────────────────────────────────────────────
  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  }

  const sortedEvents = [...events].sort((a, b) => {
    let cmp = 0;
    if (sortField === 'createdAt') {
      cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    } else if (sortField === 'eventType') {
      cmp = a.eventType.localeCompare(b.eventType);
    } else if (sortField === 'actorType') {
      cmp = a.actorType.localeCompare(b.actorType);
    }
    return sortDirection === 'asc' ? cmp : -cmp;
  });

  // ── Export ──────────────────────────────────────────────────────────
  async function handleExport() {
    try {
      const params: Record<string, string> = { format: 'jsonl' };
      if (eventTypeFilter) params['eventType'] = eventTypeFilter;
      if (actorIdFilter) params['actorId'] = actorIdFilter;
      if (startDate) params['startDate'] = new Date(startDate).toISOString();
      if (endDate) params['endDate'] = new Date(endDate).toISOString();

      const blob = await api.download('/audit/export', params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-export-${new Date().toISOString().slice(0, 10)}.jsonl`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // handled by global error
    }
  }

  // ── Redact sensitive fields for display ─────────────────────────────
  function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'api_key', 'authorization'];
    const redacted: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(payload)) {
      if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk))) {
        redacted[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        redacted[key] = redactPayload(value as Record<string, unknown>);
      } else {
        redacted[key] = value;
      }
    }

    return redacted;
  }

  // ── Sort indicator ──────────────────────────────────────────────────
  function sortIndicator(field: SortField) {
    if (sortField !== field) return '';
    return sortDirection === 'asc' ? ' \u2191' : ' \u2193';
  }

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">Audit Log</h1>
          <button
            onClick={handleExport}
            className="rounded-md bg-gray-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-900"
          >
            Export JSONL
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Filters */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4 grid grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500">Event Type</label>
            <input
              type="text"
              placeholder="e.g. auth.login"
              value={eventTypeFilter}
              onChange={(e) => setEventTypeFilter(e.target.value)}
              className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500">Actor ID</label>
            <input
              type="text"
              placeholder="User or agent ID"
              value={actorIdFilter}
              onChange={(e) => setActorIdFilter(e.target.value)}
              className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500">Start Date</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500">End Date</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
        </div>

        {totalCount != null && (
          <div className="text-xs text-gray-500 mb-2">
            {totalCount} total event{totalCount !== 1 ? 's' : ''}
          </div>
        )}

        {/* Event table */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th
                  onClick={() => handleSort('createdAt')}
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-700"
                >
                  Timestamp{sortIndicator('createdAt')}
                </th>
                <th
                  onClick={() => handleSort('eventType')}
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-700"
                >
                  Event Type{sortIndicator('eventType')}
                </th>
                <th
                  onClick={() => handleSort('actorType')}
                  className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase cursor-pointer hover:text-gray-700"
                >
                  Actor{sortIndicator('actorType')}
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  Session
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {sortedEvents.map((event) => (
                <tr key={event.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-xs text-gray-600 font-mono">
                    {new Date(event.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                      {event.eventType}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    <span className="font-medium">{event.actorType}</span>
                    {event.actorId && (
                      <span className="ml-1 text-gray-400 font-mono">{event.actorId.slice(0, 8)}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-400 font-mono">
                    {event.sessionId ? event.sessionId.slice(0, 8) : '-'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setSelectedEvent(event)}
                      className="text-xs text-blue-600 hover:text-blue-700"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
              {sortedEvents.length === 0 && !loading && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-500">
                    No audit events found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Load more */}
        {nextCursor && (
          <div className="mt-4 text-center">
            <button
              onClick={() => fetchEvents(nextCursor)}
              disabled={loading}
              className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {loading ? 'Loading...' : 'Load more'}
            </button>
          </div>
        )}
      </div>

      {/* Detail modal */}
      {selectedEvent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-900">
                Event: {selectedEvent.eventType}
              </h3>
              <button
                onClick={() => setSelectedEvent(null)}
                className="text-gray-400 hover:text-gray-600 text-lg"
              >
                x
              </button>
            </div>
            <div className="px-6 py-4 overflow-y-auto flex-1">
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="font-medium text-gray-500">ID</dt>
                  <dd className="mt-0.5 text-gray-900 font-mono text-xs">{selectedEvent.id}</dd>
                </div>
                <div>
                  <dt className="font-medium text-gray-500">Timestamp</dt>
                  <dd className="mt-0.5 text-gray-900">{new Date(selectedEvent.createdAt).toISOString()}</dd>
                </div>
                <div>
                  <dt className="font-medium text-gray-500">Actor</dt>
                  <dd className="mt-0.5 text-gray-900">
                    {selectedEvent.actorType}{selectedEvent.actorId ? ` (${selectedEvent.actorId})` : ''}
                  </dd>
                </div>
                {selectedEvent.agentId && (
                  <div>
                    <dt className="font-medium text-gray-500">Agent ID</dt>
                    <dd className="mt-0.5 text-gray-900 font-mono text-xs">{selectedEvent.agentId}</dd>
                  </div>
                )}
                {selectedEvent.sessionId && (
                  <div>
                    <dt className="font-medium text-gray-500">Session ID</dt>
                    <dd className="mt-0.5 text-gray-900 font-mono text-xs">{selectedEvent.sessionId}</dd>
                  </div>
                )}
                <div>
                  <dt className="font-medium text-gray-500">Payload</dt>
                  <dd className="mt-1">
                    <pre className="bg-gray-50 rounded-md p-3 text-xs text-gray-800 overflow-x-auto">
                      {JSON.stringify(redactPayload(selectedEvent.payload), null, 2)}
                    </pre>
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
