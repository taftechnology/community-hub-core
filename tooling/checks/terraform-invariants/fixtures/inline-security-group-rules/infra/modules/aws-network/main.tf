resource "aws_security_group" "task" {
  region  = var.aws_region
  vpc_id  = "vpc-example"
  ingress = []

  egress = [
    {
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = ["0.0.0.0/0"]
    },
  ]
}

resource "aws_security_group" "rds" {
  region  = var.aws_region
  vpc_id  = "vpc-example"
  ingress = []
  egress  = []
}

resource "aws_vpc_security_group_egress_rule" "task_rds" {
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = aws_security_group.rds.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}
