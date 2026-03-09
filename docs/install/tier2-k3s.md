# Tier 2: K3s Deployment

## Overview

Tier 2 uses [K3s](https://k3s.io/), a lightweight Kubernetes distribution, to provide better isolation and resilience than Docker Compose while remaining simple to operate. Suitable for:

- Small to medium teams (5-50 users)
- Single-node or small cluster deployments
- Edge deployments
- Environments needing Kubernetes features without full cluster complexity

---

## Prerequisites

| Requirement | Minimum | Recommended |
|------------|---------|-------------|
| OS | Ubuntu 22.04+, RHEL 9+, or similar | Ubuntu 24.04 |
| RAM | 8 GB | 32 GB |
| CPU | 4 cores | 8 cores |
| Disk | 40 GB | 100 GB |
| Network | Outbound internet (for initial setup) | - |

## Installation

### 1. Install K3s

```bash
# Single-node installation
curl -sfL https://get.k3s.io | sh -

# Verify
sudo k3s kubectl get nodes
```

### 2. Install HonorClaw CLI

```bash
git clone https://github.com/JJJ-Mo3/honorclaw.git
cd honorclaw
pnpm install && pnpm build
cd packages/cli && pnpm link --global
```

### 3. Initialize HonorClaw

```bash
honorclaw init
```

This generates Kubernetes manifests in `./k8s/`:
- `namespace.yaml`
- `postgres.yaml`
- `redis.yaml`
- `ollama.yaml`
- `control-plane.yaml`
- `agent-runtime.yaml`
- `network-policies.yaml`

### 4. Apply Manifests

```bash
sudo k3s kubectl apply -f k8s/
```

### 5. Wait for Pods

```bash
sudo k3s kubectl get pods -n honorclaw -w
```

Wait until all pods show `Running` status.

### 6. Verify

```bash
honorclaw doctor
```

---

## Multi-Node Cluster

### Add Worker Nodes

On the primary node, get the join token:
```bash
sudo cat /var/lib/rancher/k3s/server/node-token
```

On worker nodes:
```bash
curl -sfL https://get.k3s.io | K3S_URL=https://<primary-ip>:6443 K3S_TOKEN=<token> sh -
```

### Node Roles

| Node | Role | Components |
|------|------|-----------|
| Node 1 | Server | Control plane, PostgreSQL, Redis |
| Node 2+ | Agent | Agent-runtime pods, Ollama |

---

## Storage

### Default (Local Path)

K3s includes a local-path provisioner by default. Suitable for single-node deployments.

### Longhorn (Recommended for Multi-Node)

```bash
sudo k3s kubectl apply -f https://raw.githubusercontent.com/longhorn/longhorn/v1.7.0/deploy/longhorn.yaml
```

Update PVC storage class in manifests:
```yaml
storageClassName: longhorn
```

---

## Network Policies

K3s uses Traefik as the default ingress and supports NetworkPolicy via kube-router. The HonorClaw manifests include NetworkPolicies that:

- Isolate agent-runtime pods (egress only to Redis sidecar)
- Allow control plane to reach PostgreSQL and Redis
- Deny all other inter-namespace traffic

Verify network policies are active:
```bash
sudo k3s kubectl get networkpolicies -n honorclaw
sudo k3s kubectl get networkpolicies -n honorclaw-agents
```

---

## Ingress

### Default (Traefik)

K3s includes Traefik. Create an IngressRoute:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: honorclaw
  namespace: honorclaw
  annotations:
    traefik.ingress.kubernetes.io/router.tls: "true"
spec:
  tls:
    - hosts:
        - honorclaw.local
      secretName: honorclaw-tls
  rules:
    - host: honorclaw.local
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: honorclaw-control-plane
                port:
                  number: 3000
```

### TLS Certificate

```bash
# Generate self-signed certificate (development)
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout tls.key -out tls.crt \
  -subj "/CN=honorclaw.local"

sudo k3s kubectl create secret tls honorclaw-tls \
  --cert=tls.crt --key=tls.key \
  -n honorclaw
```

For production, use cert-manager with Let's Encrypt.

---

## Upgrading

```bash
# Upgrade K3s
curl -sfL https://get.k3s.io | sh -

# Upgrade HonorClaw
honorclaw upgrade --type kubernetes
```

---

## Backup

```bash
# Database backup
honorclaw backup create

# K3s etcd backup (if using embedded etcd)
sudo k3s etcd-snapshot save --name honorclaw-backup
```

---

## Monitoring

### Built-in Metrics

HonorClaw exposes Prometheus metrics at `/metrics`. To scrape them:

```bash
# Install kube-prometheus-stack (optional)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install monitoring prometheus-community/kube-prometheus-stack -n monitoring --create-namespace
```

### Logs

```bash
# Control plane logs
sudo k3s kubectl logs -n honorclaw deploy/honorclaw-control-plane -f

# Agent runtime logs
sudo k3s kubectl logs -n honorclaw-agents -l app=agent-runtime -f
```
