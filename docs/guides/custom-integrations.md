# Custom Integrations

HonorClaw ships with 20 built-in integrations (Slack, GitHub, Snowflake, etc.), but you can also define your own custom integrations to connect agents to internal APIs, proprietary services, or any system that requires stored credentials.

Custom integrations appear alongside built-in integrations in the Web UI, API, and CLI. They support the same credential configuration and connection testing workflow.

## Creating a Custom Integration

### Web UI

1. Navigate to **Integrations** in the admin sidebar.
2. Click **+ Add Custom Integration** in the top right.
3. Fill in the form:
   - **Name** — Display name (e.g., "Internal Analytics API")
   - **Description** — What the integration connects to
   - **Category** — Grouping label (defaults to "Custom")
   - **Secret Fields** — One or more credential fields your integration requires. Each field has:
     - **Label** — Field name shown in the UI (e.g., "API Key")
     - **Placeholder** — Hint text (e.g., "sk-...")
     - **Required** — Whether the field must be filled to pass connection tests
4. Click **Create Integration**.
5. The new integration card appears with a **Custom** badge. Click **Configure** to enter credentials.

### CLI

```bash
# Create a custom integration with two fields
honorclaw integrations create "Internal Analytics API" \
  --description "Query internal analytics warehouse" \
  --category "Internal Tools" \
  --field "API Key:true" \
  --field "Base URL:false"

# List all integrations (built-in + custom)
honorclaw integrations list

# Store credentials for the custom integration
honorclaw secrets set custom/internal-analytics-api/api-key "sk-abc123"
honorclaw secrets set custom/internal-analytics-api/base-url "https://analytics.internal.com"

# Test the connection
honorclaw integrations test custom/internal-analytics-api

# Update the integration
honorclaw integrations update internal-analytics-api --name "Analytics API v2"

# Delete it (also removes stored credentials)
honorclaw integrations delete internal-analytics-api
```

### API

```bash
# Create
curl -X POST http://localhost:3000/api/integrations/custom \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -d '{
    "name": "Internal Analytics API",
    "description": "Query internal analytics warehouse",
    "category": "Internal Tools",
    "secretFields": [
      { "label": "API Key", "required": true, "placeholder": "sk-..." },
      { "label": "Base URL", "required": false, "placeholder": "https://analytics.internal.com" }
    ]
  }'

# List custom integrations only
curl http://localhost:3000/api/integrations/custom \
  -H "Cookie: session=..."

# Update
curl -X PUT http://localhost:3000/api/integrations/custom/internal-analytics-api \
  -H "Content-Type: application/json" \
  -H "Cookie: session=..." \
  -d '{ "name": "Analytics API v2" }'

# Delete
curl -X DELETE http://localhost:3000/api/integrations/custom/internal-analytics-api \
  -H "Cookie: session=..."
```

## How Slugs Work

Each custom integration gets a **slug** — a lowercase, hyphenated identifier derived from the name:
- "Internal Analytics API" → `internal-analytics-api`
- You can also provide a custom slug in the API request.

Slugs must be 2-64 characters, lowercase alphanumeric and hyphens only, and cannot conflict with built-in integration IDs.

## How Secret Paths Work

Secret fields for custom integrations are stored under the `custom/<slug>/` namespace:

| Field Label | Secret Path |
|---|---|
| API Key | `custom/internal-analytics-api/api-key` |
| Base URL | `custom/internal-analytics-api/base-url` |

The main credentials marker is at `integrations/custom/<slug>/credentials`.

This path namespace ensures custom integration secrets never collide with built-in integration secrets.

## Using Custom Integration Secrets in Tools

Custom tool implementations can read the stored secrets at runtime using the secrets API:

```typescript
// In a custom tool handler
const apiKey = await getSecret(`custom/${slug}/api-key`);
const baseUrl = await getSecret(`custom/${slug}/base-url`) ?? 'https://default.api.com';
```

## Limits

- Maximum **20 secret fields** per custom integration.
- Custom integrations are scoped to the workspace — different workspaces can define different custom integrations.
- Only `workspace_admin` users can create, update, or delete custom integrations.
