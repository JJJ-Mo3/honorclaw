# HonorClaw HIPAA Deployment Guide

## Overview

This guide provides a checklist and configuration guidance for deploying HonorClaw in environments that must comply with the Health Insurance Portability and Accountability Act (HIPAA). HonorClaw is self-hosted, which eliminates many cloud-vendor BAA requirements, but the deploying organization must configure the platform correctly.

**Important:** HonorClaw is infrastructure software. It does not itself process, store, or transmit Protected Health Information (PHI). However, agents built on HonorClaw may interact with PHI, making the deployment environment subject to HIPAA requirements. This guide covers the Technical Safeguards.

---

## Pre-Deployment Checklist

### 1. Risk Assessment (164.308(a)(1))

- [ ] Complete a formal risk assessment covering the HonorClaw deployment
- [ ] Document all systems that will store, process, or transmit PHI
- [ ] Identify which agents will have access to PHI-containing systems
- [ ] Document the data flow: user input -> agent -> tools -> data sources

### 2. Business Associate Agreements

- [ ] BAA with infrastructure provider (cloud or data center)
- [ ] BAA with any external LLM provider (if not using local models)
- [ ] **Recommended:** Use Ollama (local model) to avoid LLM-provider BAA requirements

### 3. Workforce Training (164.308(a)(5))

- [ ] Train operators on HonorClaw security model
- [ ] Train operators on incident response procedures
- [ ] Document training completion

---

## Technical Safeguard Configuration

### Access Control (164.312(a))

#### Unique User Identification (164.312(a)(2)(i))

```yaml
# honorclaw.yaml — Ensure unique user IDs and short sessions
auth:
  jwtIssuer: honorclaw          # JWT issuer identifier
  accessTokenTtlMinutes: 15     # Short-lived tokens for PHI environments
  refreshTokenTtlDays: 1        # Limit refresh token lifespan
  mfaRequired: true             # MFA required for HIPAA
```

- [ ] Each user has a unique account (no shared accounts)
- [ ] SSO integration configured (OIDC recommended for enterprise)
- [ ] Service accounts have unique identifiers

#### Emergency Access Procedure (164.312(a)(2)(ii))

- [ ] Document break-glass procedure for emergency access
- [ ] Store emergency credentials in a sealed envelope or HSM
- [ ] Test emergency access procedure quarterly

#### Automatic Logoff (164.312(a)(2)(iii))

```yaml
# honorclaw.yaml
auth:
  accessTokenTtlMinutes: 15   # 15-minute access token lifetime
  refreshTokenTtlDays: 1      # 1-day refresh token lifetime

session:
  maxDurationMinutes: 60       # Agent sessions expire after 1 hour
```

- [ ] Session timeout configured to 15 minutes or less
- [ ] Absolute session timeout configured

#### Encryption and Decryption (164.312(a)(2)(iv))

- [ ] Secrets encrypted with AES-256-GCM (built-in)
- [ ] Database encryption at rest enabled (PostgreSQL TDE or volume encryption)
- [ ] Verify: `honorclaw doctor` reports encryption status

### Audit Controls (164.312(b))

```yaml
# honorclaw.yaml
audit:
  enabled: true
  retentionDays: 2190       # 6 years (HIPAA requires 6 years)
  includeInputHash: true
  includeToolCallDetails: true
  externalSiem:
    enabled: true
    webhookUrl: https://siem.internal/honorclaw
```

- [ ] Audit logging enabled (non-negotiable)
- [ ] Retention set to minimum 6 years
- [ ] External SIEM integration configured
- [ ] Audit log integrity verification (append-only table)
- [ ] Regular audit log review process documented

### Integrity (164.312(c))

#### Mechanism to Authenticate ePHI (164.312(c)(2))

- [ ] Container images signed with Cosign
- [ ] OPA policy: AllImagesFromApprovedRegistry enforced
- [ ] Database backups include SHA-256 checksums
- [ ] Manifest versioning with integrity hashes

### Person or Entity Authentication (164.312(d))

```yaml
# honorclaw.yaml — MFA required for HIPAA
auth:
  mfaRequired: true
  # Note: Password complexity (min 12 chars) is enforced at the application level,
  # not via honorclaw.yaml configuration.
```

- [ ] MFA enabled and required for all users
- [ ] Strong password policy configured
- [ ] Password rotation policy enforced (90 days)

### Transmission Security (164.312(e))

