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

run "happy" {
  command = apply

  variables {
    account_id = "00000000000000000000000000000000"
    name       = "ch-staging-au-kms-broker"
  }

  assert {
    condition     = cloudflare_zero_trust_tunnel_cloudflared.this.name == var.name
    error_message = "tunnel name must match the module input"
  }

  assert {
    condition = (
      length(cloudflare_zero_trust_tunnel_cloudflared_config.this.config.ingress) == 1
      && cloudflare_zero_trust_tunnel_cloudflared_config.this.config.ingress[0].service == "http://127.0.0.1:8080"
      && cloudflare_zero_trust_tunnel_cloudflared_config.this.config.ingress[0].hostname == null
    )
    error_message = "ingress must be a single catch-all to http://127.0.0.1:8080 with a null hostname"
  }

  assert {
    condition = (
      !strcontains(file("${path.module}/main.tf"), "hostname")
      && !strcontains(file("${path.module}/main.tf"), "cloudflare_record")
      && !strcontains(file("${path.module}/main.tf"), "cloudflare_dns_record")
      && !strcontains(file("${path.module}/main.tf"), "cfargotunnel.com")
    )
    error_message = "main.tf must not declare a hostname, a DNS record, or a cfargotunnel.com route"
  }

  assert {
    condition = alltrue([
      for rule in cloudflare_zero_trust_tunnel_cloudflared_config.this.config.ingress :
      !strcontains(lower(rule.service), "postgres")
      && !strcontains(lower(rule.service), "rds.amazonaws.com")
    ])
    error_message = "ingress must not reference Postgres or an RDS hostname"
  }

  assert {
    condition     = length(output.tunnel_token) > 0
    error_message = "tunnel_token output must exist"
  }

  assert {
    condition = (
      strcontains(file("${path.root}/outputs.tf"), "output \"tunnel_token\"")
      && strcontains(file("${path.root}/outputs.tf"), "sensitive   = true")
    )
    error_message = "tunnel_token output must be marked sensitive"
  }
}
