output "hostname" {
  description = "Regionalised hostname."
  value       = cloudflare_regional_hostname.this.hostname
}

output "region_key" {
  description = "Regional Services region key."
  value       = cloudflare_regional_hostname.this.region_key
}
