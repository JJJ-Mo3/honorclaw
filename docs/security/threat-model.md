# HonorClaw Threat Model

## Overview

This document provides a STRIDE-based threat analysis of the HonorClaw platform. Each threat category is analyzed with specific attack scenarios, existing mitigations, and residual risk.

---

## System Components

| Component | Trust Level | Network Zone |
|-----------|------------|--------------|
| Control Plane API | Trusted | Internal, TLS-terminated |
| PostgreSQL | Trusted | Internal, no external access |
| Redis | Semi-trusted | Localhost only (sidecar) |
| Agent Runtime | Untrusted | Isolated, egress denied |
| LLM (Ollama/External) | Semi-trusted | Control plane egress only |
| User Client | Untrusted | External |
| Admin Console | Trusted | Internal/VPN only |

---

## STRIDE Analysis

### S — Spoofing

**S1: User Identity Spoofing**
- **Threat:** Attacker forges authentication tokens to impersonate another user.
- **Mitigation:** JWT tokens signed with HS256 (HMAC-SHA256) using a server-side secret, configurable expiration (default 60 min), refresh token rotation. TOTP-based MFA for admin accounts.
- **Residual Risk:** Low. Token theft via XSS if admin console is compromised.

**S2: Agent Identity Spoofing**
- **Threat:** Malicious agent claims to be a different agent to access another workspace's resources.
- **Mitigation:** Agent identity is bound to the capability manifest, which includes `agentId` and `workspaceId`. The control plane verifies these on every tool call. Agents cannot modify their own manifest.
- **Residual Risk:** Very low. Would require control plane compromise.

**S3: Service-to-Service Spoofing**
- **Threat:** Attacker spins up a fake control plane or Redis instance.
- **Mitigation:** Kubernetes NetworkPolicy restricts which pods can communicate. Redis connections require authentication. mTLS for inter-service communication in Tier 3+ deployments.
- **Residual Risk:** Low in Tier 3+. Medium in Tier 1 (Docker Compose) where network isolation is weaker.

### T — Tampering

**T1: Manifest Tampering**
- **Threat:** Attacker modifies the capability manifest to grant additional tools or relax constraints.
- **Mitigation:** Manifests are stored in PostgreSQL with version history. Changes require admin authentication and are audit-logged. The control plane loads manifests from the database, not from the agent.
- **Residual Risk:** Low. Database compromise would be required.

**T2: Audit Log Tampering**
- **Threat:** Attacker deletes or modifies audit logs to cover tracks.
- **Mitigation:** Audit events are written to an append-only table with row-level security. Optionally streamed to external SIEM via webhooks. Database role used by the control plane has INSERT but not UPDATE/DELETE on audit tables.
- **Residual Risk:** Low with external SIEM integration. Medium without.

**T3: Container Binary Tampering**
- **Threat:** Attacker modifies binaries inside a running container.
- **Mitigation:** Read-only root filesystem (enforced by OPA policy). Container images signed with Cosign. Image pull policy set to Always.
- **Residual Risk:** Very low.

**T4: Redis Message Tampering**
- **Threat:** Attacker modifies messages in the Redis pub/sub channel.
- **Mitigation:** Redis is bound to localhost (sidecar pattern). Redis AUTH required. Messages include HMAC signatures for integrity verification.
- **Residual Risk:** Low. Would require sidecar container compromise.

### R — Repudiation

**R1: User Denies Sending a Request**
- **Threat:** User claims they did not send a particular message or authorize an action.
- **Mitigation:** All user messages are logged with session ID, user ID, workspace ID, IP address, and SHA-256 hash of the message content. Audit events include timestamps with server-side clock.
- **Residual Risk:** Very low with audit logging enabled.

**R2: Admin Denies Configuration Change**
- **Threat:** Admin claims they did not modify a manifest or policy.
- **Mitigation:** All configuration changes are versioned with diff tracking, user attribution, and timestamp. MFA required for admin operations.
- **Residual Risk:** Very low.

### I — Information Disclosure

**I1: System Prompt Extraction**
- **Threat:** User tricks the LLM into revealing its system prompt or internal configuration.
- **Mitigation:** Input guardrail layer detects prompt extraction patterns. Even if extraction succeeds, the system prompt contains no secrets — all sensitive configuration is in the manifest (not exposed to the LLM).
- **Residual Risk:** Medium. System prompt content may reveal agent behavior patterns, but not credentials or access tokens.

**I2: Cross-Workspace Data Leakage**
- **Threat:** Agent or user in workspace A accesses data from workspace B.
- **Mitigation:** All database queries are scoped by `workspace_id`. Memory vector store is partitioned by workspace. Storage is prefixed by workspace ID. API endpoints validate workspace access before returning data.
- **Residual Risk:** Low. SQL injection in workspace_id would be required (parameterized queries prevent this).

**I3: Credential Exposure in Logs**
- **Threat:** Secrets or API keys appear in audit logs or error messages.
- **Mitigation:** PII detection filters on output. Secrets are stored encrypted (AES-256-GCM) and never logged in plaintext. Error messages are sanitized before logging.
- **Residual Risk:** Low.

