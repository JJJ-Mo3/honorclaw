import type { Redis } from 'ioredis';
import type { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';

export interface ApprovalHandlerDeps {
  redis: Redis;
  webClient: WebClient;
}

interface ApprovalPayload {
  sessionId: string;
  agentId: string;
}

/**
 * Register Slack interactive action handlers for tool-call approval.
 *
 * Escalation messages are sent as Block Kit messages with two buttons:
 *   - approval_approve  →  publishes an "approved" decision via Redis
 *   - approval_reject   →  publishes a "rejected" decision via Redis
 *
 * The Control Plane's tool-approval gate subscribes to these Redis channels
 * and resumes (or aborts) the pending tool call accordingly.
 */
export function registerApprovalHandlers(app: App, deps: ApprovalHandlerDeps): void {
  // ── Approve button ────────────────────────────────────────────────────
  app.action('approval_approve', async ({ ack, action, body }) => {
    await ack();

    const value = (action as { value?: string }).value;
    if (!value) return;

    const payload: ApprovalPayload = JSON.parse(value);
    const userId = body.user.id;

    // Publish approval decision to Redis
    const decision = JSON.stringify({
      sessionId: payload.sessionId,
      agentId: payload.agentId,
      decision: 'approved',
      approvedBy: userId,
      decidedAt: new Date().toISOString(),
    });

    await deps.redis.publish(
      `approval:${payload.sessionId}:decision`,
      decision,
    );

    // Update the original message to reflect the decision
    const messageTs = (body as unknown as Record<string, unknown>)['message_ts'] as string | undefined
      ?? ((body as unknown as Record<string, unknown>)['message'] as Record<string, unknown> | undefined)?.['ts'] as string | undefined;
    const channelId = (body as { channel?: { id?: string } }).channel?.id;

    if (channelId && messageTs) {
      await deps.webClient.chat.update({
        channel: channelId,
        ts: messageTs,
        text: `Approved by <@${userId}>`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:white_check_mark: *Approved* by <@${userId}> at ${new Date().toISOString()}`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Session: \`${payload.sessionId}\` | Agent: \`${payload.agentId}\``,
              },
            ],
          },
        ],
      });
    }
  });

  // ── Reject button ─────────────────────────────────────────────────────
  app.action('approval_reject', async ({ ack, action, body }) => {
    await ack();

    const value = (action as { value?: string }).value;
    if (!value) return;

    const payload: ApprovalPayload = JSON.parse(value);
    const userId = body.user.id;

    // Publish rejection decision to Redis
    const decision = JSON.stringify({
      sessionId: payload.sessionId,
      agentId: payload.agentId,
      decision: 'rejected',
      rejectedBy: userId,
      decidedAt: new Date().toISOString(),
    });

    await deps.redis.publish(
      `approval:${payload.sessionId}:decision`,
      decision,
    );

    // Update the original message to reflect the decision
    const messageTs = (body as unknown as Record<string, unknown>)['message_ts'] as string | undefined
      ?? ((body as unknown as Record<string, unknown>)['message'] as Record<string, unknown> | undefined)?.['ts'] as string | undefined;
    const channelId = (body as { channel?: { id?: string } }).channel?.id;

    if (channelId && messageTs) {
      await deps.webClient.chat.update({
        channel: channelId,
        ts: messageTs,
        text: `Rejected by <@${userId}>`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:x: *Rejected* by <@${userId}> at ${new Date().toISOString()}`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Session: \`${payload.sessionId}\` | Agent: \`${payload.agentId}\``,
              },
            ],
          },
        ],
      });
    }
  });
}
