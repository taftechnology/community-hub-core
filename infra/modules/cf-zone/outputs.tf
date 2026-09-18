output "zone_id" {
  description = "Cloudflare zone ID."
  value       = cloudflare_zone.this.id
}

output "zone_name" {
  description = "Configured zone name."
  value       = cloudflare_zone.this.name
}
