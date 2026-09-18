provider "cloudflare" {}

module "zone" {
  source = "../modules/cf-zone"

  account_id  = var.cloudflare_account_id
  environment = var.environment
  zone_name   = var.zone_name
}
