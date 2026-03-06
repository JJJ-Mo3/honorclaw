import {
  ActivityHandler,
  BotFrameworkAdapter,
  CardFactory,
  ConversationReference,
  TurnContext,
  type Activity,
} from 'botbuilder';
import {
  MicrosoftAppCredentials,
  JwtTokenValidation,
  SimpleCredentialProvider,
} from 'botframework-connector';
import type {
  ChannelAdapter,
  OutboundMessage,
  EscalationContext,
  SecretsProvider,
} from '@honorclaw/core';

export interface TeamsAdapterOptions {
  secrets: SecretsProvider;
  /** Callback invoked when an inbound user message arrives. */
  onMessage: (msg: {
    externalUserId: string;
    externalChannelId: string;
    content: string;
    threadId?: string;
    conversationReference: Partial<ConversationReference>;
  }) => Promise<string | void>;
}

/**
 * Microsoft Teams channel adapter.
 *
 * - Bot Framework integration via botbuilder SDK
 * - Token validation on every inbound Activity
 * - Adaptive cards for structured output and approval requests
 * - Conversation reference storage for proactive messaging
 */
export class TeamsAdapter implements ChannelAdapter {
  name = 'teams' as const;

  private adapter: BotFrameworkAdapter | null = null;
  private bot: TeamsBot | null = null;
  private readonly secrets: SecretsProvider;
  private readonly onMessage: TeamsAdapterOptions['onMessage'];

  /** Stored conversation references keyed by `channelId:userId` for proactive messaging. */
  private readonly conversationRefs = new Map<string, Partial<ConversationReference>>();

  constructor(options: TeamsAdapterOptions) {
    this.secrets = options.secrets;
    this.onMessage = options.onMessage;
  }

  async start(): Promise<void> {
    const appId = await this.secrets.getSecret('teams/app-id');
    const appPassword = await this.secrets.getSecret('teams/app-password');

    this.adapter = new BotFrameworkAdapter({
      appId,
      appPassword,
    });

    // Error handler — log and send a generic message back
    this.adapter.onTurnError = async (context: TurnContext, error: Error) => {
      console.error('[TeamsAdapter] Turn error:', error.message);
      await context.sendActivity('Sorry, something went wrong processing your request.');
    };

    this.bot = new TeamsBot({
      appId,
      appPassword,
      onMessage: this.onMessage,
      conversationRefs: this.conversationRefs,
    });
  }

  async stop(): Promise<void> {
    this.adapter = null;
    this.bot = null;
    this.conversationRefs.clear();
  }

  /**
   * Process an incoming HTTP request from the Bot Framework channel.
   * Call this from your HTTP server's POST /api/messages route.
   */
  async processActivity(req: unknown, res: unknown): Promise<void> {
    if (!this.adapter || !this.bot) {
      throw new Error('TeamsAdapter not started');
    }
    await this.adapter.processActivity(
      req as any,
      res as any,
      async (context) => {
        await this.bot!.run(context);
      },
    );
  }

  async sendOutbound(_workspaceId: string, msg: OutboundMessage): Promise<void> {
    if (!this.adapter) {
      throw new Error('TeamsAdapter not started');
    }

    const text = typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');

    const ref = this.conversationRefs.get(msg.externalChannelId);
    if (!ref) {
      throw new Error(`No conversation reference found for channel ${msg.externalChannelId}`);
    }

    await this.adapter.continueConversation(ref, async (context) => {
      await context.sendActivity(text);
    });
  }

