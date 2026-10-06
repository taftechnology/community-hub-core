mock_provider "aws" {}

run "staging_happy" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    subnet_ids             = ["subnet-aaaa", "subnet-bbbb"]
    vpc_security_group_ids = ["sg-rds"]
    kms_key_arn            = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
    alarm_topic_arn        = "arn:aws:sns:ap-southeast-2:123456789012:ch-staging-alarms"
    deletion_protection    = false
    backup_retention_days  = 0
  }

  assert {
    condition     = aws_db_instance.this.region == "ap-southeast-2"
    error_message = "RDS region argument must be ap-southeast-2"
  }

  assert {
    condition = (
      aws_db_instance.this.tags["environment"] == "staging" &&
      aws_db_instance.this.tags["project"] == "community-hub"
    )
    error_message = "RDS instance tags must be environment=staging and project=community-hub"
  }

  assert {
    condition     = aws_db_instance.this.db_name == "communityhub"
    error_message = "RDS database name must be communityhub"
  }

  assert {
    condition     = aws_db_instance.this.publicly_accessible == false
    error_message = "RDS must not be publicly accessible"
  }

  assert {
    condition     = aws_db_instance.this.storage_encrypted == true
    error_message = "RDS storage must be encrypted"
  }

  assert {
    condition     = aws_db_instance.this.manage_master_user_password == true
    error_message = "RDS master password must be managed so it never enters state"
  }

  assert {
    condition     = aws_db_instance.this.ca_cert_identifier == "rds-ca-rsa2048-g1"
    error_message = "RDS CA must be pinned"
  }

  assert {
    condition     = aws_db_instance.this.deletion_protection == false
    error_message = "staging RDS deletion protection is off"
  }

  assert {
    condition     = aws_db_instance.this.backup_retention_period == 0
    error_message = "staging RDS backup retention is off"
  }

  assert {
    condition     = aws_db_instance.this.instance_class == "db.t4g.micro"
    error_message = "RDS instance class default must be db.t4g.micro"
  }

  assert {
    condition     = aws_db_instance.this.multi_az == false
    error_message = "staging RDS must not be Multi-AZ"
  }

  assert {
    condition     = aws_db_instance.this.max_allocated_storage == 100
    error_message = "RDS max allocated storage must be 100 GiB"
  }

  assert {
    condition     = aws_db_instance.this.backup_window == "17:00-18:00"
    error_message = "RDS backup window must be 17:00-18:00"
  }

  assert {
    condition     = aws_db_instance.this.maintenance_window == "tue:15:00-tue:16:00"
    error_message = "RDS maintenance window must be tue:15:00-tue:16:00"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.cpu_credit_balance.metric_name == "CPUCreditBalance" &&
      aws_cloudwatch_metric_alarm.cpu_credit_balance.comparison_operator == "LessThanThreshold" &&
      aws_cloudwatch_metric_alarm.cpu_credit_balance.threshold == 24 &&
      aws_cloudwatch_metric_alarm.cpu_credit_balance.period == 300 &&
      aws_cloudwatch_metric_alarm.cpu_credit_balance.evaluation_periods == 3 &&
      aws_cloudwatch_metric_alarm.cpu_credit_balance.datapoints_to_alarm == 3 &&
      aws_cloudwatch_metric_alarm.cpu_credit_balance.alarm_actions == toset([var.alarm_topic_arn])
    )
    error_message = "CPUCreditBalance alarm thresholds and SNS action must match spec"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.freeable_memory.metric_name == "FreeableMemory" &&
      aws_cloudwatch_metric_alarm.freeable_memory.comparison_operator == "LessThanThreshold" &&
      aws_cloudwatch_metric_alarm.freeable_memory.threshold == 104857600 &&
      aws_cloudwatch_metric_alarm.freeable_memory.period == 300 &&
      aws_cloudwatch_metric_alarm.freeable_memory.evaluation_periods == 3 &&
      aws_cloudwatch_metric_alarm.freeable_memory.datapoints_to_alarm == 3 &&
      aws_cloudwatch_metric_alarm.freeable_memory.alarm_actions == toset([var.alarm_topic_arn])
    )
    error_message = "FreeableMemory alarm thresholds and SNS action must match spec"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.free_storage_space.metric_name == "FreeStorageSpace" &&
      aws_cloudwatch_metric_alarm.free_storage_space.comparison_operator == "LessThanThreshold" &&
      aws_cloudwatch_metric_alarm.free_storage_space.threshold == 2147483648 &&
      aws_cloudwatch_metric_alarm.free_storage_space.period == 300 &&
      aws_cloudwatch_metric_alarm.free_storage_space.evaluation_periods == 3 &&
      aws_cloudwatch_metric_alarm.free_storage_space.datapoints_to_alarm == 3 &&
      aws_cloudwatch_metric_alarm.free_storage_space.alarm_actions == toset([var.alarm_topic_arn])
    )
    error_message = "FreeStorageSpace alarm thresholds and SNS action must match spec"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.database_connections.metric_name == "DatabaseConnections" &&
      aws_cloudwatch_metric_alarm.database_connections.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.database_connections.threshold == 30 &&
      aws_cloudwatch_metric_alarm.database_connections.period == 300 &&
      aws_cloudwatch_metric_alarm.database_connections.evaluation_periods == 3 &&
      aws_cloudwatch_metric_alarm.database_connections.datapoints_to_alarm == 3 &&
      aws_cloudwatch_metric_alarm.database_connections.alarm_actions == toset([var.alarm_topic_arn])
    )
    error_message = "DatabaseConnections alarm thresholds and SNS action must match spec"
  }
}

