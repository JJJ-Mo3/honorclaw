# OPA Policy: AgentRuntimeNetworkPolicy
# Enforces that agent-runtime pods have the correct NetworkPolicy applied.
# Agent-runtime pods MUST be isolated: they can only communicate with Redis
# on localhost (sidecar). All other egress — internet, PostgreSQL, control
# plane — is denied at the network layer.

package kubernetes.admission.honorclaw

import rego.v1

# Deny agent-runtime pods without the required network isolation label
deny_missing_network_label contains msg if {
  input.request.object.kind == "Pod"
  some container in input.request.object.spec.containers
  contains(container.image, "honorclaw/agent-runtime")
  not input.request.object.metadata.labels["honorclaw.io/network-policy"]
  msg := sprintf(
    "Agent-runtime pod '%s' must have label 'honorclaw.io/network-policy=agent-isolated'.",
    [input.request.object.metadata.name],
  )
}

# Deny agent-runtime pods with incorrect network policy label
deny_wrong_network_label contains msg if {
  input.request.object.kind == "Pod"
  some container in input.request.object.spec.containers
  contains(container.image, "honorclaw/agent-runtime")
  label := input.request.object.metadata.labels["honorclaw.io/network-policy"]
  label != "agent-isolated"
  msg := sprintf(
    "Agent-runtime pod '%s' has network-policy label '%s' but must be 'agent-isolated'.",
    [input.request.object.metadata.name, label],
  )
}

# Deny agent-runtime pods with hostNetwork enabled
deny_host_network contains msg if {
  input.request.object.kind == "Pod"
  some container in input.request.object.spec.containers
  contains(container.image, "honorclaw/agent-runtime")
  input.request.object.spec.hostNetwork == true
  msg := sprintf(
    "Agent-runtime pod '%s' must not use hostNetwork.",
    [input.request.object.metadata.name],
  )
}

# Deny agent-runtime pods with hostPort mappings
deny_host_port contains msg if {
  input.request.object.kind == "Pod"
  some container in input.request.object.spec.containers
  contains(container.image, "honorclaw/agent-runtime")
  some port in container.ports
  port.hostPort
  msg := sprintf(
    "Agent-runtime container '%s' must not use hostPort (port %d).",
    [container.name, port.hostPort],
  )
}

# Ensure NetworkPolicy exists for agent namespace (advisory)
# This rule validates that Deployments in the agent namespace reference
# pods that should have a corresponding NetworkPolicy.
deny_deployment_without_network_policy contains msg if {
  input.request.object.kind == "Deployment"
  input.request.object.metadata.namespace == "honorclaw-agents"
  not input.request.object.metadata.annotations["honorclaw.io/network-policy-verified"]
  msg := sprintf(
    "Deployment '%s' in honorclaw-agents namespace must have annotation 'honorclaw.io/network-policy-verified=true'.",
    [input.request.object.metadata.name],
  )
}

# Violation output for Gatekeeper
violation contains {"msg": msg} if {
  some msg in deny_missing_network_label
}

violation contains {"msg": msg} if {
  some msg in deny_wrong_network_label
}

violation contains {"msg": msg} if {
  some msg in deny_host_network
}

violation contains {"msg": msg} if {
  some msg in deny_host_port
}

violation contains {"msg": msg} if {
  some msg in deny_deployment_without_network_policy
}
