variable "aws_region" {
  type        = string
  description = "AWS region for the connector. Must stay in Australia."

  validation {
    condition     = var.aws_region == "ap-southeast-2"
    error_message = "tunnel connector must stay in ap-southeast-2."
  }
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID used to build plan-known IAM ARNs. Not a tenant identifier."
}

variable "name" {
  type        = string
  description = "Name prefix for cluster, service, secret, and log group."
}

variable "public_subnet_id" {
  type        = string
  description = "Public subnet for the connector (public IP, no inbound)."
}

variable "connector_security_group_id" {
  type        = string
  description = "Connector security group with ingress = []."
}

variable "tunnel_token" {
  type        = string
  sensitive   = true
  description = "Cloudflare Tunnel token. Stored in Secrets Manager, never a task environment variable."
}

variable "cloudflared_image" {
  type        = string
  description = "cloudflared image pinned by digest. Prefer an ECR pull-through cache in the apply runbook."
  default     = "docker.io/cloudflare/cloudflared@sha256:b7a6db450ae2e2f773d4fbe9ffb48e7b5fc451e17329daab1b4dda5a2487e2cc"

  validation {
    condition     = strcontains(var.cloudflared_image, "sha256:")
    error_message = "cloudflared image must be pinned by digest."
  }
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch log retention. 0 means never expire and is forbidden."
  default     = 30

  validation {
    condition     = var.log_retention_days >= 1
    error_message = "log retention_in_days must be >= 1 (0 never expires)."
  }
}

variable "kms_key_arn" {
  type        = string
  default     = null
  nullable    = true
  description = "If set, encrypt the tunnel token secret with this key and allow kms:Decrypt on the execution role."
}
