variable "name" {
  type = string
}

variable "environment" {
  type = string
}

variable "project" {
  type = string
}

variable "alert_email" {
  type = string
}

variable "enable_budgets" {
  type    = bool
  default = false
}
