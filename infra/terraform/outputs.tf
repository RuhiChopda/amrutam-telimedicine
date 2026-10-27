output "waf_acl_arn" { value = aws_wafv2_web_acl.api.arn }
output "eks_cluster" { value = module.eks.cluster_name }
output "db_writer_endpoint" { value = aws_rds_cluster.main.endpoint }
output "db_reader_endpoint" { value = aws_rds_cluster.main.reader_endpoint }
output "audit_archive_bucket" { value = aws_s3_bucket.audit_archive.bucket }
output "alerts_topic" { value = aws_sns_topic.alerts.arn }
