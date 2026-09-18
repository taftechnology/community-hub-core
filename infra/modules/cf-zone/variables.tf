variable "account_id" {
  type        = string
  description = "Cloudflare account ID."
}

variable "environment" {
  type        = string
  description = "staging or prod. Staging must not use communityhub.one."

  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "zone_name" {
  type        = string
  description = "Dedicated zone. Staging rejects communityhub.one (any case, trailing dot, or subdomain)."

  validation {
    condition = (
      var.environment == "prod"
      || (
        trimsuffix(lower(var.zone_name), ".") != "communityhub.one"
        && !endswith(trimsuffix(lower(var.zone_name), "."), ".communityhub.one")
      )
    )
    error_message = "staging zone must not be communityhub.one or a subdomain of it."
  }
}
