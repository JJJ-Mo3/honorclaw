# Creating Custom Agents

This guide walks you through creating custom AI agents in HonorClaw — from a simple chatbot to a fully locked-down production agent with tool constraints, egress filtering, and budget controls.

## Overview

An agent in HonorClaw is defined by:

1. **Name and model** — What LLM powers the agent
2. **System prompt** — Behavioral instructions
3. **Capability manifest** — Tools, egress rules, guardrails, budgets (the security boundary)

You can create agents three ways: Web UI, CLI, or manifest YAML file.

## Method 1: Quick Create via CLI

The fastest way to create an agent:

```bash
honorclaw agents create \
  -n "my-assistant" \
  -m "ollama/llama3.2" \
  -p "You are a helpful assistant."
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `-n, --name` | Agent name (required) | — |
| `-d, --display-name` | Display name | — |
| `-m, --model` | Model identifier | `ollama/llama3.2` |
| `-w, --workspace` | Workspace ID | Current workspace |
| `-p, --prompt` | System prompt | — |

This creates a basic agent with default guardrails and no tools. Good for testing.

## Method 2: Quick Create via Web UI

1. Navigate to **Agents** in the sidebar
2. Click **Create Agent**
3. Fill in name, model, and system prompt
4. Click **Save**

## Method 3: Deploy from Manifest (Recommended for Production)

For production agents, define everything in a YAML manifest file and deploy it:

```bash
honorclaw agents deploy my-agent.yaml
```

This is the recommended approach because:
- Version-controlled in Git
- Reproducible across environments
- Full control over security constraints
- Supports all manifest features

## Agent Manifest Format

Here is the complete manifest format with all available fields:

```yaml
# my-agent.yaml
name: my-agent
description: Short description of what this agent does

# LLM Configuration
model:
  provider: ollama          # ollama, anthropic, openai, google
  model: llama3.2           # Model name within the provider
  temperature: 0.7          # 0.0 = deterministic, 1.0 = creative
  maxTokens: 2048           # Max tokens per LLM response

# System Prompt — defines the agent's persona and behavior
systemPrompt: |
  You are a helpful assistant specializing in [your domain].

  ## Guidelines
  - Always cite sources when providing factual information
  - Be concise and direct
  - Ask clarifying questions when the request is ambiguous

# Tools — what the agent can do
tools:
  - name: web_search
    enabled: true
    parameters:
      query:
        type: string
        maxLength: 500
    rateLimit:
      maxCallsPerMinute: 10
      maxCallsPerSession: 100

  - name: file_ops
    enabled: true
    requiresApproval: true    # Human must approve each file write
    parameters:
      path:
        type: string
        allowedPatterns:
          - "^/workspace/"    # Only allow files under /workspace/
      operation:
        type: string
        allowedValues:        # Only allow these operations
          - read
          - write
          - list

# Egress — what external domains the agent's tools can reach
egress:
  allowedDomains:
    - "*.google.com"
    - "api.example.com"
  blockedDomains:
    - "*.internal.corp"
  maxResponseSizeBytes: 5242880  # 5 MB

# Input Guardrails — protect against prompt injection
inputGuardrails:
  injectionDetection: true
  blockToolDiscovery: true
  blockPromptExtraction: true
  maxMessageLength: 4000
  blockedInputPatterns:
    - "ignore previous instructions"
  allowedTopics: []            # Empty = all topics allowed
  blockedTopics:
    - "competitor pricing"
  piiFilterInputs: false

# Output Filters — sanitize agent responses
outputFilters:
  piiDetection: true
  maxResponseTokens: 4096
  blockedOutputPatterns:
    - "(?:password|secret|api_key)\\s*[:=]\\s*['\"][^'\"]+['\"]"
  contentPolicy: "professional"

# Session Limits
session:
  maxDurationMinutes: 120
  maxTokensPerSession: 100000
  maxToolCallsPerSession: 500

# Budget Controls (optional)
budget:
  maxTokensPerDay: 500000
  maxCostPerDayUsd: 10.00
  maxCostPerSession: 2.00
  hardStopOnBudgetExceeded: false  # true = kill session; false = warn

# LLM Rate Limits (optional)
llmRateLimits:
  maxLlmCallsPerMinute: 20
  maxTokensPerMinute: 50000

# Approval Rules (optional) — override per-tool approval settings
approvalRules:
  - tool: file_ops
    condition: always          # always, never, or a condition expression
    approvers: []              # Empty = any workspace_admin
    timeoutMinutes: 30
```

## Example: Customer Support Agent

```yaml
name: support-bot
description: Customer support agent with CRM and email access

model:
  provider: ollama
  model: llama3.2
  temperature: 0.5
  maxTokens: 2048

systemPrompt: |
  You are a customer support agent for Acme Corp. Your job is to help
  customers resolve issues quickly and professionally.

  ## Guidelines
  - Always greet the customer by name if available
  - Look up their account in Salesforce before responding
  - Never share internal pricing or discount information
  - Escalate to a human agent if the customer is dissatisfied after 2 attempts
  - Always confirm the resolution before closing

