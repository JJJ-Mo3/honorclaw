import { useState, useEffect, useRef, useCallback, type FormEvent } from 'react';
import { useAuth } from '../../auth/useAuth.js';
import { api } from '../../api/client.js';

// ── Types ───────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'error';
}

type MessageType = 'user' | 'agent_response' | 'tool_call_pending' | 'tool_result';

interface ChatMessage {
  id: string;
  type: MessageType;
  content: string;
  timestamp: string;
  toolCallId?: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  toolStatus?: 'pending_approval' | 'approved' | 'rejected' | 'success' | 'error';
  toolResult?: unknown;
}

interface WsInboundMessage {
  type: MessageType;
  id: string;
  content?: string;
  timestamp: string;
  toolCallId?: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  toolStatus?: string;
  toolResult?: unknown;
}

// ── Component ───────────────────────────────────────────────────────────

export function ChatPage() {
  const { user, workspaceId } = useAuth();

  // ── State ───────────────────────────────────────────────────────────
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ── Load agents ─────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const data = await api.get<{ agents: Agent[] }>('/agents');
        setAgents(data.agents);
        if (data.agents.length > 0 && !selectedAgentId) {
          setSelectedAgentId(data.agents[0]!.id);
        }
      } catch {
        // Will be handled by global error handling
      }
    }
    void load();
  }, [selectedAgentId]);

  // ── WebSocket connection ────────────────────────────────────────────
  const connectWs = useCallback(() => {
    if (!selectedAgentId || !workspaceId) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws/chat?agentId=${selectedAgentId}&workspaceId=${workspaceId}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string) as WsInboundMessage;

        if ((data as unknown as { sessionId?: string }).sessionId && !sessionId) {
          setSessionId((data as unknown as { sessionId: string }).sessionId);
        }

        const msg: ChatMessage = {
          id: data.id,
          type: data.type,
          content: data.content ?? '',
          timestamp: data.timestamp,
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          toolParams: data.toolParams,
          toolStatus: data.toolStatus as ChatMessage['toolStatus'],
          toolResult: data.toolResult,
        };

        setMessages((prev) => [...prev, msg]);
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      // Auto-reconnect after 3 seconds
      reconnectTimerRef.current = setTimeout(() => {
        connectWs();
      }, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };

    return () => {
      ws.close();
    };
  }, [selectedAgentId, workspaceId, sessionId]);

  useEffect(() => {
    const cleanup = connectWs();
    return () => {
      cleanup?.();
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, [connectWs]);

  // ── Auto-scroll ─────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Send message ────────────────────────────────────────────────────
  function handleSend(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      type: 'user',
      content: input.trim(),
      timestamp: new Date().toISOString(),
    };

    wsRef.current.send(JSON.stringify({
      type: 'user_message',
      content: msg.content,
      id: msg.id,
    }));

    setMessages((prev) => [...prev, msg]);
    setInput('');
  }

  // ── Tool approval ───────────────────────────────────────────────────
  function handleApproval(toolCallId: string, decision: 'approve' | 'reject') {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    wsRef.current.send(JSON.stringify({
      type: 'tool_approval',
      toolCallId,
      decision,
    }));

    setMessages((prev) =>
      prev.map((m) =>
        m.toolCallId === toolCallId
          ? { ...m, toolStatus: decision === 'approve' ? 'approved' : 'rejected' }
          : m,
      ),
    );
  }

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-gray-900">HonorClaw Chat</h1>

          {/* Agent selector */}
          <select
            value={selectedAgentId ?? ''}
            onChange={(e) => {
              setSelectedAgentId(e.target.value || null);
              setMessages([]);
              setSessionId(null);
            }}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="" disabled>Select agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        {/* Connection indicator */}
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <div
            className={`h-2 w-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`}
          />
          {connected ? 'Connected' : 'Disconnected'}
          {user && <span className="ml-2 text-gray-400">({user.displayName})</span>}
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.map((msg) => (
          <div key={msg.id}>
            {msg.type === 'user' && (
              <div className="flex justify-end">
                <div className="max-w-[70%] rounded-lg bg-blue-600 px-4 py-2 text-white text-sm">
                  {msg.content}
                </div>
              </div>
            )}

            {msg.type === 'agent_response' && (
              <div className="flex justify-start">
                <div className="max-w-[70%] rounded-lg bg-white border border-gray-200 px-4 py-2 text-sm text-gray-900 shadow-sm">
                  {msg.content}
                </div>
              </div>
            )}

            {msg.type === 'tool_call_pending' && (
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm shadow-sm">
                  <div className="font-medium text-amber-800">
                    Tool Call: {msg.toolName}
                  </div>
                  {msg.toolParams && (
                    <pre className="mt-2 overflow-x-auto rounded bg-amber-100 p-2 text-xs text-amber-900">
                      {JSON.stringify(msg.toolParams, null, 2)}
                    </pre>
                  )}
                  {msg.toolStatus === 'pending_approval' && (
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => msg.toolCallId && handleApproval(msg.toolCallId, 'approve')}
                        className="rounded-md bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => msg.toolCallId && handleApproval(msg.toolCallId, 'reject')}
                        className="rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
                      >
                        Reject
                      </button>
                    </div>
                  )}
                  {msg.toolStatus === 'approved' && (
                    <div className="mt-2 text-xs text-green-700 font-medium">Approved</div>
                  )}
                  {msg.toolStatus === 'rejected' && (
                    <div className="mt-2 text-xs text-red-700 font-medium">Rejected</div>
                  )}
                </div>
              </div>
            )}

            {msg.type === 'tool_result' && (
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-lg border border-gray-200 bg-gray-50 px-4 py-2 text-sm shadow-sm">
                  <div className="text-xs font-medium text-gray-500">Tool Result</div>
                  <pre className="mt-1 overflow-x-auto text-xs text-gray-700">
                    {typeof msg.toolResult === 'string'
                      ? msg.toolResult
                      : JSON.stringify(msg.toolResult, null, 2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="border-t border-gray-200 bg-white px-4 py-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={connected ? 'Type a message...' : 'Reconnecting...'}
            disabled={!connected}
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!connected || !input.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
