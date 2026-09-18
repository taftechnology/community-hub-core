mock_provider "aws" {}

run "staging_happy" {
  command = plan

  variables {
    aws_region = "ap-southeast-2"
    name       = "ch-staging"
  }

  assert {
    condition     = aws_kms_key.storage.region == "ap-southeast-2"
    error_message = "storage KMS key region argument must be ap-southeast-2"
  }

  assert {
    condition     = aws_kms_key.storage.enable_key_rotation == true
    error_message = "storage KMS key must rotate"
  }
}

run "rotation_off_fails" {
  command = plan

  variables {
    aws_region           = "ap-southeast-2"
    name                 = "ch-staging"
    enable_key_rotation  = false
  }

  expect_failures = [var.enable_key_rotation]
}

run "wrong_region_fails" {
  command = plan

  variables {
    aws_region = "us-east-1"
    name       = "ch-staging"
  }

  expect_failures = [var.aws_region]
}
