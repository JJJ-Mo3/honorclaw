# Quickstart: First Agent in 10 Minutes

## Prerequisites

- Docker and Docker Compose installed
- 8 GB RAM minimum (16 GB recommended for local LLM)
- 20 GB free disk space

---

## Step 1: Install the CLI

```bash
curl -fsSL https://honorclaw.dev/install.sh | sh
```

Or download manually from [GitHub Releases](https://github.com/honorclaw/honorclaw/releases).

## Step 2: Initialize the Deployment

```bash
honorclaw init
```

This will:
- Create configuration files
- Pull Docker images
- Start PostgreSQL, Redis, Ollama, and the control plane
- Run database migrations
- Pull the default LLM model (llama3.2)

Wait for initialization to complete (2-5 minutes depending on your internet speed).

## Step 3: Verify the Deployment

```bash
honorclaw doctor
```

You should see all checks passing:

```
[ok] Docker is running
[ok] PostgreSQL is healthy
[ok] Redis is healthy
[ok] Ollama is running
[ok] Control plane API is responding
[ok] LLM model is available
```

## Step 4: Create Your First Agent

Create a file called `my-agent.yaml`:

```yaml
name: my-first-agent
description: A simple assistant that can search the web

model:
  provider: ollama
  model: llama3.2

systemPrompt: |
  You are a helpful assistant. Be concise and accurate.

tools:
  - name: web_search
    enabled: true
    parameters:
      query:
        type: string
        maxLength: 500

egress:
  allowedDomains:
    - "*.google.com"
    - "*.wikipedia.org"

inputGuardrails:
  injectionDetection: true
  blockToolDiscovery: true
  maxMessageLength: 4000
```

Deploy it:

```bash
honorclaw agent deploy my-agent.yaml
```

## Step 5: Start a Conversation

```bash
honorclaw chat my-first-agent
```

You are now chatting with your agent! Try asking:
- "What is the weather like today?"
- "Summarize the Wikipedia article about quantum computing"

## Step 6: Review the Audit Log

Every interaction is logged:

```bash
honorclaw audit query --agent my-first-agent --limit 10
```

---

## Next Steps

- **[Creating Your First Agent](operations/first-agent.md)** — Detailed guide with all configuration options
- **[Tier 1 Docker Compose Guide](install/tier1-docker-compose.md)** — Full deployment guide
- **[Security Model](security/security-model.md)** — Understand how HonorClaw keeps agents safe
- **[Example Agents](https://github.com/honorclaw/honorclaw/tree/main/examples)** — Pre-built agent templates

---

## Troubleshooting

### "Docker is not running"

Start Docker Desktop or the Docker daemon:
```bash
# macOS/Windows: Start Docker Desktop
# Linux:
sudo systemctl start docker
```

### "LLM model not available"

The first model pull can take several minutes. Check progress:
```bash
docker compose logs ollama
```

### "Control plane API not responding"

Check the logs:
```bash
docker compose logs honorclaw
```

Common issues:
- Port 3000 is already in use: change the port in the configuration
- Database migration failed: run `honorclaw upgrade`

For more troubleshooting help, see [Troubleshooting Guide](operations/troubleshooting.md).
