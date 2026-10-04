output "rds_hostname" {
  description = "RDS hostname for the VPC service (not a private IP)."
  value       = module.rds.address
}

output "envelope_key_arn" {
  description = "ARN of the envelope KMS wrapping key."
  value       = module.envelope.key_arn
}

output "kms_endpoint_id" {
  description = "ID of the KMS interface VPC endpoint. Null when the endpoint is off."
  value       = module.envelope.endpoint_id
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
