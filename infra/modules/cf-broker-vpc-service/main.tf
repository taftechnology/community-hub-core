resource "cloudflare_connectivity_directory_service" "broker" {
  account_id = var.account_id
  name       = "${var.name}-kms-broker"
  type       = "http"
  http_port  = 8080

  host = {
    ipv4 = "127.0.0.1"
    network = {
      tunnel_id = var.tunnel_id
    }
  }
}
