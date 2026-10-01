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
  description = "ARN of the broker task role. The key policy is the only grant."
  value       = aws_iam_role.task.arn
}

output "task_role_name" {
  description = "Name of the broker task role."
  value       = aws_iam_role.task.name
}

output "broker_security_group_id" {
  description = "Broker task security group. No inbound."
  value       = aws_security_group.broker.id
}

output "endpoint_id" {
  description = "ID of the KMS interface endpoint."
  value       = aws_vpc_endpoint.kms.id
}

output "execution_role_arn" {
  description = "ARN of the broker execution role."
  value       = aws_iam_role.execution.arn
}

output "tunnel_secret_name" {
  description = "Secrets Manager name of the broker tunnel token."
  value       = aws_secretsmanager_secret.broker_tunnel.name
}
