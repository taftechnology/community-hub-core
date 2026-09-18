variable "aws_region" {
  type        = string
  description = "AWS region for the state bucket and KMS key. Must stay in Australia."

  validation {
    condition     = var.aws_region == "ap-southeast-2"
    error_message = "bootstrap must stay in ap-southeast-2."
  }
}

variable "environment" {
  type        = string
  description = "staging or prod. Controls the state bucket name only; residency rules are identical."

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}
