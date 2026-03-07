import type { Message } from '@honorclaw/core';

export interface ContextManager {
  prepare(messages: Message[], tokenBudget: number): Promise<Message[]>;
}

/**
 * NaiveContextManager: simple most-recent-first truncation.
 * Kept for backwards compatibility and testing.
 */
export class NaiveContextManager implements ContextManager {
  async prepare(messages: Message[], tokenBudget: number): Promise<Message[]> {
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

export interface SmartContextManagerOptions {
  /** Number of most-recent messages to always preserve. Default: 10. */
  recentMessageCount?: number;
}

/**
 * SmartContextManager: a context-aware compression strategy.
 *
 * Strategy:
 * 1. The first message (system prompt) is always kept.
 * 2. The most recent N messages (configurable, default 10) are always kept.
 * 3. For messages in the middle (between system prompt and recent window):
 *    - Keep messages that contain tool calls or tool results (factual content).
 *    - Drop pure conversational messages (user/assistant without tool involvement).
 * 4. If the context still exceeds the token budget after filtering, fall back to
 *    truncation of the oldest remaining middle messages.
 */
export class SmartContextManager implements ContextManager {
  private readonly recentCount: number;

  constructor(options?: SmartContextManagerOptions) {
    this.recentCount = options?.recentMessageCount ?? 10;
  }

  async prepare(messages: Message[], tokenBudget: number): Promise<Message[]> {
    if (messages.length === 0) return [];

    const estimateTokens = (msg: Message): number => {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      return Math.ceil(content.length / 4);
    };

    const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m), 0);

    // If we're under 75% of budget, return everything as-is
    if (totalTokens <= tokenBudget * 0.75) {
      return messages;
    }

    // Separate system messages (always kept) from the rest
    const systemMessages: Message[] = [];
    const nonSystemMessages: Message[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessages.push(msg);
      } else {
        nonSystemMessages.push(msg);
      }
    }

    // Split non-system messages into "recent" (tail) and "middle" (everything before)
    const recentStart = Math.max(0, nonSystemMessages.length - this.recentCount);
    const middleMessages = nonSystemMessages.slice(0, recentStart);
    const recentMessages = nonSystemMessages.slice(recentStart);

    // From the middle, keep only messages involved in tool interactions
    const importantMiddle = middleMessages.filter(msg => this.isToolRelated(msg));

    // Assemble candidate result
    let result = [...systemMessages, ...importantMiddle, ...recentMessages];
    let usedTokens = result.reduce((sum, m) => sum + estimateTokens(m), 0);

    // If still over budget, progressively drop the oldest important-middle messages
    if (usedTokens > tokenBudget) {
      const fixedTokens =
        systemMessages.reduce((s, m) => s + estimateTokens(m), 0) +
        recentMessages.reduce((s, m) => s + estimateTokens(m), 0);

      let middleBudget = tokenBudget - fixedTokens;
      const keptMiddle: Message[] = [];

      // Keep from most-recent middle messages backwards
      for (let i = importantMiddle.length - 1; i >= 0; i--) {
        const tokens = estimateTokens(importantMiddle[i]!);
        if (middleBudget - tokens < 0) break;
        middleBudget -= tokens;
        keptMiddle.unshift(importantMiddle[i]!);
      }

      result = [...systemMessages, ...keptMiddle, ...recentMessages];
      usedTokens = result.reduce((sum, m) => sum + estimateTokens(m), 0);
    }

    // Final safety: if recent messages alone exceed budget, truncate from the oldest recent
    if (usedTokens > tokenBudget) {
      const systemTokens = systemMessages.reduce((s, m) => s + estimateTokens(m), 0);
      let remainingBudget = tokenBudget - systemTokens;
      const truncatedRecent: Message[] = [];

      for (let i = recentMessages.length - 1; i >= 0; i--) {
        const tokens = estimateTokens(recentMessages[i]!);
        if (remainingBudget - tokens < 0) break;
        remainingBudget -= tokens;
        truncatedRecent.unshift(recentMessages[i]!);
      }

      result = [...systemMessages, ...truncatedRecent];
    }

    return result;
  }

  /**
   * Determine whether a message is related to tool usage.
   * Tool-related messages carry important factual content and should be preserved.
   */
  private isToolRelated(msg: Message): boolean {
    // Tool result messages
    if (msg.role === 'tool') return true;
    // Assistant messages that contain tool calls
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) return true;
    // Messages referencing a tool call id
    if (msg.tool_call_id) return true;
    return false;
  }
}
