mock_provider "cloudflare" {}

run "staging_happy" {
  command = plan

  variables {
    account_id              = "00000000000000000000000000000000"
    name                    = "ch-staging-postgres"
    tunnel_id               = "00000000-0000-0000-0000-000000000001"
    rds_hostname            = "ch-staging-postgres.xxxxx.ap-southeast-2.rds.amazonaws.com"
    cert_verification_mode  = "disabled"
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.this.type == "tcp"
    error_message = "VPC service must be tcp"
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.this.app_protocol == "postgresql"
    error_message = "VPC service app_protocol must be postgresql"
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.this.tcp_port == 5432
    error_message = "VPC service must listen on 5432"
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.this.host.hostname == "ch-staging-postgres.xxxxx.ap-southeast-2.rds.amazonaws.com"
    error_message = "VPC service host must be the RDS hostname"
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.this.tls_settings.cert_verification_mode == "disabled"
    error_message = "staging may disable TLS verification on the VPC service"
  }
}
