import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import { App, type AppOptions, LogLevel } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import type {
  ChannelAdapter,
  OutboundMessage,
  EscalationContext,
  SecretsProvider,
} from '@honorclaw/core';
import { registerMessageHandlers } from './handlers/message.js';
import { registerApprovalHandlers } from './handlers/approval.js';

export interface SlackAdapterOptions {
  secrets: SecretsProvider;
  db: Pool;
  redis: Redis;
  /** Force HTTP mode even in development (default: socket mode when SLACK_APP_TOKEN is available) */
  httpMode?: boolean;
}

/**
 * Full Slack channel adapter implementing the ChannelAdapter interface.
 *
 * - Socket Mode for development (requires SLACK_APP_TOKEN)
 * - HTTP mode for production
 * - HMAC-SHA256 signing secret verification on every HTTP request
 * - Replay prevention (rejects timestamps > 300s old)
 */
export class SlackAdapter implements ChannelAdapter {
  name = 'slack' as const;

  private app: App | null = null;
  private webClient: WebClient | null = null;
  private readonly secrets: SecretsProvider;
  private readonly db: Pool;
  private readonly redis: Redis;
  private readonly httpMode: boolean;

  constructor(options: SlackAdapterOptions) {
    this.secrets = options.secrets;
    this.db = options.db;
    this.redis = options.redis;
    this.httpMode = options.httpMode ?? false;
  }

  async start(): Promise<void> {
    const botToken = await this.secrets.getSecret('slack/bot-token');
    const signingSecret = await this.secrets.getSecret('slack/signing-secret');

    const appOptions: AppOptions = {
      token: botToken,
      signingSecret,
      logLevel: LogLevel.WARN,
    };

    // Use socket mode when an app-level token is available and httpMode is not forced
    let useSocketMode = false;
    if (!this.httpMode) {
      try {
        const appToken = await this.secrets.getSecret('slack/app-token');
        if (appToken) {
          appOptions.socketMode = true;
          appOptions.appToken = appToken;
          useSocketMode = true;
        }
      } catch {
        // No app token — fall through to HTTP mode
      }
    }

    this.app = new App(appOptions);
    this.webClient = new WebClient(botToken);

    // Register custom request verification middleware for HTTP mode
    if (!useSocketMode) {
      this.app.use(async ({ next, body, context }) => {
        // Bolt handles verification internally for HTTP mode via signingSecret,
        // but we add our own explicit HMAC-SHA256 check for defense-in-depth
        const rawBody = (context as Record<string, unknown>)['rawBody'] as string | undefined;
        const timestamp = (context as Record<string, unknown>)['requestTimestamp'] as string | undefined;
        const signature = (context as Record<string, unknown>)['requestSignature'] as string | undefined;

        if (rawBody && timestamp && signature) {
          this.verifySignature(signingSecret, rawBody, timestamp, signature);
        }

        await next();
      });
    }

    // Register event handlers
    registerMessageHandlers(this.app, {
      db: this.db,
      redis: this.redis,
      webClient: this.webClient,
    });

    registerApprovalHandlers(this.app, {
      redis: this.redis,
      webClient: this.webClient,
    });

    if (useSocketMode) {
      await this.app.start();
    } else {
      // HTTP mode — start on port 3001 (separate from main API)
      await this.app.start(3001);
    }
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      this.webClient = null;
    }
  }

  /**
   * Post a message to a Slack channel.
   */
  async sendOutbound(_workspaceId: string, msg: OutboundMessage): Promise<void> {
    if (!this.webClient) {
      throw new Error('SlackAdapter not started');
    }

    const text = typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');

    await this.webClient.chat.postMessage({
      channel: msg.externalChannelId,
      text,
      thread_ts: msg.threadId ?? undefined,
    });
  }

  /**
   * Post a Block Kit message with Approve / Reject buttons for an escalation.
   */
  async sendEscalation(_workspaceId: string, ctx: EscalationContext): Promise<void> {
    if (!this.webClient) {
      throw new Error('SlackAdapter not started');
    }

    // Determine the channel from the agent config (fallback to a well-known escalation channel)
    const channelResult = await this.db.query<{ slack_channel_id: string }>(
      `SELECT slack_channel_id FROM agent_channel_config
       WHERE agent_id = $1 AND channel_type = 'slack_escalation'
       LIMIT 1`,
      [ctx.agentId],
    );

    const channelId = channelResult.rows[0]?.slack_channel_id;
    if (!channelId) {
      throw new Error(`No Slack escalation channel configured for agent ${ctx.agentId}`);
    }

    const confidenceText = ctx.confidence != null
      ? `Confidence: ${(ctx.confidence * 100).toFixed(0)}%`
      : '';

    await this.webClient.chat.postMessage({
      channel: channelId,
      text: `Escalation: ${ctx.reason}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: 'Tool Approval Required',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `*Reason:* ${ctx.reason}`,
              confidenceText,
              `*Agent:* ${ctx.agentId}`,
              `*Session:* \`${ctx.sessionId}\``,
              '',
              `*Conversation Summary:*`,
              ctx.conversationSummary,
            ].filter(Boolean).join('\n'),
          },
        },
        {
          type: 'actions',
          block_id: `approval_${ctx.sessionId}`,
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Approve' },
              style: 'primary',
              action_id: 'approval_approve',
              value: JSON.stringify({
                sessionId: ctx.sessionId,
                agentId: ctx.agentId,
              }),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reject' },
              style: 'danger',
              action_id: 'approval_reject',
              value: JSON.stringify({
                sessionId: ctx.sessionId,
                agentId: ctx.agentId,
              }),
            },
          ],
        },
      ],
    });
  }

  /**
   * Resolve a Slack user ID to a HonorClaw user ID via the database.
   */
  async resolveUser(_workspaceId: string, externalUserId: string): Promise<string | null> {
    const result = await this.db.query<{ id: string }>(
      `SELECT u.id FROM users u
       JOIN user_external_identities uei ON uei.user_id = u.id
       WHERE uei.provider = 'slack' AND uei.external_id = $1
       LIMIT 1`,
      [externalUserId],
    );

    return result.rows[0]?.id ?? null;
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /**
   * Verify a Slack request signature (HMAC-SHA256).
   * Throws if the signature is invalid or the timestamp is stale (> 300s).
   */
  private verifySignature(
    signingSecret: string,
    rawBody: string,
    timestamp: string,
    signature: string,
  ): void {
    const ts = Number(timestamp);
    const now = Math.floor(Date.now() / 1000);

    // Reject timestamps older than 300 seconds to prevent replay attacks
    if (Math.abs(now - ts) > 300) {
      throw new Error('Slack request timestamp is too old (possible replay attack)');
    }

    const sigBasestring = `v0:${timestamp}:${rawBody}`;
    const hmac = crypto.createHmac('sha256', signingSecret);
    hmac.update(sigBasestring);
    const expectedSignature = `v0=${hmac.digest('hex')}`;

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      throw new Error('Invalid Slack request signature');
    }
  }
}
