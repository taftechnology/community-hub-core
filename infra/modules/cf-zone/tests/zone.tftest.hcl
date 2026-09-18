mock_provider "cloudflare" {}

run "staging_happy" {
  command = plan

  variables {
    account_id  = "00000000000000000000000000000000"
    environment = "staging"
    zone_name   = "ch-staging.test"
  }

  assert {
    condition     = cloudflare_zone.this.name == "ch-staging.test"
    error_message = "zone name must match the configured value"
  }

  assert {
    condition     = cloudflare_zone.this.type == "full"
    error_message = "staging zone must be a full zone"
  }
}

run "prod_apex_allowed" {
  command = plan

  variables {
    account_id  = "00000000000000000000000000000000"
    environment = "prod"
    zone_name   = "communityhub.one"
  }

  assert {
    condition     = cloudflare_zone.this.name == "communityhub.one"
    error_message = "prod may name communityhub.one"
  }
}

run "apex_case_dot_fails" {
  command = plan

  variables {
    account_id  = "00000000000000000000000000000000"
    environment = "staging"
    zone_name   = "CommunityHub.one."
  }

  expect_failures = [var.zone_name]
}

run "subdomain_fails" {
  command = plan

  variables {
    account_id  = "00000000000000000000000000000000"
    environment = "staging"
    zone_name   = "staging.communityhub.one"
  }

  expect_failures = [var.zone_name]
}
