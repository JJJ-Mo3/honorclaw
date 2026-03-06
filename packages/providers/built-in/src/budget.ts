import type { BudgetProvider, UsageRecord, UsageSummary, BudgetCheck } from '@honorclaw/core';
import type { Pool } from 'pg';

export class PostgresBudgetProvider implements BudgetProvider {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async recordUsage(workspaceId: string, agentId: string, usage: UsageRecord): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET tokens_used = tokens_used + $1
       WHERE agent_id = (SELECT id FROM agents WHERE id = $2::uuid AND workspace_id = $3::uuid LIMIT 1)
       AND status = 'active'
       ORDER BY started_at DESC LIMIT 1`,
      [usage.promptTokens + usage.completionTokens, agentId, workspaceId],
    );
  }

  async getUsage(workspaceId: string, agentId: string | undefined, period: 'hour' | 'day' | 'week' | 'month'): Promise<UsageSummary> {
    const interval = { hour: '1 hour', day: '1 day', week: '7 days', month: '30 days' }[period];
    const params: unknown[] = [workspaceId, interval];
    let agentFilter = '';
    if (agentId) {
      agentFilter = ' AND s.agent_id = $3::uuid';
      params.push(agentId);
    }

    const result = await this.pool.query(
      `SELECT a.name as agent_name, a.id as agent_id, SUM(s.tokens_used) as total_tokens
       FROM sessions s JOIN agents a ON a.id = s.agent_id
       WHERE s.workspace_id = $1::uuid AND s.started_at >= now() - $2::interval${agentFilter}
       GROUP BY a.id, a.name`,
      params,
    );

    const byAgent: Record<string, { tokens: number; costUsd: number }> = {};
    let totalTokens = 0;
    for (const row of result.rows) {
      const tokens = parseInt(row.total_tokens) || 0;
      totalTokens += tokens;
      byAgent[row.agent_name] = { tokens, costUsd: tokens * 0.000001 }; // rough estimate
    }

    return { totalTokens, totalCostUsd: totalTokens * 0.000001, byAgent };
  }

  async checkBudget(workspaceId: string, agentId: string): Promise<BudgetCheck> {
    // Get manifest budget config
    const result = await this.pool.query(
      `SELECT m.manifest->'budget' as budget FROM capability_manifests m
       WHERE m.agent_id = $1::uuid AND m.workspace_id = $2::uuid
       ORDER BY m.version DESC LIMIT 1`,
      [agentId, workspaceId],
    );

    const budget = result.rows[0]?.budget;
    if (!budget || (!budget.max_tokens_per_day && !budget.max_cost_per_day_usd)) {
      return { allowed: true };
    }

    const usage = await this.getUsage(workspaceId, agentId, 'day');
    if (budget.max_tokens_per_day && usage.totalTokens >= budget.max_tokens_per_day) {
      return { allowed: !budget.hard_stop_on_budget_exceeded, remainingUsd: 0, reason: 'Daily token budget exceeded' };
    }

    return { allowed: true, remainingUsd: (budget.max_cost_per_day_usd ?? 999) - usage.totalCostUsd };
  }
}
