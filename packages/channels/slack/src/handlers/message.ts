import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { App, SlackEventMiddlewareArgs, AllMiddlewareArgs } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { RedisChannels } from '@honorclaw/core';

export interface MessageHandlerDeps {
  db: Pool;
  redis: Redis;
  webClient: WebClient;
}

interface UserRow {
  id: string;
  workspace_id: string;
}

interface ChannelConfigRow {
  agent_id: string;
  workspace_id: string;
}

/**
 * Register Slack message event handlers.
 *
 * Listens for:
 *   - app_mention: when the bot is @-mentioned in a channel
 *   - message (direct_message): DMs sent to the bot
 *
 * For each inbound message the handler:
 *   1. ACKs immediately (< 3s Slack requirement)
 *   2. Resolves the Slack user to a HonorClaw user (DB lookup by slack_user_id)
 *   3. Maps the channel to an agent (from workspace config)
 *   4. If the user is unmapped, replies with setup instructions and emits an audit event
 *   5. Publishes to agent:{session_id}:input via Redis
 *   6. Subscribes to agent:{session_id}:output and posts the reply in the Slack thread
 */
export function registerMessageHandlers(app: App, deps: MessageHandlerDeps): void {
  // Handler for @mentions in channels
  app.event('app_mention', async (args) => {
    await handleIncomingMessage(args, deps);
  });

  // Handler for direct messages
  app.event('message', async (args) => {
    const event = args.event as unknown as Record<string, unknown>;
    // Only handle direct messages (im channel type) and ignore bot messages
    if (event['channel_type'] !== 'im') return;
    if (event['bot_id'] || event['subtype']) return;

    await handleIncomingMessage(
      args as unknown as SlackEventMiddlewareArgs<'app_mention'> & AllMiddlewareArgs,
      deps,
    );
  });
}

async function handleIncomingMessage(
  args: SlackEventMiddlewareArgs<'app_mention'> & AllMiddlewareArgs,
  deps: MessageHandlerDeps,
): Promise<void> {
  const { event } = args;
  const slackUserId = event.user;
  const channelId = event.channel;
  const threadTs = (event as unknown as Record<string, unknown>)['thread_ts'] as string | undefined ?? event.ts;
  const text = (event as unknown as Record<string, unknown>)['text'] as string ?? '';

  // ── Step 1: Resolve Slack user → HonorClaw user ──────────────────────
  const userResult = await deps.db.query<UserRow>(
    `SELECT u.id, uwm.workspace_id
     FROM users u
     JOIN user_external_identities uei ON uei.user_id = u.id
     JOIN user_workspace_memberships uwm ON uwm.user_id = u.id
     WHERE uei.provider = 'slack' AND uei.external_id = $1
     LIMIT 1`,
    [slackUserId],
  );

  const user = userResult.rows[0];

  if (!user) {
    // Unmapped user — reply with setup instructions
    await deps.webClient.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: [
        "It looks like your Slack account isn't linked to HonorClaw yet.",
        'Please ask your workspace administrator to connect your account, or visit the HonorClaw dashboard to link your Slack identity.',
      ].join(' '),
    });

    // Emit an audit event for unmapped user attempt
    const auditEvent = JSON.stringify({
      eventType: 'auth.login_failed',
      actorType: 'system',
      payload: {
        channel: 'slack',
        slackUserId,
        slackChannelId: channelId,
        reason: 'unmapped_slack_user',
      },
      timestamp: new Date().toISOString(),
    });

    await deps.redis.publish('audit:events', auditEvent);
    return;
  }

  // ── Step 2: Map channel → agent via workspace config ─────────────────
  const configResult = await deps.db.query<ChannelConfigRow>(
    `SELECT agent_id, workspace_id FROM agent_channel_config
     WHERE slack_channel_id = $1 AND workspace_id = $2
     LIMIT 1`,
    [channelId, user.workspace_id],
  );

  const config = configResult.rows[0];

  if (!config) {
    await deps.webClient.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: 'No agent is configured for this channel. Please ask an administrator to set up an agent mapping.',
    });
    return;
  }

  // ── Step 3: Build or resume a session ────────────────────────────────
  // Use a deterministic session key based on channel + thread + agent so the
  // same Slack thread always maps to the same agent session.
  const sessionKey = `slack:${channelId}:${threadTs}:${config.agent_id}`;
  let sessionId = await deps.redis.get(`session:key:${sessionKey}`);

  if (!sessionId) {
    // Create a new session ID and store the mapping
    sessionId = crypto.randomUUID();
    // TTL of 24 hours for the session key mapping
    await deps.redis.set(`session:key:${sessionKey}`, sessionId, 'EX', 86400);

    // Store session metadata for the output subscriber
    await deps.redis.hset(`session:meta:${sessionId}`, {
      slackChannelId: channelId,
      slackThreadTs: threadTs,
      agentId: config.agent_id,
      workspaceId: config.workspace_id,
      userId: user.id,
    });
    await deps.redis.expire(`session:meta:${sessionId}`, 86400);
  }

  // ── Step 4: Publish input to the Control Plane via Redis ─────────────
  const inputMessage = JSON.stringify({
    sessionId,
    content: text,
    senderId: user.id,
    timestamp: new Date().toISOString(),
  });

  await deps.redis.publish(RedisChannels.agentInput(sessionId), inputMessage);

  // ── Step 5: Subscribe to output and post reply ───────────────────────
  // Use a separate Redis connection for subscribing (sub connections are
  // dedicated in Redis). We create a duplicate to avoid blocking the main client.
  const subscriber = deps.redis.duplicate();
  const outputChannel = RedisChannels.agentOutput(sessionId);

  try {
    await subscriber.subscribe(outputChannel);

    const reply = await new Promise<string | null>((resolve) => {
      const timeout = setTimeout(() => {
        resolve(null);
      }, 60_000); // 60s timeout for agent response

      subscriber.on('message', (_ch: string, message: string) => {
        clearTimeout(timeout);
        resolve(message);
      });
    });

    if (reply) {
      const parsed = JSON.parse(reply) as { content: string | unknown };
      const replyText = typeof parsed.content === 'string'
        ? parsed.content
        : JSON.stringify(parsed.content);

      await deps.webClient.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: replyText,
      });
    }
  } finally {
    await subscriber.unsubscribe(outputChannel);
    subscriber.disconnect();
  }
}
