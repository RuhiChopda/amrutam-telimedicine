resource "aws_wafv2_web_acl" "api" {
  name  = "amrutam-${var.env}-api"
  scope = "REGIONAL"
  default_action {
    allow {}
  }
  rule {
    name     = "aws-common"
    priority = 1
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "common"
      sampled_requests_enabled   = true
    }
  }
  rule {
    name     = "aws-sqli"
    priority = 2
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "sqli"
      sampled_requests_enabled   = true
    }
  }
  rule {
    name     = "ip-rate-limit"
    priority = 3
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 2000 # per IP per 5 min; the app enforces finer per-user limits behind this coarse edge limit
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "ratelimit"
      sampled_requests_enabled   = true
    }
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "amrutam-api"
    sampled_requests_enabled   = true
  }
}

resource "aws_sns_topic" "alerts" {
  name              = "amrutam-${var.env}-alerts"
  kms_master_key_id = aws_kms_key.secrets.id
}
resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "amrutam-${var.env}-aurora-cpu-high"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBClusterIdentifier = aws_rds_cluster.main.id, Role = "WRITER" }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 70
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_metric_alarm" "db_replica_lag" {
  alarm_name          = "amrutam-${var.env}-aurora-replica-lag"
  namespace           = "AWS/RDS"
  metric_name         = "AuroraReplicaLagMaximum"
  dimensions          = { DBClusterIdentifier = aws_rds_cluster.main.id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 1000 # ms
  comparison_operator = "GreaterThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
