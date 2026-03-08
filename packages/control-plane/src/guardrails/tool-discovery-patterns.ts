export const TOOL_DISCOVERY_PATTERNS_VERSION = '1.0.0';

export const TOOL_DISCOVERY_PATTERNS: RegExp[] = [
  /what\s+tools?\s+(?:do\s+you|can\s+you|are\s+you\s+able\s+to)\s+(?:use|have|access)/i,
  /(?:list|show|enumerate|print|output)\s+(?:\w+\s+)*(?:tools?|functions?|commands?|capabilities)/i,
  /what\s+(?:apis?|integrations?|functions?|commands?)\s+(?:do\s+you|can\s+you)\s+(?:access|call|use|execute)/i,
  /(?:what|which)\s+(?:tool|function|command|api)\s+(?:would\s+you|do\s+you)\s+use\s+to/i,
  /(?:show|list|enumerate|describe)\s+(?:\w+\s+)*(?:tool|function|api|command)\s+(?:names?|list|schema)/i,
];
