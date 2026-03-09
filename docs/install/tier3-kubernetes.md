# Tier 3: Production Kubernetes Deployment

## Overview

Tier 3 is the recommended deployment for production environments. It uses a standard Kubernetes cluster with full security hardening. Suitable for:

- Production workloads
- Medium to large teams (50+ users)
- Environments requiring high availability
- SOC 2, HIPAA, or other compliance requirements

---

## Prerequisites

| Requirement | Minimum | Recommended |
|------------|---------|-------------|
| Kubernetes | 1.28+ | 1.30+ |
| Nodes | 3 | 5+ |
| RAM per node | 16 GB | 32 GB |
| CPU per node | 4 cores | 8 cores |
| CNI | Calico or Cilium (must support NetworkPolicy) | Cilium |
| Storage | CSI driver with ReadWriteOnce support | Ceph/Longhorn |
| Ingress | Any (nginx, Traefik, Envoy) | nginx-ingress |

### Required Cluster Add-ons

- **cert-manager** — TLS certificate management
- **OPA Gatekeeper** — Policy enforcement at admission
- **Falco** — Runtime security monitoring

## Installation

### 1. Install Prerequisites

```bash
# cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml

# OPA Gatekeeper
kubectl apply -f https://raw.githubusercontent.com/open-policy-agent/gatekeeper/master/deploy/gatekeeper.yaml

# Falco
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm install falco falcosecurity/falco -n falco --create-namespace
```

### 2. Install HonorClaw CLI

```bash
git clone https://github.com/JJJ-Mo3/honorclaw.git
cd honorclaw
pnpm install && pnpm build
cd packages/cli && pnpm link --global
```

### 3. Initialize

```bash
honorclaw init
```

### 4. Apply OPA Policies

```bash
kubectl apply -f infra/kubernetes/policies/
```

### 5. Apply Falco Rules

```bash
kubectl apply -f infra/kubernetes/falco-rules.yaml
```

### 6. Deploy HonorClaw

```bash
kubectl apply -f k8s/
```

### 7. Verify

```bash
honorclaw doctor
kubectl get pods -n honorclaw
kubectl get pods -n honorclaw-agents
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                        │
│                                                             │
│  Namespace: honorclaw                                        │
│  ┌──────────────┐ ┌──────────┐ ┌───────────────────────────┐│
│  │ Control Plane │ │PostgreSQL│ │   Redis (HA Sentinel)     ││
│  │  (3 replicas) │ │(primary/ │ │                           ││
│  │               │ │ replica) │ │                           ││
│  └──────┬────────┘ └──────────┘ └──────────┬────────────────┘│
│         │                                   │                │
│  ───────┼───────── Namespace Boundary ──────┼────────────── │
│         │                                   │                │
│  Namespace: honorclaw-agents                │                │
│  ┌──────┴───────────────────────────────────┴──────────────┐│
│  │                Agent Runtime Pods                        ││
│  │  ┌─────────────────┐  ┌─────────────────┐              ││
│  │  │  Agent Pod       │  │  Agent Pod       │   ...       ││
│  │  │  ┌─────────────┐│  │  ┌─────────────┐│              ││
│  │  │  │agent-runtime││  │  │agent-runtime││              ││
│  │  │  └──────┬──────┘│  │  └──────┬──────┘│              ││
│  │  │  ┌──────┴──────┐│  │  ┌──────┴──────┐│              ││
│  │  │  │redis-proxy  ││  │  │redis-proxy  ││              ││
│  │  │  │(sidecar)    ││  │  │(sidecar)    ││              ││
│  │  │  └─────────────┘│  │  └─────────────┘│              ││
│  │  └─────────────────┘  └─────────────────┘              ││
│  └────────────────────────────────────────────────────────┘│
│                                                             │
│  Namespace: falco                                           │
│  ┌───────────────────┐                                     │
│  │  Falco DaemonSet  │ (runtime security monitoring)       │
│  └───────────────────┘                                     │
└─────────────────────────────────────────────────────────────┘
```

---

## Security Hardening

### Network Policies

```yaml
# Deny all egress from agent-runtime pods
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: agent-default-deny
  namespace: honorclaw-agents
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: agent-runtime
  policyTypes:
    - Ingress
    - Egress
  egress:
    - to:
        - ipBlock:
            cidr: 127.0.0.1/32
      ports:
        - port: 6379
          protocol: TCP
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
        - podSelector:
            matchLabels:
              k8s-app: kube-dns
      ports:
        - port: 53
          protocol: UDP
```

### Pod Security Standards

Apply restricted pod security standard:

```bash
kubectl label namespace honorclaw-agents \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=latest
```

### mTLS with Service Mesh (Optional)

For inter-service encryption, deploy a service mesh:

```bash
# Linkerd (lightweight)
linkerd install | kubectl apply -f -
linkerd inject k8s/control-plane.yaml | kubectl apply -f -
```

---

## High Availability

### Control Plane

Deploy 3+ replicas with anti-affinity:

```yaml
spec:
  replicas: 3
  template:
    spec:
      affinity:
        podAntiAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  app: honorclaw-control-plane
              topologyKey: kubernetes.io/hostname
```

### PostgreSQL

Use CloudNativePG or Patroni for HA PostgreSQL:

```bash
kubectl apply -f https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/main/releases/cnpg-1.24.0.yaml

# Deploy HA PostgreSQL cluster
kubectl apply -f k8s/postgres-ha.yaml
```

### Redis

Use Redis Sentinel for HA:

```bash
helm install redis bitnami/redis --set sentinel.enabled=true -n honorclaw
```

---

## Monitoring and Alerting

### Prometheus

```bash
# ServiceMonitor for HonorClaw
kubectl apply -f - <<EOF
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: honorclaw
  namespace: honorclaw
spec:
  selector:
    matchLabels:
      app: honorclaw-control-plane
  endpoints:
    - port: metrics
      interval: 30s
EOF
```

### Key Metrics to Alert On

| Metric | Threshold | Severity |
|--------|-----------|----------|
| `honorclaw_guardrail_violations_total` | > 10/min | Warning |
| `honorclaw_tool_call_errors_total` | > 5/min | Warning |
| `honorclaw_active_sessions` | > 80% of limit | Warning |
| `honorclaw_health_status` | != 1 | Critical |

---

## Upgrading

```bash
honorclaw upgrade --type kubernetes
```

For manual control:

```bash
# Update image tags
kubectl set image deployment/honorclaw-control-plane \
  control-plane=ghcr.io/jjj-mo3/honorclaw:0.1.0 \
  -n honorclaw

# Watch rollout
kubectl rollout status deployment/honorclaw-control-plane -n honorclaw
```

Rollback if needed:

```bash
kubectl rollout undo deployment/honorclaw-control-plane -n honorclaw
```
