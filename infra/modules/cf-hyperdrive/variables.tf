variable "account_id" {
  type        = string
  description = "Cloudflare account ID."
}

variable "name" {
  type        = string
  description = "Hyperdrive config name."
}

variable "service_id" {
  type        = string
  description = "Workers VPC service ID. Origin is this service only — no host/port, no mtls."
}

variable "database" {
  type        = string
  description = "Application database name. Empty RDS until packages-db; default postgres."
  default     = "postgres"
}

variable "user" {
  type        = string
  description = "Application role name (non-BYPASSRLS). Created later by packages-db."
  default     = "app"
}

variable "enable_hyperdrive" {
  type        = bool
  description = "First apply must be false: Cloudflare tests the origin before the tunnel exists."
  default     = false
}

variable "origin_password" {
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
  description = "Application-role password. Required only when enable_hyperdrive is true."
}

variable "caching_disabled" {
  type        = bool
  description = "Hyperdrive caching must stay off."
  default     = true

  validation {
    condition     = var.caching_disabled
    error_message = "Hyperdrive caching must be disabled."
  }
}

variable "use_mtls" {
  type        = bool
  description = "Must stay false. mtls cannot be combined with a VPC service origin."
  default     = false

  validation {
    condition     = !var.use_mtls
    error_message = "mtls cannot be combined with a VPC service origin."
  }
}
