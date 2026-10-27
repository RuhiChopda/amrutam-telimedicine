module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.13"

  name = "amrutam-${var.env}"
  cidr = var.vpc_cidr
  azs  = var.azs

  public_subnets   = [for i in range(3) : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnets  = [for i in range(3) : cidrsubnet(var.vpc_cidr, 8, i + 10)]
  database_subnets = [for i in range(3) : cidrsubnet(var.vpc_cidr, 8, i + 20)]

  enable_nat_gateway     = true
  one_nat_gateway_per_az = true # AZ-independent egress: a single-AZ NAT failure must not break the PSP path
  create_database_subnet_group = true

  enable_flow_log                      = true
  create_flow_log_cloudwatch_iam_role  = true
  create_flow_log_cloudwatch_log_group = true

  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }
}
