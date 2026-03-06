# OPA Policy: RequireReadOnlyRootFilesystem
# Ensures all containers in HonorClaw deployments mount root filesystem
# as read-only. This prevents attackers from modifying binaries, planting
# backdoors, or tampering with configuration files inside containers.

package kubernetes.admission.honorclaw

import rego.v1

# Deny containers without read-only root filesystem
deny_writable_rootfs contains msg if {
  some container in input_containers
  not container_has_readonly_rootfs(container)
  msg := sprintf(
    "Container '%s' must set securityContext.readOnlyRootFilesystem=true. Use emptyDir or tmpfs mounts for writable paths.",
    [container.name],
  )
}

# Container has readOnlyRootFilesystem set to true
container_has_readonly_rootfs(container) if {
  container.securityContext.readOnlyRootFilesystem == true
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
  some msg in deny_writable_rootfs
}
