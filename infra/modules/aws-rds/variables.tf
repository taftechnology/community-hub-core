variable "aws_region" {
  type        = string
  description = "AWS region for RDS. Must stay in Australia."

  validation {
    condition     = var.aws_region == "ap-southeast-2"
    error_message = "RDS must stay in ap-southeast-2."
  }
}

variable "name" {
  type        = string
  description = "Identifier prefix for the instance and subnet group."
}

variable "environment" {
  type        = string
  description = "staging or prod. Prod preconditions require deletion protection and backups."

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "project" {
  type = string
}

variable "subnet_ids" {
  type        = list(string)
  description = "Private subnet IDs for the DB subnet group (two AZs)."
}

variable "vpc_security_group_ids" {
  type        = list(string)
  description = "Security groups attached to the instance (RDS SG from aws-network)."
}

variable "kms_key_arn" {
  type        = string
  description = "Storage KMS key ARN."
}

variable "engine_version" {
  type        = string
  description = "PostgreSQL engine version. uuidv7() is packages-db, not this module."
  default     = "17"
}

variable "parameter_group_family" {
  type        = string
  description = "DB parameter group family matching engine_version."
  default     = "postgres17"
}

variable "instance_class" {
  type        = string
  description = "RDS instance class."
  default     = "db.t4g.micro"
}

variable "multi_az" {
  type        = bool
  description = "Whether the instance runs Multi-AZ."
  default     = false
}

variable "deletion_protection" {
  type        = bool
  description = "RDS deletion protection flag passed from the cell root."
}

variable "backup_retention_days" {
  type        = number
  description = "Backup retention in days passed from the cell root."
}

variable "alarm_topic_arn" {
  type        = string
  description = "SNS topic ARN for the four database alarms. The root owns the topic."
}

variable "publicly_accessible" {
  type        = bool
  description = "Must stay false. Tests may set true to prove validation."
  default     = false

  validation {
    condition     = var.publicly_accessible == false
    error_message = "RDS must not be publicly accessible."
  }
}

variable "ca_cert_identifier" {
  type        = string
  description = "Pinned RDS CA. Do not leave the default implicit."
  default     = "rds-ca-rsa2048-g1"
}
