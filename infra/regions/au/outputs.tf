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

output "envelope_key_arn" {
  description = "ARN of the envelope KMS wrapping key."
  value       = module.envelope.key_arn
}

output "kms_endpoint_id" {
  description = "ID of the KMS interface VPC endpoint for the broker."
  value       = module.envelope.endpoint_id
}

output "broker_tunnel_id" {
  description = "Cloudflare Tunnel ID for the KMS broker."
  value       = module.broker_tunnel.tunnel_id
}

output "broker_tunnel_token" {
  description = "Broker tunnel token. Top-tier secret; not for logs or CI."
  value       = module.broker_tunnel.tunnel_token
  sensitive   = true
}

output "envelope_key_policy" {
  description = "Envelope KMS key policy document."
  value       = module.envelope.key_policy
}

output "storage_key_policy" {
  description = "Storage KMS key policy document."
  value       = module.kms.key_policy
}

output "broker_execution_policy" {
  description = "Broker execution role policy document."
  value       = module.envelope.execution_policy
}

output "connector_execution_policy" {
  description = "Connector execution role policy document."
  value       = module.ecs.execution_policy
}

output "broker_vpc_service_id" {
  description = "Workers VPC service ID for the broker. Null when tasks are disabled."
  value       = var.enable_kms_broker_tasks ? module.broker_vpc_service[0].service_id : null
}
