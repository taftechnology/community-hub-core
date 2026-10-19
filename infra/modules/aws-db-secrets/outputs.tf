output "app_secret_arn" {
  description = "ARN of the app role password secret."
  value       = aws_secretsmanager_secret.app.arn
}

output "identity_secret_arn" {
  description = "ARN of the identity role password secret."
  value       = aws_secretsmanager_secret.identity.arn
}

output "platform_secret_arn" {
  description = "ARN of the platform role password secret."
  value       = aws_secretsmanager_secret.platform.arn
}

output "key_arn" {
  description = "ARN of the KMS key that encrypts the three role password secrets and the billing secret."
  value       = aws_kms_key.secrets.arn
}

output "billing_secret_arn" {
  description = "ARN of the billing secret."
  value       = aws_secretsmanager_secret.billing.arn
}
