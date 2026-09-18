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

run "staging_happy" {
  command = plan

  variables {
    aws_region               = "ap-southeast-2"
    aws_account_id           = "123456789012"
    cloudflare_account_id    = "00000000000000000000000000000000"
    environment              = "staging"
    cert_verification_mode   = "disabled"
    deletion_protection      = false
    backup_retention_days    = 0
    zone_id                  = "00000000000000000000000000000000"
    zone_name                = "communityhub-staging.net"
    enable_hyperdrive        = false
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
}

run "prod_tfvars" {
  command = plan

  variables {
    aws_region               = "ap-southeast-2"
    aws_account_id           = "123456789012"
    cloudflare_account_id    = "00000000000000000000000000000000"
    environment              = "prod"
    cert_verification_mode   = "verify_full"
    deletion_protection      = true
    backup_retention_days    = 7
    zone_id                  = "00000000000000000000000000000000"
    zone_name                = "communityhub.one"
    enable_hyperdrive        = false
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
}

run "prod_disabled_tls_fails" {
  command = plan

  variables {
    aws_region               = "ap-southeast-2"
    aws_account_id           = "123456789012"
    cloudflare_account_id    = "00000000000000000000000000000000"
    environment              = "prod"
    cert_verification_mode   = "disabled"
    deletion_protection      = true
    backup_retention_days    = 7
    zone_id                  = "00000000000000000000000000000000"
    zone_name                = "communityhub.one"
  }

  expect_failures = [
    check.prod_tls,
    terraform_data.prod_tls,
  ]
}

run "wrong_region_fails" {
  command = plan

  variables {
    aws_region               = "us-east-1"
    aws_account_id           = "123456789012"
    cloudflare_account_id    = "00000000000000000000000000000000"
    environment              = "staging"
    cert_verification_mode   = "disabled"
    zone_id                  = "00000000000000000000000000000000"
    zone_name                = "communityhub-staging.net"
  }

  expect_failures = [var.aws_region]
}
