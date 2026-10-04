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

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:ap-southeast-2:123456789012:certificate/mock"
      domain_validation_options = [
        {
          domain_name           = "au.api.example"
          resource_record_name  = "_x.au.api.example."
          resource_record_type  = "CNAME"
          resource_record_value = "_x.acm-validations.aws."
        },
      ]
    }
  }

  mock_resource "aws_apigatewayv2_domain_name" {
    defaults = {
      id = "domain-mock"
      domain_name_configuration = {
        target_domain_name = "d-mock.execute-api.ap-southeast-2.amazonaws.com"
        hosted_zone_id     = "ZMOCK"
      }
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
    alert_email           = "alerts@example.com"
    staging_zone_id       = "ZSTAGING"
    create_public_zone    = false
    attach_public_dns     = true
  }

  override_resource {
    target = module.ingress.aws_apigatewayv2_api.tenant
    values = {
      id = "api-tenant"
    }
    override_during = plan
  }

  override_resource {
    target = module.ingress.aws_apigatewayv2_api.ops
    values = {
      id = "api-ops"
    }
    override_during = plan
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
    condition     = !strcontains(output.storage_key_policy, "ch-staging-task")
    error_message = "storage key policy must not reference the envelope task role"
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
        statement.Principal.AWS == "arn:aws:iam::123456789012:role/ch-staging-task"
        if statement.Sid != "Admin"
      ]) &&
      !strcontains(output.envelope_key_policy, "aws:SourceVpce")
    )
    error_message = "default staging plan must bind four cryptographic statements to the task role and must not contain aws:SourceVpce"
  }

  assert {
    condition     = module.envelope.endpoint_id == null
    error_message = "endpoint_id must be null when the KMS endpoint is off"
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(output.execution_policy).Statement :
      alltrue([for action in statement.Action : !strcontains(action, "kms:")])
    ])
    error_message = "service execution log policy must not call kms"
  }

  assert {
    condition     = !strcontains(file("${path.module}/env/staging.tfvars"), "policy_probe_action")
    error_message = "env/staging.tfvars must not set policy_probe_action"
  }

  assert {
    condition     = !strcontains(file("${path.module}/env/prod.tfvars"), "policy_probe_action")
    error_message = "env/prod.tfvars must not set policy_probe_action"
  }

  assert {
    condition     = var.enable_budgets == false
    error_message = "enable_budgets must default to false when unset"
  }

  assert {
    condition     = module.ingress.api_hostname == "au.api.communityhub-staging.net" && module.ingress.ecs_service_desired_count == 0
    error_message = "staging root attaches the staging names and plans no ECS service"
  }
}

run "budgets_on" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    environment    = "staging"
    enable_budgets     = true
    alert_email        = "alerts@example.com"
    staging_zone_id    = "ZSTAGING"
    create_public_zone = false
    attach_public_dns  = true
  }
}

run "staging_endpoint_on" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    environment           = "staging"
    deletion_protection   = false
    backup_retention_days = 0
    enable_kms_endpoint   = true
    alert_email           = "alerts@example.com"
    staging_zone_id       = "ZSTAGING"
    create_public_zone    = false
    attach_public_dns     = true
  }

  override_resource {
    target = module.envelope.aws_vpc_endpoint.kms[0]
    values = {
      id = "vpce-mock"
    }
    override_during = plan
  }

  assert {
    condition     = module.envelope.endpoint_id == "vpce-mock"
    error_message = "envelope endpoint id must be the mocked VPC endpoint id"
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(output.envelope_key_policy).Statement :
      statement.Condition.StringEquals["aws:SourceVpce"] == "vpce-mock"
      if statement.Sid != "Admin"
    ])
    error_message = "cryptographic statements must bind aws:SourceVpce to the VPC endpoint"
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
    enable_kms_endpoint   = true
    alert_email           = "alerts@example.com"
    create_public_zone    = true
    attach_public_dns     = false
  }

  assert {
    condition     = length(regexall("(?m)^\\s*environment\\s*=\\s*\"prod\"", file("${path.module}/env/prod.tfvars"))) > 0
    error_message = "env/prod.tfvars must set environment = \"prod\""
  }

  assert {
    condition     = length(regexall("(?m)^\\s*enable_kms_endpoint\\s*=\\s*true", file("${path.module}/env/prod.tfvars"))) > 0
    error_message = "env/prod.tfvars must set enable_kms_endpoint = true"
  }

  assert {
    condition     = module.ingress.api_hostname == "au.api.communityhub.one" && module.ingress.ecs_service_desired_count == 0
    error_message = "production root creates hostnames for communityhub.one and plans no ECS service"
  }
}

run "prod_endpoint_off_fails" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    environment           = "prod"
    enable_kms_endpoint   = false
    deletion_protection   = true
    backup_retention_days = 7
    alert_email           = "alerts@example.com"
    create_public_zone    = true
    attach_public_dns     = false
  }

  expect_failures = [
    check.prod_kms_endpoint,
    terraform_data.prod_kms_endpoint,
  ]
}

run "wrong_region_fails" {
  command = plan

  variables {
    aws_region     = "us-east-1"
    aws_account_id = "123456789012"
    environment        = "staging"
    alert_email        = "alerts@example.com"
    staging_zone_id    = "ZSTAGING"
    create_public_zone = false
    attach_public_dns  = true
  }

  expect_failures = [var.aws_region]
}

run "staging_without_zone_id_fails" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    environment           = "staging"
    deletion_protection   = false
    backup_retention_days = 0
    alert_email           = "alerts@example.com"
    staging_zone_id       = null
    create_public_zone    = false
    attach_public_dns     = false
  }

  expect_failures = [
    check.staging_zone,
    terraform_data.staging_zone,
  ]
}
