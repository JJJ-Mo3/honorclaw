/**
 * Model family knowledge base for HonorClaw model migrations.
 *
 * Defines characteristics of supported model families including
 * tool call format, context window, known sensitivities, and
 * rate limit expectations.
 */

export interface ModelFamily {
  /** Model family identifier. */
  family: string;
  /** Display name. */
  displayName: string;
  /** Context window size in tokens. */
  contextWindow: number;
  /** Maximum output tokens. */
  maxOutputTokens?: number;
  /** Tool call format used by this model family. */
  toolCallFormat: 'openai' | 'anthropic' | 'google' | 'native_json';
  /** Whether the model supports forced JSON/structured output. */
  supportsStructuredOutput: boolean;
  /** Whether the model supports system prompts. */
  supportsSystemPrompt: boolean;
  /** Whether the model supports image inputs. */
  supportsVision: boolean;
  /** Typical requests-per-minute limit (for rate limit guidance). */
  typicalRpmLimit?: number;
  /** Known sensitivities and behavioral notes. */
  knownSensitivities: string[];
  /** Model identifiers that belong to this family. */
  models: string[];
}

export const MODEL_FAMILIES: Record<string, ModelFamily> = {
  claude: {
    family: 'claude',
    displayName: 'Anthropic Claude',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    toolCallFormat: 'anthropic',
    supportsStructuredOutput: true,
    supportsSystemPrompt: true,
    supportsVision: true,
    typicalRpmLimit: 50_000,
    knownSensitivities: [
      'Claude may refuse tasks it considers potentially harmful, even with explicit tool permissions.',
      'Long system prompts can reduce effective context for conversation history.',
      'Claude prefers explicit tool use instructions over implicit function calling.',
    ],
    models: [
      'claude-3-5-sonnet',
      'claude-3-5-haiku',
      'claude-3-opus',
      'claude-3-sonnet',
      'claude-3-haiku',
      'claude-opus-4',
    ],
  },

  gpt: {
    family: 'gpt',
    displayName: 'OpenAI GPT',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    toolCallFormat: 'openai',
    supportsStructuredOutput: true,
    supportsSystemPrompt: true,
    supportsVision: true,
    typicalRpmLimit: 80_000,
    knownSensitivities: [
      'GPT-4o may truncate very long tool call arguments silently.',
      'JSON mode requires explicit instruction in the prompt to produce valid JSON.',
      'Parallel tool calling can produce inconsistent parameter ordering.',
    ],
    models: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
      'o1',
      'o1-mini',
      'o3',
      'o3-mini',
    ],
  },

  llama: {
    family: 'llama',
    displayName: 'Meta Llama',
    contextWindow: 128_000,
    maxOutputTokens: 4_096,
    toolCallFormat: 'native_json',
    supportsStructuredOutput: false,
    supportsSystemPrompt: true,
    supportsVision: true,
    typicalRpmLimit: undefined, // Self-hosted, varies by deployment
    knownSensitivities: [
      'Tool call formatting varies by serving framework (vLLM, TGI, Ollama).',
      'Llama models may hallucinate tool names or parameters not in the schema.',
      'Context window utilization above 80% can degrade response quality.',
      'Function calling reliability decreases with many (>10) available tools.',
    ],
    models: [
      'llama-3.3-70b',
      'llama-3.1-405b',
      'llama-3.1-70b',
      'llama-3.1-8b',
      'llama-3-70b',
      'llama-3-8b',
    ],
  },

  mistral: {
    family: 'mistral',
    displayName: 'Mistral AI',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    toolCallFormat: 'openai',
    supportsStructuredOutput: true,
    supportsSystemPrompt: true,
    supportsVision: false,
    typicalRpmLimit: 60_000,
    knownSensitivities: [
      'Mistral Large supports tool use but smaller models have limited function calling.',
      'JSON mode output may include trailing whitespace or newlines.',
      'System prompt instructions are sometimes partially ignored in long conversations.',
    ],
    models: [
      'mistral-large',
      'mistral-medium',
      'mistral-small',
      'mixtral-8x22b',
      'mixtral-8x7b',
      'codestral',
    ],
  },

  gemma: {
    family: 'gemma',
    displayName: 'Google Gemma',
    contextWindow: 8_192,
    maxOutputTokens: 2_048,
    toolCallFormat: 'native_json',
    supportsStructuredOutput: false,
    supportsSystemPrompt: true,
    supportsVision: false,
    typicalRpmLimit: undefined, // Self-hosted
    knownSensitivities: [
      'Gemma models have limited tool calling support — requires careful prompt engineering.',
      'Small context window (8K) limits complex multi-turn agent conversations.',
      'Best suited for lightweight, single-purpose agents with few tools.',
      'Does not support parallel tool calls.',
    ],
    models: [
      'gemma-2-27b',
      'gemma-2-9b',
      'gemma-2-2b',
      'gemma-7b',
      'gemma-2b',
    ],
  },

  gemini: {
    family: 'gemini',
    displayName: 'Google Gemini',
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    toolCallFormat: 'google',
    supportsStructuredOutput: true,
    supportsSystemPrompt: true,
    supportsVision: true,
    typicalRpmLimit: 60_000,
    knownSensitivities: [
      'Gemini uses a different tool call format (google) that requires function declaration translation.',
      'Very large context window (1M) may lead to high costs if not managed.',
      'Grounding features may conflict with HonorClaw RAG pipelines.',
    ],
    models: [
      'gemini-2.0-flash',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
    ],
  },
};

/**
 * Look up the model family for a given model identifier.
 * Returns undefined if the model is not recognized.
 */
export function getModelFamily(modelId: string): ModelFamily | undefined {
  const normalized = modelId.toLowerCase();

  for (const family of Object.values(MODEL_FAMILIES)) {
    if (family.models.some((m) => normalized.includes(m) || m.includes(normalized))) {
      return family;
    }
  }

  // Try prefix matching as a fallback
  for (const family of Object.values(MODEL_FAMILIES)) {
    if (normalized.startsWith(family.family)) {
      return family;
    }
  }

  return undefined;
}

/**
 * List all known model families.
 */
export function listModelFamilies(): ModelFamily[] {
  return Object.values(MODEL_FAMILIES);
}
