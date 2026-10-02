output "tunnel_id" {
  description = "Cloudflare Tunnel ID."
  value       = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

output "tunnel_name" {
  description = "Cloudflare Tunnel name."
  value       = var.name
}

output "tunnel_token" {
  description = "Token used by cloudflared. Top-tier secret — Secrets Manager only, never a task environment variable."
  value       = data.cloudflare_zero_trust_tunnel_cloudflared_token.this.token
  sensitive   = true
}
