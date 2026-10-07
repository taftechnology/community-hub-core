resource "aws_security_group" "connector" {
  region = var.aws_region
  vpc_id = "vpc-example"
}

resource "aws_security_group" "rds" {
  region = var.aws_region
  vpc_id = "vpc-example"
}

resource "aws_vpc_security_group_ingress_rule" "rds_postgres" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.connector.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}