run "prod_protection" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    name                   = "ch-prod"
    environment            = "prod"
    project                = "community-hub"
    subnet_ids             = ["subnet-aaaa", "subnet-bbbb"]
    vpc_security_group_ids = ["sg-rds"]
    kms_key_arn            = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
    alarm_topic_arn        = "arn:aws:sns:ap-southeast-2:123456789012:ch-staging-alarms"
    deletion_protection    = true
    backup_retention_days  = 7
  }

  assert {
    condition     = aws_db_instance.this.deletion_protection == true
    error_message = "prod RDS must set deletion protection"
  }

  assert {
    condition     = aws_db_instance.this.backup_retention_period >= 7
    error_message = "prod RDS must retain backups"
  }

  assert {
    condition     = aws_db_instance.this.publicly_accessible == false
    error_message = "prod RDS must not be publicly accessible"
  }
}

run "prod_backup_off_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    name                   = "ch-prod"
    environment            = "prod"
    project                = "community-hub"
    subnet_ids             = ["subnet-aaaa", "subnet-bbbb"]
    vpc_security_group_ids = ["sg-rds"]
    kms_key_arn            = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
    alarm_topic_arn        = "arn:aws:sns:ap-southeast-2:123456789012:ch-staging-alarms"
    deletion_protection    = false
    backup_retention_days  = 7
  }

  expect_failures = [terraform_data.prod_protection]
}

run "prod_retention_off_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    name                   = "ch-prod"
    environment            = "prod"
    project                = "community-hub"
    subnet_ids             = ["subnet-aaaa", "subnet-bbbb"]
    vpc_security_group_ids = ["sg-rds"]
    kms_key_arn            = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
    alarm_topic_arn        = "arn:aws:sns:ap-southeast-2:123456789012:ch-staging-alarms"
    deletion_protection    = true
    backup_retention_days  = 0
  }

  expect_failures = [terraform_data.prod_protection]
}

run "public_rds_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    subnet_ids             = ["subnet-aaaa", "subnet-bbbb"]
    vpc_security_group_ids = ["sg-rds"]
    kms_key_arn            = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
    alarm_topic_arn        = "arn:aws:sns:ap-southeast-2:123456789012:ch-staging-alarms"
    deletion_protection    = false
    backup_retention_days  = 0
    publicly_accessible    = true
  }

  expect_failures = [var.publicly_accessible]
}

run "wrong_region_fails" {
  command = plan

  variables {
    aws_region             = "us-east-1"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    subnet_ids             = ["subnet-aaaa", "subnet-bbbb"]
    vpc_security_group_ids = ["sg-rds"]
    kms_key_arn            = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
    alarm_topic_arn        = "arn:aws:sns:ap-southeast-2:123456789012:ch-staging-alarms"
    deletion_protection    = false
    backup_retention_days  = 0
  }

  expect_failures = [var.aws_region]
}
