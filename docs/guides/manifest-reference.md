# Capability Manifest Reference

The capability manifest defines the security boundary for an agent — what tools it can use, what parameters are allowed, what domains it can reach, and what guardrails protect it. Every tool call is validated against the manifest before execution.

## Top-Level Fields

```yaml
# Agent identity
name: string                    # Agent name (required)
description: string             # Human-readable description

# LLM configuration
model:
  provider: string              # ollama, anthropic, openai, google, mistral, etc.
  model: string                 # Model name within the provider
  temperature: number           # 0.0-1.0 (default: 0.7)
  maxTokens: number             # Max tokens per LLM response

# Agent behavior
systemPrompt: string            # System prompt (supports multi-line YAML |)

# Security boundary (all optional with secure defaults)
tools: ToolCapability[]
egress: EgressConfig
dataAccess: DataAccess
inputGuardrails: InputGuardrails
outputFilters: OutputFilters
session: SessionConfig
budget: BudgetConfig
llmRateLimits: LlmRateLimits
approvalRules: ApprovalRule[]
allowedSecretPaths: string[]      # Secret paths accessible to this agent (default: [])
```

---

## tools

List of tools the agent can use. Each tool call is validated against these definitions.

```yaml
tools:
  - name: string                # Tool name (required, must match a registered tool)
    source: string              # Tool source/package (optional)
    enabled: boolean            # Enable/disable this tool (default: true)
    requiresApproval: boolean   # Require human approval before execution (default: false)
    parameters:                 # Per-parameter constraints (optional)
      <param_name>:
        type: string            # string, integer, boolean, array, object
        maxLength: number       # Max string length
        min: number             # Min numeric value
        max: number             # Max numeric value
        allowedValues: string[] # Whitelist of allowed values
        allowedPatterns: string[] # Regex patterns that must match
        blockedPatterns: string[] # Regex patterns that must NOT match
        piiFilter: boolean      # Filter PII from this parameter
    rateLimit:                  # Per-tool rate limiting (optional)
      maxCallsPerMinute: number
      maxCallsPerSession: number
```

### Example: Constrained File Operations

```yaml
tools:
  - name: file_ops
    parameters:
      path:
        type: string
        maxLength: 1024
        allowedPatterns:
          - "^/workspace/"         # Only /workspace/ paths
        blockedPatterns:
          - "\\.\\."               # No path traversal
      operation:
        type: string
        allowedValues:
          - read
          - list                   # No write, delete, or mkdir
      content:
        type: string
        maxLength: 100000
        piiFilter: true            # Scrub PII before passing to tool
    rateLimit:
      maxCallsPerMinute: 30
      maxCallsPerSession: 500
```

### Example: Read-Only Database Queries

```yaml
tools:
  - name: database_query
    parameters:
      query:
        type: string
        maxLength: 2000
        blockedPatterns:
          - "\\b(DELETE|DROP|ALTER|INSERT|UPDATE|TRUNCATE)\\b"
          - "\\b(GRANT|REVOKE|CREATE)\\b"
        allowedPatterns:
          - "^SELECT\\b"           # Must start with SELECT
    rateLimit:
      maxCallsPerMinute: 10
```

---

## egress

Controls what external domains the agent's tools can reach.

```yaml
egress:
  allowedDomains: string[]      # Domains tools can access (default: [])
  blockedDomains: string[]      # Domains explicitly blocked (default: [])
  maxResponseSizeBytes: number  # Max response size from external calls (default: 10485760 / 10 MB)
```

### Domain Patterns

- Exact match: `api.github.com`
- Wildcard subdomain: `*.atlassian.net` (matches `acme.atlassian.net`, `foo.atlassian.net`)
- Empty `allowedDomains` = **no external access** (fully offline agent)

### Example: Locked-Down Egress

```yaml
egress:
  allowedDomains:
    - api.github.com
    - "*.atlassian.net"
  blockedDomains:
    - "*.internal.corp"
  maxResponseSizeBytes: 5242880  # 5 MB
```

---

## dataAccess

Controls database and storage access for the agent.

