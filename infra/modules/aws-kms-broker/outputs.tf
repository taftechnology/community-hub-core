output "repository_name" {
  description = "Name of the broker ECR repository."
  value       = aws_ecr_repository.broker.name
}

output "repository_arn" {
  description = "ARN of the broker ECR repository."
  value       = aws_ecr_repository.broker.arn
}
