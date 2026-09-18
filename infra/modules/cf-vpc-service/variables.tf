variable "account_id" {
  type        = string
  description = "Cloudflare account ID."
}

variable "name" {
  type        = string
  description = "VPC service name."
}

variable "tunnel_id" {
  type        = string
  description = "Cloudflare Tunnel ID the RDS hostname is reached through."
}

variable "rds_hostname" {
  type        = string
  description = "RDS hostname (not a private IP) so a future verify_full can match the cert SAN."
}

variable "cert_verification_mode" {
  type        = string
  description = "TLS verification on the VPC service. Staging may be disabled; prod must be verify_full (enforced at the cell root)."

  validation {
    condition     = contains(["verify_full", "verify_ca", "disabled"], var.cert_verification_mode)
    error_message = "cert_verification_mode must be verify_full, verify_ca, or disabled."
  }
}
