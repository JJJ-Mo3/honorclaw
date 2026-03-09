import { z } from 'zod';

export const ServerConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().default('0.0.0.0'),
  corsOrigins: z.array(z.string()).default(['http://localhost:3000']),
  sessionCookieSecret: z.string().optional(),
});

export const DatabaseConfigSchema = z.object({
  socket: z.string().optional(),
  name: z.string().default('honorclaw'),
  poolSize: z.number().default(10),
  url: z.string().optional(),
});

export const RedisConfigSchema = z.object({
  socket: z.string().optional(),
  password: z.string().optional(),
  url: z.string().optional(),
});

export const LlmProviderConfigSchema = z.object({
  baseUrl: z.string().optional(),
  enabled: z.boolean().default(true),
  apiKeySecret: z.string().optional(),
  accessTokenSecret: z.string().optional(),
  authMode: z.enum(['api_key', 'iam', 'service_account']).optional(),
});

export const LlmConfigSchema = z.object({
  defaultModel: z.string().default('ollama/llama3.2'),
  providers: z.record(LlmProviderConfigSchema).default({}),
});

export const EmbeddingsConfigSchema = z.object({
  provider: z.string().default('ollama'),
  model: z.string().default('nomic-embed-text'),
  apiKeySecret: z.string().optional(),
});

export const SecurityConfigSchema = z.object({
  mode: z.enum(['dev', 'namespace', 'full']).default('namespace'),
});

export const AuthConfigSchema = z.object({
  jwtIssuer: z.string().default('honorclaw'),
  accessTokenTtlMinutes: z.number().default(60),
  refreshTokenTtlDays: z.number().default(7),
  mfaRequired: z.boolean().default(false),
});

export const StorageConfigSchema = z.object({
  type: z.string().default('local'),
  root: z.string().default('/data/storage'),
  bucket: z.string().optional(),
  region: z.string().optional(),
  credentialsSecret: z.string().optional(),
});

export const ToolsConfigSchema = z.object({
  timeoutSeconds: z.number().default(30),
  registries: z.array(z.object({
    type: z.string(),
    topic: z.string().optional(),
    url: z.string().optional(),
    authSecret: z.string().optional(),
  })).default([{ type: 'local' }]),
});

export const HonorClawConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  database: DatabaseConfigSchema.default({}),
  redis: RedisConfigSchema.default({}),
  llm: LlmConfigSchema.default({}),
  embeddings: EmbeddingsConfigSchema.default({}),
  security: SecurityConfigSchema.default({}),
  auth: AuthConfigSchema.default({}),
  storage: StorageConfigSchema.default({}),
  tools: ToolsConfigSchema.default({}),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;
export type RedisConfig = z.infer<typeof RedisConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type EmbeddingsConfig = z.infer<typeof EmbeddingsConfigSchema>;
export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type StorageConfig = z.infer<typeof StorageConfigSchema>;
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;
export type HonorClawConfig = z.infer<typeof HonorClawConfigSchema>;
