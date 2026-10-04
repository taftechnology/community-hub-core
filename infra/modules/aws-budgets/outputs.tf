output "budget_id" {
  description = "ID of the environment budget when enable_budgets is true."
  value       = one(aws_budgets_budget.environment[*].id)
}
