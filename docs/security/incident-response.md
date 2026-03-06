# HonorClaw Incident Response Playbook

## Overview

This playbook defines the incident response procedures for HonorClaw deployments. It covers detection, triage, containment, investigation, remediation, and post-incident activities.

---

## Severity Levels

| Level | Name | Definition | Response Time | Examples |
|-------|------|------------|--------------|---------|
| SEV-1 | Critical | Active exploitation, data breach confirmed, system compromise | 15 minutes | Container escape, cross-workspace data leak, credential exposure |
| SEV-2 | High | Likely exploitation attempt, security control failure | 1 hour | Repeated prompt injection bypasses, Falco identity file write alert, unauthorized outbound connection |
| SEV-3 | Medium | Suspicious activity, potential vulnerability | 4 hours | Unusual tool call patterns, failed authentication spike, dependency vulnerability (CVSS >= 7) |
| SEV-4 | Low | Informational, minor policy violation | 24 hours | Single blocked prompt injection, rate limit hit, non-critical CVE |

---

## Detection Sources

### Automated Detection

| Source | What It Detects | Alert Channel |
|--------|----------------|---------------|
| Falco | Unexpected process spawn, identity file write, unauthorized connections | Webhook -> PagerDuty |
| Input Guardrails | Prompt injection, tool discovery, prompt extraction attempts | Audit log + webhook |
| Manifest Enforcer | Tool calls not in manifest, parameter constraint violations | Audit log + webhook |
| Sanitizer | SSRF attempts, path traversal, SQL injection | Audit log + webhook |
| CI Security Pipeline | CVEs in dependencies, secrets in code, container vulnerabilities | GitHub Security alerts |
| Rate Limiter | Unusual call volume, potential DoS | Audit log + webhook |

### Manual Detection

- Audit log review (monthly)
- Penetration testing (annually)
- User/operator reports

---

## Incident Response Procedures

### Phase 1: Detection and Triage (0-15 minutes)

**Goal:** Confirm the incident and assess severity.

1. **Acknowledge the alert**
   - Assign an incident commander (IC)
   - Create an incident channel (Slack/Teams)
   - Log the start time

2. **Gather initial context**
   ```bash
   # Check recent audit events for the affected workspace
   honorclaw audit query --workspace-id <ws-id> --since 1h --severity high

   # Check agent session details
   honorclaw session inspect <session-id>

   # Check Falco alerts
   kubectl logs -n falco -l app=falco --since=1h | grep honorclaw
   ```

3. **Classify severity** using the table above

4. **Notify stakeholders**
   - SEV-1: Engineering lead, security team, executive sponsor
   - SEV-2: Engineering lead, security team
   - SEV-3: On-call engineer
   - SEV-4: Ticket created for next business day

### Phase 2: Containment (15 minutes - 1 hour)

**Goal:** Stop the bleeding. Prevent further damage.

#### For Compromised Agent Session

```bash
# Kill the agent session immediately
honorclaw session kill <session-id>

# Disable the agent to prevent new sessions
honorclaw agent disable <agent-id>

# If the agent-runtime pod is compromised, kill it
kubectl delete pod <pod-name> -n honorclaw-agents --grace-period=0

# Block the user if credential compromise is suspected
honorclaw user disable <user-id>
```

#### For Network-Level Incident

```bash
# Apply emergency NetworkPolicy to isolate all agent pods
kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: emergency-isolate-agents
  namespace: honorclaw-agents
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
EOF

# Verify isolation
kubectl get networkpolicy -n honorclaw-agents
```

#### For Data Breach Suspicion

```bash
# Export audit logs for the time window
honorclaw backup create --audit-only --since <start-time> --output incident-$(date +%Y%m%d).tar.gz

# Preserve evidence: snapshot the database
pg_dump -h localhost -U honorclaw honorclaw > incident-db-snapshot.sql

# Rotate all API keys and tokens
honorclaw auth rotate-keys --all
```

### Phase 3: Investigation (1-4 hours)

**Goal:** Understand what happened, what was affected, and root cause.

#### Investigation Checklist

- [ ] **Timeline reconstruction:** Build a timeline of events from audit logs
- [ ] **Blast radius assessment:** Which workspaces, agents, users, and data were affected?
- [ ] **Attack vector identification:** How did the attacker get in? What control failed?
- [ ] **Data exposure assessment:** Was any sensitive data accessed, exfiltrated, or modified?
- [ ] **Lateral movement:** Did the attacker move beyond the initial point of compromise?

#### Key Investigation Queries

```bash
# All tool calls for the suspect session
honorclaw audit query --session-id <session-id> --type tool_call

# All failed validation events (blocked attacks)
honorclaw audit query --workspace-id <ws-id> --type guardrail_violation --since 24h

# Cross-workspace access attempts
honorclaw audit query --type authorization_denied --since 24h

# Unusual egress patterns
honorclaw audit query --type egress_blocked --since 24h
```

