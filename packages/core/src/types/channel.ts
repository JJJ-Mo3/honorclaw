import type { MessageContent } from './message.js';

export interface InboundMessage {
  externalUserId: string;
  externalChannelId: string;
  content: MessageContent;
  externalMessageId: string;
  threadId?: string;
  receivedAt: Date;
}

export interface OutboundMessage {
  externalChannelId: string;
  externalMessageId?: string;
  content: MessageContent;
  threadId?: string;
}

export interface EscalationContext {
  sessionId: string;
  agentId: string;
  reason: string;
  confidence?: number;
  conversationSummary: string;
  approvalRequired?: boolean;
}

export interface ChannelAdapter {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendOutbound(workspaceId: string, msg: OutboundMessage): Promise<void>;
  sendEscalation(workspaceId: string, ctx: EscalationContext): Promise<void>;
  resolveUser(workspaceId: string, externalUserId: string): Promise<string | null>;
}
