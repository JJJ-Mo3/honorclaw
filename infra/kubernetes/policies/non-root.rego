# OPA Policy: RequireNonRootUser
# Ensures all containers in HonorClaw deployments run as non-root.
# This is a foundational defense-in-depth control: even if an attacker
# escapes the application sandbox, they land as an unprivileged user.

package kubernetes.admission.honorclaw

import rego.v1

# Deny containers running as root
deny_root_user contains msg if {
  some container in input_containers
  not container_runs_as_non_root(container)
  msg := sprintf(
    "Container '%s' must not run as root. Set securityContext.runAsNonRoot=true and securityContext.runAsUser to a non-zero UID.",
    [container.name],
  )
}

# Check pod-level securityContext
pod_runs_as_non_root if {
  input.request.object.spec.securityContext.runAsNonRoot == true
}

pod_runs_as_non_root if {
  input.request.object.spec.securityContext.runAsUser != 0
  input.request.object.spec.securityContext.runAsUser != null
}

# Container passes if it explicitly sets non-root or inherits from pod
container_runs_as_non_root(container) if {
  container.securityContext.runAsNonRoot == true
}

container_runs_as_non_root(container) if {
  container.securityContext.runAsUser != 0
  container.securityContext.runAsUser != null
}

container_runs_as_non_root(container) if {
  not container.securityContext.runAsNonRoot == false
  not has_key(container.securityContext, "runAsUser")
  pod_runs_as_non_root
}

container_runs_as_non_root(container) if {
  not has_key(container, "securityContext")
  pod_runs_as_non_root
}

# Deny containers with allowPrivilegeEscalation
deny_privilege_escalation contains msg if {
  some container in input_containers
  container.securityContext.allowPrivilegeEscalation == true
  msg := sprintf(
    "Container '%s' must set allowPrivilegeEscalation=false.",
    [container.name],
  )
}

# Deny privileged containers
deny_privileged contains msg if {
  some container in input_containers
  container.securityContext.privileged == true
  msg := sprintf(
    "Container '%s' must not run in privileged mode.",
    [container.name],
  )
}

# Helper
has_key(obj, key) if {
  _ := obj[key]
}

# Collect all containers
input_containers contains container if {
  some container in input.request.object.spec.containers
}

input_containers contains container if {
  some container in input.request.object.spec.initContainers
}

# Violation output for Gatekeeper
violation contains {"msg": msg} if {
  some msg in deny_root_user
}

violation contains {"msg": msg} if {
  some msg in deny_privilege_escalation
}

violation contains {"msg": msg} if {
  some msg in deny_privileged
}
