import { readFileSync, existsSync } from 'node:fs';
import { parse as yamlParse } from 'yaml';
import { HonorClawConfigSchema, type HonorClawConfig } from '@honorclaw/core';

export function loadConfig(): HonorClawConfig {
  const configPaths = [
    process.env.HONORCLAW_CONFIG,
    '/data/honorclaw.yaml',
    './honorclaw.yaml',
  ].filter(Boolean) as string[];

  for (const path of configPaths) {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8');
      const parsed = yamlParse(raw);
      return HonorClawConfigSchema.parse(parsed);
    }
  }

  // Default config
  return HonorClawConfigSchema.parse({});
}
