module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.24"

  cluster_name                   = "amrutam-${var.env}"
  cluster_version                = "1.31"
  vpc_id                         = module.vpc.vpc_id
  subnet_ids                     = module.vpc.private_subnets
  cluster_endpoint_public_access = false # API server reachable only from inside the VPC / VPN
  enable_cluster_creator_admin_permissions = true

  cluster_encryption_config = { resources = ["secrets"], provider_key_arn = aws_kms_key.secrets.arn }
  cluster_enabled_log_types = ["api", "audit", "authenticator"]

  eks_managed_node_groups = {
    app = {
      instance_types = var.eks_node_instance_types
      min_size       = var.eks_min_nodes
      max_size       = var.eks_max_nodes
      desired_size   = var.eks_min_nodes
      metadata_options = { http_tokens = "required", http_put_response_hop_limit = 1 } # IMDSv2 only
    }
  }
}
