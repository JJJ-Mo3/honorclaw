export const RedisChannels = {
  agentInput: (sessionId: string) => `agent:${sessionId}:input`,
  agentOutput: (sessionId: string) => `agent:${sessionId}:output`,
  agentError: (sessionId: string) => `agent:${sessionId}:error`,
  agentState: (sessionId: string) => `agent:${sessionId}:state`,
  toolRequest: (sessionId: string, callId: string) => `tools:${sessionId}:request:${callId}`,
  toolResult: (sessionId: string, callId: string) => `tools:${sessionId}:result:${callId}`,
  llmRequest: (sessionId: string) => `llm:${sessionId}:request`,
  llmResponse: (sessionId: string) => `llm:${sessionId}:response`,
  llmStream: (sessionId: string, correlationId: string) => `llm:${sessionId}:stream:${correlationId}`,
  sessionControl: (sessionId: string) => `session:${sessionId}:control`,
  sessionState: (sessionId: string) => `session:${sessionId}:state`,
  sessionTokens: (sessionId: string) => `session:${sessionId}:tokens`,
} as const;
