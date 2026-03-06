import type { LLMRequest, LLMResponse } from '@honorclaw/core';

export interface LLMAdapter {
  name: string;
  complete(request: LLMRequest): Promise<LLMResponse>;
}
