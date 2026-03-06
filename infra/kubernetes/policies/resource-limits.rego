# OPA Policy: RequireResourceLimits
# Ensures all containers in HonorClaw deployments specify CPU and memory
# limits. Without resource limits, a compromised agent could consume all
# node resources (denial-of-service) or mine cryptocurrency.

package kubernetes.admission.honorclaw

import rego.v1

# Deny containers without CPU limits
deny_no_cpu_limit contains msg if {
  some container in input_containers
  not container_has_cpu_limit(container)
  msg := sprintf(
    "Container '%s' must specify resources.limits.cpu.",
    [container.name],
  )
}

# Deny containers without memory limits
deny_no_memory_limit contains msg if {
  some container in input_containers
  not container_has_memory_limit(container)
  msg := sprintf(
    "Container '%s' must specify resources.limits.memory.",
    [container.name],
  )
}

# Deny containers without CPU requests
deny_no_cpu_request contains msg if {
  some container in input_containers
  not container_has_cpu_request(container)
  msg := sprintf(
    "Container '%s' must specify resources.requests.cpu.",
    [container.name],
  )
}

# Deny containers without memory requests
deny_no_memory_request contains msg if {
  some container in input_containers
  not container_has_memory_request(container)
  msg := sprintf(
    "Container '%s' must specify resources.requests.memory.",
    [container.name],
  )
}

# Deny agent-runtime containers with excessive CPU
deny_agent_excessive_cpu contains msg if {
  some container in input_containers
  container.image
  contains(container.image, "honorclaw/agent-runtime")
  limit := container.resources.limits.cpu
  cpu_millicores := parse_cpu(limit)
  cpu_millicores > 4000
  msg := sprintf(
    "Agent-runtime container '%s' CPU limit %s exceeds maximum 4 cores.",
    [container.name, limit],
  )
}

# Deny agent-runtime containers with excessive memory
deny_agent_excessive_memory contains msg if {
  some container in input_containers
  container.image
  contains(container.image, "honorclaw/agent-runtime")
  limit := container.resources.limits.memory
  mem_bytes := parse_memory(limit)
  mem_bytes > 8589934592  # 8Gi
  msg := sprintf(
    "Agent-runtime container '%s' memory limit %s exceeds maximum 8Gi.",
    [container.name, limit],
  )
}

# Helpers
container_has_cpu_limit(container) if {
  container.resources.limits.cpu
}

container_has_memory_limit(container) if {
  container.resources.limits.memory
}

container_has_cpu_request(container) if {
  container.resources.requests.cpu
}

container_has_memory_request(container) if {
  container.resources.requests.memory
}

# Parse CPU string to millicores (simplified)
parse_cpu(cpu) := millicores if {
  endswith(cpu, "m")
  millicores := to_number(trim_suffix(cpu, "m"))
}

parse_cpu(cpu) := millicores if {
  not endswith(cpu, "m")
  millicores := to_number(cpu) * 1000
}

# Parse memory string to bytes (simplified)
parse_memory(mem) := bytes if {
  endswith(mem, "Gi")
  bytes := to_number(trim_suffix(mem, "Gi")) * 1073741824
}

parse_memory(mem) := bytes if {
  endswith(mem, "Mi")
  bytes := to_number(trim_suffix(mem, "Mi")) * 1048576
}

parse_memory(mem) := bytes if {
  endswith(mem, "Ki")
  bytes := to_number(trim_suffix(mem, "Ki")) * 1024
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
  some msg in deny_no_cpu_limit
}

violation contains {"msg": msg} if {
  some msg in deny_no_memory_limit
}

violation contains {"msg": msg} if {
  some msg in deny_no_cpu_request
}

violation contains {"msg": msg} if {
  some msg in deny_no_memory_request
}

violation contains {"msg": msg} if {
  some msg in deny_agent_excessive_cpu
}

violation contains {"msg": msg} if {
  some msg in deny_agent_excessive_memory
}
