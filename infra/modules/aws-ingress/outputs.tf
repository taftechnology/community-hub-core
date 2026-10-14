output "api_hostname" {
  value = local.api_hostname
}

output "auth_hostname" {
  value = local.auth_hostname
}

output "webhooks_hostname" {
  value = local.webhooks_hostname
}

output "ops_hostname" {
  value = local.ops_hostname
}

output "task_subnet_ids" {
  description = "Subnets the ECS service uses. Empty while the image is unset."
  value       = var.task_subnet_ids
}

output "ecs_service_desired_count" {
  description = "Desired count when the image is set, otherwise 0."
  value       = var.service_image == null ? 0 : var.desired_count
}

output "repository_url" {
  description = "ECR repository URL for the service image."
  value       = aws_ecr_repository.service.repository_url
}

output "repository_arn" {
  description = "ECR repository ARN for the one service image."
  value       = aws_ecr_repository.service.arn
}

output "tenant_write_throttle" {
  description = "Write-route caps, built from the same locals the tenant stage uses."
  value = {
    for key in local.tenant_write_route_keys : key => {
      rate  = local.tenant_write_rate
      burst = local.tenant_write_burst
    }
  }
}

output "service_environment" {
  description = "Container environment map when service_image is set, otherwise empty."
  value       = var.service_image == null ? {} : { for e in jsondecode(aws_ecs_task_definition.this[0].container_definitions)[0].environment : e.name => e.value }
}
