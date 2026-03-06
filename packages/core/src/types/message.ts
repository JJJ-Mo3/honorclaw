import { z } from 'zod';

export const TextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const ImageContentSchema = z.object({
  type: z.literal('image_url'),
  url: z.string().url(),
  detail: z.enum(['auto', 'low', 'high']).optional(),
});

export const ContentPartSchema = z.discriminatedUnion('type', [
  TextContentSchema,
  ImageContentSchema,
]);

export const MessageContentSchema = z.union([z.string(), z.array(ContentPartSchema)]);

export const ToolCallRequestSchema = z.object({
  id: z.string(),
  tool_name: z.string(),
  parameters: z.record(z.unknown()),
});

export const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: MessageContentSchema,
  tool_calls: z.array(ToolCallRequestSchema).optional(),
  tool_call_id: z.string().optional(),
});

export type TextContent = z.infer<typeof TextContentSchema>;
export type ImageContent = z.infer<typeof ImageContentSchema>;
export type ContentPart = z.infer<typeof ContentPartSchema>;
export type MessageContent = z.infer<typeof MessageContentSchema>;
export type ToolCallRequest = z.infer<typeof ToolCallRequestSchema>;
export type Message = z.infer<typeof MessageSchema>;
