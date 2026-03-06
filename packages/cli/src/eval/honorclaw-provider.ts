/**
 * Custom promptfoo provider that routes eval turns through the HonorClaw Control Plane API.
 *
 * Creates headless eval sessions, registers mock tool handlers,
 * and returns output + audit metadata.
 */

import type { EvalMock } from '@honorclaw/core';

interface ProviderOptions {
  /** Control Plane API base URL. */
  apiBaseUrl: string;
  /** API key for authentication. */
  apiKey: string;
  /** Agent ID to evaluate. */
  agentId: string;
  /** Mock tool handlers for deterministic execution. */
  mocks?: EvalMock[];
}

interface ProviderResponse {
  output: string;
  tokenUsage?: { total: number; prompt: number; completion: number };
  cost?: number;
  metadata?: Record<string, unknown>;
}

export class HonorclawProvider {
  id: string;
  private readonly config: ProviderOptions;

  constructor(config: ProviderOptions) {
    this.config = config;
    this.id = `honorclaw:${config.agentId}`;
  }

  async callApi(prompt: string): Promise<ProviderResponse> {
    const { apiBaseUrl, apiKey, agentId, mocks } = this.config;

    // 1. Create a headless eval session
    const sessionRes = await fetch(`${apiBaseUrl}/eval/sessions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, sessionType: 'eval' }),
    });
    const session = await sessionRes.json() as { sessionId: string };

    // 2. Register mock tool handlers
    if (mocks?.length) {
      await fetch(`${apiBaseUrl}/eval/sessions/${session.sessionId}/mocks`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mocks }),
      });
    }

    // 3. Send the prompt as a turn
    const turnRes = await fetch(`${apiBaseUrl}/eval/sessions/${session.sessionId}/turns`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: prompt }),
    });
    const turn = await turnRes.json() as {
      output: string;
      tokenUsage?: { prompt: number; completion: number; total: number };
      cost?: number;
      auditTrail?: Record<string, unknown>;
    };

    return {
      output: turn.output,
      tokenUsage: turn.tokenUsage,
      cost: turn.cost,
      metadata: { sessionId: session.sessionId, auditTrail: turn.auditTrail },
    };
  }
}
