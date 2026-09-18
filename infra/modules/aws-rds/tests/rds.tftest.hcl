mock_provider "aws" {}

run "staging_happy" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    name                   = "ch-staging"
    environment            = "staging"
    subnet_ids             = ["subnet-aaaa", "subnet-bbbb"]
    vpc_security_group_ids = ["sg-rds"]
    kms_key_arn            = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
  }

  assert {
    condition     = aws_db_instance.this.region == "ap-southeast-2"
    error_message = "RDS region argument must be ap-southeast-2"
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
}

run "prod_protection" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    name                   = "ch-prod"
    environment            = "prod"
    subnet_ids             = ["subnet-aaaa", "subnet-bbbb"]
    vpc_security_group_ids = ["sg-rds"]
    kms_key_arn            = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
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

run "public_rds_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    name                   = "ch-staging"
    environment            = "staging"
    subnet_ids             = ["subnet-aaaa", "subnet-bbbb"]
    vpc_security_group_ids = ["sg-rds"]
    kms_key_arn            = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
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
    subnet_ids             = ["subnet-aaaa", "subnet-bbbb"]
    vpc_security_group_ids = ["sg-rds"]
    kms_key_arn            = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
  }

  expect_failures = [var.aws_region]
}
