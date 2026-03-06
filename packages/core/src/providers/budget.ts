export interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
}

export interface UsageSummary {
  totalTokens: number;
  totalCostUsd: number;
  byAgent: Record<string, { tokens: number; costUsd: number }>;
}

export interface BudgetCheck {
  allowed: boolean;
  remainingUsd?: number;
  reason?: string;
}

export interface BudgetProvider {
  recordUsage(workspaceId: string, agentId: string, usage: UsageRecord): Promise<void>;
  getUsage(workspaceId: string, agentId: string | undefined, period: 'hour' | 'day' | 'week' | 'month'): Promise<UsageSummary>;
  checkBudget(workspaceId: string, agentId: string): Promise<BudgetCheck>;
}
