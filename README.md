<p align="center">
  <img src="assets/logo.png" alt="HonorClaw" width="200" />
</p>
<p align="center">
  <strong>Enterprise-grade, self-hosted AI agent platform where security is architectural, not behavioral.</strong>
</p>

HonorClaw is a fully open-source platform for deploying, managing, and securing AI agents in enterprise environments. It matches the feature set of platforms like OpenClaw (agents, memory, tool calling, multi-agent orchestration) while adding enterprise-grade security controls baked into every layer. A fully prompt-injected agent is still contained, because the architecture physically prevents it from exceeding its authorized capabilities.

## Why HonorClaw?

| Problem (typical agent platforms) | HonorClaw Solution |
|:--|:--|
| No authentication — anyone on the network can use the agent | Email/password auth, JWT sessions, TOTP MFA, API key auth |
| No authorization — agents can do anything tools permit | Capability manifests with per-agent, per-tool, per-parameter constraints |
| Behavioral security — prompt injection bypasses all controls | Architectural enforcement — agent runtime is sandwiched between trusted layers |
| No audit logging | Immutable append-only audit trail with compliance-grade event schema |
| No network controls — tools can reach any endpoint | Egress filtering via Policy Proxy, allowlist per agent |
| No workspace isolation | Workspace-scoped RBAC: agents, secrets, and users scoped per team |
| Local OS install with full host access | Containerized deployment with isolated agent networking |

## The Capability Sandwich

The agent's LLM "brain" is treated as an **untrusted component**, sandwiched between trusted enforcement layers:

```
[TRUSTED]  Control Plane — loads manifest, validates tool calls, filters output
               | (Redis pub/sub)
[UNTRUSTED] Agent Runtime — LLM lives here; cannot escape; no internet access
               | (tool call request via Redis)
[TRUSTED]  Tool Execution Layer — validates every request against capability manifest
```

Even a fully injected agent cannot call tools outside its manifest, reach unauthorized endpoints, access credentials, or exfiltrate data. The enforcement is structural, not behavioral.

## Key Features

### Agent Runtime
- Multi-turn conversational agents with persistent session memory
- Tool calling enforced by capability manifests (YAML/JSON)
- Multi-agent orchestration with narrowed (never expanded) delegation
- Human-in-the-loop approval flows for sensitive operations
- Agent-to-human escalation with routing to Slack, Teams, email, or webhook
- Scheduled (cron) and webhook-triggered headless agent sessions
- Smart context compression for long conversations
- Streaming responses (SSE/WebSocket)

### Security
- **Capability Manifests**: per-agent definitions of allowed tools, parameter constraints, rate limits, egress rules, and output filters
- **Policy Enforcement**: every tool call is validated by the PolicyEnforcer and ParameterSanitizer before execution
- **Output Filtering**: PII/PHI/credential detection and redaction on all agent responses before delivery
- **Input Guardrails**: injection pattern detection, tool discovery blocking, prompt extraction blocking — all deterministic, no LLM evaluation
- **Immutable Audit Logging**: all events (auth, tool calls, LLM interactions, policy violations) written to append-only store
- **Secrets Isolation**: agents never see API keys or credentials; injected at the Tool Execution Layer
- **Network Isolation**: agent containers run in isolated networks with no internet access
- **Encryption**: AES-256-GCM encryption at rest for secrets, TOTP tokens, and webhook signing keys

### Authentication & Authorization
- Email/password with TOTP MFA (no external service required)
- SSO integration points: SAML 2.0 / OIDC support planned
- RBAC roles: Deployment Admin, Workspace Admin, Agent User, Auditor, API Service
- API key auth for machine-to-machine integrations
- Workspace-scoped permissions — users can belong to multiple workspaces with different roles

### Interfaces
- **Web UI**: React SPA with agent chat, admin panel, visual manifest editor, audit viewer
- **Slack**: bot installation, channel-to-agent mapping, slash commands
- **Microsoft Teams**: Bot Framework integration, Teams app manifest
- **Discord**: bot integration for developer communities
- **Email**: inbound/outbound email-triggered agent sessions (SMTP/IMAP)
- **Webhooks**: inbound (event-driven sessions) and outbound (SIEM/PagerDuty integration)
- **REST API**: full programmatic access to all platform capabilities
- **CLI**: agent management, diagnostics, eval, secrets, backup, and more

