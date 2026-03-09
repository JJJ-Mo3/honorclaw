import type { LLMAdapter } from './base.js';
import type { LLMRequest, LLMResponse, ToolCallRequest } from '@honorclaw/core';
import crypto from 'node:crypto';

/**
 * Adapter for Claude models via Google Cloud Vertex AI.
 *
 * Authenticates using a GCP service account JSON key to obtain short-lived
 * OAuth2 access tokens. This is a supported cloud-provider path for Claude —
 * Anthropic's TOS prohibits consumer OAuth tokens in third-party tools,
 * but Vertex AI access is fully sanctioned.
 *
 * Endpoint: POST https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/publishers/anthropic/models/{model}:rawPredict
 */
export class VertexAdapter implements LLMAdapter {
  name = 'vertex';
  private serviceAccountKey: ServiceAccountKey;
  private projectId: string;
  private region: string;
  private cachedToken: { token: string; expiresAt: number } | null = null;
  private anthropicVersion: string;

  constructor(options: {
    serviceAccountJson: string;
    region?: string;
  }) {
    this.serviceAccountKey = JSON.parse(options.serviceAccountJson) as ServiceAccountKey;
    this.projectId = this.serviceAccountKey.project_id;
    this.region = options.region ?? 'us-central1';
    this.anthropicVersion = 'vertex-2023-10-16';
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const modelId = request.model.includes('/')
      ? request.model.split('/').slice(1).join('/')
      : request.model;

    // Build message body (same as Anthropic format)
    const systemParts: string[] = [];
    const conversationMessages: Array<{
      role: 'user' | 'assistant';
      content: string | Array<Record<string, unknown>>;
    }> = [];

    for (const msg of request.messages) {
      const textContent =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('');

      if (msg.role === 'system') {
        systemParts.push(textContent);
        continue;
      }

      if (msg.role === 'tool') {
        conversationMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId ?? 'unknown',
              content: textContent,
            },
          ],
        });
        continue;
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const contentBlocks: Array<Record<string, unknown>> = [];
        if (textContent) contentBlocks.push({ type: 'text', text: textContent });
        for (const tc of msg.toolCalls) {
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.tool_name,
            input: tc.parameters,
          });
        }
        conversationMessages.push({ role: 'assistant', content: contentBlocks });
        continue;
      }

      const role = msg.role === 'user' ? 'user' : 'assistant';
      conversationMessages.push({ role, content: textContent });
    }

    const body: Record<string, unknown> = {
      anthropic_version: this.anthropicVersion,
      max_tokens: request.maxTokens ?? 4096,
      messages: conversationMessages,
    };

    if (systemParts.length > 0) body.system = systemParts.join('\n\n');

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.parameters ?? { type: 'object', properties: {} },
      }));
    }

    const accessToken = await this.getAccessToken();
    const url =
      `https://${this.region}-aiplatform.googleapis.com/v1/` +
      `projects/${this.projectId}/locations/${this.region}/` +
      `publishers/anthropic/models/${modelId}:rawPredict`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const status = response.status;
      if (status === 429) throw new Error(`Vertex AI rate limit exceeded: ${errorBody}`);
      if (status === 401 || status === 403) throw new Error(`Vertex AI authentication failed: check service account credentials`);
      throw new Error(`Vertex AI API error ${status}: ${errorBody}`);
    }

    const data = (await response.json()) as VertexResponse;

    let textContent = '';
    const toolCalls: ToolCallRequest[] = [];

    for (const block of data.content ?? []) {
      if (block.type === 'text') textContent += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id ?? `call_${Date.now()}_${toolCalls.length}`,
          tool_name: block.name ?? 'unknown',
          parameters: (block.input as Record<string, unknown>) ?? {},
        });
      }
    }

    let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';
    if (data.stop_reason === 'tool_use') finishReason = 'tool_calls';
    else if (data.stop_reason === 'max_tokens') finishReason = 'length';

    return {
      sessionId: request.sessionId,
      correlationId: request.correlationId,
      content: textContent || null,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      tokensUsed: {
        prompt: data.usage?.input_tokens ?? 0,
        completion: data.usage?.output_tokens ?? 0,
        total: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
      model: request.model,
      finishReason,
    };
  }

  /**
   * Get a short-lived access token using the service account's private key.
   * Uses a self-signed JWT exchanged for an access token (no Google SDK needed).
   */
  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 60_000) {
      return this.cachedToken.token;
    }

    const now = Math.floor(Date.now() / 1000);
    const jwtHeader = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const jwtClaims = base64url(JSON.stringify({
      iss: this.serviceAccountKey.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }));

    const signingInput = `${jwtHeader}.${jwtClaims}`;
    const signature = crypto
      .createSign('RSA-SHA256')
      .update(signingInput)
      .sign(this.serviceAccountKey.private_key);
    const jwt = `${signingInput}.${base64url(signature)}`;

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!tokenResponse.ok) {
      const err = await tokenResponse.text();
      throw new Error(`Failed to get Vertex AI access token: ${err}`);
    }

    const tokenData = (await tokenResponse.json()) as { access_token: string; expires_in: number };

    this.cachedToken = {
      token: tokenData.access_token,
      expiresAt: Date.now() + tokenData.expires_in * 1000,
    };

    return this.cachedToken.token;
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function base64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
  return buf.toString('base64url');
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ServiceAccountKey {
  project_id: string;
  client_email: string;
  private_key: string;
}

interface VertexContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface VertexResponse {
  content: VertexContentBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}
