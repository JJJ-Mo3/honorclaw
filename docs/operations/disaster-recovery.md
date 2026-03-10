# Disaster Recovery Guide

## Overview

This document defines the disaster recovery (DR) procedures for HonorClaw deployments, including Recovery Time Objectives (RTO), Recovery Point Objectives (RPO), and step-by-step restoration procedures.

---

## Recovery Objectives

| Deployment Tier | RTO Target | RPO Target | Strategy |
|----------------|-----------|-----------|----------|
| Tier 1 (Docker Compose) | 1 hour | 24 hours | Daily backups + manual restore |
| Tier 2 (K3s) | 30 minutes | 12 hours | Automated backups + scripted restore |
| Tier 3 (Kubernetes) | 15 minutes | 1 hour | Multi-replica + automated failover |
| Tier 4 (Cloud) | 5 minutes | Near-zero | Multi-AZ + continuous replication |

### Definitions

- **RTO (Recovery Time Objective):** Maximum acceptable time from failure to service restoration.
- **RPO (Recovery Point Objective):** Maximum acceptable data loss measured in time. An RPO of 1 hour means you may lose up to 1 hour of data.

---

## Failure Scenarios

### Scenario 1: Single Container/Pod Failure

**Impact:** Temporary service disruption for one component.

**Recovery (Tier 1 — Docker Compose):**
```bash
# Restart the failed container
docker compose restart <service-name>

# If container is corrupted, recreate it
docker compose up -d --force-recreate <service-name>

# Verify health
honorclaw doctor
```

**Recovery (Tier 3/4 — Kubernetes):**
Automatic. Kubernetes restarts the pod via the deployment controller. If the node is unhealthy, the pod is rescheduled to a healthy node.

**RTO:** < 2 minutes (automatic), < 5 minutes (manual)

### Scenario 2: Database Failure

**Impact:** All operations halt. No new sessions, tool calls, or audit events.

**Recovery (Tier 1):**
```bash
# Check if PostgreSQL container is running
docker compose ps postgres

# If data volume is intact, restart
docker compose restart postgres

# If data is corrupted, restore from backup
honorclaw backup restore latest-backup.tar.gz

# Run migrations (in case schema version differs)
honorclaw upgrade --skip-migrations=false
```

**Recovery (Tier 3/4 — with HA PostgreSQL):**
```bash
# Check PostgreSQL cluster status
kubectl get pods -n honorclaw -l app=postgres

# If primary failed, replica promotes automatically (Patroni/CloudNativePG)
# Verify new primary
kubectl exec -n honorclaw postgres-0 -- patronictl list

# If full cluster failure, restore from backup
honorclaw backup restore s3://backups/latest.tar.gz
```

**RTO:** 15-60 minutes depending on database size and tier.

### Scenario 3: Complete Node Failure

**Impact:** All services on the node are unavailable.

**Recovery (Tier 1 — single node):**
```bash
# On a new node or after node recovery:
# 1. Install Docker and Docker Compose
# 2. Restore data volumes from backup
# 3. Start services
docker compose up -d

# 4. Restore database
honorclaw backup restore latest-backup.tar.gz

# 5. Verify
honorclaw doctor
```

**Recovery (Tier 3/4 — multi-node):**
Kubernetes automatically reschedules pods to healthy nodes. If persistent volumes are on the failed node:

```bash
# Check pod status
kubectl get pods -n honorclaw -o wide

# Force delete stuck pods
kubectl delete pod <pod-name> -n honorclaw --grace-period=0 --force

# If PV was local, restore from backup
# If PV was network-attached (EBS, Ceph), it reattaches automatically
```

**RTO:** 5-30 minutes depending on tier and storage type.

### Scenario 4: Data Corruption

**Impact:** Data integrity compromised. Agents may produce incorrect results.

**Recovery:**
```bash
# 1. Stop all services to prevent further corruption
docker compose stop  # or kubectl scale --replicas=0

# 2. Identify the last known-good backup
ls -la backups/

# 3. Restore from the last verified backup
honorclaw backup restore backups/honorclaw-backup-YYYYMMDD.tar.gz

# 4. Start services
docker compose up -d  # or kubectl scale --replicas=1

# 5. Verify data integrity
honorclaw doctor
```

### Scenario 5: Full Environment Loss

**Impact:** Complete loss of infrastructure (e.g., region failure, data center loss).

**Recovery:**
1. Provision new infrastructure (Terraform/Pulumi)
2. Install HonorClaw:
   ```bash
   git clone https://github.com/JJJ-Mo3/honorclaw.git
   cd honorclaw
   pnpm install && pnpm build
   cd packages/cli && pnpm link --global
   ```
3. Restore from off-site backup
4. Verify and resume operations

```bash
# 1. Install HonorClaw CLI
git clone https://github.com/JJJ-Mo3/honorclaw.git
cd honorclaw
pnpm install && pnpm build
cd packages/cli && pnpm link --global

# 2. Initialize new deployment
honorclaw init

# 3. Restore from off-site backup (S3, GCS, etc.)
# Download backup first
aws s3 cp s3://honorclaw-dr-backups/latest.tar.gz ./latest.tar.gz

# 4. Restore
honorclaw backup restore ./latest.tar.gz

# 5. Update DNS records to point to new deployment
# 6. Verify
honorclaw doctor
```

---

## Backup Storage Recommendations

### Off-Site Backup Requirements

Backups MUST be stored off-site (different failure domain than the primary deployment):

| Tier | Primary Storage | Off-Site Storage |
|------|----------------|-----------------|
| Tier 1 | Local filesystem | Cloud object storage (S3/GCS/Azure Blob) |
| Tier 2 | Local filesystem | Cloud object storage or NFS |
| Tier 3 | PVC in cluster | Cross-region cloud storage |
| Tier 4 | Cloud-native snapshots | Cross-region replication |

### Backup Encryption

All off-site backups should be encrypted:

```bash
# Encrypt backup with GPG
gpg --symmetric --cipher-algo AES256 honorclaw-backup.tar.gz

# Upload encrypted backup
aws s3 cp honorclaw-backup.tar.gz.gpg s3://honorclaw-dr-backups/

# Decrypt when restoring
gpg --decrypt honorclaw-backup.tar.gz.gpg > honorclaw-backup.tar.gz
```

---

## DR Testing

### Testing Schedule

| Test | Frequency | Description |
|------|-----------|-------------|
| Backup verification | Monthly | Restore a backup to a test environment and verify data |
| Single component failover | Quarterly | Kill a component and verify automatic recovery |
| Full DR drill | Semi-annually | Restore entire deployment from backup to a new environment |
| Runbook review | Annually | Review and update DR procedures |

### DR Test Procedure

1. Provision a test environment (isolated from production)
2. Copy the latest production backup to the test environment
3. Execute the restore procedure
4. Verify:
   - All services are healthy (`honorclaw doctor`)
   - Audit logs are complete
   - Agent manifests are intact
   - A test agent session can execute successfully
5. Document the results and time taken
6. Destroy the test environment

---

## Monitoring for DR Readiness

Set up alerts for:

- [ ] Backup job failure (CronJob status)
- [ ] Backup age exceeds RPO threshold
- [ ] Backup storage capacity approaching limits
- [ ] Database replication lag (Tier 3/4)
- [ ] Cross-region replication status (Tier 4)
