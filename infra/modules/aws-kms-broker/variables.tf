variable "aws_region" {
  type        = string
  description = "AWS region for the broker task. Must stay in Australia."

  validation {
    condition     = var.aws_region == "ap-southeast-2"
    error_message = "kms broker task must stay in ap-southeast-2."
  }
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID used to validate the broker image reference."
}

variable "name" {
  type        = string
  description = "Name prefix for the ECR repository, cluster, and service."
}

variable "public_subnet_id" {
  type        = string
  description = "Public subnet for the broker Fargate service."
}

variable "tunnel_secret_arn" {
  type        = string
  description = "Secrets Manager ARN for the Cloudflare tunnel token."
}

variable "execution_role_name" {
  type        = string
  description = "Broker execution role name for the ECR pull policy attachment."
}

variable "execution_role_arn" {
  type        = string
  description = "Broker execution role ARN for the task definition."
}

variable "log_group_name" {
  type        = string
  description = "CloudWatch log group shared by both task containers."
}

variable "task_role_arn" {
  type        = string
  description = "Broker task role ARN passed to the task definition."
}

variable "broker_security_group_id" {
  type        = string
  description = "Security group for the broker Fargate service."
}

variable "envelope_key_arn" {
  type        = string
  description = "Envelope KMS key ARN passed to the broker process as ENVELOPE_KEY_ARN."
}

variable "enable_tasks" {
  type        = bool
  description = "When false, only the ECR repository is created."
  default     = false
}

variable "kms_broker_image" {
  type    = string
  default = null

  validation {
    condition = (
      var.kms_broker_image == null ||
      can(regex(
        "^${var.aws_account_id}\\.dkr\\.ecr\\.ap-southeast-2\\.amazonaws\\.com/${var.name}/kms-broker@sha256:[0-9a-f]{64}$",
        var.kms_broker_image
      ))
    )
    error_message = "kms_broker_image must be this cell's ECR repository digest, lowercase hex, or null."
  }
}

variable "kms_broker_cloudflared_image" {
  type    = string
  default = "docker.io/cloudflare/cloudflared@sha256:b7a6db450ae2e2f773d4fbe9ffb48e7b5fc451e17329daab1b4dda5a2487e2cc"

  validation {
    condition     = can(regex("^docker\\.io/cloudflare/cloudflared@sha256:[0-9a-f]{64}$", var.kms_broker_cloudflared_image))
    error_message = "cloudflared image must be docker.io/cloudflare/cloudflared pinned by digest."
  }
}