#### Evidence Preservation

1. Do NOT restart or redeploy any affected components until investigation is complete
2. Capture pod logs: `kubectl logs <pod-name> -n honorclaw-agents > pod-evidence.log`
3. Capture network captures if available: `kubectl exec <pod> -- tcpdump -w /tmp/capture.pcap`
4. Export all audit events to a secure, immutable location

### Phase 4: Remediation (4-24 hours)

**Goal:** Fix the root cause and restore normal operations.

#### Common Remediations

| Root Cause | Remediation |
|-----------|-------------|
| Novel prompt injection bypassed guardrails | Add new pattern to `injection-patterns.ts`, deploy update |
| Manifest too permissive | Tighten manifest constraints, add blocked patterns |
| Container vulnerability | Update base image, rebuild and redeploy |
| Dependency CVE | Update vulnerable package, run `pnpm audit` |
| Configuration drift | Re-apply OPA policies, run `honorclaw doctor` |
| Credential leak | Rotate all affected credentials, revoke sessions |
| Network policy gap | Update NetworkPolicy, verify with network tests |

#### Remediation Verification

```bash
# Run security test suite
pnpm vitest run tests/security/ --reporter=verbose

# Run OPA policy checks
for policy in infra/kubernetes/policies/*.rego; do
  opa check "$policy"
done

# Run full health check
honorclaw doctor --full

# Verify network isolation
kubectl run test-egress --rm -it --image=busybox -n honorclaw-agents -- wget -qO- http://google.com
# Expected: connection refused/timeout
```

### Phase 5: Recovery

**Goal:** Restore full service and verify integrity.

1. **Re-enable affected components**
   ```bash
   honorclaw agent enable <agent-id>
   # Remove emergency NetworkPolicy if applied
   kubectl delete networkpolicy emergency-isolate-agents -n honorclaw-agents
   ```

2. **Verify system integrity**
   ```bash
   honorclaw doctor --full
   # Check that all health endpoints return healthy
   curl -s http://localhost:3000/health | jq
   ```

3. **Monitor closely for 24-48 hours**
   - Watch for recurrence of the attack pattern
   - Review audit logs at increased frequency
   - Confirm all security controls are active

### Phase 6: Post-Incident (24-72 hours)

**Goal:** Learn from the incident and improve defenses.

#### Post-Incident Review Template

```
## Incident Summary
- **Incident ID:** INC-YYYY-NNN
- **Severity:** SEV-X
- **Duration:** Start time to resolution time
- **Commander:** Name

## Timeline
| Time | Event |
|------|-------|
| HH:MM | Alert received |
| HH:MM | IC assigned |
| HH:MM | Containment action taken |
| HH:MM | Root cause identified |
| HH:MM | Fix deployed |
| HH:MM | Service restored |

## Root Cause
[Description of what failed and why]

## Impact
- Users affected: N
- Workspaces affected: N
- Data exposed: [describe]
- Duration of exposure: HH:MM

## What Went Well
- [List]

## What Could Be Improved
- [List]

## Action Items
| Action | Owner | Due Date | Status |
|--------|-------|----------|--------|
| [Action] | [Name] | [Date] | Open |
```

---

## Communication Templates

### Internal Notification (SEV-1/SEV-2)

```
Subject: [SEV-X] HonorClaw Security Incident - INC-YYYY-NNN

We have detected a security incident in the HonorClaw deployment.

Severity: SEV-X
Detected: YYYY-MM-DD HH:MM UTC
Status: [Investigating | Contained | Resolved]

Incident Commander: [Name]
Incident Channel: #inc-YYYY-NNN

Summary: [Brief description]

Impact: [Known or estimated impact]

Actions Taken: [List of containment actions]

Next Update: HH:MM UTC
```

### External Notification (if required)

For HIPAA-covered deployments, breach notification must be provided:
- To HHS: within 60 days of discovery
- To affected individuals: within 60 days of discovery
- To media: if 500+ individuals affected in a state/jurisdiction

Consult legal counsel before external notification.

---

## Runbook Quick Reference

| Scenario | Action |
|----------|--------|
| Falco: unexpected process in agent | `kubectl delete pod <pod> -n honorclaw-agents --grace-period=0` |
| Falco: identity file write | Pod auto-killed by Falco response. Investigate immediately. |
| Repeated prompt injection from single user | `honorclaw user disable <user-id>` |
| Agent calling tool not in manifest | Check for manifest tampering. `honorclaw audit query --type tool_not_allowed` |
| SSRF attempt detected | Review sanitizer logs. No action needed if blocked (verify). |
| Dependency CVE (CVSS >= 9) | Emergency patch: `pnpm update <package>`, rebuild, redeploy |
| Secret detected in git history | `git filter-branch` or BFG to remove. Rotate the secret immediately. |
