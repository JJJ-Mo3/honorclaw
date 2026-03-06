import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

// ── Types ───────────────────────────────────────────────────────────────

export type NotificationTrigger =
  | 'scheduled_run_complete'
  | 'approval_request'
  | 'budget_alert'
  | 'long_running_tool'
  | 'session_error'
  | 'custom';

export type NotificationChannel = 'in_app' | 'slack' | 'teams' | 'email';

export interface NotificationPayload {
  trigger: NotificationTrigger;
  workspaceId: string;
  userId?: string;
  agentId?: string;
  sessionId?: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'critical';
  channels: NotificationChannel[];
  metadata?: Record<string, unknown>;
}

export interface StoredNotification {
  id: string;
  trigger: NotificationTrigger;
  workspaceId: string;
  userId: string | null;
  agentId: string | null;
  sessionId: string | null;
  title: string;
  body: string;
  severity: string;
  read: boolean;
  createdAt: Date;
}

export interface NotificationDispatcherOptions {
  redis: Redis;
  db: Pool;
  /** Optional Slack webhook URL for Slack channel delivery. */
  slackWebhookUrl?: string;
  /** Optional Teams webhook URL for Teams channel delivery. */
  teamsWebhookUrl?: string;
  /** Optional email transport send function. */
  sendEmail?: (to: string, subject: string, body: string) => Promise<void>;
}

/**
 * Multi-channel notification dispatcher.
 *
 * Triggers: scheduled run complete, approval request, budget alert, long-running tool
 * Channels: in-app (WebSocket push via Redis pub/sub), Slack, Teams, email
 */
export class NotificationDispatcher {
  private readonly redis: Redis;
  private readonly db: Pool;
  private readonly slackWebhookUrl?: string;
  private readonly teamsWebhookUrl?: string;
  private readonly sendEmail?: (to: string, subject: string, body: string) => Promise<void>;

  constructor(options: NotificationDispatcherOptions) {
    this.redis = options.redis;
    this.db = options.db;
    this.slackWebhookUrl = options.slackWebhookUrl;
    this.teamsWebhookUrl = options.teamsWebhookUrl;
    this.sendEmail = options.sendEmail;
  }

  /**
   * Dispatch a notification to all configured channels.
   */
  async dispatch(payload: NotificationPayload): Promise<string> {
    const notificationId = crypto.randomUUID();

    // Store the notification in the database
    await this.db.query(
      `INSERT INTO notifications (id, trigger, workspace_id, user_id, agent_id, session_id, title, body, severity, read, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, NOW())`,
      [
        notificationId,
        payload.trigger,
        payload.workspaceId,
        payload.userId ?? null,
        payload.agentId ?? null,
        payload.sessionId ?? null,
        payload.title,
        payload.body,
        payload.severity,
      ],
    );

    // Deliver to each channel in parallel
    const deliveries = payload.channels.map(async (channel) => {
      try {
        switch (channel) {
          case 'in_app':
            await this.deliverInApp(notificationId, payload);
            break;
          case 'slack':
            await this.deliverSlack(payload);
            break;
          case 'teams':
            await this.deliverTeams(payload);
            break;
          case 'email':
            await this.deliverEmail(payload);
            break;
        }
      } catch (err) {
        console.error(
          `[NotificationDispatcher] Failed to deliver via ${channel}:`,
          err,
        );
      }
    });

    await Promise.allSettled(deliveries);
    return notificationId;
  }

  // ── Channel Delivery Methods ──────────────────────────────────────────

  /**
   * In-app delivery via WebSocket push (Redis pub/sub).
   */
  private async deliverInApp(
    notificationId: string,
    payload: NotificationPayload,
  ): Promise<void> {
    const wsChannel = payload.userId
      ? `honorclaw:ws:user:${payload.userId}`
      : `honorclaw:ws:workspace:${payload.workspaceId}`;

    await this.redis.publish(
      wsChannel,
      JSON.stringify({
        type: 'notification',
        id: notificationId,
        trigger: payload.trigger,
        title: payload.title,
        body: payload.body,
        severity: payload.severity,
        agentId: payload.agentId,
        sessionId: payload.sessionId,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  /**
   * Slack delivery via incoming webhook.
   */
  private async deliverSlack(payload: NotificationPayload): Promise<void> {
    if (!this.slackWebhookUrl) {
      console.warn('[NotificationDispatcher] Slack webhook URL not configured — skipping Slack delivery.');
      return;
    }

    const severityEmoji: Record<string, string> = {
      info: ':information_source:',
      warning: ':warning:',
      critical: ':rotating_light:',
    };

    const slackPayload = {
      text: `${severityEmoji[payload.severity] ?? ''} *${payload.title}*`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: [
              `*${payload.title}*`,
              payload.body,
              payload.agentId ? `_Agent: ${payload.agentId}_` : '',
              payload.sessionId ? `_Session: \`${payload.sessionId}\`_` : '',
            ].filter(Boolean).join('\n'),
          },
        },
      ],
    };

    await fetch(this.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackPayload),
    });
  }

  /**
   * Microsoft Teams delivery via incoming webhook.
   */
  private async deliverTeams(payload: NotificationPayload): Promise<void> {
    if (!this.teamsWebhookUrl) {
      console.warn('[NotificationDispatcher] Teams webhook URL not configured — skipping Teams delivery.');
      return;
    }

    const teamsPayload = {
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      summary: payload.title,
      themeColor: payload.severity === 'critical' ? 'FF0000' : payload.severity === 'warning' ? 'FF9900' : '0076D7',
      title: payload.title,
      sections: [
        {
          text: payload.body,
          facts: [
            ...(payload.agentId ? [{ name: 'Agent', value: payload.agentId }] : []),
            ...(payload.sessionId ? [{ name: 'Session', value: payload.sessionId }] : []),
            { name: 'Severity', value: payload.severity },
          ],
        },
      ],
    };

    await fetch(this.teamsWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(teamsPayload),
    });
  }

  /**
   * Email delivery via configured email transport.
   */
  private async deliverEmail(payload: NotificationPayload): Promise<void> {
    if (!this.sendEmail) {
      console.warn('[NotificationDispatcher] Email transport not configured — skipping email delivery.');
      return;
    }

    // Look up the user's email address
    let toAddress = '';
    if (payload.userId) {
      const result = await this.db.query<{ email: string }>(
        `SELECT email FROM users WHERE id = $1`,
        [payload.userId],
      );
      toAddress = result.rows[0]?.email ?? '';
    }

    if (!toAddress) {
      // Fall back to workspace admin email
      const result = await this.db.query<{ email: string }>(
        `SELECT u.email FROM users u
         JOIN workspace_members wm ON wm.user_id = u.id
         WHERE wm.workspace_id = $1 AND wm.role = 'workspace_admin'
         LIMIT 1`,
        [payload.workspaceId],
      );
      toAddress = result.rows[0]?.email ?? '';
    }

    if (!toAddress) {
      console.warn('[NotificationDispatcher] No recipient email found — skipping email delivery.');
      return;
    }

    const subject = `[HonorClaw] [${payload.severity.toUpperCase()}] ${payload.title}`;
    await this.sendEmail(toAddress, subject, payload.body);
  }
}
