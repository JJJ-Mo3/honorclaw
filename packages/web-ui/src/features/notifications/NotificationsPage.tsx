import { useState, useEffect, useCallback } from 'react';
import { api } from '../../api/client.js';

interface Notification {
  id: string;
  trigger: string;
  workspace_id: string;
  user_id: string | null;
  agent_id: string;
  session_id: string;
  title: string;
  body: string;
  severity: string;
  read: boolean;
  created_at: string;
}

export function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const [error, setError] = useState('');

  const loadNotifications = useCallback(async () => {
    try {
      setError('');
      const params: Record<string, string> = { limit: '100' };
      if (showUnreadOnly) params['unreadOnly'] = 'true';
      const data = await api.get<{ notifications: Notification[]; unreadCount: number }>('/notifications', params);
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notifications');
    } finally {
      setLoading(false);
    }
  }, [showUnreadOnly]);

  useEffect(() => {
    void loadNotifications();
    const interval = setInterval(() => { void loadNotifications(); }, 10000);
    return () => clearInterval(interval);
  }, [loadNotifications]);

  const markAsRead = async (id: string) => {
    try {
      await api.post(`/notifications/${id}/read`);
      void loadNotifications();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark as read');
    }
  };

  const severityColor = (severity: string) => {
    switch (severity) {
      case 'critical': return 'bg-red-100 text-red-700 border-red-200';
      case 'warning': return 'bg-yellow-100 text-yellow-700 border-yellow-200';
      case 'info': return 'bg-blue-100 text-blue-700 border-blue-200';
      default: return 'bg-gray-100 text-gray-600 border-gray-200';
    }
  };

  if (loading) return <div className="min-h-screen bg-gray-50 p-6"><p className="text-sm text-gray-500">Loading notifications...</p></div>;

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          {unreadCount > 0 && (
            <p className="text-sm text-gray-500 mt-1">{unreadCount} unread</p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input
            type="checkbox"
            checked={showUnreadOnly}
            onChange={(e) => setShowUnreadOnly(e.target.checked)}
            className="rounded border-gray-300"
          />
          Show unread only
        </label>
      </div>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      {notifications.length === 0 ? (
        <p className="text-gray-500">No notifications.</p>
      ) : (
        <div className="space-y-3">
          {notifications.map((n) => (
            <div
              key={n.id}
              className={`bg-white rounded-lg shadow-sm border p-4 ${n.read ? 'opacity-60' : ''} ${severityColor(n.severity)}`}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${severityColor(n.severity)}`}>
                      {n.severity}
                    </span>
                    <span className="text-xs text-gray-400">{n.trigger}</span>
                  </div>
                  <h3 className={`font-semibold mt-1 ${n.read ? 'text-gray-500' : 'text-gray-900'}`}>{n.title}</h3>
                  <p className="text-sm text-gray-600 mt-1">{n.body}</p>
                  <p className="text-xs text-gray-400 mt-2">
                    {new Date(n.created_at).toLocaleString()}
                    {n.agent_id && <> | Agent: <span className="font-mono">{n.agent_id.slice(0, 8)}</span></>}
                  </p>
                </div>
                {!n.read && (
                  <button
                    onClick={() => { void markAsRead(n.id); }}
                    className="ml-4 text-xs text-blue-600 hover:text-blue-800 shrink-0"
                  >
                    Mark read
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
