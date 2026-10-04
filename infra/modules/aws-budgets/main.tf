resource "aws_budgets_budget" "environment" {
  count        = var.enable_budgets ? 1 : 0
  name         = "${var.name}-cost"
  budget_type  = "COST"
  limit_amount = var.environment == "prod" ? "110" : "50"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:environment$%s", var.environment)]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}
