resource "cloudflare_connectivity_directory_service" "this" {
  account_id   = var.account_id
  name         = var.name
  type         = "tcp"
  tcp_port     = 5432
  app_protocol = "postgresql"

  host = {
    hostname = var.rds_hostname
    resolver_network = {
      tunnel_id = var.tunnel_id
    }
  }

  tls_settings = {
    cert_verification_mode = var.cert_verification_mode
  }
}
