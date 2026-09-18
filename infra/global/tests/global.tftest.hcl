mock_provider "cloudflare" {}

run "staging_happy" {
  command = plan

  variables {
    cloudflare_account_id = "00000000000000000000000000000000"
    environment           = "staging"
    zone_name             = "communityhub-staging.net"
  }

  assert {
    condition     = module.zone.zone_name == "communityhub-staging.net"
    error_message = "global staging zone must be the dedicated zone"
  }

  assert {
    condition     = length(regexall("(?m)^\\s*environment\\s*=\\s*\"staging\"", file("${path.module}/env/staging.tfvars"))) > 0
    error_message = "env/staging.tfvars must set environment = \"staging\""
  }

  assert {
    condition     = length(regexall("(?m)^\\s*zone_name\\s*=\\s*\"communityhub-staging.net\"", file("${path.module}/env/staging.tfvars"))) > 0
    error_message = "env/staging.tfvars must name the dedicated staging zone"
  }
}

run "prod_tfvars" {
  command = plan

  variables {
    cloudflare_account_id = "00000000000000000000000000000000"
    environment           = "prod"
    zone_name             = "communityhub.one"
  }

  assert {
    condition     = module.zone.zone_name == "communityhub.one"
    error_message = "prod tfvars may name communityhub.one"
  }

  assert {
    condition     = length(regexall("(?m)^\\s*environment\\s*=\\s*\"prod\"", file("${path.module}/env/prod.tfvars"))) > 0
    error_message = "env/prod.tfvars must set environment = \"prod\""
  }
}

run "staging_apex_fails" {
  command = plan

  variables {
    cloudflare_account_id = "00000000000000000000000000000000"
    environment           = "staging"
    zone_name             = "communityhub.one"
  }

  expect_failures = [var.zone_name]
}
