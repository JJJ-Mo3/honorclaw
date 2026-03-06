// HonorClaw Tool: Slack as Tool — post, search, read messages
import { createTool, z } from '@honorclaw/tool-sdk';

const InputSchema = z.object({
  tool_name: z.enum([
    'slack_post_message',
    'slack_search_messages',
    'slack_read_thread',
    'slack_read_channel_history',
    'slack_lookup_user',
  ]),
  // Post message
  channel: z.string().optional(),
  text: z.string().optional(),
  thread_ts: z.string().optional(),
  // Search
  query: z.string().optional(),
  max_results: z.number().optional(),
  // Channel history
  oldest: z.string().optional(),
  latest: z.string().optional(),
  // Lookup user
  email: z.string().optional(),
  user_id: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;

interface SlackCreds {
  bot_token: string;
}

function getCredentials(): SlackCreds {
  const raw = process.env.SLACK_TOOL_CREDENTIALS;
  if (!raw) throw new Error('SLACK_TOOL_CREDENTIALS env var is required');
  return JSON.parse(raw) as SlackCreds;
}

async function getClient() {
  const { WebClient } = await import('@slack/web-api');
  const creds = getCredentials();
  return new WebClient(creds.bot_token);
}

// ── Post Message ───────────────────────────────────

async function postMessage(input: Input) {
  const client = await getClient();
  if (!input.channel) throw new Error('channel is required');
  if (!input.text) throw new Error('text is required');

  const res = await client.chat.postMessage({
    channel: input.channel,
    text: input.text,
    thread_ts: input.thread_ts,
  });

  return {
    ok: res.ok,
    channel: res.channel,
    ts: res.ts,
    message: res.message ? {
      text: (res.message as Record<string, unknown>).text,
      ts: (res.message as Record<string, unknown>).ts,
    } : undefined,
  };
}

// ── Search Messages ────────────────────────────────

async function searchMessages(input: Input) {
  const client = await getClient();
  if (!input.query) throw new Error('query is required');

  const res = await client.search.messages({
    query: input.query,
    count: input.max_results ?? 20,
    sort: 'timestamp',
    sort_dir: 'desc',
  });

  const messages = res.messages as Record<string, unknown> | undefined;
  const matches = messages?.matches as Array<Record<string, unknown>> | undefined;

  return {
    total: messages?.total ?? 0,
    messages: (matches ?? []).map((m) => ({
      ts: m.ts,
      text: m.text,
      user: m.user ?? (m.username as string | undefined),
      channel: (m.channel as Record<string, unknown> | undefined)?.name ?? m.channel,
      permalink: m.permalink,
    })),
  };
}

// ── Read Thread ────────────────────────────────────

async function readThread(input: Input) {
  const client = await getClient();
  if (!input.channel) throw new Error('channel is required');
  if (!input.thread_ts) throw new Error('thread_ts is required');

  const res = await client.conversations.replies({
    channel: input.channel,
    ts: input.thread_ts,
    limit: input.max_results ?? 100,
  });

  return {
    messages: (res.messages ?? []).map((m) => ({
      ts: m.ts,
      user: m.user,
      text: m.text,
      thread_ts: m.thread_ts,
      reply_count: (m as Record<string, unknown>).reply_count,
    })),
    has_more: res.has_more,
  };
}

// ── Read Channel History ───────────────────────────

async function readChannelHistory(input: Input) {
  const client = await getClient();
  if (!input.channel) throw new Error('channel is required');

  const res = await client.conversations.history({
    channel: input.channel,
    limit: input.max_results ?? 50,
    oldest: input.oldest,
    latest: input.latest,
  });

  return {
    messages: (res.messages ?? []).map((m) => ({
      ts: m.ts,
      user: m.user,
      text: m.text,
      thread_ts: m.thread_ts,
      reply_count: (m as Record<string, unknown>).reply_count,
      reactions: (m as Record<string, unknown>).reactions,
    })),
    has_more: res.has_more,
  };
}

// ── Lookup User ────────────────────────────────────

async function lookupUser(input: Input) {
  const client = await getClient();

  if (input.email) {
    const res = await client.users.lookupByEmail({ email: input.email });
    const user = res.user as Record<string, unknown> | undefined;
    const profile = user?.profile as Record<string, unknown> | undefined;
    return {
      id: user?.id,
      name: user?.name,
      real_name: user?.real_name ?? profile?.real_name,
      email: profile?.email,
      title: profile?.title,
      status_text: profile?.status_text,
      timezone: user?.tz,
      is_bot: user?.is_bot,
    };
  }

  if (input.user_id) {
    const res = await client.users.info({ user: input.user_id });
    const user = res.user as Record<string, unknown> | undefined;
    const profile = user?.profile as Record<string, unknown> | undefined;
    return {
      id: user?.id,
      name: user?.name,
      real_name: user?.real_name ?? profile?.real_name,
      email: profile?.email,
      title: profile?.title,
      status_text: profile?.status_text,
      timezone: user?.tz,
      is_bot: user?.is_bot,
    };
  }

  throw new Error('email or user_id is required');
}

// ── Dispatch ───────────────────────────────────────

const handlers: Record<string, (input: Input) => Promise<unknown>> = {
  slack_post_message: postMessage,
  slack_search_messages: searchMessages,
  slack_read_thread: readThread,
  slack_read_channel_history: readChannelHistory,
  slack_lookup_user: lookupUser,
};

createTool(InputSchema, async (input) => {
  const handler = handlers[input.tool_name];
  if (!handler) throw new Error(`Unknown tool: ${input.tool_name}`);
  return handler(input);
});
