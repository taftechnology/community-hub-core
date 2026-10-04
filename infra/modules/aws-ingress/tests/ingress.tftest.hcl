mock_provider "aws" {
  override_during = plan

  mock_resource "aws_ecr_repository" {
    defaults = {
      id  = "ecr-service"
      arn = "arn:aws:ecr:ap-southeast-2:123456789012:repository/ch-staging/service"
    }
  }
}

run "staging_unset" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    name           = "ch-staging"
    environment    = "staging"
    project        = "community-hub"
    service_image  = null
  }

  assert {
    condition     = aws_ecr_repository.service.image_tag_mutability == "IMMUTABLE" && aws_ecr_repository.service.force_delete == false && aws_ecr_repository.service.image_scanning_configuration[0].scan_on_push == true
    error_message = "ECR tags are immutable, scan on push is on, and the repository is not force-deleted"
  }

  assert {
    condition     = strcontains(aws_ecr_lifecycle_policy.service.policy, "\"tagStatus\":\"tagged\"") && strcontains(aws_ecr_lifecycle_policy.service.policy, "\"countNumber\":10") && !strcontains(aws_ecr_lifecycle_policy.service.policy, "untagged")
    error_message = "lifecycle policy keeps 10 tagged images and does not expire untagged manifests"
  }
}

run "image_tag_fails" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    name           = "ch-staging"
    environment    = "staging"
    project        = "community-hub"
    service_image  = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service:latest"
  }

  expect_failures = [var.service_image]
}

run "foreign_registry_fails" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    name           = "ch-staging"
    environment    = "staging"
    project        = "community-hub"
    service_image  = "public.ecr.aws/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  expect_failures = [var.service_image]
}

run "other_region_fails" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    name           = "ch-staging"
    environment    = "staging"
    project        = "community-hub"
    service_image  = "123456789012.dkr.ecr.us-east-1.amazonaws.com/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  expect_failures = [var.service_image]
}

run "uppercase_digest_fails" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    name           = "ch-staging"
    environment    = "staging"
    project        = "community-hub"
    service_image  = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service@sha256:0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  expect_failures = [var.service_image]
}

run "trailing_suffix_fails" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    name           = "ch-staging"
    environment    = "staging"
    project        = "community-hub"
    service_image  = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef-extra"
  }

  expect_failures = [var.service_image]
}
