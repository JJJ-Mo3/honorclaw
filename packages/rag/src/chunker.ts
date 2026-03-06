// ---------------------------------------------------------------------------
// Document text chunking
// ---------------------------------------------------------------------------

export interface ChunkOptions {
  strategy?: 'recursive' | 'fixed' | 'sentence';
  /** Maximum tokens per chunk (1 token ~ 4 chars) */
  size?: number;
  /** Overlap tokens between consecutive chunks */
  overlap?: number;
}

export interface Chunk {
  index: number;
  text: string;
  tokenEstimate: number;
}

const CHARS_PER_TOKEN = 4;
const DEFAULT_SIZE = 512;
const DEFAULT_OVERLAP = 50;

function toChars(tokens: number): number {
  return tokens * CHARS_PER_TOKEN;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Split `text` by the first separator that produces > 1 segment. */
function splitRecursive(text: string, maxChars: number): string[] {
  const separators = ['\n\n', '\n', '. ', ' '];

  for (const sep of separators) {
    const parts = text.split(sep);
    if (parts.length <= 1) continue;

    const merged: string[] = [];
    let buf = '';

    for (const part of parts) {
      const candidate = buf ? buf + sep + part : part;
      if (candidate.length > maxChars && buf) {
        merged.push(buf);
        buf = part;
      } else {
        buf = candidate;
      }
    }
    if (buf) merged.push(buf);

    if (merged.length > 1) return merged;
  }

  // Nothing could split it further — return as-is
  return [text];
}

export function chunkText(text: string, opts?: ChunkOptions): Chunk[] {
  const strategy = opts?.strategy ?? 'recursive';
  const maxTokens = opts?.size ?? DEFAULT_SIZE;
  const overlapTokens = opts?.overlap ?? DEFAULT_OVERLAP;
  const maxChars = toChars(maxTokens);
  const overlapChars = toChars(overlapTokens);

  let rawSegments: string[];

  switch (strategy) {
    case 'fixed': {
      rawSegments = [];
      let start = 0;
      while (start < text.length) {
        rawSegments.push(text.slice(start, start + maxChars));
        start += maxChars - overlapChars;
      }
      break;
    }
    case 'sentence': {
      const sentenceRe = /(?<=[.!?])\s+/;
      const sentences = text.split(sentenceRe).filter(Boolean);
      rawSegments = [];
      let buf = '';
      for (const sentence of sentences) {
        if ((buf + ' ' + sentence).length > maxChars && buf) {
          rawSegments.push(buf.trim());
          // overlap: keep tail of previous buf
          const tail = buf.slice(-overlapChars);
          buf = tail + ' ' + sentence;
        } else {
          buf = buf ? buf + ' ' + sentence : sentence;
        }
      }
      if (buf.trim()) rawSegments.push(buf.trim());
      break;
    }
    case 'recursive':
    default: {
      rawSegments = splitRecursive(text, maxChars);
      break;
    }
  }

  return rawSegments.map((seg, i) => ({
    index: i,
    text: seg,
    tokenEstimate: estimateTokens(seg),
  }));
}
