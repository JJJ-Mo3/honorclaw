import { z } from 'zod';

export type WebhookEventType =
  | 'session.started'
  | 'session.ended'
  | 'tool_call.completed'
  | 'tool_call.failed'
  | 'policy_violation'
  | 'approval.requested'
  | 'approval.resolved'
  | 'escalation.triggered'
  | 'agent.error'
  | 'budget.alert'
  | 'manifest.updated';

export const WebhookEventTypes: WebhookEventType[] = [
  'session.started',
  'session.ended',
  'tool_call.completed',
  'tool_call.failed',
  'policy_violation',
  'approval.requested',
  'approval.resolved',
  'escalation.triggered',
  'agent.error',
  'budget.alert',
  'manifest.updated',
];

export interface SessionStartedData {
  user_id: string;
  agent_name: string;
  channel: string;
}

export interface SessionEndedData {
  user_id: string;
  agent_name: string;
  duration_ms: number;
  total_turns: number;
  total_tokens: number;
}

export interface ToolCallCompletedData {
  tool_name: string;
  duration_ms: number;
  exit_code: number;
}

export interface ToolCallFailedData {
  tool_name: string;
  error_code: string;
  error_message: string;
}

export interface PolicyViolationData {
  violation_type: string;
  rule: string;
  input_hash: string;
  action_taken: 'blocked' | 'flagged';
}

export interface ApprovalRequestedData {
  tool_name: string;
  parameters_summary: string;
  requested_by_agent: string;
}

export interface ApprovalResolvedData {
  tool_name: string;
  decision: 'approved' | 'rejected';
  decided_by: string;
}

export interface EscalationTriggeredData {
  reason: string;
  confidence?: number;
  conversation_summary: string;
}

export interface AgentErrorData {
  error_type: string;
  error_message: string;
  agent_name: string;
}

export interface BudgetAlertData {
  agent_name: string;
  current_usage: number;
  budget_limit: number;
  period: string;
}

export interface ManifestUpdatedData {
  agent_name: string;
  version: number;
  changed_by: string;
  changes_summary: string;
}

export interface WebhookEventDataMap {
  'session.started': SessionStartedData;
  'session.ended': SessionEndedData;
  'tool_call.completed': ToolCallCompletedData;
  'tool_call.failed': ToolCallFailedData;
  'policy_violation': PolicyViolationData;
  'approval.requested': ApprovalRequestedData;
  'approval.resolved': ApprovalResolvedData;
  'escalation.triggered': EscalationTriggeredData;
  'agent.error': AgentErrorData;
  'budget.alert': BudgetAlertData;
  'manifest.updated': ManifestUpdatedData;
}

export interface WebhookPayload<T extends WebhookEventType = WebhookEventType> {
  id: string;
  type: T;
  workspace_id: string;
  agent_id?: string;
  session_id?: string;
  timestamp: string;
  data: T extends keyof WebhookEventDataMap ? WebhookEventDataMap[T] : unknown;
}

export const WebhookSubscriptionSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  url: z.string().url(),
  event_types: z.array(z.string()),
  enabled: z.boolean().default(true),
  signing_secret_encrypted: z.string(),
  created_at: z.string().datetime(),
  last_delivered_at: z.string().datetime().nullable(),
  consecutive_failures: z.number().int().default(0),
});

export type WebhookSubscription = z.infer<typeof WebhookSubscriptionSchema>;
