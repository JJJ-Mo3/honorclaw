import type { SecretsProvider } from './secrets.js';
import type { IdentityProvider } from './identity.js';
import type { EncryptionProvider } from './encryption.js';
import type { AuditSink } from './audit.js';
import type { StorageProvider } from './storage.js';
import type { MemoryStore } from './memory.js';
import type { QueueProvider } from './queue.js';
import type { ComputeProvider } from './compute.js';
import type { OutputFilterProvider } from './output-filter.js';
import type { BudgetProvider } from './budget.js';
import type { EmbeddingService } from './embeddings.js';

export interface Providers {
  secrets: SecretsProvider;
  identity: IdentityProvider;
  encryption: EncryptionProvider;
  audit: AuditSink;
  storage: StorageProvider;
  memory: MemoryStore;
  queue: QueueProvider;
  compute: ComputeProvider;
  outputFilter: OutputFilterProvider;
  budget: BudgetProvider;
  embeddings: EmbeddingService;
}

export * from './secrets.js';
export * from './identity.js';
export * from './encryption.js';
export * from './audit.js';
export * from './storage.js';
export * from './memory.js';
export * from './queue.js';
export * from './compute.js';
export * from './output-filter.js';
export * from './budget.js';
export * from './embeddings.js';
