variable "aws_region" {
  type = string

  validation {
    condition     = var.aws_region == "ap-southeast-2"
    error_message = "ingress stays in ap-southeast-2."
  }
}

variable "aws_account_id" {
  type = string
}

variable "name" {
  type = string
}

variable "environment" {
  type = string

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "project" {
  type = string
}

# tflint-ignore: terraform_unused_declarations
variable "service_image" {
  type    = string
  default = null

  validation {
    condition = (
      var.service_image == null ||
      can(regex("^${var.aws_account_id}\\.dkr\\.ecr\\.ap-southeast-2\\.amazonaws\\.com/${var.name}/service@sha256:[0-9a-f]{64}$", var.service_image))
    )
    error_message = "service_image must be a lowercase sha256 digest in this account's ap-southeast-2 ECR repository."
  }
}
