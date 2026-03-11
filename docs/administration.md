# Administration Guide

This guide covers day-to-day administration of a HonorClaw deployment: user management, workspace configuration, RBAC, secrets, audit logging, MFA, and backup/restore.

## RBAC Roles

HonorClaw uses role-based access control (RBAC) scoped to workspaces. Each user can have different roles in different workspaces.

| Role | Scope | Capabilities |
|------|-------|-------------|
| **deployment_admin** | Global | Bypasses all role checks; create/manage workspaces, manage all users, full platform access |
| **workspace_admin** | Workspace | Manage agents, skills, secrets, users, webhooks, approvals within workspace |
| **agent_user** | Workspace | Create sessions, interact with agents, view own sessions |
| **auditor** | Workspace | Read-only access to audit logs, metrics, and session history |
| **api_service** | Workspace | Machine-to-machine API access for integrations |

The first user created during `honorclaw init` is automatically a **deployment_admin**.

## User Management

### Create a User

**CLI:**

```bash
# Create a user with a specific role
honorclaw users create -e user@example.com -p "securepassword" -r agent_user

# Create a workspace admin
honorclaw users create -e admin@example.com -p "securepassword" -r workspace_admin
```

Valid roles: `workspace_admin`, `agent_user`, `auditor`, `api_service`

Password minimum: 12 characters.

**API:**

```bash
curl -X POST http://localhost:3000/api/users \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "securepassword", "role": "agent_user"}'
```

If `password` is omitted, a temporary password is auto-generated and returned in the response.

### List Users

```bash
honorclaw users list
```

## Workspace Management

Workspaces provide isolation boundaries. Agents, secrets, sessions, and audit logs are all scoped to a workspace.

### Create a Workspace

```bash
honorclaw workspaces create -n "engineering-team"
```

Only deployment admins can create workspaces.

### List Workspaces

```bash
honorclaw workspaces list
```

Deployment admins see all workspaces. Regular users see only workspaces they belong to.

## Deployment Management

### Start / Stop

```bash
# Start deployment
honorclaw start
honorclaw start --detach        # Run in background
honorclaw start --wait          # Wait for services to be ready
honorclaw start --no-detach     # Force foreground mode

# Stop deployment
honorclaw stop
honorclaw stop --remove         # Stop and remove containers/volumes
```

### View Logs

```bash
honorclaw logs
honorclaw logs -f               # Follow (stream) logs
honorclaw logs -n 100           # Last 100 lines
```

### Login

```bash
honorclaw login -s http://localhost:3000
```

## Registration Control

By default, self-registration is enabled for the first user (who becomes deployment admin). After the first user is created, self-registration is disabled unless the `ALLOW_SELF_REGISTRATION=true` environment variable is set:

```bash
# In .env or docker-compose environment
ALLOW_SELF_REGISTRATION=true   # Enable open registration (default: disabled after first user)
```

When registration is disabled:
- The `/register` page in the Web UI redirects to `/login`
- The `POST /api/auth/register` endpoint returns `403 Forbidden`
- New users must be created by a workspace admin via CLI or API

To check the current registration setting:

```bash
curl http://localhost:3000/api/auth/config
# Returns: {"selfRegistrationEnabled": false, "mfaRequired": false}
```

## MFA / TOTP Setup

HonorClaw supports TOTP-based two-factor authentication (compatible with Google Authenticator, Authy, 1Password, etc.).

### Enable TOTP for a User

1. **Web UI**: Go to **Settings > Security** and click **Enable Two-Factor Authentication**
2. **API**: Call `POST /api/auth/totp/setup` (requires authentication)

The setup endpoint returns an `otpauthUri` for generating a QR code. The raw TOTP secret is never exposed in the API response.

### MFA Login Flow

1. User submits email/password to `POST /api/auth/login`
2. If TOTP is enabled, the response includes `requiresMfa: true` and a temporary `mfaToken`
3. User enters the 6-digit TOTP code
4. Code + `mfaToken` are sent to `POST /api/auth/totp/verify`
5. On success, full access/refresh tokens are returned

### Enforce MFA

To require MFA for all users, set in `honorclaw.yaml`:

```yaml
auth:
  mfaRequired: true
```

## Secrets Management

Secrets are encrypted at rest with AES-256-GCM using the `HONORCLAW_MASTER_KEY`. Agents never see secret values directly — they are injected by the Tool Execution Layer at runtime.

### Store a Secret

```bash
honorclaw secrets set integrations/slack/bot-token "xoxb-your-token-here"
```

Secrets use path-based naming (e.g., `integrations/slack/bot-token`, `providers/openai/api-key`).

### List Secrets

```bash
# List all secrets (paths only, values are never displayed)
honorclaw secrets list

# Filter by prefix
honorclaw secrets list -p integrations/
```

### Rotate a Secret

```bash
honorclaw secrets rotate integrations/slack/bot-token
```

