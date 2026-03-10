import { readFileSync, existsSync } from 'node:fs';
import { parse as yamlParse } from 'yaml';
import { HonorClawConfigSchema, type HonorClawConfig } from '@honorclaw/core';

export function loadConfig(): HonorClawConfig {
  const configPaths = [
    process.env.HONORCLAW_CONFIG,
    '/data/honorclaw.yaml',
    './honorclaw.yaml',
  ].filter(Boolean) as string[];

  let parsed: Record<string, unknown> = {};
  for (const path of configPaths) {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      parsed = yamlParse(raw) ?? {};
      break;
    }
  }

  // Allow env vars to override YAML config
  if (process.env.POSTGRES_URL) {
    parsed.database = { ...(parsed.database as Record<string, unknown> ?? {}), url: process.env.POSTGRES_URL };
  }
  if (process.env.REDIS_URL) {
    parsed.redis = { ...(parsed.redis as Record<string, unknown> ?? {}), url: process.env.REDIS_URL };
  }
  if (process.env.OLLAMA_BASE_URL) {
    const llm = (parsed.llm as Record<string, unknown>) ?? {};
    const providers = (llm.providers as Record<string, unknown>) ?? {};
    providers.ollama = { ...(providers.ollama as Record<string, unknown> ?? {}), baseUrl: process.env.OLLAMA_BASE_URL };
    llm.providers = providers;
    parsed.llm = llm;
  }

  if (process.env.SESSION_COOKIE_SECRET) {
    const server = (parsed.server as Record<string, unknown>) ?? {};
    server.sessionCookieSecret = process.env.SESSION_COOKIE_SECRET;
    parsed.server = server;
  }
  // JWT_SECRET is read directly from process.env by auth/plugin.ts (not from config)
  if (process.env.REDIS_SOCKET) {
    parsed.redis = { ...(parsed.redis as Record<string, unknown> ?? {}), socket: process.env.REDIS_SOCKET };
  }
  if (process.env.DATABASE_SOCKET) {
    parsed.database = { ...(parsed.database as Record<string, unknown> ?? {}), socket: process.env.DATABASE_SOCKET };
  }

  return HonorClawConfigSchema.parse(parsed);
}
