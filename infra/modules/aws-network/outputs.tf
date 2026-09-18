output "vpc_id" {
  description = "VPC ID."
  value       = aws_vpc.this.id
}

output "public_subnet_id" {
  description = "Public subnet for the tunnel connector."
  value       = aws_subnet.public.id
}

output "private_subnet_ids" {
  description = "Private subnets for RDS (two AZs)."
  value       = aws_subnet.private[*].id
}

output "connector_security_group_id" {
  description = "Security group for the tunnel connector (ingress empty)."
  value       = aws_security_group.connector.id
}

output "rds_security_group_id" {
  description = "Security group for RDS (ingress 5432 from connector only)."
  value       = aws_security_group.rds.id
}
