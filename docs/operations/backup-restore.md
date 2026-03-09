# Backup and Restore Guide

## Overview

HonorClaw provides built-in backup and restore commands to protect your deployment data. Backups include the PostgreSQL database, configuration files, capability manifests, and audit logs.

---

## Creating a Backup

### Full Backup

```bash
honorclaw backup create
```

This creates a `.tar.gz` archive containing:
- PostgreSQL database dump (full schema + data)
- Configuration files from `/etc/honorclaw/`
- Capability manifests (exported from database)
- Audit event log
- Metadata file with SHA-256 checksums

The archive is saved to `./backups/` by default.

### Custom Output Location

```bash
honorclaw backup create --output my-backup.tar.gz
```

### Audit-Only Backup

Export only audit logs (useful for compliance):

```bash
honorclaw backup create --audit-only
```

### Time-Scoped Audit Export

```bash
honorclaw backup create --audit-only --since 2025-01-01T00:00:00Z
```

### Skip Database Dump

If you manage database backups separately:

```bash
honorclaw backup create --skip-db
```

---

## Restoring from Backup

### Full Restore

```bash
honorclaw backup restore ./backups/honorclaw-backup-2025-01-15_10-30-00.tar.gz
```

This will:
1. Verify archive integrity (SHA-256 checksums)
2. Restore the PostgreSQL database
3. Restore configuration files to `/etc/honorclaw/`

### Dry Run (Verify Only)

```bash
honorclaw backup restore ./backups/honorclaw-backup-2025-01-15.tar.gz --dry-run
```

### Selective Restore

Skip database restore (config only):
```bash
honorclaw backup restore archive.tar.gz --skip-db
```

Skip config restore (database only):
```bash
honorclaw backup restore archive.tar.gz --skip-config
```

### Skip Verification

```bash
honorclaw backup restore archive.tar.gz --no-verify
```

---

## Backup Schedule Recommendations

| Deployment Tier | Frequency | Retention |
|----------------|-----------|-----------|
| Tier 1 (Docker Compose) | Daily | 30 days |
| Tier 2 (K3s) | Daily | 30 days |
| Tier 3 (Kubernetes) | Every 6 hours | 90 days |
| Tier 4 (Cloud) | Continuous (cloud-native) | 365 days |
| HIPAA deployments | Daily minimum | 6 years |

### Automated Backup with Cron

```bash
# Daily backup at 2:00 AM
0 2 * * * /usr/local/bin/honorclaw backup create --output /backups/honorclaw-$(date +\%Y\%m\%d).tar.gz 2>&1 >> /var/log/honorclaw-backup.log
```

### Automated Backup in Kubernetes

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: honorclaw-backup
  namespace: honorclaw
spec:
  schedule: "0 2 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          containers:
            - name: backup
              image: ghcr.io/jjj-mo3/honorclaw:latest
              command: ["honorclaw", "backup", "create"]
              env:
                - name: HONORCLAW_PG_HOST
                  value: honorclaw-postgres
                - name: HONORCLAW_PG_PASSWORD
                  valueFrom:
                    secretKeyRef:
                      name: honorclaw-db
                      key: password
              volumeMounts:
                - name: backups
                  mountPath: /backups
          volumes:
            - name: backups
              persistentVolumeClaim:
                claimName: honorclaw-backups
          restartPolicy: OnFailure
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HONORCLAW_PG_HOST` | `localhost` | PostgreSQL host |
| `HONORCLAW_PG_PORT` | `5432` | PostgreSQL port |
| `HONORCLAW_PG_USER` | `honorclaw` | PostgreSQL user |
| `HONORCLAW_PG_PASSWORD` | (none) | PostgreSQL password |
| `HONORCLAW_PG_DATABASE` | `honorclaw` | PostgreSQL database |
| `HONORCLAW_CONFIG_DIR` | `/etc/honorclaw` | Configuration directory |
| `HONORCLAW_BACKUP_DIR` | `./backups` | Backup output directory |

---

## Verification

After restoring, always verify the deployment:

```bash
honorclaw doctor
```

This checks:
- Database connectivity and schema version
- Configuration file validity
- Service health endpoints
- Agent runtime connectivity
