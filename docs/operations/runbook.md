# HonorClaw Operational Runbook

## Overview

This runbook covers common operational procedures for HonorClaw deployments. It is intended for operators and SREs who manage HonorClaw in production.

---

## Daily Operations

### Health Check

```bash
# Quick health check
honorclaw doctor

# Full health check (includes database, Redis, agent runtime)
honorclaw doctor

# Docker Compose: check all containers
docker compose ps

# Kubernetes: check all pods
kubectl get pods -n honorclaw
```

### Check Service Logs

```bash
# Docker Compose
docker compose logs --tail=100 honorclaw
docker compose logs --tail=100 --follow honorclaw

# Kubernetes
kubectl logs -n honorclaw deploy/honorclaw-control-plane --tail=100
kubectl logs -n honorclaw deploy/honorclaw-control-plane -f
```

### Monitor Active Sessions

```bash
# List active sessions via API
curl -s http://localhost:3000/api/sessions?status=active | jq '.sessions | length'
```

---

## User Management

### Create Admin User

```bash
# Interactive
honorclaw users create -e admin@example.com -p <password> -r workspace_admin

# Non-interactive
honorclaw users create -e admin@example.com -p <password> -r workspace_admin
```

### Disable a User

> **Note:** User disabling is available via the Web UI or API (`PATCH /api/users/:id/role`).

### Reset User Password

> **Note:** Password resets are available via the Web UI.

### Rotate Keys

```bash
# Rotate master key
honorclaw key-rotation rotate-master

# Rotate JWT signing keys
honorclaw key-rotation rotate-jwt

# Rotate tool signing keys
honorclaw key-rotation rotate-tool-signing
```

---

## Agent Management

### Deploy a New Agent

```bash
# Validate manifest before deploying
honorclaw agents deploy agent.yaml

# Deploy the agent
honorclaw agents deploy agent.yaml

# Check agent status
honorclaw agents get <agent-id>
```

### Disable an Agent

```bash
# Disable (prevents new sessions, existing sessions continue)
honorclaw agents update <agent-id> -s inactive

# Note: active sessions will continue until they end naturally
honorclaw agents update <agent-id> -s inactive
```

### Update Agent Manifest

```bash
# Deploy updated manifest (creates new version)
honorclaw agents deploy updated-agent.yaml

# View manifest version history
honorclaw agents versions <agent-id>

# Rollback to previous version
honorclaw agents rollback <agent-id> --to 2
```

---

## Database Operations

### Check Database Status

```bash
# Docker Compose
docker compose exec postgres pg_isready

# Kubernetes
kubectl exec -n honorclaw postgres-0 -- pg_isready
```

### Run Migrations

```bash
# Docker Compose
docker compose run --rm honorclaw node dist/db/migrate.js

# Kubernetes
kubectl exec -n honorclaw deploy/honorclaw-control-plane -- node dist/db/migrate.js
```

### Database Size

```bash
# Docker Compose
docker compose exec postgres psql -U honorclaw -c "SELECT pg_size_pretty(pg_database_size('honorclaw'));"

# Check table sizes
docker compose exec postgres psql -U honorclaw -c "
  SELECT relname AS table,
         pg_size_pretty(pg_total_relation_size(relid)) AS size
  FROM pg_catalog.pg_statio_user_tables
  ORDER BY pg_total_relation_size(relid) DESC
  LIMIT 10;
"
```

### Audit Log Maintenance

```bash
# Count audit events
docker compose exec postgres psql -U honorclaw -c "SELECT count(*) FROM audit_events;"

# Archive old audit events (keep 90 days in primary table)
docker compose exec postgres psql -U honorclaw -c "
  DELETE FROM audit_events WHERE created_at < NOW() - INTERVAL '90 days';
"
# NOTE: Always export to backup BEFORE deleting old audit events
```

---

## Certificate Management

### Check Certificate Expiry

```bash
# Check TLS certificate expiry
openssl x509 -in /etc/honorclaw/tls/tls.crt -noout -enddate

# Kubernetes: check cert-manager certificates
kubectl get certificates -n honorclaw
```

### Rotate TLS Certificates

```bash
# If using cert-manager, trigger renewal
kubectl delete secret honorclaw-tls -n honorclaw
# cert-manager will automatically re-issue

# If using manual certificates
# 1. Generate new certificate
# 2. Update the secret/config
# 3. Restart the control plane
docker compose restart honorclaw
```

---

## Scaling

### Scale Agent Runtime Pods

```bash
# Kubernetes: scale agent runtime
kubectl scale deployment/honorclaw-agent-runtime -n honorclaw-agents --replicas=5

# View current replica count
kubectl get deployment/honorclaw-agent-runtime -n honorclaw-agents
```

### Scale Control Plane

```bash
# Kubernetes: scale control plane (ensure database can handle connections)
kubectl scale deployment/honorclaw-control-plane -n honorclaw --replicas=3
```

---

## Troubleshooting Quick Reference

| Symptom | Check | Resolution |
|---------|-------|------------|
| API returns 503 | `honorclaw doctor` | Restart control plane |
| Agent sessions timing out | Redis connectivity | Check Redis logs, restart if needed |
| Database connection refused | `pg_isready` | Check PostgreSQL container/pod |
| High memory usage | `docker stats` or `kubectl top pods` | Check for memory leaks, adjust limits |
| Audit events not recording | Database connectivity | Verify audit table exists, check logs |
| Agent cannot call tools | Manifest enforcement | Check manifest for the agent, verify tool is enabled |
| Prompt injection alerts | Audit logs | Review the input, update guardrail patterns if false positive |
| Image pull errors | Registry connectivity | Check registry credentials, network access |

---

## Emergency Procedures

### Emergency Shutdown

```bash
# Docker Compose
docker compose down

# Kubernetes
kubectl scale deployment --all --replicas=0 -n honorclaw
kubectl scale deployment --all --replicas=0 -n honorclaw-agents
```

### Emergency Database Access

```bash
# Docker Compose
docker compose exec postgres psql -U honorclaw

# Kubernetes
kubectl exec -it -n honorclaw postgres-0 -- psql -U honorclaw
```

### Recover from Failed Upgrade

```bash
# Docker Compose: restore previous images
docker compose pull  # or specify exact version tags in compose file
docker compose up -d

# Kubernetes: rollback deployment
kubectl rollout undo deployment/honorclaw-control-plane -n honorclaw
kubectl rollout undo deployment/honorclaw-agent-runtime -n honorclaw-agents

# If database migration failed, restore from backup
honorclaw backup restore latest-backup.tar.gz
```
