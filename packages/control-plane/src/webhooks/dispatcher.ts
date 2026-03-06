import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuditEvent } from '@honorclaw/core';
import type { EncryptionProvider } from '@honorclaw/core';
import { validateWebhookUrl } from './url-validator.js';
import pino from 'pino';

const log = pino({ name: 'webhook-dispatcher' });

interface WebhookSubscriptionRow {
  id: string;
  workspace_id: string;
  url: string;
  event_types: string[];
  signing_secret_encrypted: Buffer;
  enabled: boolean;
  consecutive_failures: number;
}

interface DeliveryResult {
  success: boolean;
  status?: number;
  error?: string;
}

const RETRY_DELAYS_MS = [30_000, 300_000, 1_800_000]; // 30s, 5min, 30min
const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_PAYLOAD_BYTES = 65_536;
const MAX_CONSECUTIVE_FAILURES = 3;

export class WebhookDispatcher {
  private db: Pool;
  private encryption: EncryptionProvider;
  private allowHttp: boolean;

  constructor(db: Pool, encryption: EncryptionProvider, allowHttp = false) {
    this.db = db;
    this.encryption = encryption;
    this.allowHttp = allowHttp;
  }

  async dispatch(event: AuditEvent): Promise<void> {
    const eventType = event.eventType;
    const workspaceId = event.workspaceId;

    if (!workspaceId) return;

    // Find matching subscriptions
    const result = await this.db.query<WebhookSubscriptionRow>(
      `SELECT id, workspace_id, url, event_types, signing_secret_encrypted, enabled, consecutive_failures
       FROM webhook_subscriptions
       WHERE workspace_id = $1 AND enabled = true AND $2 = ANY(event_types)`,
      [workspaceId, eventType],
    );

    for (const sub of result.rows) {
      this.deliverWithRetry(sub, event).catch((err) => {
        log.error({ subscriptionId: sub.id, error: err }, 'Webhook delivery failed permanently');
      });
    }
  }

  private async deliverWithRetry(sub: WebhookSubscriptionRow, event: AuditEvent): Promise<void> {
    for (let attempt = 1; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
      const result = await this.deliver(sub, event, attempt);

      await this.logDelivery(sub.id, event, attempt, result);

      if (result.success) {
        await this.db.query(
          `UPDATE webhook_subscriptions SET last_delivered_at = now(), consecutive_failures = 0 WHERE id = $1`,
          [sub.id],
        );
        return;
      }

      if (attempt <= RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]!));
      }
    }

    // All retries exhausted
    const res = await this.db.query<{ consecutive_failures: number }>(
      `UPDATE webhook_subscriptions SET consecutive_failures = consecutive_failures + 1
       WHERE id = $1 RETURNING consecutive_failures`,
      [sub.id],
    );

    const failures = res.rows[0]?.consecutive_failures ?? 0;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      await this.db.query(
        `UPDATE webhook_subscriptions SET enabled = false WHERE id = $1`,
        [sub.id],
      );
      log.warn({ subscriptionId: sub.id }, 'Webhook subscription disabled after consecutive failures');
    }
  }

  private async deliver(
    sub: WebhookSubscriptionRow,
    event: AuditEvent,
    attempt: number,
  ): Promise<DeliveryResult> {
    // SSRF check on every attempt (IP rotation protection)
    const urlCheck = await validateWebhookUrl(sub.url, this.allowHttp);
    if (!urlCheck.valid) {
      return { success: false, error: `SSRF blocked: ${urlCheck.reason}` };
    }

    // Build payload
    const payload = {
      id: randomUUID(),
      type: event.eventType,
      workspace_id: sub.workspace_id,
      agent_id: event.agentId ?? undefined,
      session_id: event.sessionId ?? undefined,
      timestamp: new Date().toISOString(),
      data: event.payload ?? {},
    };

    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > MAX_PAYLOAD_BYTES) {
      return { success: false, error: 'Payload exceeds 64KB limit' };
    }

    // Sign
    const signingKey = await this.encryption.decrypt(sub.signing_secret_encrypted);
    const signature = createHmac('sha256', signingKey).update(body).digest('hex');

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

      const response = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-HonorClaw-Signature': `sha256=${signature}`,
          'X-HonorClaw-Event': event.eventType,
          'X-HonorClaw-Delivery': payload.id,
          'User-Agent': 'HonorClaw-Webhooks/1.0',
        },
        body,
        signal: controller.signal,
        redirect: 'error', // Do NOT follow redirects
      });

      clearTimeout(timeout);

      if (response.ok) {
        return { success: true, status: response.status };
      }
      return { success: false, status: response.status, error: `HTTP ${response.status}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  private async logDelivery(
    subscriptionId: string,
    event: AuditEvent,
    attempt: number,
    result: DeliveryResult,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO webhook_deliveries (subscription_id, event_id, attempt, status, response_status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        subscriptionId,
        event.id ?? randomUUID(),
        attempt,
        result.success ? 'success' : attempt > RETRY_DELAYS_MS.length ? 'failed' : 'pending_retry',
        result.status ?? null,
        result.error ?? null,
      ],
    );
  }
}
