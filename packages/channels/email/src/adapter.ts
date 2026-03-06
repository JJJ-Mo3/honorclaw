import { createTransport, type Transporter } from 'nodemailer';
import { ImapFlow } from 'imapflow';
import type {
  ChannelAdapter,
  OutboundMessage,
  EscalationContext,
  SecretsProvider,
} from '@honorclaw/core';

export interface EmailAdapterOptions {
  secrets: SecretsProvider;
  /** Callback invoked when an inbound email arrives. */
  onMessage: (msg: {
    externalUserId: string;
    externalChannelId: string;
    content: string;
    threadId?: string;
    subject: string;
    messageId: string;
  }) => Promise<string | void>;
  /** IMAP polling interval in milliseconds (default: 30000). */
  pollIntervalMs?: number;
}

/**
 * Email (SMTP/IMAP) channel adapter.
 *
 * - Inbound: IMAP IDLE polling via imapflow
 * - Outbound: SMTP via nodemailer
 * - Thread mapping via In-Reply-To headers
 * - Strip HTML/signatures before agent processing
 */
export class EmailAdapter implements ChannelAdapter {
  name = 'email' as const;

  private imapClient: ImapFlow | null = null;
  private smtpTransport: Transporter | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  private readonly secrets: SecretsProvider;
  private readonly onMessage: EmailAdapterOptions['onMessage'];
  private readonly pollIntervalMs: number;

  /** Map of email Message-ID to internal thread ID for threading. */
  private readonly threadMap = new Map<string, string>();

  constructor(options: EmailAdapterOptions) {
    this.secrets = options.secrets;
    this.onMessage = options.onMessage;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
  }

