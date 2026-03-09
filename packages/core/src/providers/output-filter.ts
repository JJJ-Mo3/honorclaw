export interface FilterFinding {
  type: string;
  pattern: string;
  start: number;
  end: number;
}

export interface FilterContext {
  workspaceId: string;
  agentId: string;
  blockedOutputPatterns?: string[];
  maxResponseTokens?: number;
}

export interface OutputFilterProvider {
  filter(text: string, context: FilterContext): Promise<{ filtered: string; findings: FilterFinding[] }>;
}
