# API Reference

Complete REST API reference for HonorClaw. All endpoints are prefixed with `/api` unless otherwise noted.

## Authentication

All authenticated endpoints require one of:
- **Cookie**: `token` cookie (set automatically by login/register)
- **Bearer token**: `Authorization: Bearer <access_token>` header (JWT, HS256)
- **API key**: `X-API-Key: <key>` header (for machine-to-machine; `hc_` prefix; SHA-256 hash lookup; scope enforcement restricts access to resource paths like `"agents"`, `"sessions"`)

## Base URL

```
http://localhost:3000/api
```

---

## Auth

### POST /auth/login

Authenticate with email and password.

**Public:** Yes (rate-limited: 5 attempts/15 min)

```json
// Request
{
  "email": "user@example.com",
  "password": "password123"
}

// Response (success)
{
  "user": { "id": "uuid", "email": "string", "isDeploymentAdmin": false },
  "workspaceId": "uuid",
  "roles": ["agent_user"],
  "accessToken": "jwt-string",
  "refreshToken": "jwt-string",
  "expiresAt": "2024-01-01T01:00:00.000Z"
}

// Response (MFA required)
{
  "requiresMfa": true,
  "mfaToken": "jwt-string"
}
```

**Status Codes:** 200, 401 (invalid credentials), 423 (account locked), 429 (rate limited)

Account locks after 5 failed attempts for 15 minutes.

### POST /auth/register

Create a new account. The first user becomes deployment admin.

**Public:** Yes (gated by `auth.allowRegistration` config)

```json
// Request
{
  "email": "user@example.com",
  "password": "min12characters",
  "displayName": "Jane Doe"  // optional
}

// Response
{
  "user": { "id": "uuid", "email": "string", "isDeploymentAdmin": false },
  "workspaceId": "uuid",
  "roles": ["agent_user"],
  "accessToken": "jwt-string",
  "refreshToken": "jwt-string",
  "expiresAt": "2024-01-01T01:00:00.000Z"
}
```

**Status Codes:** 201, 400 (invalid input), 403 (registration disabled), 409 (email exists)

### POST /auth/refresh

Refresh an expired access token using the refresh cookie.

**Auth:** Refresh token cookie

```json
// Response
{ "success": true }
```

Sets a new `token` cookie.

### GET /auth/me

Get the current user's profile.

**Auth:** Required

```json
// Response
{
  "user": { "id": "uuid", "email": "string", "displayName": "string" },
  "workspaceId": "uuid",
  "roles": ["workspace_admin"]
}
```

### POST /auth/logout

Clear authentication cookies.

```json
// Response
{ "success": true }
```

### GET /auth/config

Get public authentication configuration.

**Public:** Yes

```json
// Response
{
  "selfRegistrationEnabled": true,
  "mfaRequired": false
}
```

### POST /admin/bootstrap

First-run bootstrap — creates the initial deployment admin account. Only available when no users exist.

**Public:** Yes (rate-limited: 5 attempts/15 min)

```json
// Request
{
  "email": "admin@example.com",
  "password": "min12characters",
  "displayName": "Admin"  // optional
}

// Response (201)
{
  "user": { "id": "uuid", "email": "string", "isDeploymentAdmin": true },
  "workspaceId": "uuid",
  "roles": ["deployment_admin"],
  "accessToken": "jwt-string",
  "refreshToken": "jwt-string"
}
```

**Status Codes:** 201, 400 (invalid input), 403 (bootstrap already completed), 429 (rate limited)

### POST /auth/totp/setup

Initialize TOTP two-factor authentication.

**Auth:** Required

```json
// Response
{
  "otpauthUri": "otpauth://totp/HonorClaw:user@example.com?secret=..."
}
```

The `otpauthUri` can be rendered as a QR code for the user to scan with their authenticator app. The raw TOTP secret is never exposed in the API response.

**Status Codes:** 200, 409 (TOTP already enabled)

### POST /auth/totp/verify

Complete MFA verification during login.

**Public:** Yes (rate-limited)

```json
// Request
{
  "code": "123456",
  "mfaToken": "jwt-from-login-response"
}

// Response
{
  "user": { "id": "uuid", "email": "string", "isDeploymentAdmin": false },
  "workspaceId": "uuid",
  "roles": ["agent_user"]
}
```

**Status Codes:** 200, 400 (missing code), 401 (invalid token/code)

---

## Agents

