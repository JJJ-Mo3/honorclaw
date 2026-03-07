import type { LLMRequest, LLMResponse } from '@honorclaw/core';

/**
 * Callback invoked for each chunk during streaming.
 * @param chunk - The text chunk received from the LLM.
 */
export type StreamChunkCallback = (chunk: string) => void;

export interface LLMAdapter {
  name: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
  /**
   * Stream a completion, invoking `onChunk` for each text fragment.
   * Falls back to `complete()` if the adapter does not support streaming.
   */
  completeStream?(
    request: LLMRequest,
    onChunk: StreamChunkCallback,
  ): Promise<LLMResponse>;
}
