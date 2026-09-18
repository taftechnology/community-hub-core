resource "aws_security_group" "connector" {
  region  = "ap-southeast-2"
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
  region  = "ap-southeast-2"
  vpc_id  = "vpc-example"
  ingress = []
  egress  = []
}

resource "aws_vpc_security_group_ingress_rule" "rds_postgres" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.connector.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}
