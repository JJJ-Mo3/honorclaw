import { z } from 'zod';
import { MessageContentSchema, ToolCallRequestSchema } from '../types/message.js';

export const AgentInputMessageSchema = z.object({
  sessionId: z.string(),
  content: MessageContentSchema,
  senderId: z.string(),
  timestamp: z.string().datetime(),
});

export const LLMRequestSchema = z.object({
  sessionId: z.string(),
  correlationId: z.string(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system', 'tool']),
    content: MessageContentSchema,
    toolCalls: z.array(ToolCallRequestSchema).optional(),
    toolCallId: z.string().optional(),
  })),
  tools: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.unknown()).optional(),
  })).optional(),
  model: z.string(),
  maxTokens: z.number().optional(),
});

export const LLMResponseSchema = z.object({
  sessionId: z.string(),
  correlationId: z.string(),
  content: MessageContentSchema.nullable(),
  toolCalls: z.array(ToolCallRequestSchema).optional(),
  tokensUsed: z.object({
    prompt: z.number(),
    completion: z.number(),
    total: z.number(),
  }),
  model: z.string(),
  finishReason: z.enum(['stop', 'tool_calls', 'length', 'error']),
});

export const ToolCallResultSchema = z.object({
  sessionId: z.string(),
  callId: z.string(),
  status: z.enum(['success', 'error', 'rejected', 'timeout', 'pending_approval']),
  result: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).optional(),
});

export const AgentOutputMessageSchema = z.object({
  sessionId: z.string(),
  content: MessageContentSchema,
  toolResults: z.array(ToolCallResultSchema).optional(),
  timestamp: z.string().datetime(),
});

export const SessionControlSchema = z.object({
  sessionId: z.string(),
  command: z.enum(['drain', 'terminate']),
  reason: z.string().optional(),
});

export type AgentInputMessage = z.infer<typeof AgentInputMessageSchema>;
export type LLMRequest = z.infer<typeof LLMRequestSchema>;
export type LLMResponse = z.infer<typeof LLMResponseSchema>;
export type ToolCallResult = z.infer<typeof ToolCallResultSchema>;
export type AgentOutputMessage = z.infer<typeof AgentOutputMessageSchema>;
export type SessionControl = z.infer<typeof SessionControlSchema>;
