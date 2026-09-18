output "zone_id" {
  description = "Dedicated zone ID. Pass into regions/au as a variable — do not use terraform_remote_state."
  value       = module.zone.zone_id
}

output "zone_name" {
  description = "Configured zone name."
  value       = module.zone.zone_name
}
