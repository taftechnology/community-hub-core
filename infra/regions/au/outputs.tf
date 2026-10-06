output "rds_hostname" {
  description = "RDS hostname. Null when enable_database is false."
  value       = var.enable_database ? module.rds[0].address : null
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

output "execution_policy" {
  description = "Service execution role policy document."
  value       = module.envelope.execution_policy
}
