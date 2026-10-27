# Container for the application secret bundle (DATABASE_URL, REDIS_URL, JWT_*, DATA_KEYS_JSON, *_KEY_B64, webhook secret).
# Terraform creates only the connection strings it owns; cryptographic keys are generated out-of-band
# (`npm run gen:env` format) and rotated per docs/security/key-management.md so they never enter Terraform state.
resource "aws_secretsmanager_secret" "app" {
  name       = "amrutam/${var.env}/app"
  kms_key_id = aws_kms_key.secrets.arn
}

resource "aws_secretsmanager_secret" "db_conn" {
  name       = "amrutam/${var.env}/db-connection"
  kms_key_id = aws_kms_key.secrets.arn
}
resource "aws_secretsmanager_secret_version" "db_conn" {
  secret_id = aws_secretsmanager_secret.db_conn.id
  secret_string = jsonencode({
    DATABASE_URL      = "postgres://amrutam_admin:${random_password.db.result}@${aws_rds_cluster.main.endpoint}:5432/amrutam"
    DATABASE_READ_URL = "postgres://amrutam_admin:${random_password.db.result}@${aws_rds_cluster.main.reader_endpoint}:5432/amrutam"
    REDIS_URL         = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
  })
}
