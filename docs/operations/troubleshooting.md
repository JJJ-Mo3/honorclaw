# Troubleshooting Guide

## Common Issues and Fixes

---

### honorclaw doctor fails

**Symptom:** `honorclaw doctor` reports one or more failing checks.

**Fix:** Address each failing check individually:

| Check | Common Cause | Fix |
|-------|-------------|-----|
| Docker not running | Docker daemon stopped | `sudo systemctl start docker` or start Docker Desktop |
| PostgreSQL unhealthy | Container crashed or data corruption | `docker compose restart postgres` |
| Redis unhealthy | Container OOM killed | Check memory limits, restart: `docker compose restart redis` |
| Ollama not running | Model not downloaded | `docker compose logs ollama`, wait for model pull |
| Control plane not responding | Port conflict or crash | Check port 3000, review logs: `docker compose logs honorclaw` |

---

### Agent deployment fails

**Symptom:** `honorclaw agent deploy agent.yaml` returns an error.

**Common causes:**

1. **Invalid YAML syntax**
   ```bash
   # Validate YAML syntax
   python3 -c "import yaml; yaml.safe_load(open('agent.yaml'))"
   ```

2. **Invalid regex in blockedPatterns or allowedPatterns**
   ```bash
   # Test your regex patterns
   node -e "new RegExp('your_pattern_here')"
   ```

3. **Missing required fields**
   ```bash
   honorclaw agent validate agent.yaml
   ```

4. **Duplicate agent name**
   ```bash
   honorclaw agent list
   # If exists, update instead:
   honorclaw agent update <agent-id> --manifest agent.yaml
   ```

---

### Agent cannot call tools

**Symptom:** Agent says it will use a tool but the tool call fails or is rejected.

**Diagnosis:**

```bash
# Check audit log for the agent
honorclaw audit query --agent <agent-id> --type tool_call --limit 10

# Look for enforcement violations
honorclaw audit query --agent <agent-id> --type guardrail_violation
```

**Common causes:**

| Error | Cause | Fix |
|-------|-------|-----|
| `tool_not_allowed` | Tool not in manifest | Add the tool to the agent's manifest |
| `tool_disabled` | Tool is disabled | Set `enabled: true` in the manifest |
| `blocked_patterns` | Parameter matched a blocked pattern | Adjust `blockedPatterns` or fix the input |
| `allowed_patterns` | Parameter did not match any allowed pattern | Adjust `allowedPatterns` |
| `max_length` | Parameter too long | Increase `maxLength` or shorten input |
| `rate_limit` | Too many calls | Wait, or increase `maxCallsPerMinute` |

---

### Guardrail false positives

**Symptom:** Legitimate user messages are blocked by injection detection.

**Diagnosis:**

```bash
honorclaw audit query --type guardrail_violation --limit 20
```

**Fix options:**

1. **Adjust topic restrictions** — If `allowedTopics` is too narrow, broaden it.

2. **Add exception patterns** — The guardrail patterns are in `packages/control-plane/src/guardrails/`. You can customize by forking the patterns.

3. **Disable specific guardrails** (not recommended for production):
   ```yaml
   inputGuardrails:
     injectionDetection: false   # CAUTION: reduces security
   ```

---

### High memory usage

**Symptom:** Containers using more memory than expected, OOM kills.

**Diagnosis:**

```bash
# Docker Compose
docker stats

# Kubernetes
kubectl top pods -n honorclaw
kubectl top pods -n honorclaw-agents
```

**Common causes:**

1. **Ollama model too large** — Use a smaller model:
   ```yaml
   model:
     model: llama3.2   # 3B params, ~4GB RAM
     # Instead of: llama3.1:70b (70B params, ~40GB RAM)
   ```

2. **Too many concurrent agent sessions** — Reduce max sessions:
   ```yaml
   session:
     maxDurationMinutes: 30  # Shorter sessions
   ```

3. **PostgreSQL needs tuning** — Adjust `shared_buffers` and `work_mem` in PostgreSQL config.

---

### Database connection errors

**Symptom:** "Connection refused" or "too many connections" errors.

**Diagnosis:**

```bash
# Check if PostgreSQL is running
docker compose exec postgres pg_isready

# Check connection count
docker compose exec postgres psql -U honorclaw -c "SELECT count(*) FROM pg_stat_activity;"
```

**Fixes:**

1. **Connection refused:**
   ```bash
   docker compose restart postgres
   ```

2. **Too many connections:**
   ```bash
   # Increase max_connections in PostgreSQL
   # Edit postgresql.conf or set environment variable:
   # POSTGRES_MAX_CONNECTIONS=200
   docker compose restart postgres
   ```

---

### Redis connection issues

**Symptom:** Agent sessions fail to start, "Redis connection timeout" errors.

**Diagnosis:**

```bash
# Check Redis
docker compose exec redis redis-cli ping
# Should return: PONG

# Check memory usage
docker compose exec redis redis-cli info memory
```

**Fixes:**

1. **Restart Redis:**
   ```bash
   docker compose restart redis
   ```

2. **Redis OOM:** Increase memory limit or configure eviction:
   ```bash
   # In docker-compose.yml
   redis:
     command: redis-server --maxmemory 512mb --maxmemory-policy allkeys-lru
   ```

---

### TLS certificate errors

**Symptom:** "Certificate expired" or "self-signed certificate" errors.

**Fixes:**

1. **Check certificate expiry:**
   ```bash
   openssl x509 -in /etc/honorclaw/tls/tls.crt -noout -enddate
   ```

2. **Renew certificate:**
   ```bash
   # If using cert-manager
   kubectl delete certificate honorclaw-tls -n honorclaw
   # cert-manager will re-issue

   # If using self-signed
   openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
     -keyout tls.key -out tls.crt \
     -subj "/CN=honorclaw.local"
   ```

---

### Port 3000 already in use

**Symptom:** Control plane fails to start with "EADDRINUSE" error.

**Fix:**

```bash
# Find what is using port 3000
lsof -i :3000

# Kill the process or change the port
# In honorclaw.yaml:
server:
  port: 3001
```

---

### Docker Compose "image not found"

**Symptom:** `docker compose up` fails with image pull errors.

**Fixes:**

1. **Authenticate to GHCR:**
   ```bash
   echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin
   ```

2. **Pull images manually:**
   ```bash
   docker pull ghcr.io/honorclaw/honorclaw:latest
   docker pull ghcr.io/honorclaw/agent-runtime:latest
   ```

3. **Build from source:**
   ```bash
   docker build -f infra/docker/honorclaw.Dockerfile -t honorclaw/honorclaw:latest .
   ```

---

### Upgrade fails

**Symptom:** `honorclaw upgrade` fails during migration or restart.

**Fix:**

1. **Check logs:**
   ```bash
   docker compose logs honorclaw
   ```

2. **Retry with force:**
   ```bash
   honorclaw upgrade --force
   ```

3. **Manual rollback:**
   ```bash
   # Restore from backup
   honorclaw backup restore latest-backup.tar.gz

   # Restart with previous version
   docker compose up -d
   ```

---

## Getting Help

If your issue is not covered here:

1. Run `honorclaw doctor --full` and save the output
2. Collect logs: `docker compose logs > honorclaw-logs.txt`
3. Check the [GitHub Issues](https://github.com/honorclaw/honorclaw/issues)
4. Open a new issue with the diagnostic output
