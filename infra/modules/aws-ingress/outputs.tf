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

output "repository_url" {
  description = "ECR repository URL for the service image."
  value       = aws_ecr_repository.service.repository_url
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
