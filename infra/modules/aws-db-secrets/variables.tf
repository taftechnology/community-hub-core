variable "aws_region" {
  type        = string
  description = "AWS region for the secrets key and the three role passwords. Must stay in Australia."

  validation {
    condition     = var.aws_region == "ap-southeast-2"
    error_message = "database secrets must stay in ap-southeast-2."
  }
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID used to build plan-known KMS and Secrets Manager ARNs. Not a tenant identifier."
}

variable "name" {
  type        = string
  description = "Name prefix for the secrets key and the three role password secrets."
}

variable "environment" {
  type        = string
  description = "Environment tag for the secrets key and the three role password secrets."
}

variable "project" {
  type        = string
  description = "Project tag for the secrets key and the three role password secrets."
}

variable "enable_key_rotation" {
  type        = bool
  description = "Customer-managed secrets keys must rotate. Tests may set false to prove validation."
  default     = true

  validation {
    condition     = var.enable_key_rotation
    error_message = "database secrets KMS key must rotate."
  }
}
