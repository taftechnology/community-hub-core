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

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)

  validation {
    condition     = length(var.private_subnet_ids) == 2
    error_message = "the VPC link is created with both private subnets."
  }
}

variable "task_security_group_id" {
  type = string
}

variable "cloud_map_record_type" {
  type    = string
  default = "SRV"

  validation {
    condition     = var.cloud_map_record_type == "SRV"
    error_message = "Cloud Map record type must be SRV."
  }
}

variable "zone_name" {
  type = string
}

variable "create_public_zone" {
  type    = bool
  default = false

  validation {
    condition     = !(var.create_public_zone && var.public_zone_id != null)
    error_message = "Do not pass a zone id when create_public_zone is true."
  }
}

variable "attach_public_dns" {
  type    = bool
  default = false

  validation {
    condition     = !var.attach_public_dns || var.public_zone_id != null || var.create_public_zone
    error_message = "attach_public_dns requires a zone id or create_public_zone."
  }
}

variable "public_zone_id" {
  type    = string
  default = null
}

variable "minimum_tls_version" {
  type    = string
  default = "TLS_1_2"

  validation {
    condition     = var.minimum_tls_version == "TLS_1_2"
    error_message = "minimum TLS version is 1.2."
  }
}

variable "stage_name" {
  type    = string
  default = "$default"

  validation {
    condition     = var.stage_name == "$default" || var.overwrite_request_path
    error_message = "a named stage must overwrite the request path."
  }
}

variable "overwrite_request_path" {
  type    = bool
  default = false
}

variable "disable_execute_api_endpoint" {
  type    = bool
  default = true

  validation {
    condition     = var.disable_execute_api_endpoint
    error_message = "execute-api stays disabled."
  }
}

variable "access_log_retention_days" {
  type    = number
  default = 14

  validation {
    condition     = var.access_log_retention_days > 0
    error_message = "access log retention must be greater than zero."
  }
}

variable "desired_count" {
  type    = number
  default = 0
}

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
