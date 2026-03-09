# HonorClaw Quickstart

Get HonorClaw running in under 5 minutes.

## Prerequisites

- **Docker** (20.10+) with Docker Compose
- **4 GB RAM** minimum (8 GB recommended for local LLM inference via Ollama)

## Step 1: Clone and Initialize

```bash
git clone https://github.com/JJJ-Mo3/honorclaw.git
cd honorclaw

# Initialize — generates secrets, creates database schema, sets up admin user
make init
```

During `make init`, you will be prompted to create an admin email and password. These are your first login credentials.

## Step 2: Start HonorClaw

```bash
make up
```

This starts the HonorClaw container with PostgreSQL (pgvector), Redis, and the control plane on a single port.

## Step 3: Open the Web UI

Navigate to [http://localhost:3000](http://localhost:3000) and log in with the admin credentials you created during `make init`.

## Step 4: Create Your First Agent

### Option A: Web UI

1. Go to **Agents** in the sidebar
2. Click **Create Agent**
3. Fill in the agent name, select a model (e.g., `ollama/llama3.2`), and optionally set a system prompt
4. Click **Save**

### Option B: CLI

```bash
# Authenticate the CLI
honorclaw login -s http://localhost:3000

# Create an agent
honorclaw agents create -n "my-assistant" -m "ollama/llama3.2" -p "You are a helpful assistant."

# Start chatting
honorclaw chat my-assistant
```

### Option C: REST API

```bash
# Get an access token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"your-password"}' \
  | jq -r '.accessToken')

# Create an agent
curl -X POST http://localhost:3000/api/agents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-assistant",
    "model": "ollama/llama3.2",
    "systemPrompt": "You are a helpful assistant."
  }'

# Start a session
SESSION_ID=$(curl -s -X POST http://localhost:3000/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "<agent-id-from-above>"}' \
  | jq -r '.session.id')

# Send a message
curl -X POST "http://localhost:3000/api/sessions/$SESSION_ID/messages" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello! What can you help me with?"}'
```

## Step 5: Deploy an Agent from a Manifest

For production agents, define capabilities in a YAML manifest:

```yaml
# agent.yaml
name: support-bot
model: ollama/llama3.2
system_prompt: "You are a customer support assistant."
tools:
  - name: web_search
    constraints:
      max_results: 5
  - name: memory_search
rate_limit:
  requests_per_minute: 30
```

```bash
honorclaw agents deploy agent.yaml
```

## Step 6: Verify Health

```bash
# Run diagnostic checks
honorclaw doctor

# Check platform status
honorclaw status
```

## Next Steps

- [Administration Guide](administration.md) — User management, RBAC, secrets, audit
- [Security Architecture](security/security-model.md) — The Capability Sandwich explained
- [API Reference](api-reference.md) — Complete REST API documentation
- [First Agent Guide](operations/first-agent.md) — Detailed agent deployment walkthrough
- [Deployment Tiers](install/tier1-docker-compose.md) — Docker Compose, Swarm, and Kubernetes guides
