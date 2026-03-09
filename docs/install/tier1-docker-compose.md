# Tier 1: Docker Compose Deployment

## Overview

Tier 1 is the simplest deployment option. All HonorClaw components run in a single Docker Compose stack on one machine. Suitable for:

- Development and testing
- Small teams (1-10 users)
- Proof of concept
- Environments where Kubernetes is not available

**Not recommended for:** production workloads with strict SLA requirements, HIPAA, or multi-tenant environments.

---

## Prerequisites

| Requirement | Minimum | Recommended |
|------------|---------|-------------|
| Docker | 24.0+ | Latest |
| Docker Compose | v2.20+ | Latest |
| RAM | 8 GB | 16 GB |
| CPU | 4 cores | 8 cores |
| Disk | 20 GB | 50 GB |
| OS | Linux, macOS, Windows (WSL2) | Ubuntu 22.04+ |

## Installation

### 1. Install the CLI

```bash
git clone https://github.com/JJJ-Mo3/honorclaw.git && cd honorclaw && pnpm install && pnpm build && npm link packages/cli
```

### 2. Initialize

```bash
mkdir honorclaw && cd honorclaw
honorclaw init
```

This generates:
- `docker-compose.yml` — Service definitions
- `honorclaw.yaml` — Platform configuration
- `.env` — Environment variables (secrets)

### 3. Configure

Edit `honorclaw.yaml`:

```yaml
# Minimum configuration
server:
  host: 0.0.0.0
  port: 3000

database:
  host: postgres
  port: 5432
  name: honorclaw
  user: honorclaw
  # Password is in .env file

redis:
  host: redis
  port: 6379

llm:
  provider: ollama
  endpoint: http://ollama:11434
  defaultModel: llama3.2

auth:
  jwtSecret: ${JWT_SECRET}  # Auto-generated in .env
  sessionTimeout: 60m
```

Edit `.env`:

```bash
# Auto-generated — change these for production
POSTGRES_PASSWORD=<generated>
JWT_SECRET=<generated>
REDIS_PASSWORD=<generated>
```

### 4. Start

```bash
docker compose up -d
```

### 5. Verify

```bash
honorclaw doctor
```

### 6. Create Admin User

```bash
honorclaw users create -e admin@example.com -p <password> -r workspace_admin
```

---

## Architecture

```
┌──────────────────────────────────────────────┐
│                Docker Host                    │
│                                               │
│  ┌─────────┐  ┌─────────┐  ┌──────────────┐ │
│  │PostgreSQL│  │  Redis   │  │   Ollama     │ │
│  │  :5432   │  │  :6379   │  │   :11434     │ │
│  └────┬─────┘  └────┬─────┘  └──────┬───────┘ │
│       │              │               │         │
│  ┌────┴──────────────┴───────────────┴───────┐ │
│  │           Control Plane (:3000)            │ │
│  │  - API server                              │ │
│  │  - Policy enforcer                         │ │
│  │  - Session manager                         │ │
│  │  - Audit logger                            │ │
│  └────────────────────┬──────────────────────┘ │
│                       │ Redis pub/sub          │
│  ┌────────────────────┴──────────────────────┐ │
│  │        Agent Runtime (per session)         │ │
│  │  - Sandboxed execution                     │ │
│  │  - Read-only filesystem                    │ │
│  │  - Network-isolated                        │ │
│  └───────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

---

## Service Details

| Service | Image | Ports | Volumes |
|---------|-------|-------|---------|
| `postgres` | `pgvector/pgvector:pg16` | 5432 (internal) | `honorclaw_pgdata` |
| `redis` | `redis:7-alpine` | 6379 (internal) | None (ephemeral) |
| `ollama` | `ollama/ollama` | 11434 (internal) | `honorclaw_ollama` |
| `honorclaw` | `ghcr.io/jjj-mo3/honorclaw` | 3000 | Config mount |

---

## Security Configuration

### TLS Termination

For production use, place a reverse proxy (nginx, Caddy, Traefik) in front of HonorClaw:

```yaml
# docker-compose.override.yml
services:
  caddy:
    image: caddy:2-alpine
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
```

### Backup

Set up automated backups:

```bash
# Add to crontab
0 2 * * * /usr/local/bin/honorclaw backup create --output /backups/daily-$(date +\%Y\%m\%d).tar.gz
```

---

## Upgrading

```bash
honorclaw upgrade
```

This pulls latest images, runs migrations, and restarts services.

---

## Limitations

- **No high availability:** Single point of failure for all components
- **Limited network isolation:** Docker networking is less strict than Kubernetes NetworkPolicy
- **No mTLS:** Inter-service communication is not encrypted (OK on localhost)
- **Single node:** Cannot scale horizontally

For production deployments, consider [Tier 3 (Kubernetes)](tier3-kubernetes.md) or [Tier 4 (Cloud)](tier4-cloud.md).