Rotation generates a new value. To set a specific new value, use `honorclaw secrets set` with the same path (it performs an upsert).

### Custom Integrations

In addition to the 20 built-in integrations, you can create custom integrations to connect agents to internal APIs or proprietary services.

```bash
# Create a custom integration
honorclaw integrations create "Internal Analytics API" \
  --description "Query internal analytics warehouse" \
  --field "API Key:true" \
  --field "Base URL:false"

# List all integrations
honorclaw integrations list

# Configure credentials for the custom integration
honorclaw secrets set custom/internal-analytics-api/api-key "sk-abc123"

# Test the connection
honorclaw integrations test custom/internal-analytics-api

# Delete a custom integration (also removes credentials)
honorclaw integrations delete internal-analytics-api
```

Custom integrations can also be created from the Web UI via the **+ Add Custom Integration** button on the Integrations page. See [Custom Integrations Guide](guides/custom-integrations.md) for full details.

## Audit Logging

All platform events are written to an immutable append-only audit log. Events include authentication attempts, agent tool calls, policy violations, user management actions, and more.

### Query Audit Events

```bash
# Recent events (last 7 days)
honorclaw audit events --start 2024-01-01 --end 2024-01-31

# Filter by event type
honorclaw audit events -t auth.login

# Filter by actor
honorclaw audit events -a <user-id>

# Filter by session
honorclaw audit events -s <session-id>

# Limit results
honorclaw audit events -l 100
```

### Export Audit Log

```bash
# Export to NDJSON file
honorclaw audit export -o audit-export.jsonl

# Export with filters
honorclaw audit export -o export.jsonl -t tool_call --start 2024-01-01 --end 2024-01-31
```

The export format is NDJSON (newline-delimited JSON), suitable for ingestion into SIEM systems.

### Audit Event Types

| Event Type | Description |
|------------|-------------|
| `auth.login` | User login attempt (success or failure) |
| `auth.register` | User registration |
| `auth.mfa` | MFA verification attempt |
| `agent.created` | Agent created |
| `agent.updated` | Agent configuration changed |
| `agent.deleted` | Agent archived |
| `session.created` | Chat session started |
| `session.ended` | Chat session ended |
| `tool_call` | Agent tool invocation |
| `policy.violation` | Tool call blocked by capability manifest |
| `secret.created` | Secret stored |
| `secret.rotated` | Secret rotated |
| `user.created` | User account created |
| `webhook.delivered` | Webhook delivery attempt |

## Backup and Restore

### Create a Backup

```bash
honorclaw backup create
```

This creates a full backup of the PostgreSQL database and configuration.

### Restore a Backup

```bash
honorclaw backup restore <backup-id>
```

### List Backups

```bash
honorclaw backup list
```

### Schedule Backups

```bash
honorclaw backup schedule
```

### Export Workspace Data

```bash
# Export current workspace data as JSON
honorclaw migrate export -o workspace-export.json
```

The export includes agents, skills, sessions (metadata only), secrets (paths only, not values), approvals, webhooks, and notifications.

### Import Workspace Data

```bash
# Import agents and skills from a previous export
honorclaw migrate import -f workspace-export.json
```

Import uses upsert logic — existing agents/skills are updated, new ones are created.

## Agent Management

### List Agents

```bash
honorclaw agents list
```

### Create an Agent

```bash
honorclaw agents create -n "my-agent" -m "ollama/llama3.2" -p "You are a helpful assistant."
```

### Deploy from Manifest

```bash
honorclaw agents deploy agent.yaml
```

### View Agent Details

```bash
honorclaw agents get <agent-id>
```

### Update an Agent

```bash
honorclaw agents update <agent-id> -n "new-name" -m "ollama/llama3.2" -s active
```

### Rollback Agent Manifest

```bash
# List manifest versions
honorclaw agents versions <agent-id>

# Rollback to a specific version
honorclaw agents rollback <agent-id> --to <version>
```

### Delete (Archive) an Agent

```bash
honorclaw agents delete <agent-id>
```

This performs a soft delete (sets status to `archived`).

## Session Management

### List Sessions

```bash
# List all sessions
honorclaw sessions list

# Filter by status
honorclaw sessions list -s active

# Filter by agent
honorclaw sessions list -a <agent-id>

# Limit results
honorclaw sessions list -l 20
```

### View Session Messages

```bash
honorclaw sessions messages <session-id>
```

### Interactive Chat

```bash
honorclaw chat <agent-name-or-id>
```

### Export / Import Sessions

```bash
honorclaw sessions export <session-id>
honorclaw sessions import <file>
```

### Create a Session

```bash
honorclaw sessions create -a <agent-id>
```

### Send a Message

```bash
honorclaw sessions chat <session-id> -m "Hello!"
```

## Skills Management

### List Installed Skills

```bash
honorclaw skills list
```

### Search for Skills

```bash
honorclaw skills search <query>
```

### Install a Skill

