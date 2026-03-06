import type { Message } from '@honorclaw/core';

export interface ContextManager {
  prepare(messages: Message[], tokenBudget: number): Promise<Message[]>;
}

export class NaiveContextManager implements ContextManager {
  async prepare(messages: Message[], tokenBudget: number): Promise<Message[]> {
    // Token approximation: 1 token ≈ 4 chars
    const estimateTokens = (msg: Message): number => {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return Math.ceil(content.length / 4);
    };

    // Always keep system prompt (first message) and last user message
    const systemMessages = messages.filter(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    let budget = tokenBudget;
    const result: Message[] = [];

    // Add system messages first
    for (const msg of systemMessages) {
      budget -= estimateTokens(msg);
      result.push(msg);
    }

    // Add messages from most recent, working backwards
    const reversed = [...nonSystemMessages].reverse();
    const included: Message[] = [];

    for (const msg of reversed) {
      const tokens = estimateTokens(msg);
      if (budget - tokens < 0) break;
      budget -= tokens;
      included.unshift(msg);
    }

    result.push(...included);
    return result;
  }
}
