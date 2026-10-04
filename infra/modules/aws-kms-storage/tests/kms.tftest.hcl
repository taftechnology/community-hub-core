mock_provider "aws" {}

run "staging_happy" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    name           = "ch-staging"
  }

  assert {
    condition     = aws_kms_key.storage.region == "ap-southeast-2"
    error_message = "storage KMS key region argument must be ap-southeast-2"
  }

  assert {
    condition     = aws_kms_key.storage.enable_key_rotation == true
    error_message = "storage KMS key must rotate"
  }

  assert {
    condition     = length(jsondecode(aws_kms_key.storage.policy).Statement) == 1
    error_message = "storage key policy must have exactly one statement"
  }

  assert {
    condition     = jsondecode(aws_kms_key.storage.policy).Statement[0].Sid == "Enable IAM User Permissions"
    error_message = "storage key policy Sid must be the AWS default Enable IAM User Permissions"
  }

  assert {
    condition     = jsondecode(aws_kms_key.storage.policy).Statement[0].Action == "kms:*"
    error_message = "storage key policy must grant kms:* to the account root"
  }

  assert {
    condition     = jsondecode(aws_kms_key.storage.policy).Statement[0].Principal.AWS == "arn:aws:iam::123456789012:root"
    error_message = "storage key policy principal must be the account root ARN"
  }

  assert {
    condition     = jsondecode(aws_kms_key.storage.policy).Statement[0].Resource == "*"
    error_message = "storage key policy resource must be *"
  }

  assert {
    condition     = !strcontains(aws_kms_key.storage.policy, "ch-staging-task")
    error_message = "storage key policy must not name the envelope task role"
  }
}

run "rotation_off_fails" {
  command = plan

  variables {
    aws_region          = "ap-southeast-2"
    aws_account_id      = "123456789012"
    name                = "ch-staging"
    enable_key_rotation = false
  }

  expect_failures = [var.enable_key_rotation]
}

run "wrong_region_fails" {
  command = plan

  variables {
    aws_region     = "us-east-1"
    aws_account_id = "123456789012"
    name           = "ch-staging"
  }

  expect_failures = [var.aws_region]
}
