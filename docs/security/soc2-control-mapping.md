# HonorClaw SOC 2 Trust Services Criteria (TSC) Mapping

## Overview

This document maps HonorClaw platform controls to SOC 2 Type II Trust Services Criteria. It is intended for auditors and compliance teams evaluating HonorClaw deployments.

HonorClaw is a self-hosted platform. The organization deploying HonorClaw is the "service organization" for SOC 2 purposes. This mapping identifies which controls HonorClaw provides out of the box and which require operator configuration.

---

## CC1 — Control Environment

| TSC | Criteria | HonorClaw Control | Status |
|-----|----------|-------------------|--------|
| CC1.1 | COSO Principle 1: Demonstrates commitment to integrity and ethical values | Operator responsibility. HonorClaw provides audit logging to support oversight. | Operator |
| CC1.2 | COSO Principle 2: Board exercises oversight | Operator responsibility. RBAC enforces separation of duties. | Operator |
| CC1.3 | COSO Principle 3: Management establishes structure, authority, accountability | RBAC with admin/operator/viewer roles. All role assignments audit-logged. | Built-in |
| CC1.4 | COSO Principle 4: Demonstrates commitment to competence | Operator responsibility. | Operator |
| CC1.5 | COSO Principle 5: Enforces accountability | Complete audit trail: every user action, agent tool call, and configuration change is logged with user ID, timestamp, and workspace context. | Built-in |

## CC2 — Communication and Information

| TSC | Criteria | HonorClaw Control | Status |
|-----|----------|-------------------|--------|
| CC2.1 | COSO Principle 13: Uses relevant quality information | Structured audit events with schema validation (Zod). Events include severity, category, and full context. | Built-in |
| CC2.2 | COSO Principle 14: Communicates internally | Webhook integration for Slack/PagerDuty/SIEM notifications on security events. | Built-in |
| CC2.3 | COSO Principle 15: Communicates externally | Operator responsibility. HonorClaw provides exportable audit logs and compliance reports. | Operator |

## CC3 — Risk Assessment

| TSC | Criteria | HonorClaw Control | Status |
|-----|----------|-------------------|--------|
| CC3.1 | COSO Principle 6: Specifies suitable objectives | Capability Manifests define explicit, auditable security objectives per agent. | Built-in |
| CC3.2 | COSO Principle 7: Identifies and analyzes risk | STRIDE threat model documented. Falco rules detect runtime anomalies. | Built-in |
| CC3.3 | COSO Principle 8: Assesses fraud risk | Input guardrails detect prompt injection, social engineering, and tool discovery attempts. | Built-in |
| CC3.4 | COSO Principle 9: Identifies and assesses changes | Manifest versioning with diff tracking. Configuration change audit trail. | Built-in |

## CC4 — Monitoring Activities

| TSC | Criteria | HonorClaw Control | Status |
|-----|----------|-------------------|--------|
| CC4.1 | COSO Principle 16: Selects, develops, performs ongoing evaluations | Automated security pipeline: pnpm audit, Trivy, Semgrep, TruffleHog. Falco runtime monitoring. | Built-in |
| CC4.2 | COSO Principle 17: Evaluates and communicates deficiencies | Security test suite with 50+ prompt injection tests. Webhook alerts on guardrail violations. | Built-in |

## CC5 — Control Activities

| TSC | Criteria | HonorClaw Control | Status |
|-----|----------|-------------------|--------|
| CC5.1 | COSO Principle 10: Selects and develops control activities | Capability Sandwich architecture: input guardrails, structural enforcement, output filters. | Built-in |
| CC5.2 | COSO Principle 11: Selects and develops technology controls | Network isolation (Kubernetes NetworkPolicy), container hardening (seccomp, non-root, read-only rootfs), OPA admission control. | Built-in |
| CC5.3 | COSO Principle 12: Deploys through policies | OPA policies enforce approved registries, non-root, read-only rootfs, resource limits, and network isolation at admission time. | Built-in |

## CC6 — Logical and Physical Access Controls

| TSC | Criteria | HonorClaw Control | Status |
|-----|----------|-------------------|--------|
| CC6.1 | Logical access security | JWT authentication with RS256 signing. Session management with configurable timeouts. | Built-in |
| CC6.2 | Prior to issuing credentials | User creation requires admin role. API keys are generated with scoped permissions. | Built-in |
| CC6.3 | Registration and authorization | RBAC: admin, operator, viewer roles. Workspace-scoped permissions. | Built-in |
| CC6.4 | Restriction and removal of access | API key revocation. Session invalidation. User deactivation (soft delete with audit). | Built-in |
| CC6.5 | Accountability for access | All authentication events logged: login, logout, failed attempts, token refresh, MFA verification. | Built-in |
| CC6.6 | Restriction of system and data access | Agent-runtime containers are network-isolated. Workspace isolation at database level. SSRF protection in sanitizer. | Built-in |
| CC6.7 | Data transmission protection | TLS 1.2+ for all external connections. Internal traffic encrypted via mTLS in Tier 3+. | Built-in (Tier 3+) |
| CC6.8 | Preventing unauthorized software | OPA policy: AllImagesFromApprovedRegistry. Container images signed with Cosign. | Built-in |

