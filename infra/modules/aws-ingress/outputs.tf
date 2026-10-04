output "repository_url" {
  description = "ECR repository URL for the service image."
  value       = aws_ecr_repository.service.repository_url
}
