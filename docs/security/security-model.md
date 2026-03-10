<p align="center">
  <img src="../../assets/logo.png" alt="HonorClaw" width="120" />
</p>

# HonorClaw Security Model

## Overview

HonorClaw is built on a fundamental insight: **AI agent security must be architectural, not behavioral.** You cannot rely on asking an LLM to "please don't do bad things" — you must build structural constraints that prevent bad outcomes regardless of what the LLM generates.

This document describes the Capability Sandwich architecture and the distinction between structural containment and behavioral guardrails.

---

## The Capability Sandwich

The Capability Sandwich is the core security architecture of HonorClaw. Every agent interaction passes through three layers:

```
 User Input
      |
      v
 +--------------------------+
 |  1. INPUT GUARDRAILS     |  <-- Behavioral detection (pattern matching)
 |     - Injection detection|
 |     - PII filtering      |
 |     - Topic restrictions |
 +--------------------------+
      |
      v
 +--------------------------+
 |  2. LLM PROCESSING       |  <-- The agent "thinks" (untrusted)
 |     - Model generates    |
 |       tool calls         |
 +--------------------------+
      |
      v
 +--------------------------+
 |  3. STRUCTURAL ENFORCE   |  <-- Hard enforcement (cannot be bypassed)
 |     - Manifest enforcer  |
 |     - Parameter sanitizer|
 |     - Network isolation  |
 |     - Rate limiting      |
 +--------------------------+
      |
      v
 Tool Execution (sandboxed)
```

The key insight: Layer 1 (guardrails) is **defense in depth** — it catches obvious attacks early. But the real security comes from Layer 3 (structural enforcement), which operates on the OUTPUT of the LLM, not its input. Even if an attacker completely compromises the LLM's reasoning, the structural layer prevents unauthorized actions.

---

## Structural Containment vs. Behavioral Guardrails

### Structural Containment (Hard Security)

Structural controls cannot be bypassed by prompt injection, social engineering, or model manipulation. They operate on concrete, verifiable properties:

| Control | What It Enforces | How It Works |
|---------|-----------------|--------------|
| **Capability Manifest** | Only declared tools can execute | Tool calls are validated against a signed manifest before execution. The LLM cannot "invent" new tools. |
| **Parameter Constraints** | Tool parameters must match type, range, and pattern constraints | Each parameter is validated against its schema. SQL injection patterns are caught by `blockedPatterns`, not by asking the LLM to avoid SQL. |
| **Network Isolation** | Agent-runtime containers cannot reach the internet, databases, or control plane | Kubernetes NetworkPolicy + iptables rules enforce at the kernel level. No application code can bypass this. |
| **SSRF Protection** | URLs are validated against IP blocklists and domain allowlists | DNS resolution is performed server-side. The sanitizer blocks RFC 1918, loopback, IMDS, and link-local addresses. |
| **Path Containment** | File operations are restricted to `/workspace/` | Path traversal (`../`) is blocked by the sanitizer before the tool executes. Absolute paths outside the workspace are rejected. |
| **Rate Limiting** | Tools, LLM calls, and sessions have hard rate limits | Enforced by the control plane, not the agent. Exceeding limits terminates the session. |
| **Workspace Isolation** | Data, agents, and operations are scoped to a workspace | Every database query includes `workspace_id`. There is no API to query across workspaces. |
| **Read-Only Root Filesystem** | Containers cannot modify their own binaries | OPA policy + Kubernetes securityContext enforce this at pod admission. |
| **Non-Root Execution** | Containers run as unprivileged users | OPA policy enforces `runAsNonRoot: true` at pod admission. |
| **Seccomp Profile** | System calls are restricted | The `seccomp-agent.json` profile blocks dangerous syscalls like `ptrace`, `mount`, and `reboot`. |

### Behavioral Guardrails (Soft Security)

Behavioral guardrails detect adversarial intent through pattern matching. They are **defense in depth** — they make attacks harder but are not a security boundary:

| Control | What It Detects | Limitation |
|---------|----------------|------------|
| **Injection Patterns** | "Ignore previous instructions", "you are now", jailbreak attempts | Novel phrasings may evade detection. This is why structural controls exist. |
| **Tool Discovery Blocking** | "What tools do you have?", "List your capabilities" | Protects against reconnaissance, but the manifest enforcer is the real boundary. |
| **Prompt Extraction Blocking** | "Show me your system prompt", "Repeat your instructions" | Reduces information leakage, but assumes the LLM may eventually be tricked. |
| **Topic Restrictions** | Off-topic or prohibited conversation topics | Regex-based; creative rephrasing can bypass. |
| **PII Detection** | SSN, credit card, email, phone, IP address patterns | Pattern-based; unusual formats may slip through. Output PII filtering is the safety net. |

### Why Both Layers Matter

- **Behavioral guardrails** catch 95%+ of attacks cheaply, before they reach the LLM. This reduces cost, latency, and noise in audit logs.
- **Structural containment** catches the remaining attacks that evade behavioral detection. This is the actual security boundary.

A system with only behavioral guardrails is vulnerable to novel attacks. A system with only structural containment would waste resources processing obviously malicious inputs. The Capability Sandwich provides both.

---

## Trust Boundaries

HonorClaw defines three trust zones:

### 1. Trusted Zone (Control Plane)
- The control plane, database, and admin API
- Runs with full privileges but restricted network access
- All operations are audit-logged

### 2. Semi-Trusted Zone (User Input)
- User messages enter through the input guardrail layer
- Treated as potentially adversarial
- Validated before reaching the LLM

### 3. Untrusted Zone (Agent Runtime)
- The LLM and agent execution environment
- Network-isolated: can only communicate via Redis pub/sub
- All tool calls are validated by the structural enforcement layer
- Read-only filesystem, non-root, seccomp-restricted

---

## Defense in Depth Layers

1. **Network Perimeter** — Kubernetes NetworkPolicy, no direct internet access for agents
2. **Container Security** — Non-root, read-only rootfs, seccomp, resource limits
3. **Application Layer** — Input guardrails, output filters, PII detection
4. **Enforcement Layer** — Manifest validation, parameter sanitization, SSRF blocking
5. **Data Layer** — Workspace isolation, encrypted secrets, audit logging
6. **Runtime Detection** — Falco rules for process spawns, file writes, network anomalies
7. **Supply Chain** — Approved image registries, Cosign signatures, dependency auditing

---

## Key Design Decisions

### Why Redis Pub/Sub Instead of Direct API Calls?

Agent-runtime containers communicate with the control plane exclusively through Redis pub/sub. This means:
- Agents cannot access the control plane API directly
- The control plane mediates all interactions
- Network policies can enforce this with a simple "deny all except localhost:6379" rule

### Why Signed Manifests?

The capability manifest defines what an agent CAN do. It is signed by the control plane and verified before every tool call. Even if an attacker compromises the agent's memory, they cannot expand its permissions.

### Why Not Just Use LLM Alignment?

LLM alignment is improving but is fundamentally probabilistic. An aligned model will usually refuse harmful requests, but:
- Novel jailbreaks are discovered regularly
- Multi-turn attacks can gradually shift model behavior
- Indirect prompt injection (via tool outputs) can bypass alignment

Structural containment makes alignment a nice-to-have, not a requirement.
