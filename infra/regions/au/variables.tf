variable "aws_region" {
  type        = string
  description = "AWS region for the cell. Must stay in Australia."

  validation {
    condition     = var.aws_region == "ap-southeast-2"
    error_message = "AU cell must stay in ap-southeast-2."
  }
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID for plan-known IAM ARNs."
}

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID."
}

variable "environment" {
  type        = string
  description = "staging or prod."

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "cert_verification_mode" {
  type        = string
  description = "TLS verification on the Workers VPC service."

  validation {
    condition     = contains(["verify_full", "verify_ca", "disabled"], var.cert_verification_mode)
    error_message = "cert_verification_mode must be verify_full, verify_ca, or disabled."
  }
}

variable "deletion_protection" {
  type        = bool
  description = "Must be true in prod. RDS also keys off environment."
  default     = false
}

variable "backup_retention_days" {
  type        = number
  description = "Must be >= 7 in prod."
  default     = 0
}

variable "zone_id" {
  type        = string
  description = "Dedicated zone ID from infra/global. Not terraform_remote_state."
}

variable "zone_name" {
  type        = string
  description = "Zone name used to build au.api.<zone> when regional hostnames are enabled."
}

variable "enable_hyperdrive" {
  type        = bool
  description = "Leave false on first apply."
  default     = false
}

variable "enable_regional_hostnames" {
  type        = bool
  description = "Leave false until Wrangler has created the Worker custom-domain DNS record."
  default     = false
}

variable "region_key" {
  type        = string
  description = "Cloudflare Regional Services region_key for au.api.<zone>. No default."

  validation {
    condition     = var.region_key == "au"
    error_message = "region_key must be au."
  }
}

variable "hyperdrive_origin_password" {
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
  description = "Application-role password. Required only when enable_hyperdrive is true."
}