All agent endpoints require authentication and workspace context.

### GET /agents

List all agents in the current workspace.

```json
// Response
{
  "agents": [
    {
      "id": "uuid",
      "workspaceId": "uuid",
      "name": "my-agent",
      "displayName": "My Agent",
      "model": "ollama/llama3.2",
      "status": "active",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

### GET /agents/:id

Get agent details including system prompt, settings, and manifest.

```json
// Response
{
  "agent": {
    "id": "uuid",
    "name": "my-agent",
    "displayName": "My Agent",
    "model": "ollama/llama3.2",
    "systemPrompt": "You are helpful.",
    "settings": { /* agent-specific settings */ },
    "status": "active",
    "createdAt": "2024-01-01T00:00:00.000Z"
  },
  "manifest": { /* capability manifest object */ }
}
```

**Status Codes:** 200, 404

### POST /agents

Create a new agent. **Role:** workspace_admin

```json
// Request
{
  "name": "my-agent",          // required
  "displayName": "My Agent",   // optional
  "model": "ollama/llama3.2",  // optional, default: ollama/llama3.2
  "systemPrompt": "You are a helpful assistant.",  // optional
  "manifest": { /* capability manifest */ }        // optional
}

// Response (201)
{
  "agent": { "id": "uuid", "name": "my-agent", ... }
}
```

### PUT /agents/:id

Update an agent. **Role:** workspace_admin

```json
// Request (all fields optional)
{
  "name": "new-name",
  "displayName": "New Name",
  "model": "ollama/llama3.2",
  "systemPrompt": "Updated prompt.",
  "status": "active"  // active | inactive | archived
}

// Response
{
  "agent": { /* updated agent */ }
}
```

### DELETE /agents/:id

Soft-delete (archive) an agent. **Role:** workspace_admin

```json
// Response
{
  "agent": { "id": "uuid", "name": "my-agent", "status": "archived" },
  "archived": true
}
```

---

## Manifests

Agent manifest versioning endpoints (under `/api/manifests`).

### GET /manifests/:agentId

List manifest versions for an agent.

```json
// Response
{
  "manifests": [
    { "id": "uuid", "version": 3, "createdAt": "...", "createdBy": "uuid" },
    { "id": "uuid", "version": 2, "createdAt": "...", "createdBy": "uuid" }
  ]
}
```

### POST /manifests/:agentId

Create a new manifest version for an agent. **Role:** workspace_admin

```json
// Request
{
  "tools": [
    { "name": "web_search", "constraints": { "max_results": 5 } }
  ],
  "rate_limit": { "requests_per_minute": 30 }
}

