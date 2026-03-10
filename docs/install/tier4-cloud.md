# Tier 4: Cloud-Managed Kubernetes (AWS EKS)

## Overview

Tier 4 uses cloud-managed Kubernetes for maximum scalability, reliability, and operational simplicity. This guide covers AWS EKS, but the principles apply to GKE and AKS as well. Suitable for:

- Large-scale production deployments
- Organizations with existing cloud infrastructure
- Multi-region or multi-AZ requirements
- Strict compliance requirements (SOC 2, HIPAA, FedRAMP)

---

## Prerequisites

| Requirement | Details |
|------------|---------|
| AWS Account | With permissions for EKS, RDS, ElastiCache, ECR |
| AWS CLI | v2, configured with credentials |
| eksctl | Latest version |
| kubectl | 1.28+ |
| Helm | v3 |
| Terraform (optional) | For infrastructure-as-code |

---

## Infrastructure Setup

### 1. Create EKS Cluster

```bash
eksctl create cluster \
  --name honorclaw-production \
  --region us-east-1 \
  --version 1.30 \
  --nodegroup-name standard-workers \
  --node-type m6i.xlarge \
  --nodes 3 \
  --nodes-min 3 \
  --nodes-max 10 \
  --with-oidc \
  --managed
```

### 2. Create Agent Node Group

Agents run on dedicated nodes with taints to ensure isolation:

```bash
eksctl create nodegroup \
  --cluster honorclaw-production \
  --name agent-workers \
  --node-type c6i.xlarge \
  --nodes 2 \
  --nodes-min 1 \
  --nodes-max 20 \
  --node-labels "honorclaw.io/role=agent" \
  --node-taints "honorclaw.io/agent-only=true:NoSchedule"
```

### 3. Create RDS PostgreSQL

```bash
aws rds create-db-instance \
  --db-instance-identifier honorclaw-db \
  --db-instance-class db.r6g.large \
  --engine postgres \
  --engine-version 16.4 \
  --master-username honorclaw \
  --master-user-password <password> \
  --allocated-storage 100 \
  --storage-type gp3 \
  --storage-encrypted \
  --multi-az \
  --vpc-security-group-ids <sg-id> \
  --db-subnet-group-name honorclaw-db-subnet \
  --backup-retention-period 30 \
  --deletion-protection
```

### 4. Create ElastiCache Redis

```bash
aws elasticache create-replication-group \
  --replication-group-id honorclaw-redis \
  --replication-group-description "HonorClaw Redis" \
  --engine redis \
  --engine-version 7.1 \
  --cache-node-type cache.r6g.large \
  --num-node-groups 1 \
  --replicas-per-node-group 2 \
  --at-rest-encryption-enabled \
  --transit-encryption-enabled \
  --auth-token <redis-auth-token>
```

### 5. Create ECR Repository (for private images)

```bash
aws ecr create-repository --repository-name honorclaw/honorclaw
aws ecr create-repository --repository-name honorclaw/agent-runtime
```

---

## Install Cluster Add-ons

### AWS Load Balancer Controller

```bash
helm repo add eks https://aws.github.io/eks-charts
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=honorclaw-production
```

### cert-manager

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
```

### OPA Gatekeeper

```bash
kubectl apply -f https://raw.githubusercontent.com/open-policy-agent/gatekeeper/master/deploy/gatekeeper.yaml
```

### Falco

```bash
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm install falco falcosecurity/falco \
  -n falco --create-namespace \
  --set falcosidekick.enabled=true \
  --set falcosidekick.config.aws.cloudwatchlogs.loggroup=/honorclaw/falco
```

---

## Deploy HonorClaw

### 1. Create Namespaces

```bash
kubectl create namespace honorclaw
kubectl create namespace honorclaw-agents

# Apply pod security standards
kubectl label namespace honorclaw-agents \
  pod-security.kubernetes.io/enforce=restricted
```

### 2. Create Secrets

```bash
# Database credentials
kubectl create secret generic honorclaw-db \
  -n honorclaw \
  --from-literal=host=honorclaw-db.xxxxxx.us-east-1.rds.amazonaws.com \
  --from-literal=port=5432 \
  --from-literal=username=honorclaw \
  --from-literal=password=<password> \
  --from-literal=database=honorclaw

# Redis credentials
kubectl create secret generic honorclaw-redis \
  -n honorclaw \
  --from-literal=host=honorclaw-redis.xxxxxx.cache.amazonaws.com \
  --from-literal=port=6379 \
  --from-literal=auth-token=<token>

# JWT signing key
kubectl create secret generic honorclaw-jwt \
  -n honorclaw \
  --from-literal=secret=$(openssl rand -base64url 48)
```

### 3. Apply OPA Policies

```bash
kubectl apply -f infra/kubernetes/policies/
```

### 4. Apply Falco Rules

```bash
kubectl apply -f infra/kubernetes/falco-rules.yaml
```

### 5. Deploy

```bash
honorclaw init
kubectl apply -f infra/kubernetes/
```

### 6. Configure Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: honorclaw
  namespace: honorclaw
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:...
    alb.ingress.kubernetes.io/ssl-policy: ELBSecurityPolicy-TLS13-1-2-2021-06
spec:
  rules:
    - host: honorclaw.example.com
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

---

## Autoscaling

### Horizontal Pod Autoscaler

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: honorclaw-control-plane
  namespace: honorclaw
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: honorclaw-control-plane
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
```

### Cluster Autoscaler

```bash
helm install cluster-autoscaler autoscaler/cluster-autoscaler \
  --set autoDiscovery.clusterName=honorclaw-production \
  --set awsRegion=us-east-1
```

---

## Monitoring

### CloudWatch Integration

```bash
# Install CloudWatch agent
helm install cloudwatch-agent eks/aws-cloudwatch-metrics \
  -n amazon-cloudwatch --create-namespace
```

### Key CloudWatch Alarms

- RDS CPU utilization > 80%
- RDS free storage < 20%
- ElastiCache evictions > 0
- EKS node count at max
- ALB 5xx error rate > 1%

---

## Backup Strategy

| Component | Method | Frequency | Retention |
|-----------|--------|-----------|-----------|
| RDS PostgreSQL | Automated snapshots | Continuous | 30 days |
| Configuration | `honorclaw backup create` | Daily | 90 days |
| Audit logs | S3 export | Daily | 7 years (compliance) |
| EKS cluster | eksctl/Terraform state | On change | Indefinite |

### Cross-Region DR

For cross-region disaster recovery:

```bash
# Enable RDS cross-region read replica
aws rds create-db-instance-read-replica \
  --db-instance-identifier honorclaw-db-dr \
  --source-db-instance-identifier arn:aws:rds:us-east-1:ACCOUNT:db:honorclaw-db \
  --region us-west-2

# S3 cross-region replication for backups
# Configure in S3 bucket replication settings
```

---

## Cost Optimization

| Component | On-Demand | Savings Plan | Spot (agents only) |
|-----------|-----------|--------------|-------------------|
| EKS control plane | $0.10/hr | - | - |
| Worker nodes (3x m6i.xlarge) | ~$0.58/hr | ~$0.37/hr (37% saving) | - |
| Agent nodes (spot) | ~$0.19/hr | - | ~$0.06/hr (68% saving) |
| RDS (r6g.large, Multi-AZ) | ~$0.52/hr | ~$0.33/hr (37% saving) | - |
| ElastiCache (r6g.large) | ~$0.26/hr | ~$0.17/hr (35% saving) | - |

Agent workloads are suitable for Spot instances because they are stateless and can tolerate interruption.