```yaml
dataAccess:
  workspaceId: string                # Workspace scope
  allowedDatabases: string[]         # Database names the agent can query (default: [])
  allowedStoragePrefixes: string[]   # Storage path prefixes (default: [])
  piiColumnsBlocked: string[]        # Column names to redact (default: [])
```

### Example

```yaml
dataAccess:
  workspaceId: "ws-123"
  allowedDatabases:
    - analytics
    - reporting
  allowedStoragePrefixes:
    - "documents/"
    - "reports/"
  piiColumnsBlocked:
    - ssn
    - credit_card
    - phone_number
```

---

## inputGuardrails

Protects against prompt injection and controls input content.

```yaml
inputGuardrails:
  injectionDetection: boolean       # Enable injection pattern detection (default: true)
  blockToolDiscovery: boolean       # Block "what tools do you have?" probes (default: true)
  blockPromptExtraction: boolean    # Block "show me your system prompt" attempts (default: true)
  blockedInputPatterns: string[]    # Regex patterns to block in user input (default: [])
  allowedTopics: string[]           # Topic whitelist — empty = all allowed (default: [])
  blockedTopics: string[]           # Topic blacklist (default: [])
  piiFilterInputs: boolean          # Scrub PII from user input before sending to LLM (default: false)
  maxMessageLength: number          # Max characters per user message (default: 4000)
```

### Example: Strict Input Controls

```yaml
inputGuardrails:
  injectionDetection: true
  blockToolDiscovery: true
  blockPromptExtraction: true
  maxMessageLength: 2000
  blockedInputPatterns:
    - "ignore (previous|all) instructions"
    - "you are now"
    - "pretend you"
    - "system:\\s"
  blockedTopics:
    - "competitor pricing"
    - "employee salaries"
    - "internal roadmap"
  piiFilterInputs: true
```

---

## outputFilters

Controls and sanitizes agent output before delivery to the user.

```yaml
outputFilters:
  piiDetection: boolean             # Detect and redact PII in responses (default: true)
  blockedOutputPatterns: string[]   # Regex patterns to redact from output (default: [])
  contentPolicy: string             # Content policy identifier (optional)
  maxResponseTokens: number         # Max tokens per agent response (default: 4096)
```

### Example: Sensitive Data Protection

```yaml
outputFilters:
  piiDetection: true
  maxResponseTokens: 4096
  blockedOutputPatterns:
    - "\\b\\d{3}-\\d{2}-\\d{4}\\b"              # SSN
    - "\\b\\d{16}\\b"                            # Credit card numbers
    - "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}\\b"  # Email addresses
    - "(?:password|secret|api_key)\\s*[:=]\\s*['\"][^'\"]+['\"]"   # Credentials
```

---

## session

Controls session duration and resource consumption.

```yaml
session:
  maxDurationMinutes: number        # Max session length (default: 120)
  maxTokensPerSession: number       # Total token budget per session (default: 100000)
  maxToolCallsPerSession: number    # Max tool calls per session (default: 500)
  isolateMemory: boolean            # Partition memory per-session (default: false)
```

### Example: Short Support Session

```yaml
session:
  maxDurationMinutes: 60
  maxTokensPerSession: 50000
  maxToolCallsPerSession: 200
```

### Example: Long Coding Session

```yaml
session:
  maxDurationMinutes: 480
  maxTokensPerSession: 500000
  maxToolCallsPerSession: 2000
```

---

## budget

Controls daily and per-session cost limits. Useful for frontier LLM providers with per-token costs.

```yaml
budget:
  maxTokensPerDay: number           # Daily token cap across all sessions (optional)
  maxCostPerDayUsd: number          # Daily cost cap in USD (optional)
  maxCostPerSession: number         # Per-session cost cap in USD (optional)
  hardStopOnBudgetExceeded: boolean # Kill session when exceeded (default: false)
```

When `hardStopOnBudgetExceeded` is `false`, the agent receives a warning but can continue. When `true`, the session is terminated immediately.

### Example: Budget-Controlled Agent

```yaml
budget:
  maxTokensPerDay: 1000000
  maxCostPerDayUsd: 50.00
  maxCostPerSession: 5.00
  hardStopOnBudgetExceeded: false
```

---

