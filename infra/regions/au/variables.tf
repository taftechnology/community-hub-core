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

variable "environment" {
  type        = string
  description = "staging or prod."

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
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

variable "enable_kms_endpoint" {
  type        = bool
  description = "Create the KMS interface endpoint. Staging defaults off."
  default     = false
}

variable "alert_email" {
  type        = string
  description = "Email for budget and RDS alarm SNS subscriptions."
}

variable "enable_budgets" {
  type        = bool
  description = "Create the per-environment budget. Off until the cost-allocation tag is active."
  default     = false
}
