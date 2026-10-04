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
  description = "Must be true in prod. The RDS instance uses this variable; the prod check rejects a prod plan that turns it off."
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

variable "staging_zone_id" {
  type        = string
  description = "Hosted zone id for communityhub-staging.net. Required in staging. Passed at plan time, not committed in tfvars."
  default     = null
}

variable "create_public_zone" {
  type        = bool
  description = "False in staging. True in production."
}

variable "attach_public_dns" {
  type        = bool
  description = "True in staging. False in production."
}

variable "desired_count" {
  type        = number
  description = "ECS desired count. Stays 0 until a person raises it."
  default     = 0
}

# tflint-ignore: terraform_unused_declarations
variable "turnstile_secret_arn" {
  type        = string
  description = "Optional Turnstile secret. Null until that secret exists."
  default     = null
}

variable "enable_budgets" {
  type        = bool
  description = "Create the per-environment budget. Off until the cost-allocation tag is active."
  default     = false
}
