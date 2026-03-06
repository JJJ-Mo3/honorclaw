import type { Message } from '@honorclaw/core';

export class SessionState {
  readonly sessionId: string;
  readonly messages: Message[] = [];
  readonly pendingToolCalls: string[] = [];

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  addMessage(msg: Message): void {
    this.messages.push(msg);
  }
}
