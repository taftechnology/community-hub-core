mock_provider "cloudflare" {}

run "staging_happy" {
  command = plan

  variables {
    zone_id  = "00000000000000000000000000000000"
    hostname = "au.api.ch-staging.test"
  }

  assert {
    condition     = cloudflare_regional_hostname.this.region_key == "au"
    error_message = "regional hostname must use region_key au"
  }

  assert {
    condition     = cloudflare_regional_hostname.this.hostname == "au.api.ch-staging.test"
    error_message = "regional hostname must match the configured hostname"
  }
}

run "wrong_region_fails" {
  command = plan

  variables {
    zone_id     = "00000000000000000000000000000000"
    hostname    = "au.api.ch-staging.test"
    region_key  = "ee"
  }

  expect_failures = [var.region_key]
}
