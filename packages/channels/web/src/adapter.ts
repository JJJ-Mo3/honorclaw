import type { ChannelAdapter, OutboundMessage, EscalationContext } from '@honorclaw/core';

export class WebAdapter implements ChannelAdapter {
  name = 'web' as const;
  async start(): Promise<void> { /* TODO */ }
  async stop(): Promise<void> { /* TODO */ }
  async sendOutbound(_workspaceId: string, _msg: OutboundMessage): Promise<void> { /* TODO */ }
  async sendEscalation(_workspaceId: string, _ctx: EscalationContext): Promise<void> { /* TODO */ }
  async resolveUser(_workspaceId: string, _externalUserId: string): Promise<string | null> { return null; }
}
