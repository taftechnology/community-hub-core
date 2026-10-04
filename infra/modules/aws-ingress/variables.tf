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

variable "cpu_architecture" {
  type    = string
  default = "ARM64"

  validation {
    condition     = var.cpu_architecture == "ARM64"
    error_message = "cpu architecture must be ARM64."
  }
}

variable "capacity_provider" {
  type    = string
  default = "FARGATE"

  validation {
    condition     = contains(["FARGATE", "FARGATE_SPOT"], var.capacity_provider) && !(var.environment == "prod" && var.capacity_provider == "FARGATE_SPOT")
    error_message = "capacity provider is FARGATE or FARGATE_SPOT, and prod cannot use FARGATE_SPOT."
  }
}

variable "task_subnet_ids" {
  type    = list(string)
  default = []

  validation {
    condition     = var.service_image == null || length(var.task_subnet_ids) > 0
    error_message = "a set image needs at least one task subnet."
  }
}

variable "execution_role_arn" {
  type    = string
  default = ""

  validation {
    condition     = var.service_image == null || var.execution_role_arn != ""
    error_message = "a set image needs execution_role_arn."
  }
}

variable "execution_role_name" {
  type    = string
  default = ""

  validation {
    condition     = var.service_image == null || var.execution_role_name != ""
    error_message = "a set image needs execution_role_name."
  }
}

variable "task_role_arn" {
  type    = string
  default = ""

  validation {
    condition     = var.service_image == null || var.task_role_arn != ""
    error_message = "a set image needs task_role_arn."
  }
}

variable "log_group_name" {
  type    = string
  default = ""

  validation {
    condition     = var.service_image == null || var.log_group_name != ""
    error_message = "a set image needs log_group_name."
  }
}

variable "db_host" {
  type    = string
  default = ""

  validation {
    condition     = var.service_image == null || var.db_host != ""
    error_message = "a set image needs db_host."
  }
}

variable "db_port" {
  type    = number
  default = 5432
}

variable "envelope_key_arn" {
  type    = string
  default = ""

  validation {
    condition     = var.service_image == null || var.envelope_key_arn != ""
    error_message = "a set image needs envelope_key_arn."
  }
}

variable "app_secret_arn" {
  type    = string
  default = ""

  validation {
    condition     = var.service_image == null || var.app_secret_arn != ""
    error_message = "a set image needs app_secret_arn."
  }
}

variable "identity_secret_arn" {
  type    = string
  default = ""

  validation {
    condition     = var.service_image == null || var.identity_secret_arn != ""
    error_message = "a set image needs identity_secret_arn."
  }
}

variable "platform_secret_arn" {
  type    = string
  default = ""

  validation {
    condition     = var.service_image == null || var.platform_secret_arn != ""
    error_message = "a set image needs platform_secret_arn."
  }
}

variable "turnstile_secret_arn" {
  type    = string
  default = null
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
