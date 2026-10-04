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