- [ ] TLS 1.2+ for all external connections
- [ ] mTLS for inter-service communication (Tier 3+ deployment required)
- [ ] No PHI transmitted over unencrypted channels

```yaml
# Note: TLS is handled at the infrastructure layer (reverse proxy / ingress
# controller), not in honorclaw.yaml. Configure TLS termination on your
# ingress controller or load balancer with TLS 1.2+ minimum version.
```

---

## Agent Configuration for PHI Environments

### Capability Manifest — PHI Agent Template

```yaml
agentId: phi-safe-agent
workspaceId: ws-hipaa
version: 1

tools:
  - name: patient_lookup
    enabled: true
    requiresApproval: true    # Human-in-the-loop for PHI access
    parameters:
      patient_id:
        type: string
        allowedPatterns: ["^[A-Z0-9]{8}$"]  # Strict ID format
    rateLimit:
      maxCallsPerMinute: 10
      maxCallsPerSession: 50

egress:
  allowedDomains: []          # No external egress for PHI agents
  maxResponseSizeBytes: 1048576

inputGuardrails:
  injectionDetection: true
  blockToolDiscovery: true
  blockPromptExtraction: true
  piiFilterInputs: true       # Redact PII in inputs
  maxMessageLength: 2000

outputFilters:
  piiDetection: true
  maxResponseTokens: 2048

session:
  maxDurationMinutes: 60
  maxTokensPerSession: 50000
  maxToolCallsPerSession: 100

budget:
  maxTokensPerDay: 100000
  hardStopOnBudgetExceeded: true
```

### Key PHI Agent Requirements

- [ ] `requiresApproval: true` for all tools accessing PHI
- [ ] `piiFilterInputs: true` to redact PII in conversation logs
- [ ] `piiDetection: true` in output filters
- [ ] Empty `allowedDomains` (no external egress)
- [ ] Short session timeouts
- [ ] Strict rate limits

---

## Infrastructure Requirements

### Tier 3 or Tier 4 Deployment Required

HIPAA deployments MUST use Tier 3 (Kubernetes) or Tier 4 (Cloud-managed K8s). Docker Compose (Tier 1) and K3s (Tier 2) do not provide sufficient network isolation or mTLS.

### Network Isolation

- [ ] Dedicated Kubernetes namespace for PHI workloads
- [ ] NetworkPolicy enforced (Calico or Cilium CNI required)
- [ ] Agent-runtime pods isolated (no internet access)
- [ ] Database accessible only from control plane namespace

### Encryption at Rest

- [ ] PostgreSQL volume encryption (LUKS or cloud-provider encryption)
- [ ] Redis data not persisted (in-memory only) OR encrypted volume
- [ ] Backup files encrypted with AES-256

### Node Security

- [ ] Nodes running hardened OS (CIS benchmark)
- [ ] Automatic security patching enabled
- [ ] Node access restricted to authorized operators

---

## Minimum Necessary Standard Compliance

The HIPAA Minimum Necessary Standard requires that access to PHI be limited to the minimum necessary for the intended purpose. HonorClaw implements this through:

1. **Capability Manifests**: Each agent has an explicit list of tools it can use. An agent configured for appointment scheduling cannot access lab results.

2. **Data Access Controls**: The `dataAccess` section of the manifest specifies which databases, storage prefixes, and columns the agent can access. `piiColumnsBlocked` prevents access to specific sensitive columns.

3. **Workspace Isolation**: Different departments or use cases are isolated in separate workspaces. A billing agent cannot access clinical data.

4. **Approval Workflows**: Tools that access PHI require human approval before execution.

---

## Ongoing Compliance

### Regular Tasks

| Task | Frequency | Description |
|------|-----------|-------------|
| Access review | Quarterly | Review user roles and permissions |
| Audit log review | Monthly | Review audit logs for anomalies |
| Security scan | Weekly (automated) | CI pipeline: Trivy, Semgrep, TruffleHog |
| Backup verification | Monthly | Test backup restore procedure |
| Penetration test | Annually | External assessment of the deployment |
| Risk assessment update | Annually | Update risk assessment document |
| Policy review | Annually | Review and update security policies |

### Breach Notification Preparation

- [ ] Document breach notification procedures (60-day requirement)
- [ ] Identify breach notification contacts (HHS, affected individuals, media)
- [ ] Configure webhook alerts for security events indicating potential breach
- [ ] Test incident response procedure semi-annually
