resource "terraform_data" "hyperdrive_password" {
  input = {
    enable   = var.enable_hyperdrive
    password = var.origin_password
    mtls     = var.use_mtls
  }

  lifecycle {
    precondition {
      condition     = !var.enable_hyperdrive || (var.origin_password != null && var.origin_password != "")
      error_message = "hyperdrive origin password is required when enable_hyperdrive is true."
    }
  }
}

resource "cloudflare_hyperdrive_config" "this" {
  count = var.enable_hyperdrive ? 1 : 0

  account_id = var.account_id
  name       = var.name

  origin = {
    service_id = var.service_id
    database   = var.database
    user       = var.user
    password   = var.origin_password
    scheme     = "postgres"
  }

  caching = {
    disabled = var.caching_disabled
  }

  depends_on = [terraform_data.hyperdrive_password]
}
