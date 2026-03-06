export const PROMPT_EXTRACTION_PATTERNS_VERSION = '1.0.0';

export const PROMPT_EXTRACTION_PATTERNS: RegExp[] = [
  /(?:show|tell|reveal|print|output|repeat|display|give\s+me)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+)?prompt/i,
  /what\s+(?:are|were)\s+your\s+(?:original\s+|initial\s+)?instructions/i,
  /(?:output|print|display|repeat|write\s+out)\s+(?:everything|all)\s+(?:before|above|in\s+your\s+context)/i,
  /what\s+(?:did|does)\s+your\s+(?:system\s+prompt|context|configuration)\s+say/i,
  /summarize\s+(?:your|the)\s+(?:system\s+)?(?:prompt|instructions|context)/i,
  /(?:copy|paste|transcribe)\s+(?:your|the)\s+(?:instructions?|prompt|system\s+message)/i,
  /translate\s+(?:your|the)\s+(?:instructions?|prompt)\s+(?:to|into)/i,
];