**I4: SSRF / Internal Network Reconnaissance**
- **Threat:** Agent is tricked into making requests to internal services (IMDS, databases, other pods).
- **Mitigation:** Sanitizer blocks RFC 1918, loopback, IMDS, and link-local addresses. DNS resolution is performed server-side to prevent DNS rebinding. Kubernetes NetworkPolicy blocks agent egress.
- **Residual Risk:** Very low. Multiple layers must be bypassed simultaneously.

### D — Denial of Service

**D1: Resource Exhaustion via Agent**
- **Threat:** Malicious agent consumes excessive CPU, memory, or tokens.
- **Mitigation:** Kubernetes resource limits (enforced by OPA). Session token limits. Per-minute rate limits on tool calls and LLM invocations. Budget caps per session and per day.
- **Residual Risk:** Low. A well-configured deployment has hard caps at every level.

**D2: Redis Channel Flooding**
- **Threat:** Compromised agent floods Redis with messages.
- **Mitigation:** Rate limiting at the Redis proxy sidecar. Message size limits. The control plane drops messages exceeding rate limits.
- **Residual Risk:** Low.

**D3: Manifest Bomb**
- **Threat:** Attacker creates a manifest with thousands of tools or extremely complex regex patterns.
- **Mitigation:** Manifest schema validation (Zod) enforces limits on array sizes and string lengths. Regex patterns are compiled with timeout protection.
- **Residual Risk:** Low.

### E — Elevation of Privilege

**E1: Prompt Injection to Gain Tools**
- **Threat:** User injects instructions that cause the LLM to call tools not in the manifest.
- **Mitigation:** The manifest enforcer validates every tool call against the signed manifest BEFORE execution. The LLM cannot add tools by "thinking" about them. This is a structural control, not behavioral.
- **Residual Risk:** Very low. The enforcer is a simple allow/deny check on a static list.

**E2: Container Escape**
- **Threat:** Attacker escapes the container to access the host.
- **Mitigation:** Non-root execution, read-only rootfs, seccomp profile, no `SYS_ADMIN` capability, no privileged mode. Falco detects unexpected process spawns and file writes.
- **Residual Risk:** Low. Would require a kernel vulnerability, which is mitigated by keeping nodes patched.

**E3: RBAC Bypass**
- **Threat:** Non-admin user accesses admin-only endpoints.
- **Mitigation:** RBAC middleware validates user role on every request. Roles are stored in JWT claims and verified server-side. Admin endpoints require MFA.
- **Residual Risk:** Very low.

**E4: Agent Self-Modification**
- **Threat:** Agent modifies its own manifest or configuration to gain more permissions.
- **Mitigation:** Agents have no API access to the control plane. They communicate only via Redis pub/sub. The manifest is loaded by the control plane, not the agent. The agent-runtime container has a read-only filesystem.
- **Residual Risk:** Very low.

---

## Attack Trees

### Prompt Injection Attack Tree

```
Goal: Execute unauthorized tool
├── Inject prompt to call tool not in manifest
│   └── BLOCKED: Manifest enforcer rejects unknown tools
├── Inject prompt to call tool with malicious parameters
│   └── BLOCKED: Parameter constraints (type, range, pattern) validated
├── Inject prompt to exfiltrate data via allowed tool
│   ├── Via web_search URL parameter
│   │   └── BLOCKED: Sanitizer validates URL, blocks internal IPs
│   └── Via file_read path parameter
│       └── BLOCKED: Path traversal detection, workspace containment
└── Multi-turn injection to gradually expand permissions
    └── BLOCKED: Manifest is static per session; permissions cannot increase
```

### Data Exfiltration Attack Tree

```
Goal: Extract data from another workspace
├── Direct API call with different workspace_id
│   └── BLOCKED: RBAC middleware validates workspace membership
├── SQL injection to bypass workspace_id filter
│   └── BLOCKED: Parameterized queries (drizzle-orm)
├── Via agent tool call to cross-workspace resource
│   └── BLOCKED: Tool executor scopes all operations to manifest workspace_id
└── Via Redis channel to read other workspace's messages
    └── BLOCKED: Redis channels are namespaced by workspace_id
```

---

## Risk Summary

| Threat | Severity | Likelihood | Residual Risk |
|--------|----------|------------|---------------|
| S1: User spoofing | High | Low | Low |
| S2: Agent spoofing | High | Very Low | Very Low |
| T1: Manifest tampering | Critical | Very Low | Low |
| T2: Audit tampering | High | Low | Low-Medium |
| I1: Prompt extraction | Medium | Medium | Medium |
| I2: Cross-workspace leak | Critical | Very Low | Low |
| I4: SSRF | High | Low | Very Low |
| D1: Resource exhaustion | Medium | Medium | Low |
| E1: Prompt injection escalation | Critical | Medium | Very Low |
| E2: Container escape | Critical | Very Low | Low |
