variable "aws_region" {
  type        = string
  description = "AWS region for the admin bucket. Must stay in Australia."

  validation {
    condition     = var.aws_region == "ap-southeast-2"
    error_message = "admin static files must stay in ap-southeast-2."
  }
}

variable "name" {
  type = string
}

variable "environment" {
  type = string
}

variable "project" {
  type = string
}

variable "zone_name" {
  type        = string
  description = "Existing public zone name. The hostname is admin plus this name."
}

variable "zone_id" {
  type        = string
  description = "Existing public hosted zone id. This module does not create a zone."
}