### LLM Providers (model agnostic)
- **Local**: Ollama (default), LM Studio, vLLM, or any OpenAI-compatible endpoint — data never leaves your perimeter
- **Frontier**: Anthropic Claude, OpenAI GPT-4o, Google Gemini, Mistral, Cohere, AWS Bedrock, Azure OpenAI
- Swap models at any time via `honorclaw.yaml` — no code changes required

### Built-in Tools (19 packages)

| Category | Tools |
|:--|:--|
| **Productivity** | Google Workspace (10 tools), Microsoft 365 (10 tools) |
| **Developer** | GitHub (9 tools), Jira (6 tools), Confluence (4 tools), Notion (5 tools) |
| **Ops & Data** | PagerDuty (7 tools), Salesforce (6 tools), Snowflake (3 tools), BigQuery (4 tools) |
| **Communication** | Slack (5 tools), Email Send |
| **Core** | Web Search, HTTP Request, File Ops, Database Query, Code Execution, Memory Search |
| **AI** | Claude Code (agent inception — delegates coding tasks to Claude Code CLI) |

All tools run in isolated containers. Credentials are injected by the Tool Execution Layer — they never reach the agent runtime.

### Memory & RAG
- **Working memory**: in-session conversation context (Redis)
- **Long-term memory**: vector-based semantic retrieval (pgvector)
- **Session archival**: full conversation history stored in PostgreSQL
- **Document ingestion**: `honorclaw memory documents` for PDF, Markdown, and plain text
- **Memory search**: agents can query their own vector memory via the `memory_search` tool

## Architecture

```
honorclaw/
  packages/
    core/               # Shared types, schemas, provider interfaces, telemetry
    control-plane/      # Fastify server: auth, RBAC, API, policy enforcement, tool execution
    agent-runtime/      # LLM interaction, session management (untrusted zone)
    cli/                # CLI tool (honorclaw)
    web-ui/             # React admin UI and chat interface
    tool-sdk/           # SDK for building custom tools
    rag/                # Document ingestion, chunking, embedding, retrieval
    channels/           # Channel adapters (Slack, Teams, Discord, Email, Web, API, Webhook)
    providers/          # Pluggable backends (built-in, AWS, self-hosted)
    tools/              # 19 built-in tool packages
```

**Tech stack**: TypeScript (strict ESM), Fastify, PostgreSQL (pgvector), Redis, Ollama, React, Turborepo + pnpm workspaces.

## Quickstart

```bash
# Clone the repository
git clone https://github.com/JJJ-Mo3/honorclaw.git
cd honorclaw

# First run — generates keys, creates schema, sets up admin user
make init

# Start HonorClaw (one container, one volume, one port)
make up

# Open the web UI
open http://localhost:3000
```

### Prerequisites
- Docker (20.10+)
- 4 GB RAM minimum (8 GB recommended for local LLM inference)

### CLI Quick Reference

