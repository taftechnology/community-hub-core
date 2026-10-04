mock_provider "aws" {
  override_during = plan
}

run "happy" {
  command = plan

  variables {
    aws_region          = "ap-southeast-2"
    aws_account_id      = "123456789012"
    name                = "ch-staging"
    environment         = "staging"
    project             = "community-hub"
    enable_key_rotation = true
  }

  assert {
    condition = one([
      for statement in jsondecode(aws_kms_key.secrets.policy).Statement : statement
      if statement.Sid == "SecretsManagerUse"
    ]).Principal.AWS == "arn:aws:iam::123456789012:root"
    error_message = "secrets key use statement principal must be the account root"
  }

  assert {
    condition = one([
      for statement in jsondecode(aws_kms_key.secrets.policy).Statement : statement
      if statement.Sid == "SecretsManagerUse"
    ]).Action == ["kms:Decrypt", "kms:GenerateDataKey"]
    error_message = "secrets key use statement must allow only kms:Decrypt and kms:GenerateDataKey"
  }

  assert {
    condition = (
      strcontains(aws_kms_key.secrets.policy, "secretsmanager.ap-southeast-2.amazonaws.com") &&
      strcontains(aws_kms_key.secrets.policy, "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-app-??????") &&
      strcontains(aws_kms_key.secrets.policy, "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-??????") &&
      strcontains(aws_kms_key.secrets.policy, "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-platform-??????")
    )
    error_message = "secrets key policy must bind Secrets Manager in ap-southeast-2 and the three secret ARN patterns"
  }

  assert {
    condition = (
      !strcontains(aws_kms_key.secrets.policy, "role/ch-staging-task") &&
      !strcontains(aws_kms_key.secrets.policy, "role/ch-staging-execution")
    )
    error_message = "secrets key policy must not name the task or execution role"
  }

  assert {
    condition = (
      aws_secretsmanager_secret_version.app.secret_string == null &&
      aws_secretsmanager_secret_version.identity.secret_string == null &&
      aws_secretsmanager_secret_version.platform.secret_string == null
    )
    error_message = "secret versions must not set secret_string"
  }

  assert {
    condition = (
      aws_kms_key.secrets.tags["environment"] == "staging" &&
      aws_kms_key.secrets.tags["project"] == "community-hub"
    )
    error_message = "secrets key tags must be environment=staging and project=community-hub"
  }
}

run "rotation_off_fails" {
  command = plan

  variables {
    aws_region          = "ap-southeast-2"
    aws_account_id      = "123456789012"
    name                = "ch-staging"
    environment         = "staging"
    project             = "community-hub"
    enable_key_rotation = false
  }

  expect_failures = [var.enable_key_rotation]
}
