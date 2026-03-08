import type { QueueProvider, QueueMessage, Subscription } from '@honorclaw/core';
import type { Redis } from 'ioredis';

export class RedisStreamsQueueProvider implements QueueProvider {
  private redis: Redis;
  private consumerGroup = 'honorclaw';
  private consumerId: string;

  constructor(redis: Redis) {
    this.redis = redis;
    this.consumerId = `consumer-${process.pid}-${Date.now()}`;
  }

  async publish(subject: string, payload: unknown): Promise<void> {
    await this.redis.xadd(
      `stream:${subject}`,
      '*',
      'data', JSON.stringify(payload),
      'timestamp', new Date().toISOString(),
    );
  }

  async subscribe(subject: string, handler: (msg: QueueMessage) => Promise<void>): Promise<Subscription> {
    const streamKey = `stream:${subject}`;

    // Create consumer group if it doesn't exist
    try {
      await this.redis.xgroup('CREATE', streamKey, this.consumerGroup, '0', 'MKSTREAM');
    } catch {
      // Group already exists
    }

    let running = true;
    const poll = async () => {
      while (running) {
        try {
          const results = await this.redis.xreadgroup(
            'GROUP', this.consumerGroup, this.consumerId,
            'COUNT', '10', 'BLOCK', '5000',
            'STREAMS', streamKey, '>',
          ) as any;

          if (!results) continue;

          for (const [, messages] of results) {
            for (const [id, fields] of messages) {
              const data = JSON.parse(fields[1]); // fields = ['data', jsonString, 'timestamp', ts]
              await handler({
                subject,
                data,
                timestamp: new Date(fields[3] ?? Date.now()),
              });
              await this.redis.xack(streamKey, this.consumerGroup, id);
            }
          }
        } catch {
          if (running) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }
      }
    };

    poll();

    return {
      unsubscribe: async () => {
        running = false;
      },
    };
  }
}
