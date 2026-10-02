mock_provider "cloudflare" {
  override_during = plan
}

run "http_loopback" {
  command = plan

  variables {
    account_id = "00000000000000000000000000000000"
    name       = "ch-staging"
    tunnel_id  = "00000000-0000-0000-0000-000000000099"
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.broker.type == "http"
    error_message = "VPC service must be http"
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.broker.http_port == 8080
    error_message = "VPC service must listen on 8080"
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.broker.https_port == null
    error_message = "https_port must be null"
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.broker.tls_settings == null
    error_message = "tls_settings must be absent"
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.broker.host.ipv4 == "127.0.0.1"
    error_message = "host ipv4 must be loopback"
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.broker.host.hostname == null
    error_message = "host must not set a hostname"
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.broker.host.network.tunnel_id == var.tunnel_id
    error_message = "host.network.tunnel_id must equal the tunnel variable"
  }

  assert {
    condition     = cloudflare_connectivity_directory_service.broker.name == "${var.name}-kms-broker"
    error_message = "VPC service name must be the cell name plus -kms-broker"
  }
}
