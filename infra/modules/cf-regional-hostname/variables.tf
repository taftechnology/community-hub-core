variable "zone_id" {
  type        = string
  description = "Cloudflare zone ID."
}

variable "hostname" {
  type        = string
  description = "Hostname to regionalise (au.api.<zone>). Terraform does not create the DNS record."
}

variable "region_key" {
  type        = string
  description = "Regional Services region. Australia only."
  default     = "au"

  validation {
    condition     = var.region_key == "au"
    error_message = "region_key must be au."
  }
}
