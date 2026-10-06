resource "terraform_data" "prod_protection" {
  input = var.environment

  lifecycle {
    precondition {
      condition     = var.environment != "prod" || (var.deletion_protection && var.backup_retention_days >= 7)
      error_message = "prod must set deletion protection and backup retention of at least 7 days."
    }
  }
}

resource "aws_db_subnet_group" "this" {
  region     = var.aws_region
  name       = "${var.name}-postgres"
  subnet_ids = var.subnet_ids

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_db_parameter_group" "this" {
  region = var.aws_region
  name   = "${var.name}-postgres"
  family = var.parameter_group_family

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_db_instance" "this" {
  region     = var.aws_region
  identifier = "${var.name}-postgres"

  engine                 = "postgres"
  engine_version         = var.engine_version
  instance_class         = var.instance_class
  allocated_storage      = 20
  db_subnet_group_name   = aws_db_subnet_group.this.name
  parameter_group_name   = aws_db_parameter_group.this.name
  vpc_security_group_ids = var.vpc_security_group_ids

  storage_encrypted           = true
  kms_key_id                  = var.kms_key_arn
  publicly_accessible         = var.publicly_accessible
  manage_master_user_password = true
  db_name                     = "communityhub"
  username                    = "postgres"
  ca_cert_identifier          = var.ca_cert_identifier

  multi_az                = var.multi_az
  deletion_protection     = var.deletion_protection
  backup_retention_period = var.backup_retention_days
  max_allocated_storage   = 100
  backup_window           = "17:00-18:00"
  maintenance_window      = "tue:15:00-tue:16:00"
  skip_final_snapshot     = var.environment != "prod"
  copy_tags_to_snapshot   = true
  apply_immediately       = var.environment != "prod"

  tags = merge(
    { environment = var.environment, project = var.project },
    { Name = "${var.name}-postgres" },
  )
}

resource "aws_cloudwatch_metric_alarm" "cpu_credit_balance" {
  region              = var.aws_region
  alarm_name          = "${var.name}-postgres-cpu-credit-balance"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "CPUCreditBalance"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 24
  alarm_actions       = [var.alarm_topic_arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.identifier
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_cloudwatch_metric_alarm" "freeable_memory" {
  region              = var.aws_region
  alarm_name          = "${var.name}-postgres-freeable-memory"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "FreeableMemory"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 104857600
  alarm_actions       = [var.alarm_topic_arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.identifier
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_cloudwatch_metric_alarm" "free_storage_space" {
  region              = var.aws_region
  alarm_name          = "${var.name}-postgres-free-storage-space"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 2147483648
  alarm_actions       = [var.alarm_topic_arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.identifier
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_cloudwatch_metric_alarm" "database_connections" {
  region              = var.aws_region
  alarm_name          = "${var.name}-postgres-database-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = 30
  alarm_actions       = [var.alarm_topic_arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.identifier
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}
