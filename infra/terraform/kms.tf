# One CMK per data domain so access, rotation and audit are separable.
resource "aws_kms_key" "data" {
  description             = "amrutam ${var.env} data at rest (Aurora, ElastiCache, S3, backups)"
  enable_key_rotation     = true # annual automatic rotation
  deletion_window_in_days = 30
}
resource "aws_kms_alias" "data" {
  name          = "alias/amrutam-${var.env}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_kms_key" "secrets" {
  description             = "amrutam ${var.env} Secrets Manager (app keys: JWT, field-encryption keyring, HMAC keys)"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

# Replica key in the DR region so cross-region backups stay decryptable after a regional loss.
resource "aws_kms_replica_key" "data_dr" {
  provider                = aws.dr
  description             = "DR replica of the data key"
  primary_key_arn         = aws_kms_key.data.arn
  deletion_window_in_days = 30
}
