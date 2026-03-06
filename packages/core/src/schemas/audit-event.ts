import { z } from 'zod';

export const AuditEventTypeSchema = z.enum([
  'auth.login',
  'auth.logout',
  'auth.login_failed',
  'auth.mfa_challenge',
  'auth.token_refresh',
  'auth.sso_login',
  'authorization.permission_check',
  'authorization.role_change',
  'authorization.manifest_update',
  'session.start',
  'session.end',
  'llm.interaction',
  'tool.call',
  'tool.rejected',
  'tool.timeout',
  'tool.error',
  'policy_violation',
  'admin.action',
  'webhook.delivered',
  'webhook.failed',
]);

export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;
