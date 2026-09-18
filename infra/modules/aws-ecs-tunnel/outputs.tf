output "cluster_arn" {
  description = "ECS cluster ARN."
  value       = aws_ecs_cluster.this.arn
}

output "service_name" {
  description = "ECS service name."
  value       = aws_ecs_service.connector.name
}

output "log_group_name" {
  description = "CloudWatch log group for cloudflared."
  value       = aws_cloudwatch_log_group.connector.name
}

output "secret_arn" {
  description = "Secrets Manager ARN for the tunnel token."
  value       = aws_secretsmanager_secret.tunnel.arn
  sensitive   = true
}