## llmRateLimits

Controls how frequently the agent can call the LLM.

```yaml
llmRateLimits:
  maxLlmCallsPerMinute: number     # Max LLM API calls per minute (optional)
  maxTokensPerMinute: number        # Max tokens consumed per minute (optional)
```

### Example

```yaml
llmRateLimits:
  maxLlmCallsPerMinute: 20
  maxTokensPerMinute: 50000
```

---

## approvalRules

Override per-tool approval settings with more specific rules.

```yaml
approvalRules:
  - tool: string                    # Tool name (required)
    condition: string               # When to require approval (default: "always")
    approvers: string[]             # User IDs who can approve (default: [] = any workspace_admin)
    timeoutMinutes: number          # Auto-reject after timeout (default: 30)
```

### Conditions

- `"always"` — Every call requires approval
- `"never"` — No approval needed (overrides tool-level `requiresApproval`)

### Example

```yaml
approvalRules:
  - tool: gsuite_gmail_send
    condition: always
    approvers: []
    timeoutMinutes: 15

  - tool: file_ops
    condition: always
    approvers: ["user-uuid-1", "user-uuid-2"]
    timeoutMinutes: 60
```

---

## Skill Manifest Format

Skills use a simplified format compared to full agent manifests:

```yaml
name: string                    # Skill name (required)
version: string                 # Semantic version (required)
description: string             # Human-readable description (required)

tools:                          # Simplified tool list
  - name: string                # Tool name
    requires_approval: boolean  # Human approval (default: false)

egress:
  allowed_domains: string[]

session:
  max_turns: number

trust_level: string             # standard, elevated, restricted

input_guardrails:
  injection_detection: boolean
  max_message_length: number
```

Note: Skill manifests use `snake_case` field names while agent manifests use `camelCase`.

---

## allowedSecretPaths

Controls which workspace secrets the agent can access. Secrets are injected by the Tool Execution Layer at runtime — agents never see the values directly.

```yaml
allowedSecretPaths:
  - "integrations/slack/*"          # All Slack secrets
  - "integrations/github/token"     # Specific GitHub token
  - "providers/openai/api-key"      # OpenAI API key
```

### Pattern Matching

- Exact match: `integrations/github/token`
- Wildcard: `integrations/slack/*` (matches any secret under that prefix)
- Empty list (default): agent has no access to any secrets

When agents are delegated to child agents via multi-agent orchestration, `allowedSecretPaths` is **narrowed** (intersected) — a child agent can never access more secrets than its parent.

---

## Defaults Summary

| Field | Default | Notes |
|-------|---------|-------|
| `tools[].enabled` | `true` | |
| `tools[].requiresApproval` | `false` | |
| `egress.allowedDomains` | `[]` | Empty = no external access |
| `egress.maxResponseSizeBytes` | `10485760` (10 MB) | |
| `inputGuardrails.injectionDetection` | `true` | |
| `inputGuardrails.blockToolDiscovery` | `true` | |
| `inputGuardrails.blockPromptExtraction` | `true` | |
| `inputGuardrails.maxMessageLength` | `4000` | |
| `inputGuardrails.piiFilterInputs` | `false` | |
| `outputFilters.piiDetection` | `true` | |
| `outputFilters.maxResponseTokens` | `4096` | |
| `session.maxDurationMinutes` | `120` | 2 hours |
| `session.maxTokensPerSession` | `100000` | |
| `session.maxToolCallsPerSession` | `500` | |
| `session.isolateMemory` | `false` | Partition memory per-session |
| `allowedSecretPaths` | `[]` | Empty = no secret access |
| `budget.hardStopOnBudgetExceeded` | `false` | Warn only |
| `approvalRules[].condition` | `"always"` | |
| `approvalRules[].timeoutMinutes` | `30` | |

---

## Related Guides

- [Creating Custom Agents](creating-agents.md) — How to create and deploy agents
- [Creating Custom Skills](creating-skills.md) — How to build reusable skill bundles
- [Creating Custom Tools](creating-tools.md) — How to build tools with the Tool SDK
- [First Agent Guide](../operations/first-agent.md) — Step-by-step deployment walkthrough
