import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  EscalationContext,
} from '@honorclaw/core';
import { RedisChannels } from '@honorclaw/core';

/**
 * Represents a connected web chat client using long-polling.
 *
 * A production implementation would use WebSockets (e.g. the `ws` package),
 * but this adapter uses a simple polling-based approach so it works without
 * additional dependencies beyond what the package already declares.
 */
interface WebClient {
  channelId: string;
  userId: string;
  workspaceId: string;
  lastActivity: Date;
  /** Queued messages waiting to be delivered on the next poll. */
  pendingMessages: Array<{
    type: 'message' | 'escalation';
    payload: unknown;
    createdAt: Date;
  }>;
}

export interface WebAdapterOptions {
  redis: Redis;
  /** Optional callback for inbound messages. */
  onInbound?: (workspaceId: string, msg: InboundMessage) => Promise<{ sessionId: string }>;
  /** Time in ms after which idle clients are cleaned up (default: 5 minutes). */
  clientTimeout?: number;
}

/**
 * Web chat channel adapter using a polling-based approach.
 *
 * Flow:
 *   1. Client registers via `registerClient()` (called from a REST endpoint).
 *   2. Client sends messages via `handleInbound()`.
 *   3. Client polls for responses via `pollMessages()`.
 *   4. Agent responses are queued via `sendOutbound()` / `sendEscalation()`.
 *
 * The control plane wires these methods to HTTP/WebSocket endpoints.
 */
export class WebAdapter implements ChannelAdapter {
  name = 'web' as const;

  private redis: Redis | null = null;
  private readonly options: WebAdapterOptions;
  /** Connected clients keyed by channelId. */
  private readonly clients = new Map<string, WebClient>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: WebAdapterOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.redis = this.options.redis;

    // Start a periodic cleanup of stale clients
    const timeout = this.options.clientTimeout ?? 5 * 60 * 1000;
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleClients(timeout);
    }, 60_000);
    this.cleanupTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clients.clear();
    this.redis = null;
  }

  /**
   * Register a new web chat client connection.
   *
   * Call from the REST endpoint: POST /api/channels/web/connect
   *
   * @returns A channelId the client should use for subsequent requests.
   */
  registerClient(workspaceId: string, userId: string): { channelId: string } {
    const channelId = crypto.randomUUID();
    const client: WebClient = {
      channelId,
      userId,
      workspaceId,
      lastActivity: new Date(),
      pendingMessages: [],
    };
    this.clients.set(channelId, client);
    return { channelId };
  }

  /**
   * Remove a client connection.
   *
   * Call from: POST /api/channels/web/disconnect
   */
  disconnectClient(channelId: string): void {
    this.clients.delete(channelId);
  }

  /**
   * Handle an inbound message from a web chat client.
   *
   * Call from: POST /api/channels/web/message
   */
  async handleInbound(
    channelId: string,
    body: {
      content: string;
      messageId?: string;
      threadId?: string;
    },
  ): Promise<{ sessionId: string }> {
    const client = this.clients.get(channelId);
    if (!client) {
      throw new Error('Unknown channel — client must call /connect first');
    }

    client.lastActivity = new Date();

    const inbound: InboundMessage = {
      externalUserId: client.userId,
      externalChannelId: channelId,
      content: body.content,
      externalMessageId: body.messageId ?? crypto.randomUUID(),
      threadId: body.threadId,
      receivedAt: new Date(),
    };

    if (this.options.onInbound) {
      return this.options.onInbound(client.workspaceId, inbound);
    }

    // Fallback: publish to Redis
    if (this.redis) {
      const sessionId = body.threadId ?? crypto.randomUUID();
      await this.redis.publish(
        RedisChannels.agentInput(sessionId),
        JSON.stringify(inbound),
      );
      return { sessionId };
    }

    throw new Error('WebAdapter: no inbound handler or Redis connection configured');
  }

  /**
   * Poll for pending messages on a channel.
   *
   * Call from: GET /api/channels/web/messages/:channelId
   *
   * Returns and drains all pending messages for the given channel.
   */
  pollMessages(channelId: string): Array<{ type: string; payload: unknown; createdAt: Date }> {
    const client = this.clients.get(channelId);
    if (!client) {
      return [];
    }

    client.lastActivity = new Date();
    const messages = [...client.pendingMessages];
    client.pendingMessages = [];
    return messages;
  }

  async sendOutbound(_workspaceId: string, msg: OutboundMessage): Promise<void> {
    const client = this.clients.get(msg.externalChannelId);
    if (!client) {
      // Client disconnected; silently drop the message.
      console.warn(
        `[WebAdapter] No connected client for channel ${msg.externalChannelId}, dropping message`,
      );
      return;
    }

    const text = typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');

    client.pendingMessages.push({
      type: 'message',
      payload: {
        messageId: msg.externalMessageId ?? crypto.randomUUID(),
        threadId: msg.threadId,
        content: text,
      },
      createdAt: new Date(),
    });
  }

  async sendEscalation(_workspaceId: string, ctx: EscalationContext): Promise<void> {
    // Attempt to find a connected client for this agent's sessions.
    // In practice, the session manager would track the channelId for the session.
    // For now, broadcast to all clients in the same workspace (best-effort).
    for (const client of this.clients.values()) {
      client.pendingMessages.push({
        type: 'escalation',
        payload: {
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          reason: ctx.reason,
          confidence: ctx.confidence,
          conversationSummary: ctx.conversationSummary,
          approvalRequired: ctx.approvalRequired,
        },
        createdAt: new Date(),
      });
    }
  }

  async resolveUser(_workspaceId: string, _externalUserId: string): Promise<string | null> {
    // Web chat users are authenticated via the control plane's auth middleware.
    return null;
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private cleanupStaleClients(timeoutMs: number): void {
    const now = Date.now();
    for (const [channelId, client] of this.clients) {
      if (now - client.lastActivity.getTime() > timeoutMs) {
        this.clients.delete(channelId);
      }
    }
  }
}
