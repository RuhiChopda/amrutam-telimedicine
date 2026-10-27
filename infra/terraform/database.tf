resource "random_password" "db" {
  length  = 32
  special = false
}

resource "aws_security_group" "db" {
  name_prefix = "amrutam-db-"
  vpc_id      = module.vpc.vpc_id
  ingress {
    description     = "Postgres from EKS nodes only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
}

resource "aws_rds_cluster_parameter_group" "pg" {
  name_prefix = "amrutam-pg16-"
  family      = "aurora-postgresql16"
  parameter { # TLS required on the wire
    name = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name = "log_min_duration_statement"
    value = "300"
  }
  parameter {
    name = "idle_in_transaction_session_timeout"
    value = "30000"
  }
  parameter {
    name = "shared_preload_libraries"
    value = "pg_stat_statements"
    apply_method = "pending-reboot"
  }
}

resource "aws_rds_cluster" "main" {
  cluster_identifier              = "amrutam-${var.env}"
  engine                          = "aurora-postgresql"
  engine_version                  = "16.4"
  database_name                   = "amrutam"
  master_username                 = "amrutam_admin"
  master_password                 = random_password.db.result
  db_subnet_group_name            = module.vpc.database_subnet_group_name
  vpc_security_group_ids          = [aws_security_group.db.id]
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.pg.name
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.data.arn
  backup_retention_period         = 35 # point-in-time recovery window
  preferred_backup_window         = "21:00-22:00"
  copy_tags_to_snapshot           = true
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "amrutam-${var.env}-final"
  enabled_cloudwatch_logs_exports = ["postgresql"]
  iam_database_authentication_enabled = true
}

# Writer + readers across AZs. Failover is automatic (typically < 30 s): the primary requirement for 99.95%.
resource "aws_rds_cluster_instance" "node" {
  count                        = 1 + var.db_reader_count
  identifier                   = "amrutam-${var.env}-${count.index}"
  cluster_identifier           = aws_rds_cluster.main.id
  instance_class               = var.db_instance_class
  engine                       = aws_rds_cluster.main.engine
  availability_zone            = var.azs[count.index % length(var.azs)]
  performance_insights_enabled = true
  performance_insights_kms_key_id = aws_kms_key.data.arn
  monitoring_interval          = 15
  monitoring_role_arn          = aws_iam_role.rds_monitoring.arn
  promotion_tier               = count.index == 0 ? 0 : 1
}

resource "aws_iam_role" "rds_monitoring" {
  name_prefix        = "amrutam-rds-mon-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "monitoring.rds.amazonaws.com" } }] })
}
resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}
