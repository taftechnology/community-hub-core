mock_provider "aws" {
  override_during = plan
}

run "default" {
  command = plan

  variables {
    name        = "ch-staging"
    environment = "staging"
    project     = "community-hub"
    alert_email = "alerts@example.com"
  }

  assert {
    condition     = length(aws_budgets_budget.environment) == 0
    error_message = "budget must be absent when enable_budgets is unset"
  }
}

run "enabled" {
  command = plan

  variables {
    name           = "ch-staging"
    environment    = "staging"
    project        = "community-hub"
    alert_email    = "alerts@example.com"
    enable_budgets = true
  }

  assert {
    condition     = aws_budgets_budget.environment[0].limit_amount == "50"
    error_message = "staging budget limit must be 50 USD"
  }

  assert {
    condition     = one(aws_budgets_budget.environment[0].notification).threshold == 80
    error_message = "budget notification threshold must be 80 percent"
  }

  assert {
    condition     = contains(one(aws_budgets_budget.environment[0].notification).subscriber_email_addresses, "alerts@example.com")
    error_message = "budget subscriber must be the alert email"
  }

  assert {
    condition     = contains(one(aws_budgets_budget.environment[0].cost_filter).values, "user:environment$staging")
    error_message = "budget cost filter must be the exact string user:environment$staging"
  }

  assert {
    condition = (
      aws_budgets_budget.environment[0].tags["environment"] == "staging" &&
      aws_budgets_budget.environment[0].tags["project"] == "community-hub"
    )
    error_message = "budget tags must be environment=staging and project=community-hub"
  }
}

run "prod_enabled" {
  command = plan

  variables {
    name           = "ch-prod"
    environment    = "prod"
    project        = "community-hub"
    alert_email    = "alerts@example.com"
    enable_budgets = true
  }

  assert {
    condition     = aws_budgets_budget.environment[0].limit_amount == "110"
    error_message = "prod budget limit must be 110 USD"
  }

  assert {
    condition     = contains(one(aws_budgets_budget.environment[0].cost_filter).values, "user:environment$prod")
    error_message = "prod budget cost filter must be the exact string user:environment$prod"
  }
}
