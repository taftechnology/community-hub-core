mock_provider "aws" {
  override_during = plan

  mock_resource "aws_db_instance" {
    defaults = {
      address = "ch-staging-postgres.xxxxx.ap-southeast-2.rds.amazonaws.com"
      port    = 5432
    }
  }

  mock_resource "aws_security_group" {
    defaults = {
      id = "sg-mock"
    }
  }

  mock_resource "aws_vpc_endpoint" {
    defaults = {
      id = "vpce-mock"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn                 = "arn:aws:iam::123456789012:role/mock"
      id                  = "mock-role"
      managed_policy_arns = null
    }
  }
}

run "staging_happy" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    environment           = "staging"
    deletion_protection   = false
    backup_retention_days = 0
  }

  assert {
    condition     = length(regexall("(?m)^\\s*environment\\s*=\\s*\"staging\"", file("${path.module}/env/staging.tfvars"))) > 0
    error_message = "env/staging.tfvars must set environment = \"staging\""
  }

  assert {
    condition = (
      length(jsondecode(output.storage_key_policy).Statement) == 1 &&
      jsondecode(output.storage_key_policy).Statement[0].Sid == "Enable IAM User Permissions" &&
      jsondecode(output.storage_key_policy).Statement[0].Principal.AWS == "arn:aws:iam::123456789012:root" &&
      jsondecode(output.storage_key_policy).Statement[0].Action == "kms:*" &&
      jsondecode(output.storage_key_policy).Statement[0].Resource == "*"
    )
    error_message = "storage key policy must be the single account-root kms:* statement"
  }

  assert {
    condition     = !strcontains(output.storage_key_policy, "kms-broker-task")
    error_message = "storage key policy must not reference the kms-broker task role"
  }

  assert {
    condition = (
      length(jsondecode(output.envelope_key_policy).Statement) == 5 &&
      length([
        for statement in jsondecode(output.envelope_key_policy).Statement : statement
        if statement.Sid != "Admin"
      ]) == 4 &&
      alltrue([
        for statement in jsondecode(output.envelope_key_policy).Statement :
        statement.Principal.AWS == "arn:aws:iam::123456789012:role/ch-staging-kms-broker-task" &&
        statement.Condition.StringEquals["aws:SourceVpce"] == "vpce-mock"
        if statement.Sid != "Admin"
      ])
    )
    error_message = "envelope key policy must bind each cryptographic statement to the broker task role and the VPC endpoint"
  }

  assert {
    condition     = !strcontains(output.envelope_key_policy, "connector-execution")
    error_message = "envelope key policy must not reference the connector execution role"
  }

  override_resource {
    target = module.envelope.aws_vpc_endpoint.kms
    values = {
      id = "vpce-mock"
    }
    override_during = plan
  }

  assert {
    condition     = module.envelope.endpoint_id == "vpce-mock"
    error_message = "envelope key policy must reference the mocked VPC endpoint id only"
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(output.broker_execution_policy).Statement :
      alltrue([for action in statement.Action : !strcontains(action, "kms:")])
    ])
    error_message = "broker execution policy must not call kms"
  }

  assert {
    condition     = !strcontains(file("${path.module}/env/staging.tfvars"), "policy_probe_action")
    error_message = "env/staging.tfvars must not set policy_probe_action"
  }

  assert {
    condition     = !strcontains(file("${path.module}/env/prod.tfvars"), "policy_probe_action")
    error_message = "env/prod.tfvars must not set policy_probe_action"
  }
}

run "prod_tfvars" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    environment           = "prod"
    deletion_protection   = true
    backup_retention_days = 7
  }

  assert {
    condition     = length(regexall("(?m)^\\s*environment\\s*=\\s*\"prod\"", file("${path.module}/env/prod.tfvars"))) > 0
    error_message = "env/prod.tfvars must set environment = \"prod\""
  }
}

run "wrong_region_fails" {
  command = plan

  variables {
    aws_region     = "us-east-1"
    aws_account_id = "123456789012"
    environment    = "staging"
  }

  expect_failures = [var.aws_region]
}
