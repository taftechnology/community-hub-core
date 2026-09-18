output "state_bucket_name" {
  description = "S3 bucket that holds Terraform state for this environment."
  value       = aws_s3_bucket.state.bucket
}

output "state_bucket_arn" {
  description = "ARN of the Terraform state bucket."
  value       = aws_s3_bucket.state.arn
}

output "state_kms_key_arn" {
  description = "ARN of the KMS key that encrypts Terraform state."
  value       = aws_kms_key.state.arn
}

output "state_kms_alias" {
  description = "KMS alias referenced by backend hcl files."
  value       = aws_kms_alias.state.name
}