```bash
honorclaw skills install <name>
```

### List Available Skills

```bash
honorclaw skills available
```

### Scaffold a New Skill

```bash
honorclaw skills scaffold <name>
```

### Agent-Skill Bindings

```bash
# List skills bound to an agent
honorclaw skills agent-skills <agent-id>

# Apply a skill to an agent
honorclaw skills apply <agent-id> <skill-name>

# Detach a skill from an agent
honorclaw skills detach <agent-id> <skill-name>
```

### Remove a Skill

```bash
honorclaw skills remove <name>
```

## Tool Management

### List Installed Tools

```bash
honorclaw tools list
```

### Search for Tools

```bash
honorclaw tools search <query>
```

### Install a Tool

```bash
honorclaw tools install <name>
```

### Scaffold a New Tool

```bash
honorclaw tools scaffold <name>
```

### Security Scan a Tool

```bash
honorclaw tools scan <name>
```

### Update Tools

```bash
honorclaw tools update
```

### Dev Mode

```bash
honorclaw tools dev <name>
```

### Remove a Tool

```bash
honorclaw tools remove <name>
```

## Memory / RAG Management

### View Memory Statistics

```bash
honorclaw memory stats
```

### List Memory Documents

```bash
honorclaw memory documents
```

## Models

### List Available Models

```bash
honorclaw models list
```

Lists all available LLM models (both local via Ollama and configured frontier providers).

## TLS Certificate Management

### Generate Certificates

```bash
honorclaw certs generate
```

### Renew Certificates

```bash
honorclaw certs renew
```

### Verify Certificates

```bash
honorclaw certs verify
```

## Key Rotation

### Rotate Encryption Keys

```bash
honorclaw key-rotation rotate
```

### Check Key Rotation Status

```bash
honorclaw key-rotation status
```

### Schedule Key Rotation

```bash
honorclaw key-rotation schedule
```

## Model Migration

Migrate agents from one model to another:

```bash
honorclaw migrate-model <from-model> <to-model>
```

For example:

```bash
honorclaw migrate-model ollama/llama3.2 anthropic/claude-sonnet-4-20250514
```

## API Key Management

API keys provide machine-to-machine access with the `hc_` prefix. Keys are hashed with SHA-256 for storage.

API keys are managed via the REST API (`/api/api-keys`) by workspace admins. Scopes restrict access to specific resource paths (e.g., `"agents"`, `"sessions"`).

## Evaluation Framework

The evaluation framework supports prompt regression testing via CLI:

```bash
# Manage eval sessions
honorclaw eval sessions

# Send eval turns
honorclaw eval turns

# Register mock handlers
honorclaw eval mocks

# Stream eval events
honorclaw eval events
```

## Rolling Upgrade

```bash
# Basic upgrade
honorclaw upgrade

# Skip backup before upgrading
honorclaw upgrade --skip-backup

# Skip health check after upgrading
honorclaw upgrade --skip-health-check
```

## Air-Gap Bundle Management

For air-gapped deployments, create and verify deployment bundles:

```bash
# Create an air-gap bundle
honorclaw bundle create

# Verify an air-gap bundle
honorclaw bundle verify
```

## Health Checks

### Run Diagnostics

```bash
honorclaw doctor
```

Checks database connectivity, Redis connectivity, configuration validity, and service health.

### Check Status

```bash
honorclaw status
```

Returns version, uptime, agent count, active sessions, and database/Redis health.

### Health Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health/live` | Liveness probe (always returns `ok`) |
| `GET /health/ready` | Readiness probe (checks DB and Redis) |
| `GET /health/deep` | Deep health check with latency metrics |

## Web UI Administration

The Web UI at `http://localhost:3000` provides:

- **Dashboard**: Platform overview with agent count, active sessions, and system health
- **Agents**: Create, configure, and manage agents with a visual manifest editor
- **Sessions**: View active and historical sessions, read message history
- **Skills**: Browse, install, and manage skills
- **Users**: Manage workspace users and roles (workspace admins only)
- **Audit**: Browse and search the audit log (admins and auditors)
- **Settings**: Platform configuration, MFA setup, notification preferences
- **Notifications**: View and manage platform notifications

## Environment Variables

For a complete list of environment variables, see [.env.example](../.env.example).

Key admin-relevant variables:

| Variable | Purpose |
|----------|---------|
| `HONORCLAW_MASTER_KEY` | Master encryption key for secrets (base64, 32 bytes) |
| `JWT_SECRET` | JWT signing secret (base64url, 48 bytes) |
| `SESSION_COOKIE_SECRET` | Cookie signing secret (base64url, 32 bytes) |
| `POSTGRES_PASSWORD` | PostgreSQL password (base64url, 24 bytes) |
| `REDIS_PASSWORD` | Redis password (base64url, 24 bytes) |
| `NODE_ENV` | `development` or `production` |
| `LOG_LEVEL` | Logging level (default: `info`) |
