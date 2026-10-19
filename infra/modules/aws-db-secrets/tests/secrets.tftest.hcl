mock_provider "aws" {
  override_during = plan

  mock_resource "aws_kms_key" {
    defaults = {
      arn = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-secrets"
    }
  }
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
    error_message = "secrets key policy must bind Secrets Manager in ap-southeast-2 and the five secret ARN patterns"
  }

  assert {
    condition = (
      !strcontains(aws_kms_key.secrets.policy, "role/ch-staging-task") &&
      !strcontains(aws_kms_key.secrets.policy, "role/ch-staging-execution")
    )
    error_message = "secrets key policy must not name the task or execution role"
  }

  assert {
    condition     = strcontains(aws_kms_key.secrets.policy, "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-provision-owner-??????")
    error_message = "secrets key policy must bind the provision-owner secret ARN pattern"
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

  assert {
    condition = (
      aws_secretsmanager_secret.billing.name == "ch-staging-billing" &&
      aws_secretsmanager_secret.billing.kms_key_id == aws_kms_key.secrets.arn &&
      aws_secretsmanager_secret.billing.region == "ap-southeast-2"
    )
    error_message = "billing secret name must be ch-staging-billing in ap-southeast-2 using the secrets KMS key"
  }

  assert {
    condition = (
      !strcontains(file("${path.module}/main.tf"), "\"aws_secretsmanager_secret_version\" \"billing\"") &&
      !strcontains(file("${path.module}/main.tf"), "aws_secretsmanager_secret.billing.")
    )
    error_message = "billing secret must have no version resource"
  }

  assert {
    condition = one([
      for statement in jsondecode(aws_kms_key.secrets.policy).Statement : statement
      if statement.Sid == "SecretsManagerUse"
      ]).Condition.StringLike["kms:EncryptionContext:SecretARN"] == [
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-app-??????",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-??????",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-platform-??????",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-provision-owner-??????",
      "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-billing-??????",
    ]
    error_message = "secrets key policy must bind exactly the five secret ARN patterns"
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
