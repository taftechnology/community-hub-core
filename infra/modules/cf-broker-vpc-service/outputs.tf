output "service_id" {
  description = "Workers VPC service ID for the broker."
  value       = cloudflare_connectivity_directory_service.broker.id
}

output "type" {
  description = "Workers VPC service type."
  value       = cloudflare_connectivity_directory_service.broker.type
}

output "http_port" {
  description = "HTTP port the service reaches on the broker loopback."
  value       = cloudflare_connectivity_directory_service.broker.http_port
}

output "https_port" {
  description = "HTTPS port. Null for the plaintext loopback origin."
  value       = cloudflare_connectivity_directory_service.broker.https_port
}

output "tls_settings" {
  description = "TLS settings. Null when the origin is plaintext HTTP."
  value       = cloudflare_connectivity_directory_service.broker.tls_settings
}

output "host_ipv4" {
  description = "IPv4 address the service reaches through the tunnel."
  value       = cloudflare_connectivity_directory_service.broker.host.ipv4
}

output "host_hostname" {
  description = "Hostname, when set. Null for the loopback service."
  value       = cloudflare_connectivity_directory_service.broker.host.hostname
}

output "tunnel_id" {
  description = "Tunnel ID on host.network."
  value       = cloudflare_connectivity_directory_service.broker.host.network.tunnel_id
}
