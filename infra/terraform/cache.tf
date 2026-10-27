resource "random_password" "redis" {
  length  = 40
  special = false
}

resource "aws_elasticache_subnet_group" "redis" {
  name       = "amrutam-${var.env}"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "redis" {
  name_prefix = "amrutam-redis-"
  vpc_id      = module.vpc.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}

# Redis holds only cache, revocation markers and rate-limit counters. The app degrades gracefully if it is down.
resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "amrutam-${var.env}"
  description                = "amrutam cache / rate limiting"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 3
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis.result
  snapshot_retention_limit   = 1
}
