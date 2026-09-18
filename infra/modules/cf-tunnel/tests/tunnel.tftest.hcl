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
}

run "staging_happy" {
  command = plan

  variables {
    account_id = "00000000000000000000000000000000"
    name       = "ch-staging-au"
  }

  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared.this.account_id == "00000000000000000000000000000000"
    error_message = "tunnel account_id must be the configured account"
  }

  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared.this.name == "ch-staging-au"
    error_message = "tunnel name must match the module input"
  }

  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared.this.config_src == "cloudflare"
    error_message = "tunnel must be remotely managed (config_src = cloudflare)"
  }
}