// Response (201)
{ "manifest": { "id": "uuid", "version": 4, "agentId": "uuid", ... } }
```

---

## Sessions

### GET /sessions

List sessions. Supports filtering.

**Query params:** `?status=active&agentId=uuid&limit=50` (limit max 200)

```json
// Response
{
  "sessions": [
    {
      "id": "uuid",
      "agentId": "uuid",
      "userId": "uuid",
      "channel": "api",
      "status": "active",
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

### POST /sessions

Create a new session.

```json
// Request
{
  "agentId": "uuid",      // required
  "channel": "api",       // optional, default: api
  "message": "Hello!"     // optional initial message
}

// Response (201)
{
  "session": { "id": "uuid", "agentId": "uuid", "status": "active", ... }
}
```

### GET /sessions/:id

Get session details. Returns 404 if not found.

### POST /sessions/:id/messages

Send a message to an agent session.

```json
// Request
{
  "content": "What can you help me with?",  // required
  "sync": true  // optional, default: true (wait for response)
}

// Response (sync mode)
{
  "sent": true,
  "reply": "I can help with many things! ..."
}
```

Sync mode waits up to 60 seconds for the agent response.

### GET /sessions/:id/messages

Get message history.

**Query params:** `?after=2024-01-01T00:00:00.000Z`

```json
// Response
{
  "messages": [
    {
      "id": "uuid",
      "role": "user",
      "content": "Hello!",
      "createdAt": "2024-01-01T00:00:00.000Z"
    },
    {
      "id": "uuid",
      "role": "assistant",
      "content": "Hi! How can I help?",
      "createdAt": "2024-01-01T00:00:01.000Z"
    }
  ]
}
```

### DELETE /sessions/:id

End a session.

```json
// Response
{ "ended": true }
```

---

## Skills

### GET /skills

List installed skills in the workspace.

### GET /skills/available

List all available skills from the skill bundle.

### GET /skills/search?q=query

Search skills by name or description.

### GET /skills/:name

Get skill details. Returns 400 for invalid names, 404 if not found.

### POST /skills/install

Install a skill. **Role:** workspace_admin

```json
// Request
{ "name": "web-search", "version": "latest" }

// Response (201)
{ "skill": { "name": "web-search", "version": "1.0.0", ... } }
```

### POST /skills/scaffold

Generate a skill template. **Role:** workspace_admin

```json
// Request
{ "name": "my-custom-skill" }

// Response
{
  "scaffold": {
    "name": "my-custom-skill",
    "files": { "manifest.yaml": "...", "index.ts": "..." }
  }
}
```

### DELETE /skills/:name

Remove a skill. **Role:** workspace_admin. Returns 204.

### GET /skills/agents/:agentId

List skills assigned to an agent.

### POST /skills/agents/:agentId

Assign a skill to an agent. **Role:** workspace_admin

```json
// Request
{ "skillName": "web-search" }
```

### DELETE /skills/agents/:agentId/:skillName

Remove a skill from an agent. **Role:** workspace_admin

---

## Tools

Tool management endpoints (under `/api/tools`).

### GET /tools

List installed tools.

```json
// Response
{
  "tools": [
    { "name": "web_search", "version": "1.0.0", "status": "active", ... }
  ]
}
```

### GET /tools/search?q=query

Search the GitHub tool marketplace.

### GET /tools/:name

Get tool details.

### POST /tools/install

Install a tool. **Role:** workspace_admin

```json
// Request
{ "name": "web_search", "version": "latest" }

// Response (201)
{ "tool": { "name": "web_search", "version": "1.0.0", ... } }
```

### POST /tools/scaffold

Scaffold a new custom tool. **Role:** workspace_admin

```json
// Request
{ "name": "my-custom-tool" }

// Response
{
  "scaffold": {
    "name": "my-custom-tool",
    "files": { "manifest.yaml": "...", "index.ts": "..." }
  }
}
```

### POST /tools/:name/scan

Run a security scan on a tool. **Role:** workspace_admin

### DELETE /tools/:name

Remove a tool. **Role:** workspace_admin. Returns 204.

### POST /tools/update

Update installed tools. **Role:** workspace_admin

### POST /tools/:name/dev

Enable dev mode for a tool. **Role:** workspace_admin

---

## API Keys

API key management (under `/api/api-keys`). Keys use the `hc_` prefix.

### GET /api-keys

List API keys. **Role:** workspace_admin

```json
// Response
{
  "keys": [
    { "id": "uuid", "name": "ci-pipeline", "prefix": "hc_abc...", "scopes": ["agents", "sessions"], "createdAt": "..." }
  ]
}
```

### POST /api-keys

Create a new API key. **Role:** workspace_admin

The full key value is only returned once on creation. Store it securely.

```json
// Request
{
  "name": "ci-pipeline",
  "scopes": ["agents", "sessions"]  // restricts access to specific resource paths
}

// Response (201)
{
  "key": "hc_full-key-value-returned-once",
  "id": "uuid",
  "name": "ci-pipeline",
  "scopes": ["agents", "sessions"]
}
```

API keys are looked up via SHA-256 hash. Scopes restrict access to specific resource paths (e.g., `"agents"`, `"sessions"`).

### DELETE /api-keys/:id

Revoke an API key. **Role:** workspace_admin

---

## Secrets

All secrets endpoints require **workspace_admin** role.

### GET /secrets

List secret paths (values are never returned).

**Query params:** `?prefix=integrations/`

```json
// Response
{
  "secrets": [
    { "path": "integrations/slack/bot-token", "createdAt": "...", "updatedAt": "..." }
  ]
}
```

### POST /secrets

Store or update a secret. Values are encrypted with AES-256-GCM.

```json
// Request
{
  "path": "integrations/slack/bot-token",
  "value": "xoxb-your-token",
  "expires_at": "2025-01-01T00:00:00.000Z"  // optional
}

// Response (201)
{ "secret": { "id": "uuid", "path": "...", "createdAt": "..." } }
```

### POST /secrets/rotate

Rotate a secret value.

```json
// Request
{
  "path": "integrations/slack/bot-token",
  "value": "xoxb-new-token"  // optional, auto-generated if omitted
}

// Response
{ "secret": { ... }, "rotated": true }
```

### DELETE /secrets/:secretPath

Delete a secret. **Role:** workspace_admin

**Status Codes:** 204, 404

---

## Users

### GET /users

List workspace users. **Role:** workspace_admin

```json
// Response
{
  "users": [
    {
      "id": "uuid",
      "email": "user@example.com",
      "displayName": "Jane Doe",
      "isDeploymentAdmin": false,
      "totpEnabled": true,
      "role": "agent_user",
      "createdAt": "...",
      "lastLoginAt": "..."
    }
  ]
}
```

### POST /users

Create a user. **Role:** workspace_admin

```json
// Request
{
  "email": "user@example.com",
  "password": "optional-password",  // auto-generated if omitted
  "role": "agent_user"  // workspace_admin | agent_user | auditor | api_service
}

// Response (201)
{
  "user": { "id": "uuid", "email": "user@example.com" },
  "tempPassword": "auto-generated-if-applicable"
}
```

### PATCH /users/:id/role

Update a user's role. **Role:** workspace_admin

```json
// Request
{ "role": "workspace_admin" }

// Response
{ "updated": true, "role": "workspace_admin" }
```

### DELETE /users/:id

Delete a user. **Role:** workspace_admin. Users cannot delete themselves.

**Status Codes:** 204, 400 (self-delete), 404

### PATCH /users/:id/password

Change a user's password. **Role:** workspace_admin (or the user themselves)

```json
// Request
{ "password": "newSecurePassword12" }

// Response
{ "updated": true }
```

Password minimum: 12 characters.

---

## Workspaces

### GET /workspaces

List workspaces. Deployment admins see all; others see only their own.

```json
// Response
{
  "workspaces": [
    { "id": "uuid", "name": "engineering", "displayName": "Engineering Team", ... }
  ]
}
```

### POST /workspaces

Create a workspace. **Role:** deployment_admin

```json
// Request
{ "name": "engineering", "displayName": "Engineering Team" }

// Response (201)
{ "workspace": { "id": "uuid", "name": "engineering", ... } }
```

---

## Audit

Audit endpoints require **workspace_admin** or **auditor** role.

### GET /audit/events

Query audit events with filters and cursor pagination.

**Query params:**
- `eventType` — filter by event type
- `actorId` — filter by user
- `agentId` — filter by agent
- `sessionId` — filter by session
- `startDate` / `endDate` — date range (ISO 8601)
- `cursor` — pagination cursor (UUID from previous response)
- `limit` — max 100, default 50

```json
// Response
{
  "events": [
    {
      "id": "uuid",
      "eventType": "auth.login",
      "actorId": "uuid",
      "payload": { "email": "user@example.com", "success": true },
      "createdAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "nextCursor": "uuid"
}
```

### GET /audit/export

Export audit events as NDJSON.

**Query params:** `startDate`, `endDate`

**Content-Type:** `application/x-ndjson`

---

## Notifications

### GET /notifications

List notifications.

**Query params:** `limit` (max 200), `offset`, `unreadOnly`

```json
// Response
{
  "notifications": [
    {
      "id": "uuid",
      "title": "Agent Error",
      "body": "Agent 'support-bot' encountered an error",
      "severity": "warning",
      "read": false,
      "createdAt": "..."
    }
  ],
  "unreadCount": 5
}
```

### POST /notifications/:id/read

Mark a notification as read.

### POST /notifications/read-all

Mark all notifications as read.

---

## Webhooks

All webhook endpoints require **workspace_admin** role.

### GET /webhooks

List webhook subscriptions.

### POST /webhooks

Create a webhook subscription.

```json
// Request
{
  "url": "https://example.com/webhook",
  "event_types": ["agent.created", "session.created"]
}

// Response (201)
{
  "id": "uuid",
  "signing_secret": "secret-returned-once",
  "url": "https://example.com/webhook",
  "event_types": ["agent.created", "session.created"],
  "enabled": true
}
```

The `signing_secret` is only returned on creation. Store it securely for webhook signature verification.

### PUT /webhooks/:id

Update a webhook.

```json
// Request (all optional)
{ "url": "https://new-url.com/webhook", "event_types": [...], "enabled": false }
```

### DELETE /webhooks/:id

Delete a webhook subscription.

### POST /webhooks/:id/test

Send a test delivery to verify the webhook endpoint.

### GET /webhooks/:id/deliveries

List delivery history for a webhook.

---

## Approvals

Human-in-the-loop approval flow for sensitive tool calls.

### GET /approvals

List pending approvals.

### GET /approvals/:id

Get approval details.

### POST /approvals/:id/approve

Approve a pending tool call. **Role:** workspace_admin

### POST /approvals/:id/reject

Reject a pending tool call. **Role:** workspace_admin

```json
// Request
{ "reason": "Not authorized for this action" }
```

---

## Eval

Evaluation endpoints for prompt regression testing. All require **workspace_admin** role.

### POST /eval/sessions

Create an eval session.

```json
// Request
{ "agentId": "uuid" }

// Response (201)
{ "sessionId": "uuid", "agentId": "uuid", "status": "running" }
```

### POST /eval/sessions/:id/mocks

Register mock tool responses for testing.

```json
// Request
{
  "mocks": [
    { "toolName": "web_search", "response": { "results": [] }, "delayMs": 100 }
  ]
}
```

### POST /eval/sessions/:id/turns

Send a turn in an eval session.

```json
// Request
{ "role": "user", "content": "Search for HonorClaw documentation" }

// Response
{
  "turnId": "uuid",
  "output": "Here are the results...",
  "tokenUsage": { "prompt": 150, "completion": 50, "total": 200 },
  "toolCalls": [{ "name": "web_search", "parameters": {...}, "result": {...} }]
}
```

### GET /eval/sessions/:id/events

Stream eval events via SSE (Server-Sent Events).

---

## Migrate

Workspace data export/import. Requires **workspace_admin** role.

### POST /migrate/export

Export all workspace data.

```json
// Response
{
  "exportVersion": 1,
  "exportedAt": "2024-01-01T00:00:00.000Z",
  "workspaceId": "uuid",
  "data": {
    "workspaces": [...],
    "agents": [...],
    "manifests": [...],
    "sessions": [...],
    "secrets": [...],  // paths only, no values
    "skills": [...],
    "approvals": [...],
    "webhooks": [...],
    "notifications": [...]
  }
}
```

### POST /migrate/import

Import agents and skills.

```json
// Request
{
  "data": {
    "agents": [{ "name": "my-agent", "model": "ollama/llama3.2", ... }],
    "skills": [{ "name": "web-search", "version": "1.0.0", ... }]
  }
}

// Response
{ "imported": true, "counts": { "agents": 2, "skills": 1 } }
```

---

## Scheduled Runs

Cron-based scheduled agent sessions (under `/api/scheduled-runs`).

### GET /scheduled-runs

List scheduled runs.

```json
// Response
{
  "runs": [
    {
      "id": "uuid",
      "agentId": "uuid",
      "cron": "0 9 * * 1-5",
      "message": "Generate daily report",
      "enabled": true,
      "lastRunAt": "2024-01-01T09:00:00.000Z",
      "nextRunAt": "2024-01-02T09:00:00.000Z"
    }
  ]
}
```

### POST /scheduled-runs

Create a scheduled run. **Role:** workspace_admin

```json
// Request
{
  "agentId": "uuid",
  "cron": "0 9 * * 1-5",
  "message": "Generate daily report",
  "enabled": true
}

// Response (201)
{ "run": { "id": "uuid", ... } }
```

### PUT /scheduled-runs/:id

Update a scheduled run. **Role:** workspace_admin

### DELETE /scheduled-runs/:id

Delete a scheduled run. **Role:** workspace_admin

---

## Integrations

Integration status and testing (under `/api/integrations`).

### GET /integrations

List integration status for all configured integrations.

```json
// Response
{
  "integrations": [
    { "id": "slack", "name": "Slack", "status": "connected", "lastChecked": "..." },
    { "id": "github", "name": "GitHub", "status": "not_configured" }
  ]
}
```

### POST /integrations/:id/test

Test an integration connection. For custom integrations, use the `custom/<slug>` format as the `:id` parameter.

### POST /integrations/custom

Create a custom integration definition. Requires `workspace_admin` role.

```json
{
  "name": "My Internal API",
  "description": "Connect to our internal service",
  "category": "Internal Tools",
  "secretFields": [
    { "label": "API Key", "required": true, "placeholder": "sk-..." },
    { "label": "Base URL", "required": false, "placeholder": "https://api.internal.com" }
  ]
}
```

Returns `201` with `{ "integration": { "id", "slug", "name", "description", "category", "secretFields", "createdAt", "updatedAt" } }`.

### GET /integrations/custom

List custom integration definitions for the current workspace. Returns `{ "integrations": [...] }`.

### PUT /integrations/custom/:slug

Update a custom integration. Supports partial updates (name, description, category, secretFields).

### DELETE /integrations/custom/:slug

Delete a custom integration and its associated secrets.

---

## Upgrade

Rolling upgrade management (under `/api/upgrade`).

### GET /upgrade/check

Check for available updates.

```json
// Response
{
  "currentVersion": "0.1.0",
  "latestVersion": "0.2.0",
  "updateAvailable": true,
  "releaseNotes": "..."
}
```

### POST /upgrade/apply

Apply a rolling upgrade. **Role:** deployment_admin

---

## Memory

Agent memory management endpoints (under `/api/memory`).

### GET /memory/:agentId/stats

Get memory statistics for an agent.

```json
// Response
{
  "agentId": "uuid",
  "totalDocuments": 5,
  "totalChunks": 150,
  "embeddingDimensions": 384,
  "estimatedTokens": 75000,
  "totalChars": 300000
}
```

### GET /memory/:agentId/documents

List ingested documents for an agent.

### POST /memory/:agentId/documents

Ingest a document into agent memory. **Role:** workspace_admin

```json
// Request
{
  "title": "Product FAQ",
  "content": "...",
  "metadata": { "source": "wiki" }
}

// Response (201)
{ "document": { "id": "uuid", "title": "Product FAQ", "chunks": 12, ... } }
```

### DELETE /memory/:id/documents/:docId

Delete a document and its chunks. **Role:** workspace_admin

---

## Models

### GET /models

List available LLM models.

```json
// Response
{
  "local": [
    { "name": "llama3.2", "provider": "ollama", "size": 4700000000 }
  ],
  "frontier": [
    { "name": "claude-sonnet-4-20250514", "provider": "anthropic" },
    { "name": "gpt-4o", "provider": "openai" }
  ]
}
```

Frontier models are included based on configured API keys.

---

## Metrics

### GET /metrics

Prometheus-format metrics. **Role:** workspace_admin or auditor

**Content-Type:** `text/plain; version=0.0.4`

Exposed metrics:
- `honorclaw_sessions_total` — Total sessions created
- `honorclaw_llm_tokens_total` — Total LLM tokens used
- `honorclaw_tool_calls_total` — Total tool invocations
- `honorclaw_manifest_denials_total` — Tool calls blocked by policy
- `honorclaw_sessions_active` — Currently active sessions
- `honorclaw_tool_latency_ms` — Tool execution latency

### GET /metrics/dashboard

Dashboard metrics for the Web UI. **Role:** workspace_admin or auditor

```json
// Response
{
  "agents": { "total": 5, "active": 3 },
  "sessions": { "total": 100, "active": 2 },
  "tokenUsage": { "prompt": 50000, "completion": 20000 },
  "toolCalls": { "total": 500, "denied": 3 }
}
```

---

## Health

Health endpoints are public (no authentication required).

### GET /health/live

Liveness probe. Always returns `{"status": "ok"}`.

### GET /health/ready

Readiness probe. Checks database and Redis connectivity.

```json
// Response
{ "status": "ready", "timestamp": "2024-01-01T00:00:00.000Z" }
```

### GET /health/deep

Deep health check with latency metrics.

```json
// Response
{
  "status": "healthy",
  "uptime": 86400,
  "checks": {
    "database": { "status": "ok", "latencyMs": 2 },
    "redis": { "status": "ok", "latencyMs": 1 }
  }
}
```

### GET /status

Platform status overview (used by `honorclaw status` CLI command). Not under the `/api` prefix.

```json
// Response
{
  "version": "0.1.0",
  "uptime": 86400,
  "agents": 5,
  "activeSessions": 2,
  "database": "ok",
  "redis": "ok"
}
```

---

## WebSocket

### /api/sessions/:sessionId/ws

Real-time chat via WebSocket, scoped to a specific session.

**Auth:** Cookie (`token`) or query param (`?token=jwt`)

**Client -> Server:**
```json
{
  "type": "user_message",
  "content": "Hello!"
}
```

**Server -> Client:**
```json
{ "type": "connected", "userId": "uuid", "sessionId": "uuid" }
{ "type": "agent_response", "content": "Hi! How can I help?", "sessionId": "uuid" }
{ "type": "error", "message": "Something went wrong" }
```
