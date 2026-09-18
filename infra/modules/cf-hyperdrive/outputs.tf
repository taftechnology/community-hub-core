output "id" {
  description = "Hyperdrive config ID when enabled, otherwise null."
  value       = try(cloudflare_hyperdrive_config.this[0].id, null)
}
