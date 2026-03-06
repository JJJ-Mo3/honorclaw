import type { Pool } from 'pg';
import type { EmbeddingService } from '@honorclaw/core';
import crypto from 'node:crypto';
import { chunkText } from './chunker.js';
import type { ChunkOptions } from './chunker.js';
import { deleteBySource, upsert } from './vector-store.js';
import type { VectorRow, VectorScope } from './vector-store.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IngestOptions {
  pool: Pool;
  indexName: string;
  scope: VectorScope;
  embeddings: EmbeddingService;
  /** Original filename or URI (used for logging / metadata) */
  sourceName?: string;
  chunkOptions?: ChunkOptions;
}

export interface IngestResult {
  chunks: number;
  sourceHash: string;
}

// ---------------------------------------------------------------------------
// Format detection & text extraction
// ---------------------------------------------------------------------------

function detectFormat(source: string | Buffer, sourceName?: string): 'text' | 'pdf' {
  if (Buffer.isBuffer(source)) {
    // PDF magic bytes: %PDF
    if (source.length >= 4 && source[0] === 0x25 && source[1] === 0x50 && source[2] === 0x44 && source[3] === 0x46) {
      return 'pdf';
    }
  }
  if (sourceName?.endsWith('.pdf')) return 'pdf';
  return 'text';
}

async function extractText(source: string | Buffer, sourceName?: string): Promise<string> {
  const format = detectFormat(source, sourceName);

  if (format === 'pdf' && Buffer.isBuffer(source)) {
    // Dynamic import to keep pdf-parse optional at load time
    const pdfParse = (await import('pdf-parse')).default;
    const result = await pdfParse(source);
    return result.text;
  }

  return typeof source === 'string' ? source : source.toString('utf-8');
}

// ---------------------------------------------------------------------------
// Ingest pipeline
// ---------------------------------------------------------------------------

/**
 * Idempotent document ingestion pipeline.
 * detect format -> extract text -> SHA-256 hash -> deleteBySource -> chunk -> embed -> upsert
 */
export async function ingest(
  source: string | Buffer,
  opts: IngestOptions,
): Promise<IngestResult> {
  const { pool, indexName, scope, embeddings, sourceName, chunkOptions } = opts;

  // 1. Extract text
  const text = await extractText(source, sourceName);

  // 2. Compute SHA-256 hash for idempotency
  const sourceHash = crypto
    .createHash('sha256')
    .update(typeof source === 'string' ? source : source)
    .digest('hex');

  // 3. Remove previous chunks for the same source (idempotent re-ingest)
  await deleteBySource(pool, indexName, scope, sourceHash);

  // 4. Chunk
  const chunks = chunkText(text, chunkOptions);

  if (chunks.length === 0) {
    return { chunks: 0, sourceHash };
  }

  // 5. Embed all chunks
  const rows: VectorRow[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const embedding = await embeddings.embed(chunk.text);
    rows.push({
      id: crypto.randomUUID(),
      content: chunk.text,
      embedding,
      metadata: {
        workspace_id: scope.workspaceId,
        agent_id: scope.agentId,
        source_hash: sourceHash,
        source_name: sourceName ?? 'unknown',
        chunk_index: chunk.index,
        token_estimate: chunk.tokenEstimate,
      },
    });
  }

  // 6. Upsert
  await upsert(pool, indexName, rows);

  return { chunks: rows.length, sourceHash };
}
