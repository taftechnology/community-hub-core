variable "aws_region" {
  type        = string
  description = "AWS region for the storage key. Must stay in Australia."

  validation {
    condition     = var.aws_region == "ap-southeast-2"
    error_message = "storage KMS key must stay in ap-southeast-2."
  }
}

variable "name" {
  type        = string
  description = "Name prefix for the storage KMS key alias."
}

variable "enable_key_rotation" {
  type        = bool
  description = "Customer-managed storage keys must rotate. Tests may set false to prove validation."
  default     = true

  validation {
    condition     = var.enable_key_rotation
    error_message = "storage KMS key must rotate."
  }
}
