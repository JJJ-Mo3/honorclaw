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
 * In-memory store entry for outbound messages queued for polling retrieval.
 */
interface QueuedResponse {
  type: 'message' | 'escalation';
  workspaceId: string;
  payload: OutboundMessage | EscalationContext;
  createdAt: Date;
}

export interface ApiAdapterOptions {
  redis: Redis;
  /**
   * Callback invoked when an inbound message arrives via REST.
   * The adapter itself does not own the Fastify instance; instead,
   * the control plane registers the route and calls `handleInbound`.
   */
  onInbound?: (workspaceId: string, msg: InboundMessage) => Promise<{ sessionId: string }>;
}

/**
 * REST API channel adapter.
 *
 * - Inbound messages arrive via POST /api/channels/api/message (handled by
 *   the control plane's Fastify instance, which calls `handleInbound`).
 * - Outbound messages are queued in-memory, keyed by externalChannelId,
 *   so callers can poll GET /api/channels/api/messages/:channelId.
 * - Alternatively, if the inbound request supplies a `callbackUrl`,
 *   outbound messages are POSTed to that URL.
 */
export class ApiAdapter implements ChannelAdapter {
  name = 'api' as const;

  private redis: Redis | null = null;
  private readonly options: ApiAdapterOptions;
  /** Pending outbound messages keyed by externalChannelId. */
  private readonly outboundQueue = new Map<string, QueuedResponse[]>();
  /** Registered callback URLs keyed by externalChannelId. */
  private readonly callbackUrls = new Map<string, string>();

  constructor(options: ApiAdapterOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.redis = this.options.redis;
  }

  async stop(): Promise<void> {
    this.outboundQueue.clear();
    this.callbackUrls.clear();
    this.redis = null;
  }

  /**
   * Handle an inbound REST API message.
   *
   * Call this from the Fastify route handler for POST /api/channels/api/message.
   *
   * @param workspaceId  The workspace from the authenticated request context.
   * @param body         The parsed request body.
   * @returns            The created session ID.
   */
  async handleInbound(
    workspaceId: string,
    body: {
      channelId: string;
      userId: string;
      content: string;
      messageId?: string;
      threadId?: string;
      callbackUrl?: string;
    },
  ): Promise<{ sessionId: string }> {
    // Register callback URL if provided
    if (body.callbackUrl) {
      this.callbackUrls.set(body.channelId, body.callbackUrl);
    }

    const inbound: InboundMessage = {
      externalUserId: body.userId,
      externalChannelId: body.channelId,
      content: body.content,
      externalMessageId: body.messageId ?? crypto.randomUUID(),
      threadId: body.threadId,
      receivedAt: new Date(),
    };

    if (this.options.onInbound) {
      return this.options.onInbound(workspaceId, inbound);
    }

    // Fallback: publish to Redis for the session manager to pick up
    if (this.redis) {
      const sessionId = body.threadId ?? crypto.randomUUID();
      await this.redis.publish(
        RedisChannels.agentInput(sessionId),
        JSON.stringify(inbound),
      );
      return { sessionId };
    }

    throw new Error('ApiAdapter: no inbound handler or Redis connection configured');
  }

  /**
   * Retrieve and drain queued outbound messages for a given channel.
   *
   * Call this from the Fastify route handler for GET /api/channels/api/messages/:channelId.
   */
  drainMessages(channelId: string): QueuedResponse[] {
    const messages = this.outboundQueue.get(channelId) ?? [];
    this.outboundQueue.delete(channelId);
    return messages;
  }

  async sendOutbound(workspaceId: string, msg: OutboundMessage): Promise<void> {
    const callbackUrl = this.callbackUrls.get(msg.externalChannelId);

    if (callbackUrl) {
      await this.deliverViaCallback(callbackUrl, 'message', workspaceId, msg);
      return;
    }

    // Queue for polling
    const entry: QueuedResponse = {
      type: 'message',
      workspaceId,
      payload: msg,
      createdAt: new Date(),
    };

    const queue = this.outboundQueue.get(msg.externalChannelId) ?? [];
    queue.push(entry);
    this.outboundQueue.set(msg.externalChannelId, queue);
  }

  async sendEscalation(workspaceId: string, ctx: EscalationContext): Promise<void> {
    // Try to find a channel ID from the session — use agentId as a fallback channel key
    const channelKey = ctx.agentId;
    const callbackUrl = this.callbackUrls.get(channelKey);

    if (callbackUrl) {
      await this.deliverViaCallback(callbackUrl, 'escalation', workspaceId, ctx);
      return;
    }

    // Queue for polling under the agent ID key
    const entry: QueuedResponse = {
      type: 'escalation',
      workspaceId,
      payload: ctx,
      createdAt: new Date(),
    };

    const queue = this.outboundQueue.get(channelKey) ?? [];
    queue.push(entry);
    this.outboundQueue.set(channelKey, queue);
  }

  async resolveUser(_workspaceId: string, _externalUserId: string): Promise<string | null> {
    // API channel users are identified by their API key / auth token.
    // User resolution is handled by the control plane's auth middleware.
    return null;
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private async deliverViaCallback(
    callbackUrl: string,
    type: 'message' | 'escalation',
    workspaceId: string,
    payload: OutboundMessage | EscalationContext,
  ): Promise<void> {
    try {
      const response = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, workspaceId, payload }),
      });

      if (!response.ok) {
        console.error(
          `[ApiAdapter] Callback delivery failed: HTTP ${response.status} for ${callbackUrl}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ApiAdapter] Callback delivery error: ${message}`);
    }
  }
}
