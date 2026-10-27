variable "env" {
  type = string
  default = "prod"
}
variable "region" {
  type = string
  default = "ap-south-1"
}
variable "dr_region" {
  type = string
  default = "ap-southeast-1"
}
variable "vpc_cidr" {
  type = string
  default = "10.0.0.0/16"
}
variable "azs" {
  type = list(string)
  default = ["ap-south-1a", "ap-south-1b", "ap-south-1c"]
}
variable "db_instance_class" { # sized for ~100k consults/day with headroom; see docs/architecture.md capacity model
  type = string
  default = "db.r6g.2xlarge"
}
variable "db_reader_count" {
  type = number
  default = 2
}
variable "redis_node_type" {
  type = string
  default = "cache.r6g.large"
}
variable "eks_node_instance_types" {
  type = list(string)
  default = ["m6i.xlarge"]
}
variable "eks_min_nodes" {
  type = number
  default = 3
}
variable "eks_max_nodes" {
  type = number
  default = 20
}
variable "alert_email" { type = string }
