mock_provider "aws" {}

run "staging_happy" {
  command = plan

  variables {
    aws_region                   = "ap-southeast-2"
    aws_account_id               = "123456789012"
    name                         = "ch-staging"
    public_subnet_id             = "subnet-public"
    connector_security_group_id  = "sg-connector"
    tunnel_token                 = "mock-token"
  }

  assert {
    condition     = strcontains(var.cloudflared_image, "sha256:")
    error_message = "cloudflared image must be pinned by digest"
  }

  assert {
    condition     = aws_cloudwatch_log_group.connector.retention_in_days >= 1
    error_message = "log retention must be >= 1"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.execution.policy, "secretsmanager:GetSecretValue")
    error_message = "execution role must read the tunnel token secret"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.execution.policy, "logs:CreateLogStream")
    error_message = "execution role must write log streams"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.execution.policy, "logs:PutLogEvents")
    error_message = "execution role must put log events"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.execution.policy, "\"Action\":\"*\"")
    error_message = "execution role must not contain Action *"
  }

  assert {
    condition     = !strcontains(aws_iam_role_policy.execution.policy, "kms:Decrypt")
    error_message = "execution role must not get kms:Decrypt unless a customer key is set"
  }

  assert {
    condition     = aws_ecs_task_definition.this.task_role_arn == null
    error_message = "task role must be omitted; cloudflared needs no AWS API"
  }
}

run "customer_kms_decrypt" {
  command = plan

  variables {
    aws_region                   = "ap-southeast-2"
    aws_account_id               = "123456789012"
    name                         = "ch-staging"
    public_subnet_id             = "subnet-public"
    connector_security_group_id  = "sg-connector"
    tunnel_token                 = "mock-token"
    kms_key_arn                  = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.execution.policy, "kms:Decrypt")
    error_message = "execution role must decrypt when the secret uses a customer key"
  }

  assert {
    condition     = strcontains(aws_iam_role_policy.execution.policy, "arn:aws:kms:ap-southeast-2:123456789012:key/mock")
    error_message = "kms:Decrypt must be scoped to the customer key"
  }
}

run "unpinned_image_fails" {
  command = plan

  variables {
    aws_region                   = "ap-southeast-2"
    aws_account_id               = "123456789012"
    name                         = "ch-staging"
    public_subnet_id             = "subnet-public"
    connector_security_group_id  = "sg-connector"
    tunnel_token                 = "mock-token"
    cloudflared_image            = "cloudflare/cloudflared:latest"
  }

  expect_failures = [var.cloudflared_image]
}

run "zero_retention_fails" {
  command = plan

  variables {
    aws_region                   = "ap-southeast-2"
    aws_account_id               = "123456789012"
    name                         = "ch-staging"
    public_subnet_id             = "subnet-public"
    connector_security_group_id  = "sg-connector"
    tunnel_token                 = "mock-token"
    log_retention_days           = 0
  }

  expect_failures = [var.log_retention_days]
}

run "wrong_region_fails" {
  command = plan

  variables {
    aws_region                   = "us-east-1"
    aws_account_id               = "123456789012"
    name                         = "ch-staging"
    public_subnet_id             = "subnet-public"
    connector_security_group_id  = "sg-connector"
    tunnel_token                 = "mock-token"
  }

  expect_failures = [var.aws_region]
}