  async start(): Promise<void> {
    const imapHost = await this.secrets.getSecret('email/imap-host');
    const imapPort = Number(await this.secrets.getSecret('email/imap-port').catch(() => '993'));
    const imapUser = await this.secrets.getSecret('email/imap-user');
    const imapPass = await this.secrets.getSecret('email/imap-password');

    const smtpHost = await this.secrets.getSecret('email/smtp-host');
    const smtpPort = Number(await this.secrets.getSecret('email/smtp-port').catch(() => '587'));
    const smtpUser = await this.secrets.getSecret('email/smtp-user');
    const smtpPass = await this.secrets.getSecret('email/smtp-password');

    // Initialize SMTP transport
    this.smtpTransport = createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    // Initialize IMAP client
    this.imapClient = new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: true,
      auth: {
        user: imapUser,
        pass: imapPass,
      },
      logger: false,
    });

    await this.imapClient.connect();
    this.running = true;

    // Start IMAP IDLE polling
    void this.startIdlePolling();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.imapClient) {
      await this.imapClient.logout().catch(() => {});
      this.imapClient = null;
    }

    if (this.smtpTransport) {
      this.smtpTransport.close();
      this.smtpTransport = null;
    }

    this.threadMap.clear();
  }

  async sendOutbound(_workspaceId: string, msg: OutboundMessage): Promise<void> {
    if (!this.smtpTransport) {
      throw new Error('EmailAdapter not started');
    }

    const text = typeof msg.content === 'string'
      ? msg.content
      : msg.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n');

    const fromAddress = await this.secrets.getSecret('email/from-address');

    const mailOptions: Record<string, unknown> = {
      from: fromAddress,
      to: msg.externalChannelId, // channelId is the recipient email address
      subject: 'Re: HonorClaw Agent Response',
      text,
    };

    // Thread mapping via In-Reply-To header
    if (msg.threadId) {
      mailOptions['inReplyTo'] = msg.threadId;
      mailOptions['references'] = msg.threadId;
    }

    await this.smtpTransport.sendMail(mailOptions);
  }

  async sendEscalation(_workspaceId: string, ctx: EscalationContext): Promise<void> {
    if (!this.smtpTransport) {
      throw new Error('EmailAdapter not started');
    }

    const fromAddress = await this.secrets.getSecret('email/from-address');
    const escalationTo = await this.secrets.getSecret('email/escalation-address');

    const confidenceText = ctx.confidence != null
      ? `Confidence: ${(ctx.confidence * 100).toFixed(0)}%\n`
      : '';

    const body = [
      'Tool Approval Required',
      '='.repeat(40),
      '',
      `Agent: ${ctx.agentId}`,
      `Session: ${ctx.sessionId}`,
      `Reason: ${ctx.reason}`,
      confidenceText,
      'Conversation Summary:',
      ctx.conversationSummary,
      '',
      ctx.approvalRequired
        ? 'Please reply with APPROVE or REJECT.'
        : 'This is an informational escalation.',
    ].join('\n');

    await this.smtpTransport.sendMail({
      from: fromAddress,
      to: escalationTo,
      subject: `[HonorClaw] Approval Required — ${ctx.agentId}`,
      text: body,
    });
  }

  async resolveUser(_workspaceId: string, _externalUserId: string): Promise<string | null> {
    // In a full implementation, resolve email address to HonorClaw user ID via database.
    return null;
  }

  // ── Internal Helpers ──────────────────────────────────────────────────

  /**
   * Start IMAP IDLE polling for new messages.
   * Uses IMAP IDLE when supported, falls back to periodic polling.
   */
  private async startIdlePolling(): Promise<void> {
    if (!this.imapClient || !this.running) return;

    const processNewMessages = async () => {
      if (!this.imapClient || !this.running) return;

      try {
        const lock = await this.imapClient.getMailboxLock('INBOX');
        try {
          // Fetch unseen messages
          const messages = this.imapClient.fetch({ seen: false }, {
            source: true,
            envelope: true,
            uid: true,
          });

          for await (const msg of messages) {
            await this.processInboundEmail(msg);

            // Mark as seen
            await this.imapClient.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
          }
        } finally {
          lock.release();
        }
      } catch (err) {
        if (this.running) {
          console.error('[EmailAdapter] IMAP polling error:', err);
        }
      }
    };

    // Initial fetch
    await processNewMessages();

    // Set up periodic polling
    this.pollTimer = setInterval(processNewMessages, this.pollIntervalMs);
  }

  /**
   * Process a single inbound email message.
   */
  private async processInboundEmail(msg: any): Promise<void> {
    const envelope = msg.envelope;
    if (!envelope) return;

    const fromAddress = envelope.from?.[0]?.address ?? '';
    const subject = envelope.subject ?? '';
    const messageId = envelope.messageId ?? '';
    const inReplyTo = envelope.inReplyTo ?? '';

    // Extract the text body
    let body = '';
    if (msg.source) {
      body = Buffer.isBuffer(msg.source)
        ? msg.source.toString('utf-8')
        : String(msg.source);
    }

    // Strip HTML tags and email signatures
    body = stripHtmlAndSignatures(body);

    // Resolve thread ID from In-Reply-To header
    const threadId = inReplyTo
      ? this.threadMap.get(inReplyTo) ?? inReplyTo
      : undefined;

    // Store the message ID for future threading
    if (messageId) {
      this.threadMap.set(messageId, threadId ?? messageId);
    }

    await this.onMessage({
      externalUserId: fromAddress,
      externalChannelId: fromAddress,
      content: body,
      threadId,
      subject,
      messageId,
    });
  }
}

// ── Utility ──────────────────────────────────────────────────────────────

/**
 * Strip HTML tags and common email signatures from message body.
 */
function stripHtmlAndSignatures(body: string): string {
  // Remove HTML tags
  let text = body.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Strip common email signatures (lines starting with --, Sent from, etc.)
  const signaturePatterns = [
    /^--\s*$/m,           // Standard signature delimiter
    /^Sent from /m,       // Mobile signatures
    /^Get Outlook /m,     // Outlook signatures
    /^_{3,}/m,            // Underscores separator
  ];

  for (const pattern of signaturePatterns) {
    const match = text.match(pattern);
    if (match?.index != null) {
      text = text.slice(0, match.index);
    }
  }

  // Remove excessive whitespace
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return text;
}
