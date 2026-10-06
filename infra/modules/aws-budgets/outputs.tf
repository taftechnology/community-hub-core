output "budget_id" {
  description = "ID of the environment budget when enable_budgets is true."
  value       = one(aws_budgets_budget.environment[*].id)
}

output "budget_name" {
  description = "Name of the environment budget when enable_budgets is true. Null when the budget is off."
  value       = one(aws_budgets_budget.environment[*].name)
}