## CC7 — System Operations

| TSC | Criteria | HonorClaw Control | Status |
|-----|----------|-------------------|--------|
| CC7.1 | Detection of unusual activity | Falco rules: unexpected process spawn, DNS anomalies, identity file writes, unauthorized connections. | Built-in |
| CC7.2 | Monitoring of system components | Health check endpoints. Prometheus metrics exposure. Liveness/readiness probes. | Built-in |
| CC7.3 | Evaluation of identified events | Audit event categorization with severity levels. Webhook integration for alert routing. | Built-in |
| CC7.4 | Incident response | Incident response playbook documented. Webhook-based alerting to PagerDuty/Slack. | Documented |
| CC7.5 | Recovery from incidents | Backup/restore commands (`honorclaw backup create/restore`). Disaster recovery runbook. | Built-in |

## CC8 — Change Management

| TSC | Criteria | HonorClaw Control | Status |
|-----|----------|-------------------|--------|
| CC8.1 | Authorization, design, development, configuration, testing, and approval | CI/CD pipeline with security gates. All changes through pull request workflow. Release signing with Cosign. | Built-in |

## CC9 — Risk Mitigation

| TSC | Criteria | HonorClaw Control | Status |
|-----|----------|-------------------|--------|
| CC9.1 | Identifies and assesses risk from business relationships | Supply chain security: approved image registries, dependency auditing, secret scanning. | Built-in |
| CC9.2 | Assesses and manages risks from vendors | Self-hosted deployment model eliminates most vendor risks. LLM provider risk managed via local model support (Ollama). | Built-in |

---

## Availability (A1)

| TSC | Criteria | HonorClaw Control | Status |
|-----|----------|-------------------|--------|
| A1.1 | Processing capacity management | Resource limits enforced by OPA. Budget caps per agent/session. Rate limiting. | Built-in |
| A1.2 | Environmental protections | Operator responsibility (infrastructure). HonorClaw provides health checks and graceful degradation. | Operator |
| A1.3 | Recovery from incidents | `honorclaw backup restore` command. DR guide with RTO/RPO targets. | Built-in |

---

## Confidentiality (C1)

| TSC | Criteria | HonorClaw Control | Status |
|-----|----------|-------------------|--------|
| C1.1 | Identification and maintenance of confidential information | PII detection in input and output. Workspace-scoped data access. Encrypted secret storage. | Built-in |
| C1.2 | Disposal of confidential information | Session data purged after configurable retention period. Workspace deletion cascades to all associated data. | Built-in |

---

## Processing Integrity (PI1)

| TSC | Criteria | HonorClaw Control | Status |
|-----|----------|-------------------|--------|
| PI1.1 | Completeness and accuracy of system processing | Manifest validation (Zod schema). Parameter type checking. Audit trail of all tool calls with inputs and outputs. | Built-in |
| PI1.2 | System inputs | Input guardrails validate message length, format, and content. Blocked input patterns reject malformed data. | Built-in |
| PI1.3 | System outputs | Output filters detect PII, apply content policies, and enforce token limits. | Built-in |

---

## Privacy (P1 — if applicable)

| TSC | Criteria | HonorClaw Control | Status |
|-----|----------|-------------------|--------|
| P1.1 | Privacy notice | Operator responsibility. | Operator |
| P2.1 | Data collection consent | Operator responsibility. | Operator |
| P3.1 | Data collection limited to identified purpose | Workspace-scoped data collection. Manifest defines exactly what data each agent can access. | Built-in |
| P4.1 | Use of personal information limited | PII filtering on input and output. `piiColumnsBlocked` in data access configuration. | Built-in |
| P6.1 | Disclosure to third parties | Self-hosted: data does not leave the deployment. External LLM usage is opt-in with data routing controls. | Built-in |
| P8.1 | Quality of personal information | Input validation and sanitization. NFC Unicode normalization. | Built-in |

---

## Evidence Collection Guide

For SOC 2 Type II audits, collect the following evidence:

1. **Audit Logs**: Export from `GET /api/audit` with date range filters
2. **Configuration History**: Manifest version history from PostgreSQL
3. **Security Scan Results**: CI pipeline artifacts (Trivy, Semgrep, TruffleHog reports)
4. **Access Reviews**: User and role listings from `GET /api/users`
5. **Incident Response Records**: Webhook delivery logs, Falco alert history
6. **Backup Verification**: `honorclaw backup create` output with integrity checksums
7. **Policy Enforcement**: OPA policy files and Gatekeeper constraint audit logs
