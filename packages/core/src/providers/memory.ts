export interface MemoryResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryStore {
  store(workspaceId: string, agentId: string, content: string, metadata?: Record<string, unknown>): Promise<string>;
  search(workspaceId: string, agentId: string, query: string, topK?: number): Promise<MemoryResult[]>;
  delete(workspaceId: string, agentId: string, memoryId: string): Promise<void>;
}
