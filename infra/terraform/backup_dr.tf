# ---------------------------------------------------------------------------------------------------------
# Backup & DR. Targets: RPO <= 5 min (PITR / Aurora continuous backup), RTO <= 60 min regional (see docs/dr).
# ---------------------------------------------------------------------------------------------------------
resource "aws_backup_vault" "primary" {
  name        = "amrutam-${var.env}"
  kms_key_arn = aws_kms_key.data.arn
}
resource "aws_backup_vault" "dr" {
  provider    = aws.dr
  name        = "amrutam-${var.env}-dr"
  kms_key_arn = aws_kms_replica_key.data_dr.arn
}
resource "aws_backup_vault_lock_configuration" "primary" {
  backup_vault_name   = aws_backup_vault.primary.name
  min_retention_days  = 7 # immutability: backups cannot be deleted early, even by an admin or ransomware
  changeable_for_days = 3
}

resource "aws_backup_plan" "db" {
  name = "amrutam-${var.env}-db"
  rule {
    rule_name         = "daily-35d-copy-to-dr"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 21 * * ? *)"
    lifecycle { delete_after = 35 }
    copy_action {
      destination_vault_arn = aws_backup_vault.dr.arn
      lifecycle { delete_after = 35 }
    }
  }
  rule {
    rule_name         = "monthly-1y"
    target_vault_name = aws_backup_vault.primary.name
    schedule          = "cron(0 21 1 * ? *)"
    lifecycle { delete_after = 365 }
  }
}

resource "aws_iam_role" "backup" {
  name_prefix        = "amrutam-backup-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "backup.amazonaws.com" } }] })
}
resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}
resource "aws_backup_selection" "db" {
  name         = "aurora"
  plan_id      = aws_backup_plan.db.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_rds_cluster.main.arn]
}

# WORM archive for detached audit-log partitions: S3 Object Lock (compliance mode) + cross-region replication.
resource "aws_s3_bucket" "audit_archive" {
  bucket              = "amrutam-${var.env}-audit-archive"
  object_lock_enabled = true
}
resource "aws_s3_bucket_versioning" "audit_archive" {
  bucket = aws_s3_bucket.audit_archive.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_object_lock_configuration" "audit_archive" {
  bucket = aws_s3_bucket.audit_archive.id
  rule {
    default_retention {
      mode  = "COMPLIANCE"
      years = 7
    }
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "audit_archive" {
  bucket = aws_s3_bucket.audit_archive.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.data.arn
    }
  }
}
resource "aws_s3_bucket_public_access_block" "audit_archive" {
  bucket                  = aws_s3_bucket.audit_archive.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
