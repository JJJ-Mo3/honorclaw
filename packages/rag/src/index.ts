// RAG Pipeline — chunking, embedding, vector search, ingestion
export { OllamaEmbeddings, OpenAiEmbeddings, BedrockTitanEmbeddings } from './embeddings.js';
export { chunkText } from './chunker.js';
export type { ChunkOptions, Chunk } from './chunker.js';
export { createIndex, upsert, query, deleteBySource } from './vector-store.js';
export type { VectorRow, VectorScope, VectorSearchResult } from './vector-store.js';
export { ingest } from './ingest.js';
export type { IngestOptions, IngestResult } from './ingest.js';
