variable "account_id" {
  type        = string
  description = "Cloudflare account ID."
}

variable "name" {
  type        = string
  description = "Name prefix. The service name is this value plus -kms-broker."
}

variable "tunnel_id" {
  type        = string
  description = "Broker Cloudflare Tunnel ID. The service is reached at 127.0.0.1 from cloudflared."
}