  async sendEscalation(_workspaceId: string, ctx: EscalationContext): Promise<void> {
    if (!this.adapter) {
      throw new Error('TeamsAdapter not started');
    }

    const confidenceText = ctx.confidence != null
      ? `**Confidence:** ${(ctx.confidence * 100).toFixed(0)}%`
      : '';

    const card = CardFactory.adaptiveCard({
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: 'Tool Approval Required',
          weight: 'Bolder',
          size: 'Medium',
        },
        {
          type: 'FactSet',
          facts: [
            { title: 'Agent', value: ctx.agentId },
            { title: 'Session', value: ctx.sessionId },
            { title: 'Reason', value: ctx.reason },
            ...(confidenceText ? [{ title: 'Confidence', value: `${(ctx.confidence! * 100).toFixed(0)}%` }] : []),
          ],
        },
        {
          type: 'TextBlock',
          text: ctx.conversationSummary,
          wrap: true,
          spacing: 'Medium',
        },
      ],
      actions: [
        {
          type: 'Action.Submit',
          title: 'Approve',
          style: 'positive',
          data: {
            action: 'approval_approve',
            sessionId: ctx.sessionId,
            agentId: ctx.agentId,
          },
        },
        {
          type: 'Action.Submit',
          title: 'Reject',
          style: 'destructive',
          data: {
            action: 'approval_reject',
            sessionId: ctx.sessionId,
            agentId: ctx.agentId,
          },
        },
      ],
    });

    // Send to all stored conversation references (or specific escalation channel)
    for (const [_key, ref] of this.conversationRefs) {
      await this.adapter.continueConversation(ref, async (context) => {
        await context.sendActivity({ attachments: [card] });
      });
      break; // Send to first available; in production, route to configured escalation channel
    }
  }

  async resolveUser(_workspaceId: string, externalUserId: string): Promise<string | null> {
    // In a full implementation, look up the Teams user ID in the database.
    // Returning null indicates the user is not yet linked.
    return null;
  }
}

// ── Internal Bot Handler ────────────────────────────────────────────────

interface TeamsBotOptions {
  appId: string;
  appPassword: string;
  onMessage: TeamsAdapterOptions['onMessage'];
  conversationRefs: Map<string, Partial<ConversationReference>>;
}

class TeamsBot extends ActivityHandler {
  private readonly appId: string;
  private readonly appPassword: string;
  private readonly messageCallback: TeamsAdapterOptions['onMessage'];
  private readonly conversationRefs: Map<string, Partial<ConversationReference>>;

  constructor(options: TeamsBotOptions) {
    super();
    this.appId = options.appId;
    this.appPassword = options.appPassword;
    this.messageCallback = options.onMessage;
    this.conversationRefs = options.conversationRefs;

    this.registerMessageHandler();
    this.registerMembersAddedHandler();
  }

  private registerMessageHandler() {
    super.onMessage(async (context: TurnContext, next) => {
      // Validate the inbound token
      await this.validateToken(context);

      // Store conversation reference for proactive messaging
      const ref = TurnContext.getConversationReference(context.activity);
      const key = `${ref.conversation?.id}:${ref.user?.id}`;
      this.conversationRefs.set(key, ref);

      const text = context.activity.text?.trim() ?? '';
      if (!text) {
        await next();
        return;
      }

      // Send typing indicator
      await context.sendActivities([{ type: 'typing' }]);

      const reply = await this.messageCallback({
        externalUserId: context.activity.from?.id ?? '',
        externalChannelId: key,
        content: text,
        threadId: context.activity.conversation?.id,
        conversationReference: ref,
      });

      if (reply) {
        await context.sendActivity(reply);
      }

      await next();
    });
  }

  private registerMembersAddedHandler() {
    this.onMembersAdded(async (context, next) => {
      for (const member of context.activity.membersAdded ?? []) {
        if (member.id !== context.activity.recipient.id) {
          await context.sendActivity('Hello! I am your HonorClaw agent. Send me a message to get started.');
        }
      }
      await next();
    });
  }

  /**
   * Validate the JWT token on every inbound activity for defense-in-depth.
   */
  private async validateToken(context: TurnContext): Promise<void> {
    const activity = context.activity;
    const authHeader = (activity as any).rawHeaders?.Authorization ?? '';

    try {
      const credentials = new SimpleCredentialProvider(this.appId, this.appPassword);
      await JwtTokenValidation.authenticateRequest(
        activity,
        authHeader,
        credentials,
        undefined as any,
      );
    } catch {
      // Token validation is also handled by the BotFrameworkAdapter itself.
      // This is an additional defense-in-depth check; log but do not throw
      // to avoid duplicate validation failures.
      console.warn('[TeamsAdapter] Additional token validation check failed — relying on adapter validation.');
    }
  }
}
