import { z } from 'zod';

export const AuditEventBaseSchema = z.object({
  id: z.string().uuid().optional(),
  workspaceId: z.string().uuid(),
  eventType: z.string(),
  actorType: z.enum(['user', 'agent', 'system']),
  actorId: z.string().optional(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
  createdAt: z.date().optional(),
});

export type AuditEvent = z.infer<typeof AuditEventBaseSchema>;

export interface AuditQueryFilter {
  workspaceId: string;
  eventType?: string;
  actorId?: string;
  agentId?: string;
  sessionId?: string;
  startDate?: Date;
  endDate?: Date;
  cursor?: string;
  limit?: number;
}

export interface AuditQueryResult {
  events: AuditEvent[];
  nextCursor?: string;
  totalCount?: number;
}

export interface AuditSink {
  emit(event: AuditEvent): void;
  flush(): Promise<void>;
  query(filter: AuditQueryFilter): Promise<AuditQueryResult>;
}
