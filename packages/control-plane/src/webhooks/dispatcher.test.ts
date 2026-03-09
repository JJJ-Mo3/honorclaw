import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhookDispatcher } from './dispatcher.js';

// ── Mock external modules ────────────────────────────────────────────────

vi.mock('./url-validator.js', () => ({
  validateWebhookUrl: vi.fn().mockResolvedValue({ valid: true }),
}));

import { validateWebhookUrl } from './url-validator.js';
const mockedValidateUrl = vi.mocked(validateWebhookUrl);

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMockDb() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  };
}

function makeMockEncryption() {
  return {
    encrypt: vi.fn().mockResolvedValue(Buffer.from('encrypted')),
    decrypt: vi.fn().mockResolvedValue(Buffer.from('my-signing-secret')),
  };
}

function makeSubscriptionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    workspace_id: 'ws-1',
    url: 'https://hooks.example.com/webhook',
    event_types: ['tool.call'],
    signing_secret_encrypted: Buffer.from('encrypted-secret'),
    enabled: true,
    consecutive_failures: 0,
    ...overrides,
  };
}

function makeAuditEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    workspaceId: 'ws-1',
    eventType: 'tool.call',
    actorType: 'agent' as const,
    actorId: 'agent-1',
    agentId: 'agent-1',
    sessionId: 'sess-1',
    payload: { toolName: 'search' },
    ...overrides,
  };
}

describe('WebhookDispatcher', () => {
  let db: ReturnType<typeof makeMockDb>;
  let encryption: ReturnType<typeof makeMockEncryption>;
  let dispatcher: WebhookDispatcher;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = makeMockDb();
    encryption = makeMockEncryption();
    dispatcher = new WebhookDispatcher(db as any, encryption as any, true);

    // Reset the URL validator mock
    mockedValidateUrl.mockResolvedValue({ valid: true });

    // Mock global fetch
    fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  // ── dispatch() ───────────────────────────────────────────────────────

  describe('dispatch()', () => {
    it('skips dispatch when workspaceId is missing', async () => {
      const event = makeAuditEvent({ workspaceId: undefined });

      await dispatcher.dispatch(event as any);

      expect(db.query).not.toHaveBeenCalled();
    });

    it('queries for matching webhook subscriptions', async () => {
      const event = makeAuditEvent();
      db.query.mockResolvedValueOnce({ rows: [] });

      await dispatcher.dispatch(event);

      expect(db.query).toHaveBeenCalledTimes(1);
      const [sql, params] = db.query.mock.calls[0]!;
      expect(sql).toContain('webhook_subscriptions');
      expect(params).toEqual(['ws-1', 'tool.call']);
    });

    it('creates webhook delivery records on successful delivery', async () => {
      const sub = makeSubscriptionRow();
      db.query
        .mockResolvedValueOnce({ rows: [sub] })    // SELECT subscriptions
        .mockResolvedValue({ rows: [] });            // INSERT delivery log + UPDATE

      const event = makeAuditEvent();
      await dispatcher.dispatch(event);

      // Wait for background deliverWithRetry to complete
      // On success: SELECT subs + logDelivery INSERT + UPDATE consecutive_failures = 3
      await vi.waitFor(() => {
        const deliveryLogCall = db.query.mock.calls.find(
          (c: any) => typeof c[0] === 'string' && c[0].includes('webhook_deliveries'),
        );
        expect(deliveryLogCall).toBeDefined();
      });

      // The delivery log INSERT
      const deliveryLogCall = db.query.mock.calls.find(
        (c: any) => typeof c[0] === 'string' && c[0].includes('webhook_deliveries'),
      );
      expect(deliveryLogCall).toBeDefined();
      expect(deliveryLogCall![1]![0]).toBe('sub-1'); // subscription_id
      expect(deliveryLogCall![1]![3]).toBe('success'); // status
    });

    it('sends POST to the subscription URL with correct headers', async () => {
      const sub = makeSubscriptionRow();
      db.query
        .mockResolvedValueOnce({ rows: [sub] })
        .mockResolvedValue({ rows: [] });

      const event = makeAuditEvent();
      await dispatcher.dispatch(event);

      // Wait for async delivery
      await vi.waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      const [url, opts] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://hooks.example.com/webhook');
      expect(opts.method).toBe('POST');
      expect(opts.headers['Content-Type']).toBe('application/json');
      expect(opts.headers['X-HonorClaw-Event']).toBe('tool.call');
      expect(opts.headers['User-Agent']).toBe('HonorClaw-Webhooks/1.0');
    });

    it('generates HMAC signatures using the decrypted signing secret', async () => {
      const sub = makeSubscriptionRow();
      db.query
        .mockResolvedValueOnce({ rows: [sub] })
        .mockResolvedValue({ rows: [] });

      const event = makeAuditEvent();
      await dispatcher.dispatch(event);

      await vi.waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      // Verify encryption.decrypt was called with the encrypted secret
      expect(encryption.decrypt).toHaveBeenCalledWith(sub.signing_secret_encrypted);

      // Verify the signature header is present and has the right format
      const [, opts] = fetchSpy.mock.calls[0]!;
      const sigHeader = opts.headers['X-HonorClaw-Signature'];
      expect(sigHeader).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    it('handles failed deliveries and logs them', async () => {
      const sub = makeSubscriptionRow();

      fetchSpy.mockResolvedValue({ ok: false, status: 500 });

      db.query
        .mockResolvedValueOnce({ rows: [sub] })   // SELECT subscriptions
        .mockResolvedValue({ rows: [{ consecutive_failures: 1 }] }); // delivery logs + updates

      const event = makeAuditEvent();
      await dispatcher.dispatch(event);

      // Wait for the retries to exhaust (they use setTimeout which we need to handle)
      // Since the test environment processes promises synchronously, we may need
      // to flush timers. However, the retry delays are 30s, 5min, 30min which
      // will timeout in test. Let's verify at least the first attempt was recorded.
      await vi.waitFor(() => {
        const deliveryCalls = db.query.mock.calls.filter(
          (c: any) => typeof c[0] === 'string' && c[0].includes('webhook_deliveries'),
        );
        expect(deliveryCalls.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('records SSRF-blocked deliveries as failures', async () => {
      mockedValidateUrl.mockResolvedValue({ valid: false, reason: 'Private IP address' });

      const sub = makeSubscriptionRow();
      db.query
        .mockResolvedValueOnce({ rows: [sub] })
        .mockResolvedValue({ rows: [{ consecutive_failures: 1 }] });

      const event = makeAuditEvent();
      await dispatcher.dispatch(event);

      await vi.waitFor(() => {
        const deliveryCalls = db.query.mock.calls.filter(
          (c: any) => typeof c[0] === 'string' && c[0].includes('webhook_deliveries'),
        );
        expect(deliveryCalls.length).toBeGreaterThanOrEqual(1);
        // The error should mention SSRF
        const errorParam = deliveryCalls[0]![1]![5];
        expect(errorParam).toContain('SSRF blocked');
      });

      // fetch should never have been called
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
