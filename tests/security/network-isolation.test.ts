/**
 * Network Isolation Tests
 *
 * These tests validate the network-layer isolation of agent-runtime containers.
 * In the Capability Sandwich architecture, agent-runtime pods are network-isolated:
 *
 *   - CANNOT reach the internet (all egress goes through the control plane)
 *   - CANNOT reach PostgreSQL directly (data access is mediated)
 *   - CANNOT reach the control plane API directly (communication via Redis only)
 *   - CAN reach Redis on localhost (sidecar proxy)
 *
 * These tests simulate the network policy checks that would run in a Kubernetes
 * environment. They validate the configuration and policy logic, not actual
 * network connectivity (which requires a live cluster).
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Network Policy Model
// ---------------------------------------------------------------------------

interface NetworkPolicyRule {
  direction: 'ingress' | 'egress';
  allow: boolean;
  target: string;          // CIDR or service name
  port?: number;
  protocol?: 'tcp' | 'udp';
  description: string;
}

interface PodNetworkProfile {
  podSelector: Record<string, string>;
  namespace: string;
  rules: NetworkPolicyRule[];
  defaultDeny: { ingress: boolean; egress: boolean };
}

// Agent-runtime network profile as defined by HonorClaw architecture
const agentRuntimeProfile: PodNetworkProfile = {
  podSelector: { 'app.kubernetes.io/component': 'agent-runtime' },
  namespace: 'honorclaw-agents',
  defaultDeny: { ingress: true, egress: true },
  rules: [
    // ALLOW: Redis sidecar on localhost
    {
      direction: 'egress',
      allow: true,
      target: '127.0.0.1/32',
      port: 6379,
      protocol: 'tcp',
      description: 'Redis sidecar proxy',
    },
    // ALLOW: DNS resolution (kube-dns)
    {
      direction: 'egress',
      allow: true,
      target: 'kube-system/kube-dns',
      port: 53,
      protocol: 'udp',
      description: 'DNS resolution',
    },
    // DENY: All other egress (implicit via defaultDeny)
  ],
};

// Simulates a connection attempt against the network policy
function evaluateConnection(
  profile: PodNetworkProfile,
  direction: 'ingress' | 'egress',
  target: string,
  port: number,
  protocol: 'tcp' | 'udp' = 'tcp',
): { allowed: boolean; matchedRule?: string } {
  // Check explicit rules first
  for (const rule of profile.rules) {
    if (rule.direction !== direction) continue;

    const targetMatches =
      target === rule.target ||
      target.startsWith(rule.target.replace('/32', '')) ||
      rule.target.includes(target);

    const portMatches = !rule.port || rule.port === port;
    const protoMatches = !rule.protocol || rule.protocol === protocol;

    if (targetMatches && portMatches && protoMatches) {
      return { allowed: rule.allow, matchedRule: rule.description };
    }
  }

  // Fall back to default policy
  const defaultPolicy = direction === 'ingress'
    ? profile.defaultDeny.ingress
    : profile.defaultDeny.egress;

  return { allowed: !defaultPolicy, matchedRule: 'default-deny' };
}

// ---------------------------------------------------------------------------
// Tests: agent-runtime cannot reach internet
// ---------------------------------------------------------------------------

describe('Agent-Runtime Cannot Reach Internet', () => {
  it('blocks egress to public IP on port 80 (HTTP)', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'egress', '93.184.216.34', 80);
    expect(result.allowed).toBe(false);
    expect(result.matchedRule).toBe('default-deny');
  });

  it('blocks egress to public IP on port 443 (HTTPS)', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'egress', '93.184.216.34', 443);
    expect(result.allowed).toBe(false);
  });

  it('blocks egress to arbitrary external service', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'egress', '8.8.8.8', 53, 'tcp');
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: agent-runtime cannot reach PostgreSQL
// ---------------------------------------------------------------------------

describe('Agent-Runtime Cannot Reach PostgreSQL', () => {
  it('blocks egress to PostgreSQL service on port 5432', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'egress', '10.96.1.100', 5432);
    expect(result.allowed).toBe(false);
  });

  it('blocks egress to PostgreSQL on non-standard port', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'egress', '10.96.1.100', 5433);
    expect(result.allowed).toBe(false);
  });

  it('blocks egress to postgres service name', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'egress', 'honorclaw-postgres', 5432);
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: agent-runtime cannot reach control plane
// ---------------------------------------------------------------------------

describe('Agent-Runtime Cannot Reach Control Plane', () => {
  it('blocks egress to control plane API on port 3000', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'egress', '10.96.2.50', 3000);
    expect(result.allowed).toBe(false);
  });

  it('blocks egress to control plane health endpoint', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'egress', 'honorclaw-control-plane', 3000);
    expect(result.allowed).toBe(false);
  });

  it('blocks egress to Kubernetes API server', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'egress', '10.96.0.1', 443);
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: agent-runtime CAN reach Redis only
// ---------------------------------------------------------------------------

describe('Agent-Runtime Can Reach Redis Only', () => {
  it('allows egress to Redis sidecar on localhost:6379', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'egress', '127.0.0.1', 6379);
    expect(result.allowed).toBe(true);
    expect(result.matchedRule).toBe('Redis sidecar proxy');
  });

  it('allows DNS resolution via kube-dns on UDP 53', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'egress', 'kube-system/kube-dns', 53, 'udp');
    expect(result.allowed).toBe(true);
    expect(result.matchedRule).toBe('DNS resolution');
  });

  it('blocks Redis on non-localhost address', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'egress', '10.96.3.200', 6379);
    expect(result.allowed).toBe(false);
  });

  it('blocks localhost on non-Redis port', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'egress', '127.0.0.1', 8080);
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Default deny validation
// ---------------------------------------------------------------------------

describe('Default Deny Policy', () => {
  it('default denies all ingress', () => {
    expect(agentRuntimeProfile.defaultDeny.ingress).toBe(true);
  });

  it('default denies all egress', () => {
    expect(agentRuntimeProfile.defaultDeny.egress).toBe(true);
  });

  it('blocks inbound connections from other pods', () => {
    const result = evaluateConnection(agentRuntimeProfile, 'ingress', '10.244.1.5', 8080);
    expect(result.allowed).toBe(false);
  });

  it('profile targets correct namespace', () => {
    expect(agentRuntimeProfile.namespace).toBe('honorclaw-agents');
  });

  it('profile targets agent-runtime pods', () => {
    expect(agentRuntimeProfile.podSelector['app.kubernetes.io/component']).toBe('agent-runtime');
  });
});
