variable "aws_region" {
  type        = string
  description = "AWS region for the VPC. Must stay in Australia."

  validation {
    condition     = var.aws_region == "ap-southeast-2"
    error_message = "network must stay in ap-southeast-2."
  }
}

variable "name" {
  type        = string
  description = "Name prefix for VPC resources."
}

variable "environment" {
  type = string
}

variable "project" {
  type = string
}

variable "vpc_cidr" {
  type        = string
  description = "CIDR for the VPC."
  default     = "10.64.0.0/16"
}

variable "availability_zones" {
  type        = list(string)
  description = "At least two AZs in ap-southeast-2 (RDS subnet group requirement)."
  default     = ["ap-southeast-2a", "ap-southeast-2b"]

  validation {
    condition = (
      length(var.availability_zones) >= 2
      && alltrue([for az in var.availability_zones : startswith(az, "ap-southeast-2")])
    )
    error_message = "availability_zones must be two or more AZs in ap-southeast-2."
  }
}
