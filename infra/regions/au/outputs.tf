output "rds_hostname" {
  description = "RDS hostname for the VPC service (not a private IP)."
  value       = module.rds.address
}

output "tunnel_id" {
  description = "Cloudflare Tunnel ID."
  value       = module.tunnel.tunnel_id
}

output "hyperdrive_id" {
  description = "Hyperdrive config ID when enabled."
  value       = module.hyperdrive.id
}

output "vpc_service_id" {
  description = "Workers VPC service ID."
  value       = module.vpc_service.service_id
}

output "tunnel_token" {
  description = "Tunnel token. Top-tier secret; not for logs or CI."
  value       = module.tunnel.tunnel_token
  sensitive   = true
}