```bash
honorclaw init                        # First-time setup
honorclaw start [--detach]            # Start deployment
honorclaw stop [--remove]             # Stop deployment
honorclaw logs [-f] [-n <lines>]      # View logs
honorclaw login -s <url>              # Authenticate with server
honorclaw doctor                      # Verify installation health
honorclaw status                      # Platform status overview
honorclaw upgrade                     # Rolling upgrade

honorclaw agents list                 # List all agents
honorclaw agents create -n <name>     # Create an agent
honorclaw agents deploy <path>        # Deploy agent from manifest
honorclaw agents rollback <id> --to <version>  # Rollback manifest

honorclaw chat <agent-name-or-id>     # Start interactive chat session

honorclaw skills search <query>       # Search available skills
honorclaw skills install <name>       # Install a skill
honorclaw skills available            # List available skill bundles
honorclaw skills scaffold <name>      # Scaffold a new skill
honorclaw skills agent-skills <id>    # List agent's skills
honorclaw skills apply <id> <skill>   # Apply skill to agent
honorclaw skills detach <id> <skill>  # Remove skill from agent

honorclaw secrets set <path> <value>  # Store a secret
honorclaw secrets list                # List secrets
honorclaw secrets rotate <path>       # Rotate a secret

honorclaw users list                  # List users
honorclaw users create -e <email> -p <pass> -r <role>  # Create user

honorclaw workspaces list             # List workspaces
honorclaw workspaces create -n <name> # Create workspace

honorclaw sessions list               # List sessions
honorclaw sessions messages <id>      # View session messages

honorclaw audit events --since 7d     # Query audit log
honorclaw audit export -o audit.json  # Export audit log

honorclaw tools list                  # List installed tools
honorclaw tools install <name>        # Install a tool
honorclaw tools search <query>        # Search tool marketplace

honorclaw memory stats                # Memory statistics
honorclaw memory documents            # List memory documents

honorclaw models list                 # List available models

honorclaw eval sessions               # Manage eval sessions
honorclaw eval turns                  # Send eval turns

honorclaw backup create               # Create a backup
honorclaw backup restore <id>         # Restore a backup
honorclaw backup list                 # List backups
honorclaw backup schedule             # Manage backup schedule

honorclaw certs generate              # Generate TLS certificates
honorclaw certs renew                 # Renew certificates
honorclaw certs verify                # Verify certificates

honorclaw key-rotation rotate         # Rotate encryption keys
honorclaw key-rotation status         # Key rotation status

honorclaw bundle create               # Create air-gap bundle
honorclaw bundle verify               # Verify air-gap bundle

honorclaw migrate-model <from> <to>   # Migrate between models
```

## Deployment Tiers

| Tier | Orchestration | Target | Infra Cost* |
|------|--------------|--------|-------------|
| **1 — Single Container** | `make init && make up` | Dev, demo, small team | ~$20–100/mo |
| **2 — Docker Swarm / K3s** | Swarm or K3s | Medium team, on-prem | ~$200–500/mo |
| **3 — Kubernetes** | kubeadm, RKE2, Rancher | Large enterprise | ~$500–1,500/mo |
| **4 — Cloud-Managed K8s** | EKS / GKE / AKS | Cloud-native enterprise | ~$800–2,000/mo |

*Infrastructure costs only (compute, database, Redis). LLM API costs are additional and vary by provider and usage. Local models via Ollama have no per-token cost.

## Configuration

HonorClaw is configured via `honorclaw.yaml` (generated by `honorclaw init`). Environment variables can override YAML settings:

| Variable | Purpose | Required |
|:--|:--|:--|
| `HONORCLAW_MASTER_KEY` | Master encryption key (base64, 32 bytes) | Yes (production) |
| `JWT_SECRET` | JWT signing secret (base64url, 48 bytes) | Yes (production) |
| `SESSION_COOKIE_SECRET` | Cookie signing secret (base64url, 32 bytes) | Yes (production) |
| `POSTGRES_PASSWORD` | PostgreSQL password (base64url, 24 bytes) | Yes (production) |
| `REDIS_PASSWORD` | Redis password (base64url, 24 bytes) | Yes (production) |
| `POSTGRES_URL` | External PostgreSQL connection string | No (embedded default) |
| `REDIS_URL` | External Redis connection string | No (embedded default) |
| `OLLAMA_BASE_URL` | Ollama API endpoint | No (default: localhost:11434) |
| `NODE_ENV` | `development` or `production` | No (default: development) |

See [`.env.example`](.env.example) for the full list.

## Building from Source

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run the control plane in development mode
pnpm --filter @honorclaw/control-plane dev
```

## Links

- [Documentation](docs/)
- [Quickstart Guide](docs/quickstart.md)
- [Creating Custom Agents](docs/guides/creating-agents.md)
- [Creating Custom Skills](docs/guides/creating-skills.md)
- [Creating Custom Tools](docs/guides/creating-tools.md)
- [Manifest Reference](docs/guides/manifest-reference.md)
- [Administration Guide](docs/administration.md)
- [API Reference](docs/api-reference.md)
- [Security Architecture](docs/security/security-model.md)
- [Deployment Guides](docs/install/)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [License](LICENSE) (Apache 2.0)

## License

Apache 2.0. See [LICENSE](LICENSE).
