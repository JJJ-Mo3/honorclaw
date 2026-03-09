/**
 * Multi-turn injection detector.
 *
 * Scores a conversation for patterns that indicate a prompt-injection
 * attack spread across multiple user messages. Heuristic-based — no LLM
 * call required.
 */

export interface MultiTurnResult {
  blocked: boolean;
  score: number;
  indicators: string[];
  reason?: string;
}

interface Message {
  role: string;
  content: string;
}

const AUTHORITY_ESCALATION_PATTERNS = [
  /can you (ignore|bypass|override|disable|skip|turn off)/i,
  /you (must|should|have to|need to) (do|comply|obey|follow)/i,
  /i('m| am) (your|an?) (admin|administrator|developer|creator|owner|root)/i,
  /you (agreed|promised|said you would|confirmed)/i,
  /remember (you|what|that) (said|agreed|promised)/i,
  /as (we|I) (discussed|agreed)/i,
];

const BOUNDARY_TESTING_PATTERNS = [
  /what (happens|would happen) if (you|I|we)/i,
  /are you (able|allowed|permitted) to/i,
  /what are your (limits|restrictions|boundaries|constraints)/i,
  /can you (really|actually|truly) not/i,
  /just (this once|between us|for me)/i,
];

const ROLE_CONFUSION_PATTERNS = [
  /\[system\]/i,
  /\[admin\]/i,
  /\[developer\]/i,
  /<system>/i,
  /<assistant>/i,
  /<admin>/i,
  /system:\s/i,
  /assistant:\s/i,
];

const INSTRUCTION_ANCHORING_PATTERNS = [
  /you (already|previously) (agreed|said|confirmed)/i,
  /we (already|just) (established|agreed|decided)/i,
  /you said (yes|okay|sure|of course|you would)/i,
  /earlier you (said|mentioned|told me|agreed)/i,
];

/**
 * Analyse a conversation for multi-turn injection patterns.
 *
 * @param messages  Full conversation (including system/assistant messages).
 * @param threshold Score above which the conversation is blocked (0.0–1.0).
 */
export function checkMultiTurnInjection(
  messages: Message[],
  threshold = 0.7,
): MultiTurnResult {
  // Only analyse conversations with 3+ user messages — short exchanges always pass.
  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length < 3) {
    return { blocked: false, score: 0, indicators: [] };
  }

  let score = 0;
  const indicators: string[] = [];

  // --- 1. Authority escalation ---
  const authorityHits = countPatternHits(userMessages, AUTHORITY_ESCALATION_PATTERNS);
  if (authorityHits >= 2) {
    score += 0.3;
    indicators.push(`authority_escalation(${authorityHits})`);
  }

  // --- 2. Boundary testing ---
  const boundaryHits = countPatternHits(userMessages, BOUNDARY_TESTING_PATTERNS);
  if (boundaryHits >= 2) {
    score += 0.25;
    indicators.push(`boundary_testing(${boundaryHits})`);
  }

  // --- 3. Instruction anchoring ---
  const anchoringHits = countPatternHits(userMessages, INSTRUCTION_ANCHORING_PATTERNS);
  if (anchoringHits >= 1) {
    score += 0.3;
    indicators.push(`instruction_anchoring(${anchoringHits})`);
  }

  // --- 4. Role confusion (user message contains role tags) ---
  const roleHits = countPatternHits(userMessages, ROLE_CONFUSION_PATTERNS);
  if (roleHits >= 1) {
    score += 0.35;
    indicators.push(`role_confusion(${roleHits})`);
  }

  // Clamp score to 1.0
  score = Math.min(score, 1.0);

  const blocked = score >= threshold;
  return {
    blocked,
    score,
    indicators,
    reason: blocked
      ? `Multi-turn injection detected (score=${score.toFixed(2)}, threshold=${threshold})`
      : undefined,
  };
}

function countPatternHits(messages: Message[], patterns: RegExp[]): number {
  let hits = 0;
  for (const msg of messages) {
    for (const pattern of patterns) {
      if (pattern.test(msg.content)) {
        hits++;
        break; // count at most once per message per category
      }
    }
  }
  return hits;
}
