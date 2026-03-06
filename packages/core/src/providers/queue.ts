export interface QueueMessage {
  subject: string;
  data: unknown;
  timestamp: Date;
}

export interface Subscription {
  unsubscribe(): Promise<void>;
}

export interface QueueProvider {
  publish(subject: string, payload: unknown): Promise<void>;
  subscribe(subject: string, handler: (msg: QueueMessage) => Promise<void>): Promise<Subscription>;
}
