mock_provider "aws" {
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

mock_provider "cloudflare" {
  mock_resource "cloudflare_zero_trust_tunnel_cloudflared" {
    defaults = {
      id = "00000000-0000-0000-0000-000000000001"
    }
  }

  mock_data "cloudflare_zero_trust_tunnel_cloudflared_token" {
    defaults = {
      token = "mock-tunnel-token"
    }
  }

  mock_resource "cloudflare_connectivity_directory_service" {
    defaults = {
      id         = "svc-mock"
      service_id = "svc-mock"
    }
  }
}

variables {
  region_key = "au"
}

run "staging_happy" {
  command = plan

  variables {
    aws_region                = "ap-southeast-2"
    aws_account_id            = "123456789012"
    cloudflare_account_id     = "00000000000000000000000000000000"
    environment               = "staging"
    cert_verification_mode    = "disabled"
    deletion_protection       = false
    backup_retention_days     = 0
    zone_id                   = "00000000000000000000000000000000"
    zone_name                 = "communityhub-staging.net"
    enable_hyperdrive         = false
    enable_regional_hostnames = false
  }

  assert {
    condition     = var.cert_verification_mode == "disabled"
    error_message = "staging TLS verification may be disabled"
  }

  assert {
    condition     = var.enable_hyperdrive == false
    error_message = "first apply must leave Hyperdrive disabled"
  }

  assert {
    condition     = length(regexall("(?m)^\\s*environment\\s*=\\s*\"staging\"", file("${path.module}/env/staging.tfvars"))) > 0
    error_message = "env/staging.tfvars must set environment = \"staging\""
  }

  assert {
    condition     = length(regexall("(?m)^\\s*cert_verification_mode\\s*=\\s*\"disabled\"", file("${path.module}/env/staging.tfvars"))) > 0
    error_message = "env/staging.tfvars must set cert_verification_mode = \"disabled\""
  }

  assert {
    condition     = can(regex("(?m)^\\s*region_key\\s*=\\s*\"au\"", file("${path.module}/env/staging.tfvars")))
    error_message = "env/staging.tfvars must set region_key = \"au\""
  }

  assert {
    condition     = module.broker_tunnel.tunnel_name == "ch-staging-au-kms"
    error_message = "broker tunnel name must be ch-staging-au-kms"
  }

  assert {
    condition     = module.broker_tunnel.tunnel_name != "ch-staging-au"
    error_message = "broker tunnel must not reuse the Postgres tunnel name"
  }

  assert {
    condition     = module.envelope.tunnel_secret_name == "ch-staging/kms-broker-tunnel-token"
    error_message = "broker tunnel secret name must be ch-staging/kms-broker-tunnel-token"
  }

  assert {
    condition     = !strcontains(file("${path.module}/../../modules/aws-kms-storage/main.tf"), "kms-broker-task")
    error_message = "storage key policy must not reference the kms-broker task role"
  }

  assert {
    condition = (
      module.envelope.task_role_name == "ch-staging-kms-broker-task" &&
      strcontains(file("${path.module}/../../modules/aws-kms-envelope/main.tf"), "\"aws:SourceVpce\"                 = aws_vpc_endpoint.kms.id") &&
      strcontains(file("${path.module}/../../modules/aws-kms-envelope/main.tf"), "kms:GenerateDataKey")
    )
    error_message = "envelope key policy must bind the broker task role, GenerateDataKey, and the VPC endpoint id"
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
    condition     = !strcontains(file("${path.module}/../../modules/aws-ecs-tunnel/main.tf"), "kms-broker-tunnel-token")
    error_message = "connector execution policy must not read the broker tunnel secret"
  }

  assert {
    condition = (
      !strcontains(file("${path.module}/../../modules/aws-kms-envelope/main.tf"), "/cloudflare-tunnel-token") &&
      strcontains(file("${path.module}/../../modules/aws-kms-envelope/main.tf"), "Sid      = \"GetBrokerTunnelToken\"") &&
      !strcontains(file("${path.module}/../../modules/aws-kms-envelope/main.tf"), "name = \"kms-broker-execution\"\n  role = aws_iam_role.execution.id\n  policy = jsonencode({\n    Version = \"2012-10-17\"\n    Statement = [\n      {\n        Sid      = \"GetBrokerTunnelToken\"\n        Effect   = \"Allow\"\n        Action   = [\"kms:")
    )
    error_message = "broker execution policy must not read the Postgres tunnel secret or call kms"
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
    condition     = strcontains(file("${path.module}/main.tf"), "tunnel_id              = module.tunnel.tunnel_id")
    error_message = "Workers VPC service must still use the Postgres tunnel id"
  }
}

run "probe_fails" {
  command = plan

  variables {
    aws_region                = "ap-southeast-2"
    aws_account_id            = "123456789012"
    cloudflare_account_id     = "00000000000000000000000000000000"
    environment               = "staging"
    cert_verification_mode    = "disabled"
    deletion_protection       = false
    backup_retention_days     = 0
    zone_id                   = "00000000000000000000000000000000"
    zone_name                 = "communityhub-staging.net"
    enable_hyperdrive         = false
    enable_regional_hostnames = false
    policy_probe_action       = "kms:CreateGrant"
  }

  expect_failures = [var.policy_probe_action]
}

run "prod_tfvars" {
  command = plan

  variables {
    aws_region                = "ap-southeast-2"
    aws_account_id            = "123456789012"
    cloudflare_account_id     = "00000000000000000000000000000000"
    environment               = "prod"
    cert_verification_mode    = "verify_full"
    deletion_protection       = true
    backup_retention_days     = 7
    zone_id                   = "00000000000000000000000000000000"
    zone_name                 = "communityhub.one"
    enable_hyperdrive         = false
    enable_regional_hostnames = false
  }

  assert {
    condition     = var.cert_verification_mode == "verify_full"
    error_message = "prod must use verify_full"
  }

  assert {
    condition     = length(regexall("(?m)^\\s*environment\\s*=\\s*\"prod\"", file("${path.module}/env/prod.tfvars"))) > 0
    error_message = "env/prod.tfvars must set environment = \"prod\""
  }

  assert {
    condition     = length(regexall("(?m)^\\s*cert_verification_mode\\s*=\\s*\"verify_full\"", file("${path.module}/env/prod.tfvars"))) > 0
    error_message = "env/prod.tfvars must set cert_verification_mode = \"verify_full\""
  }

  assert {
    condition     = can(regex("(?m)^\\s*region_key\\s*=\\s*\"au\"", file("${path.module}/env/prod.tfvars")))
    error_message = "env/prod.tfvars must set region_key = \"au\""
  }
}

run "prod_disabled_tls_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    cloudflare_account_id  = "00000000000000000000000000000000"
    environment            = "prod"
    cert_verification_mode = "disabled"
    deletion_protection    = true
    backup_retention_days  = 7
    zone_id                = "00000000000000000000000000000000"
    zone_name              = "communityhub.one"
  }

  expect_failures = [
    check.prod_tls,
    terraform_data.prod_tls,
  ]
}

run "wrong_region_fails" {
  command = plan

  variables {
    aws_region             = "us-east-1"
    aws_account_id         = "123456789012"
    cloudflare_account_id  = "00000000000000000000000000000000"
    environment            = "staging"
    cert_verification_mode = "disabled"
    zone_id                = "00000000000000000000000000000000"
    zone_name              = "communityhub-staging.net"
  }

  expect_failures = [var.aws_region]
}

run "wrong_region_key_fails" {
  command = plan

  variables {
    aws_region                = "ap-southeast-2"
    aws_account_id            = "123456789012"
    cloudflare_account_id     = "00000000000000000000000000000000"
    environment               = "staging"
    cert_verification_mode    = "disabled"
    deletion_protection       = false
    backup_retention_days     = 0
    zone_id                   = "00000000000000000000000000000000"
    zone_name                 = "communityhub-staging.net"
    enable_hyperdrive         = false
    enable_regional_hostnames = false
    region_key                = "ee"
  }

  expect_failures = [var.region_key]
}
