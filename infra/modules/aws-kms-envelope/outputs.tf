output "key_arn" {
  description = "ARN of the envelope KMS key."
  value       = aws_kms_key.envelope.arn
}

output "key_id" {
  description = "ID of the envelope KMS key."
  value       = aws_kms_key.envelope.key_id
}

output "alias_name" {
  description = "Alias of the envelope KMS key."
  value       = aws_kms_alias.envelope.name
}

output "task_role_arn" {
  description = "ARN of the task role. The key policy grants cryptographic actions; task_secrets grants secret read."
  value       = aws_iam_role.task.arn
}

output "task_role_name" {
  description = "Name of the task role."
  value       = aws_iam_role.task.name
}

output "endpoint_id" {
  description = "ID of the KMS interface endpoint. Null when the endpoint is off."
  value       = one(aws_vpc_endpoint.kms[*].id)
}

output "execution_role_arn" {
  description = "ARN of the execution role."
  value       = aws_iam_role.execution.arn
}

output "key_policy" {
  description = "Envelope KMS key policy document."
  value       = aws_kms_key.envelope.policy
}

output "execution_policy" {
  description = "Execution role policy document."
  value       = aws_iam_role_policy.execution.policy
}

output "execution_role_name" {
  description = "Name of the execution role. aws_iam_role_policy.role takes this, not the ARN."
  value       = aws_iam_role.execution.name
}

output "log_group_name" {
  description = "Service log group name."
  value       = local.log_group_name
}
