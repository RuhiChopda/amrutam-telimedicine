terraform {
  required_version = ">= 1.6"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.70" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Remote state with locking (create the bucket/table once, out of band).
  backend "s3" {
    bucket         = "amrutam-tfstate"
    key            = "prod/terraform.tfstate"
    region         = "ap-south-1"
    dynamodb_table = "amrutam-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region
  default_tags { tags = { Project = "amrutam", Env = var.env, ManagedBy = "terraform", DataClass = "PHI" } }
}

# Disaster-recovery region (backup copies, replicated audit archive).
provider "aws" {
  alias  = "dr"
  region = var.dr_region
  default_tags { tags = { Project = "amrutam", Env = var.env, ManagedBy = "terraform", DataClass = "PHI" } }
}
