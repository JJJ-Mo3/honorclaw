import crypto from 'node:crypto';
import type {
  ChannelAdapter,
  OutboundMessage,
  EscalationContext,
  SecretsProvider,
} from '@honorclaw/core';

/** Webhook request payload. */
export interface WebhookPayload {
  message: string;
  metadata?: Record<string, unknown>;
  callbackUrl?: string;
  outputChannel?: 'callback' | 'slack' | 'email' | 'db';
}

/** Webhook response for async mode (202). */
export interface WebhookAcceptedResponse {
  runId: string;
  status: 'accepted';
}

/** Webhook response for sync mode. */
export interface WebhookSyncResponse {
  runId: string;
  status: 'completed';
  output: string;
}

export interface WebhookAdapterOptions {
  secrets: SecretsProvider;
  /** Callback to process the webhook message. Returns the agent output. */
  onMessage: (msg: {
    agentId: string;
    content: string;
    metadata?: Record<string, unknown>;
    sync: boolean;
  }) => Promise<{ runId: string; output?: string }>;
  /** Callback to deliver output via the specified channel. */
  onDeliverOutput?: (delivery: {
    runId: string;
    output: string;
    channel: 'callback' | 'slack' | 'email' | 'db';
    callbackUrl?: string;
  }) => Promise<void>;
}

/**
 * Inbound webhook channel adapter.
 *
 * - REST endpoint: POST /webhooks/{agent-id}
 * - HMAC-SHA256 signature verification
 * - Async (202 + run-id) and sync (?sync=true) modes
 * - Output delivery: callback URL, Slack, email, or DB store
 */
export class WebhookAdapter implements ChannelAdapter {
  name = 'webhook' as const;

  private signingSecret: string | null = null;
  private readonly secrets: SecretsProvider;
  private readonly onMessage: WebhookAdapterOptions['onMessage'];
  private readonly onDeliverOutput: WebhookAdapterOptions['onDeliverOutput'];

  constructor(options: WebhookAdapterOptions) {
    this.secrets = options.secrets;
    this.onMessage = options.onMessage;
    this.onDeliverOutput = options.onDeliverOutput;
  }

  async start(): Promise<void> {
    this.signingSecret = await this.secrets.getSecret('webhook/signing-secret');
  }

  async stop(): Promise<void> {
    this.signingSecret = null;
  }

  /**
   * Handle an inbound webhook request.
   *
   * Call this from your HTTP server route: POST /webhooks/:agentId
   *
   * @param agentId  The agent ID from the URL path.
   * @param rawBody  The raw request body as a string (for signature verification).
   * @param signature  The HMAC-SHA256 signature from the X-Honorclaw-Signature header.
   * @param timestamp  The timestamp from the X-Honorclaw-Timestamp header.
   * @param payload  The parsed request body.
   * @param sync  Whether to return the result synchronously (?sync=true).
   */
  async handleWebhook(
    agentId: string,
    rawBody: string,
    signature: string,
    timestamp: string,
    payload: WebhookPayload,
    sync: boolean,
  ): Promise<WebhookAcceptedResponse | WebhookSyncResponse> {
    // Verify signature
    this.verifySignature(rawBody, signature, timestamp);

    if (sync) {
      // Synchronous mode: process and return result
      const result = await this.onMessage({
        agentId,
        content: payload.message,
        metadata: payload.metadata,
        sync: true,
      });

      return {
        runId: result.runId,
        status: 'completed',
        output: result.output ?? '',
      };
    }

    // Async mode: accept and process in background
    const result = await this.onMessage({
      agentId,
      content: payload.message,
      metadata: payload.metadata,
      sync: false,
    });

    // Schedule output delivery if a callback or output channel is specified
    if (payload.outputChannel || payload.callbackUrl) {
      const outputChannel = payload.outputChannel ?? 'callback';
      // Fire-and-forget delivery — the caller gets the 202 immediately
      void this.deliverOutputWhenReady(result.runId, outputChannel, payload.callbackUrl);
    }

    return {
      runId: result.runId,
      status: 'accepted',
    };
  }

  async sendOutbound(_workspaceId: string, msg: OutboundMessage): Promise<void> {
    // Webhook adapter does not send outbound messages directly;
    // output is delivered via the configured output channel (callback, Slack, email, or DB).
    const text = typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');

    if (this.onDeliverOutput) {
      await this.onDeliverOutput({
        runId: msg.externalMessageId ?? 'unknown',
        output: text,
        channel: 'db',
      });
    }
  }

  async sendEscalation(_workspaceId: string, _ctx: EscalationContext): Promise<void> {
    // Webhook escalations are stored in the database for later retrieval.
    // In a full implementation, this would also trigger a notification.
  }

  async resolveUser(_workspaceId: string, _externalUserId: string): Promise<string | null> {
    // Webhook users are identified by their API key, not an external user ID.
    return null;
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  /**
   * Verify HMAC-SHA256 signature on an inbound webhook request.
   * Rejects timestamps older than 300 seconds to prevent replay attacks.
   */
  private verifySignature(rawBody: string, signature: string, timestamp: string): void {
    if (!this.signingSecret) {
      throw new Error('WebhookAdapter not started');
    }

    const ts = Number(timestamp);
    const now = Math.floor(Date.now() / 1000);

    if (Number.isNaN(ts) || Math.abs(now - ts) > 300) {
      throw new Error('Webhook timestamp is invalid or too old (possible replay attack)');
    }

    const sigBasestring = `v1:${timestamp}:${rawBody}`;
    const hmac = crypto.createHmac('sha256', this.signingSecret);
    hmac.update(sigBasestring);
    const expectedSignature = `v1=${hmac.digest('hex')}`;

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      throw new Error('Invalid webhook signature');
    }
  }

  /**
   * Deliver output when the async run completes.
   * In a full implementation, this would poll or subscribe to run completion events.
   */
  private async deliverOutputWhenReady(
    runId: string,
    channel: 'callback' | 'slack' | 'email' | 'db',
    callbackUrl?: string,
  ): Promise<void> {
    if (!this.onDeliverOutput) return;

    // This is a placeholder. In production, a completion event from the
    // session manager would trigger delivery. For now, we just log.
    console.log(`[WebhookAdapter] Output delivery queued for run ${runId} via ${channel}`);
  }
}
