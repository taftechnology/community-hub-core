output "db_instance_id" {
  description = "RDS instance identifier."
  value       = aws_db_instance.this.identifier
}

output "db_instance_arn" {
  description = "RDS instance ARN."
  value       = aws_db_instance.this.arn
}

output "address" {
  description = "RDS hostname for Hyperdrive / Workers VPC (not a private IP)."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "Postgres port."
  value       = aws_db_instance.this.port
}

output "master_user_secret_arn" {
  description = "RDS-managed master secret ARN. Not a task environment variable."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}
