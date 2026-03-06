# HonorClaw

**Enterprise-grade, self-hosted AI agent platform where security is architectural, not behavioral.**

HonorClaw matches OpenClaw's feature set (agents, memory, tool calling, multi-agent orchestration) while adding enterprise-grade security controls baked into every layer. A fully prompt-injected agent is still contained, because the architecture physically prevents it from exceeding its authorized capabilities.

## The Capability Sandwich

The agent's LLM "brain" is treated as an **untrusted component**, sandwiched between trusted enforcement layers:

```
[TRUSTED]  Control Plane — loads manifest, validates tool calls, filters output
               ↓ (Redis pub/sub)
[UNTRUSTED] Agent Runtime — LLM lives here; cannot escape; no internet access
               ↓ (tool call request via Redis)
[TRUSTED]  Tool Execution Layer — validates every request against capability manifest
```

Even a fully injected agent cannot call tools outside its manifest, reach unauthorized endpoints, access credentials, or exfiltrate data.

## Quickstart

```bash
# First run — generates keys, creates schema, sets up admin user
make init

# Start HonorClaw (one container, one volume, one port)
make up

# Open the web UI
open http://localhost:3000
```

## Deployment Tiers

| Tier | Orchestration | Target | Cost |
|------|--------------|--------|------|
| **1 — Single Container** | `make init && make up` | Dev, demo, small team | ~$20–100/mo |
| **2 — Docker Swarm / K3s** | Swarm or K3s | Medium team, on-prem | ~$200–500/mo |
| **3 — Kubernetes** | kubeadm, RKE2, Rancher | Large enterprise | ~$500–1,500/mo |
| **4 — Cloud-Managed K8s** | EKS / GKE / AKS | Cloud-native enterprise | ~$800–2,000/mo |

## Links

- [Documentation](docs/)
- [Security Policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Architecture](docs/security-architecture.md)
- [License](LICENSE) (Apache 2.0)
