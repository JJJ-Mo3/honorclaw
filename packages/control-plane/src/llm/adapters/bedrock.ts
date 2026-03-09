import type { LLMAdapter } from './base.js';
import type { LLMRequest, LLMResponse, ToolCallRequest } from '@honorclaw/core';
import crypto from 'node:crypto';

/**
 * Adapter for Claude models via AWS Bedrock.
 *
 * Authenticates using AWS IAM credentials (access key + secret key) with SigV4.
 * This is the recommended way to use Claude in production without a direct
 * Anthropic API key — Anthropic's TOS prohibits consumer OAuth tokens in
 * third-party tools, but Bedrock access is fully supported.
 *
 * Endpoint: POST https://bedrock-runtime.{region}.amazonaws.com/model/{modelId}/invoke
 */
export class BedrockAdapter implements LLMAdapter {
  name = 'bedrock';
  private accessKeyId: string;
  private secretAccessKey: string;
  private sessionToken?: string;
  private region: string;
  private anthropicVersion: string;

  constructor(options: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
    region?: string;
  }) {
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.sessionToken = options.sessionToken;
    this.region = options.region ?? 'us-east-1';
    this.anthropicVersion = 'bedrock-2023-05-31';
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    // Strip provider prefix: "bedrock/anthropic.claude-sonnet-4-20250514-v1:0"
    const modelId = request.model.includes('/')
      ? request.model.split('/').slice(1).join('/')
      : request.model;

    // Build Anthropic-format message body (Bedrock uses the same format)
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
        if (textContent) {
          contentBlocks.push({ type: 'text', text: textContent });
        }
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

    if (systemParts.length > 0) {
      body.system = systemParts.join('\n\n');
    }

    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.parameters ?? { type: 'object', properties: {} },
      }));
    }

    const payload = JSON.stringify(body);
    const host = `bedrock-runtime.${this.region}.amazonaws.com`;
    const path = `/model/${encodeURIComponent(modelId)}/invoke`;
    const url = `https://${host}${path}`;

    const headers = this.signRequest('POST', host, path, payload);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: payload,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const status = response.status;
      if (status === 429) throw new Error(`Bedrock rate limit exceeded: ${errorBody}`);
      if (status === 403) throw new Error(`Bedrock authentication failed: check IAM credentials`);
      throw new Error(`Bedrock API error ${status}: ${errorBody}`);
    }

    const data = (await response.json()) as BedrockResponse;

    let textContent = '';
    const toolCalls: ToolCallRequest[] = [];

    for (const block of data.content ?? []) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
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
   * Sign a request with AWS Signature Version 4.
   */
  private signRequest(
    method: string,
    host: string,
    path: string,
    payload: string,
  ): Record<string, string> {
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const service = 'bedrock';
    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;

    const payloadHash = sha256(payload);

    const signedHeaderKeys = this.sessionToken
      ? 'content-type;host;x-amz-date;x-amz-security-token'
      : 'content-type;host;x-amz-date';

    let canonicalHeaders =
      `content-type:application/json\n` +
      `host:${host}\n` +
      `x-amz-date:${amzDate}\n`;

    if (this.sessionToken) {
      canonicalHeaders += `x-amz-security-token:${this.sessionToken}\n`;
    }

    const canonicalRequest = [
      method,
      path,
      '', // query string (empty)
      canonicalHeaders,
      signedHeaderKeys,
      payloadHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256(canonicalRequest),
    ].join('\n');

    const signingKey = getSignatureKey(this.secretAccessKey, dateStamp, this.region, service);
    const signature = hmacHex(signingKey, stringToSign);

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaderKeys}, ` +
      `Signature=${signature}`;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'host': host,
      'x-amz-date': amzDate,
      'authorization': authorization,
    };

    if (this.sessionToken) {
      headers['x-amz-security-token'] = this.sessionToken;
    }

    return headers;
  }
}

/* ------------------------------------------------------------------ */
/*  AWS SigV4 helpers                                                  */
/* ------------------------------------------------------------------ */

function sha256(data: string): string {
  return crypto.createHash('sha256').update(data, 'utf-8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf-8').digest();
}

function hmacHex(key: Buffer | string, data: string): string {
  return crypto.createHmac('sha256', key).update(data, 'utf-8').digest('hex');
}

function getSignatureKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/* ------------------------------------------------------------------ */
/*  Bedrock response types (Anthropic-format subset)                   */
/* ------------------------------------------------------------------ */

interface BedrockContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface BedrockResponse {
  content: BedrockContentBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}
