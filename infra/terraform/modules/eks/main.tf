variable "cluster_name" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "region" { type = string }

module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = var.cluster_name
  cluster_version = "1.29"

  vpc_id     = var.vpc_id
  subnet_ids = var.subnet_ids

  cluster_endpoint_public_access = true

  eks_managed_node_groups = {
    honorclaw = {
      desired_size = 3
      min_size     = 2
      max_size     = 5

      instance_types = ["m6i.xlarge"]

      labels = {
        role = "honorclaw"
      }
    }

    agents = {
      desired_size = 2
      min_size     = 1
      max_size     = 10

      instance_types = ["c6i.large"]

      labels = {
        role = "agent-runtime"
      }

      taints = [{
        key    = "honorclaw.io/agent-only"
        value  = "true"
        effect = "NO_SCHEDULE"
      }]
    }
  }

  tags = {
    Project = "honorclaw"
  }
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "node_security_group_id" {
  value = module.eks.node_security_group_id
}
