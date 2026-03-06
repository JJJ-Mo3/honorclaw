# OPA Policy: AllImagesFromApprovedRegistry
# Ensures all container images in HonorClaw deployments are pulled from
# approved registries only. This prevents supply-chain attacks via
# unauthorized image sources.

package kubernetes.admission.honorclaw

import rego.v1

# Approved registries — only these prefixes are allowed
approved_registries := [
  "ghcr.io/honorclaw/",
  "docker.io/library/",
  "registry.k8s.io/",
]

# Deny pods with images from unapproved registries
deny_unapproved_registry contains msg if {
  some container in input_containers
  image := container.image
  not image_from_approved_registry(image)
  msg := sprintf(
    "Container '%s' uses image '%s' which is not from an approved registry. Approved registries: %v",
    [container.name, image, approved_registries],
  )
}

# Check if image is from an approved registry
image_from_approved_registry(image) if {
  some registry in approved_registries
  startswith(image, registry)
}

# Collect all containers (init + regular + ephemeral)
input_containers contains container if {
  some container in input.request.object.spec.containers
}

input_containers contains container if {
  some container in input.request.object.spec.initContainers
}

input_containers contains container if {
  some container in input.request.object.spec.ephemeralContainers
}

# Violation output for Gatekeeper ConstraintTemplate
violation contains {"msg": msg} if {
  some msg in deny_unapproved_registry
}
