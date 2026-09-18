output "key_arn" {
  description = "ARN of the storage KMS key."
  value       = aws_kms_key.storage.arn
}

output "key_id" {
  description = "ID of the storage KMS key."
  value       = aws_kms_key.storage.key_id
}

output "alias_name" {
  description = "Alias of the storage KMS key."
  value       = aws_kms_alias.storage.name
}
