import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from 'discord.js';
import type {
  ChannelAdapter,
  OutboundMessage,
  EscalationContext,
  SecretsProvider,
} from '@honorclaw/core';

/** Maximum message length allowed by Discord. */
const DISCORD_MAX_LENGTH = 2000;

export interface DiscordAdapterOptions {
  secrets: SecretsProvider;
  /** Callback invoked when a user sends the /agent slash command or DMs the bot. */
  onMessage: (msg: {
    externalUserId: string;
    externalChannelId: string;
    content: string;
    threadId?: string;
  }) => Promise<string | void>;
}

/**
 * Discord channel adapter.
 *
 * - discord.js v14, Bot token auth
 * - Slash command /agent <message>
 * - Typing indicator during processing
 * - Message splitting for >2000 chars
 */
export class DiscordAdapter implements ChannelAdapter {
  name = 'discord' as const;

  private client: Client | null = null;
  private readonly secrets: SecretsProvider;
  private readonly onMessage: DiscordAdapterOptions['onMessage'];

  constructor(options: DiscordAdapterOptions) {
    this.secrets = options.secrets;
    this.onMessage = options.onMessage;
  }

  async start(): Promise<void> {
    const botToken = await this.secrets.getSecret('discord/bot-token');
    const applicationId = await this.secrets.getSecret('discord/application-id');

    // Register the /agent slash command globally
    await this.registerSlashCommands(botToken, applicationId);

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on('ready', () => {
      console.log(`[DiscordAdapter] Logged in as ${this.client?.user?.tag}`);
    });

    // Handle slash commands
    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== 'agent') return;

      await this.handleSlashCommand(interaction as ChatInputCommandInteraction);
    });

    // Handle direct messages
    this.client.on('messageCreate', async (message: Message) => {
      if (message.author.bot) return;
      if (message.guild) return; // Only handle DMs; guild messages use /agent

      await this.handleDirectMessage(message);
    });

    await this.client.login(botToken);
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
  }

  async sendOutbound(_workspaceId: string, msg: OutboundMessage): Promise<void> {
    if (!this.client) {
      throw new Error('DiscordAdapter not started');
    }

    const text = typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');

    const channel = await this.client.channels.fetch(msg.externalChannelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`Cannot send to channel ${msg.externalChannelId}`);
    }

    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      await (channel as any).send(chunk);
    }
  }

  async sendEscalation(_workspaceId: string, ctx: EscalationContext): Promise<void> {
    if (!this.client) {
      throw new Error('DiscordAdapter not started');
    }

    const confidenceText = ctx.confidence != null
      ? `**Confidence:** ${(ctx.confidence * 100).toFixed(0)}%\n`
      : '';

    const embed = {
      title: 'Tool Approval Required',
      color: 0xff9900,
      fields: [
        { name: 'Reason', value: ctx.reason, inline: false },
        { name: 'Agent', value: ctx.agentId, inline: true },
        { name: 'Session', value: `\`${ctx.sessionId}\``, inline: true },
        ...(confidenceText ? [{ name: 'Confidence', value: `${(ctx.confidence! * 100).toFixed(0)}%`, inline: true }] : []),
        { name: 'Summary', value: ctx.conversationSummary.slice(0, 1024), inline: false },
      ],
      timestamp: new Date().toISOString(),
    };

    // Send to the first available text channel (in production, use a configured escalation channel)
    for (const [, guild] of this.client.guilds.cache) {
      const channel = guild.systemChannel;
      if (channel) {
        await channel.send({ embeds: [embed] });
        break;
      }
    }
  }

  async resolveUser(_workspaceId: string, _externalUserId: string): Promise<string | null> {
    // In a full implementation, resolve Discord user ID to HonorClaw user ID via database.
    return null;
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  private async registerSlashCommands(botToken: string, applicationId: string): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(botToken);

    const command = new SlashCommandBuilder()
      .setName('agent')
      .setDescription('Send a message to the HonorClaw agent')
      .addStringOption((option) =>
        option
          .setName('message')
          .setDescription('Your message to the agent')
          .setRequired(true),
      );

    try {
      await rest.put(Routes.applicationCommands(applicationId), {
        body: [command.toJSON()],
      });
    } catch (err) {
      console.error('[DiscordAdapter] Failed to register slash commands:', err);
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const message = interaction.options.getString('message', true);

    // Defer the reply so we can take time to process
    await interaction.deferReply();

    try {
      const reply = await this.onMessage({
        externalUserId: interaction.user.id,
        externalChannelId: interaction.channelId,
        content: message,
        threadId: interaction.channelId,
      });

      if (reply) {
        const chunks = splitMessage(reply);
        await interaction.editReply(chunks[0]!);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]!);
        }
      } else {
        await interaction.editReply('Done.');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'An error occurred';
      await interaction.editReply(`Error: ${errorMsg}`);
    }
  }

  private async handleDirectMessage(message: Message): Promise<void> {
    const channel = message.channel;
    if (!('send' in channel)) return;

    // Show typing indicator during processing
    if ('sendTyping' in channel) {
      await channel.sendTyping();
    }

    // Keep typing indicator alive every 8 seconds (Discord typing lasts ~10s)
    const typingInterval = setInterval(() => {
      if ('sendTyping' in channel) {
        (channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
      }
    }, 8000);

    try {
      const reply = await this.onMessage({
        externalUserId: message.author.id,
        externalChannelId: message.channelId,
        content: message.content,
      });

      if (reply) {
        const chunks = splitMessage(reply);
        for (const chunk of chunks) {
          await (channel as { send: (content: string) => Promise<unknown> }).send(chunk);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'An error occurred';
      await (channel as { send: (content: string) => Promise<unknown> }).send(`Error: ${errorMsg}`);
    } finally {
      clearInterval(typingInterval);
    }
  }
}

// ── Utility ──────────────────────────────────────────────────────────────

/**
 * Split a message into chunks of at most DISCORD_MAX_LENGTH characters,
 * preferring to split on newlines.
 */
function splitMessage(text: string): string[] {
  if (text.length <= DISCORD_MAX_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point (newline within the limit)
    let splitIndex = remaining.lastIndexOf('\n', DISCORD_MAX_LENGTH);
    if (splitIndex <= 0) {
      // No newline found — split at a space
      splitIndex = remaining.lastIndexOf(' ', DISCORD_MAX_LENGTH);
    }
    if (splitIndex <= 0) {
      // No space found — hard split
      splitIndex = DISCORD_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}
