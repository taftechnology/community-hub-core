resource "cloudflare_regional_hostname" "this" {
  zone_id    = var.zone_id
  hostname   = var.hostname
  region_key = var.region_key
}
