mock_provider "aws" {
  mock_resource "aws_s3_bucket" {
    defaults = {
      id  = "ch-tfstate-mock"
      arn = "arn:aws:s3:::ch-tfstate-mock"
    }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      id  = "mock-kms-key"
      arn = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
    }
  }
}

run "staging_happy" {
  command = plan

  variables {
    aws_region  = "ap-southeast-2"
    environment = "staging"
  }

  assert {
    condition     = aws_s3_bucket.state.bucket == "ch-tfstate-staging-au"
    error_message = "staging state bucket name must be ch-tfstate-staging-au"
  }

  assert {
    condition = (
      aws_s3_bucket.state.tags["environment"] == "staging" &&
      aws_s3_bucket.state.tags["project"] == "community-hub"
    )
    error_message = "state bucket tags must be environment=staging and project=community-hub"
  }

  assert {
    condition     = aws_kms_key.state.region == "ap-southeast-2"
    error_message = "KMS key region argument must be ap-southeast-2"
  }

  assert {
    condition     = strcontains(aws_s3_bucket_policy.state.policy, "aws:SecureTransport")
    error_message = "bucket policy must deny non-TLS"
  }

  assert {
    condition     = aws_kms_key.state.enable_key_rotation == true
    error_message = "state KMS key must rotate"
  }

  assert {
    condition     = aws_s3_bucket_versioning.state.versioning_configuration[0].status == "Enabled"
    error_message = "state bucket versioning must be enabled"
  }

  assert {
    condition = (
      aws_s3_bucket_public_access_block.state.block_public_acls
      && aws_s3_bucket_public_access_block.state.block_public_policy
      && aws_s3_bucket_public_access_block.state.ignore_public_acls
      && aws_s3_bucket_public_access_block.state.restrict_public_buckets
    )
    error_message = "state bucket must block public access"
  }

  assert {
    condition     = length(regexall("(?m)^\\s*environment\\s*=\\s*\"staging\"", file("${path.module}/env/staging.tfvars"))) > 0
    error_message = "env/staging.tfvars must set environment = \"staging\""
  }

  assert {
    condition     = length(regexall("(?m)^\\s*aws_region\\s*=\\s*\"ap-southeast-2\"", file("${path.module}/env/staging.tfvars"))) > 0
    error_message = "env/staging.tfvars must set aws_region = \"ap-southeast-2\""
  }
}

run "prod_tfvars" {
  command = plan

  variables {
    aws_region  = "ap-southeast-2"
    environment = "prod"
  }

  assert {
    condition     = aws_s3_bucket.state.bucket == "ch-tfstate-prod-au"
    error_message = "prod state bucket name must be ch-tfstate-prod-au"
  }

  assert {
    condition     = aws_kms_key.state.enable_key_rotation == true
    error_message = "prod state KMS key must rotate"
  }

  assert {
    condition     = length(regexall("(?m)^\\s*environment\\s*=\\s*\"prod\"", file("${path.module}/env/prod.tfvars"))) > 0
    error_message = "env/prod.tfvars must set environment = \"prod\""
  }

  assert {
    condition     = length(regexall("(?m)^\\s*aws_region\\s*=\\s*\"ap-southeast-2\"", file("${path.module}/env/prod.tfvars"))) > 0
    error_message = "env/prod.tfvars must set aws_region = \"ap-southeast-2\""
  }
}

run "wrong_region_fails" {
  command = plan

  variables {
    aws_region  = "us-east-1"
    environment = "staging"
  }

  expect_failures = [var.aws_region]
}
