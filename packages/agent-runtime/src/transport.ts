import { Redis } from 'ioredis';
import type { Logger } from 'pino';

type MessageHandler = (data: unknown) => Promise<void>;

export class Transport {
  private sub: Redis;
  private pub: Redis;
  private client: Redis;
  private handlers = new Map<string, MessageHandler>();
  private logger: Logger;

  constructor(redisUrl: string, logger: Logger) {
    this.logger = logger;
    const opts = { retryStrategy: (times: number) => Math.min(times * 1000, 30_000), lazyConnect: true };
    this.sub = new Redis(redisUrl, opts);
    this.pub = new Redis(redisUrl, opts);
    this.client = new Redis(redisUrl, opts);
  }

  async connect(): Promise<void> {
    await Promise.all([this.sub.connect(), this.pub.connect(), this.client.connect()]);
    this.sub.on('message', (channel: string, message: string) => {
      const handler = this.handlers.get(channel);
      if (handler) {
        try {
          const data = JSON.parse(message);
          handler(data).catch(err => this.logger.error({ err, channel }, 'Handler error'));
        } catch (err) {
          this.logger.error({ err, channel }, 'Failed to parse message');
        }
      }
    });
    this.logger.info('Redis transport connected');
  }

  async subscribe(channel: string, handler: MessageHandler): Promise<void> {
    this.handlers.set(channel, handler);
    await this.sub.subscribe(channel);
  }

  async publish(channel: string, data: unknown): Promise<void> {
    await this.pub.publish(channel, JSON.stringify(data));
  }

  async blpop(key: string, timeoutSeconds: number): Promise<unknown | null> {
    const result = await this.client.blpop(key, timeoutSeconds);
    if (!result) return null;
    try {
      return JSON.parse(result[1]);
    } catch {
      return result[1];
    }
  }

  async set(key: string, value: string): Promise<void> {
    await this.client.set(key, value);
  }

  async getSessionContext(sessionId: string): Promise<SessionContext | null> {
    const raw = await this.client.get(`session:${sessionId}:context`);
    if (!raw) return null;
    return JSON.parse(raw) as SessionContext;
  }

  async disconnect(): Promise<void> {
    await this.sub.quit();
    await this.pub.quit();
    await this.client.quit();
  }
}

interface SessionContext {
  model: string;
  tools: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>;
  maxTokens: number;
  toolTimeoutSeconds: number;
}
