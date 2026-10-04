variable "aws_region" {
  type        = string
  description = "AWS region for the envelope key. Must stay in Australia."

  validation {
    condition     = var.aws_region == "ap-southeast-2"
    error_message = "envelope KMS key must stay in ap-southeast-2."
  }
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID used to build plan-known IAM ARNs. Not a tenant identifier."
}

variable "name" {
  type        = string
  description = "Name prefix for the envelope key, task role, and log group."
}

variable "vpc_id" {
  type        = string
  description = "VPC that contains the KMS interface endpoint."
}

variable "public_subnet_id" {
  type        = string
  description = "Public subnet for the KMS interface endpoint."
}

variable "enable_kms_endpoint" {
  type        = bool
  description = "Create the KMS interface endpoint. Staging defaults off."
  default     = false
}

variable "task_security_group_id" {
  type        = string
  description = "Task security group allowed into the KMS endpoint on 443."
}

variable "enable_key_rotation" {
  type        = bool
  description = "Customer-managed envelope keys must rotate. Tests may set false to prove validation."
  default     = true

  validation {
    condition     = var.enable_key_rotation
    error_message = "envelope KMS key must rotate."
  }
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch log retention for the service log group. 0 is forbidden."
  default     = 14

  validation {
    condition     = var.log_retention_days > 0
    error_message = "log retention_in_days must be > 0."
  }
}

variable "policy_probe_action" {
  type        = string
  default     = null
  description = "Test-only action appended to the admin statement. Any non-null value fails the plan."
}
