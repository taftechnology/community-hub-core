output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.this.id
}

output "public_subnet_id" {
  description = "Primary public subnet."
  value       = aws_subnet.public.id
}

output "public_subnet_ids" {
  description = "Public subnets (two AZs)."
  value       = [aws_subnet.public.id, aws_subnet.public_b.id]
}

output "private_subnet_ids" {
  description = "Private subnets for RDS (two AZs)."
  value       = aws_subnet.private[*].id
}

output "task_security_group_id" {
  description = "Security group for service tasks."
  value       = aws_security_group.task.id
}

output "rds_security_group_id" {
  description = "Security group for RDS (ingress 5432 from task only)."
  value       = aws_security_group.rds.id
}
