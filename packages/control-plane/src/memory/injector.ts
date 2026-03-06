import type { Pool } from 'pg';
import type { EmbeddingService } from '@honorclaw/core';
import { query as vectorQuery } from './vector-query.js';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryInjectorOpts {
  pool: Pool;
  embeddings: EmbeddingService;
  indexName?: string;
  /** Maximum tokens to inject into system prompt (default 500) */
  tokenBudget?: number;
  /** Top-K results from vector search (default 5) */
  topK?: number;
}

export interface InjectionResult {
  injected: boolean;
  contextSnippet: string;
  tokensUsed: number;
  retrievalMs: number;
}

const CHARS_PER_TOKEN = 4;

// ---------------------------------------------------------------------------
// MemoryInjector
// ---------------------------------------------------------------------------

export class MemoryInjector {
  private pool: Pool;
  private embeddings: EmbeddingService;
  private indexName: string;
  private tokenBudget: number;
  private topK: number;

  constructor(opts: MemoryInjectorOpts) {
    this.pool = opts.pool;
    this.embeddings = opts.embeddings;
    this.indexName = opts.indexName ?? 'memories';
    this.tokenBudget = opts.tokenBudget ?? 500;
    this.topK = opts.topK ?? 5;
  }

  /**
   * Before each LLM call: embed the current user message, query the vector
   * store, and return context to inject into the system prompt.
   *
   * Short-circuits with 0ms overhead if the index table does not exist.
   */
  async inject(
    workspaceId: string,
    agentId: string,
    currentMessage: string,
  ): Promise<InjectionResult> {
    const start = Date.now();

    // Short-circuit: check if table exists
    const tableCheck = await this.pool.query(
      `SELECT to_regclass($1) AS tbl`,
      [this.indexName],
    );
    if (!tableCheck.rows[0]?.tbl) {
      return { injected: false, contextSnippet: '', tokensUsed: 0, retrievalMs: 0 };
    }

    try {
      const queryEmbedding = await this.embeddings.embed(currentMessage);

      const results = await vectorQuery(
        this.pool,
        this.indexName,
        { workspaceId, agentId },
        queryEmbedding,
        this.topK,
      );

      if (results.length === 0) {
        return { injected: false, contextSnippet: '', tokensUsed: 0, retrievalMs: Date.now() - start };
      }

      // Build context string within token budget
      const maxChars = this.tokenBudget * CHARS_PER_TOKEN;
      const snippets: string[] = [];
      let usedChars = 0;

      for (const result of results) {
        const entry = `[score=${result.score.toFixed(3)}] ${result.content}`;
        if (usedChars + entry.length > maxChars) {
          // Fit partial if it's the first snippet
          if (snippets.length === 0) {
            snippets.push(entry.slice(0, maxChars));
            usedChars = maxChars;
          }
          break;
        }
        snippets.push(entry);
        usedChars += entry.length;
      }

      const contextSnippet = `<memory_context>\n${snippets.join('\n---\n')}\n</memory_context>`;
      const tokensUsed = Math.ceil(contextSnippet.length / CHARS_PER_TOKEN);

      logger.debug({ workspaceId, agentId, tokensUsed, results: results.length }, 'Memory context injected');

      return {
        injected: true,
        contextSnippet,
        tokensUsed,
        retrievalMs: Date.now() - start,
      };
    } catch (err) {
      logger.warn({ err, workspaceId, agentId }, 'Memory injection failed — skipping');
      return { injected: false, contextSnippet: '', tokensUsed: 0, retrievalMs: Date.now() - start };
    }
  }
}