tools:
  - name: salesforce_query
    parameters:
      query:
        type: string
        maxLength: 1000
        blockedPatterns:
          - "DELETE"
          - "UPDATE"
          - "INSERT"
    rateLimit:
      maxCallsPerMinute: 20

  - name: salesforce_read_record

  - name: gsuite_gmail_send
    requiresApproval: true     # Human reviews every email before sending
    parameters:
      to:
        type: string
        allowedPatterns:
          - "@acme\\.com$"     # Can only email acme.com addresses
      subject:
        type: string
        maxLength: 200

egress:
  allowedDomains:
    - "*.salesforce.com"
    - "gmail.googleapis.com"

inputGuardrails:
  injectionDetection: true
  maxMessageLength: 2000
  blockedTopics:
    - "internal pricing"
    - "employee information"

outputFilters:
  piiDetection: true
  blockedOutputPatterns:
    - "\\b\\d{3}-\\d{2}-\\d{4}\\b"  # Block SSN patterns
    - "\\b\\d{16}\\b"                # Block credit card numbers

session:
  maxDurationMinutes: 60
  maxTokensPerSession: 50000

budget:
  maxTokensPerDay: 200000
```

## Example: Minimal RAG Agent (Offline)

```yaml
name: rag-assistant
description: Document Q&A agent with no external access

model:
  provider: ollama
  model: llama3.2
  temperature: 0.2

systemPrompt: |
  You are a document assistant. Answer questions using only the documents
  in your memory. If you cannot find the answer, say so honestly.
  Never make up information.

tools:
  - name: memory_search
  - name: file_ops
    parameters:
      path:
        type: string
        allowedPatterns:
          - "^/workspace/documents/"
      operation:
        type: string
        allowedValues:
          - read
          - list

egress:
  allowedDomains: []  # Completely offline

session:
  maxTokensPerSession: 100000
```

## Writing Effective System Prompts

The system prompt is the primary way to define your agent's persona and behavior. Tips:

1. **Start with the role**: "You are a [role] for [organization]."
2. **Define responsibilities**: List 3-5 core things the agent should do
3. **Set boundaries**: What the agent should NOT do
4. **Specify format**: How should responses be structured?
5. **Add escalation rules**: When should the agent hand off to a human?

### Persona Template

```
You are a [role] for [organization]. Your job is to [primary responsibility].

## Core Responsibilities
1. [Responsibility 1]
2. [Responsibility 2]
3. [Responsibility 3]

## Communication Style
- [Tone: professional, friendly, technical, etc.]
- [Length: concise, detailed, etc.]
- [Format: bullets, paragraphs, structured, etc.]

## Escalation Rules
- [When to escalate to human]
- [How to escalate]

## Safety Rules
- Never [prohibited action 1]
- Never [prohibited action 2]
- Always [required action]
```

## Managing Agents

### View agent details

```bash
honorclaw agents get <agent-id>
```

### Update an agent

```bash
honorclaw agents update <agent-id> -n "new-name" -m "anthropic/claude-3-5-sonnet" -s active
```

### View manifest versions

```bash
honorclaw agents versions <agent-id>
```

### Rollback to a previous manifest

```bash
honorclaw agents rollback <agent-id> --to 2
```

### Archive an agent

```bash
honorclaw agents delete <agent-id>
```

## Installing Skills onto Agents

Skills are pre-built agent configurations. Install a skill, then apply it to your agent:

```bash
# Browse available skills
honorclaw skills available

# Install a skill
honorclaw skills install customer-support

# Apply to an agent via CLI
honorclaw skills apply customer-support -a <agent-id>

# Or apply via API
curl -X POST http://localhost:3000/api/skills/agents/<agent-id> \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"skillName": "customer-support"}'

# Detach a skill from an agent
honorclaw skills detach customer-support -a <agent-id>

# List skills applied to an agent
honorclaw skills agent-skills <agent-id>
```

## Available Models

```bash
# List available models (local + frontier)
curl http://localhost:3000/api/models -H "Authorization: Bearer $TOKEN"
```

| Provider | Example Models |
|----------|---------------|
| **Ollama** (local, default) | `ollama/llama3.2`, `ollama/mistral`, `ollama/codellama` |
| **Anthropic** | `anthropic/claude-3-5-sonnet`, `anthropic/claude-3-haiku` |
| **OpenAI** | `openai/gpt-4o`, `openai/gpt-4o-mini` |
| **Google** | `google/gemini-pro`, `google/gemini-flash` |

Frontier providers (Anthropic, OpenAI, Google) are available when the corresponding API keys are set. Configure them in `honorclaw.yaml` or via secrets:

```bash
honorclaw secrets set providers/anthropic/api-key "sk-ant-..."
honorclaw secrets set providers/openai/api-key "sk-..."
```

## Next Steps

- [Manifest Reference](manifest-reference.md) — Complete field-by-field reference
- [Creating Custom Skills](creating-skills.md) — Build reusable agent configurations
- [Creating Custom Tools](creating-tools.md) — Build tools your agents can use
- [First Agent Guide](../operations/first-agent.md) — Detailed deployment walkthrough
