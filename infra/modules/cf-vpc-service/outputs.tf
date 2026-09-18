output "service_id" {
  description = "Workers VPC service ID for Hyperdrive origin."
  value       = coalesce(cloudflare_connectivity_directory_service.this.service_id, cloudflare_connectivity_directory_service.this.id)
}
