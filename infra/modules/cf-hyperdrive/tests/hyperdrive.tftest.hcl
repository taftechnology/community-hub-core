mock_provider "cloudflare" {}

run "disabled_plans_without_password" {
  command = plan

  variables {
    account_id         = "00000000000000000000000000000000"
    name               = "ch-staging"
    service_id         = "svc-mock"
    enable_hyperdrive  = false
  }

  assert {
    condition     = length(cloudflare_hyperdrive_config.this) == 0
    error_message = "enable_hyperdrive = false must not create Hyperdrive"
  }
}

run "enabled_uses_service_id" {
  command = plan

  variables {
    account_id         = "00000000000000000000000000000000"
    name               = "ch-staging"
    service_id         = "svc-mock"
    enable_hyperdrive  = true
    origin_password    = "mock-app-role-password"
  }

  assert {
    condition     = cloudflare_hyperdrive_config.this[0].origin.service_id == "svc-mock"
    error_message = "Hyperdrive origin must be the VPC service_id"
  }

  assert {
    condition     = cloudflare_hyperdrive_config.this[0].caching.disabled == true
    error_message = "Hyperdrive caching must be disabled"
  }
}

run "enabled_without_password_fails" {
  command = plan

  variables {
    account_id         = "00000000000000000000000000000000"
    name               = "ch-staging"
    service_id         = "svc-mock"
    enable_hyperdrive  = true
    origin_password    = null
  }

  expect_failures = [terraform_data.hyperdrive_password]
}

run "caching_enabled_fails" {
  command = plan

  variables {
    account_id         = "00000000000000000000000000000000"
    name               = "ch-staging"
    service_id         = "svc-mock"
    caching_disabled   = false
  }

  expect_failures = [var.caching_disabled]
}

run "mtls_with_service_fails" {
  command = plan

  variables {
    account_id = "00000000000000000000000000000000"
    name       = "ch-staging"
    service_id = "svc-mock"
    use_mtls   = true
  }

  expect_failures = [var.use_mtls]
}
