resource "aws_vpc_security_group_ingress_rule" "endpoint" {
  security_group_id = "sg-endpoint"
  cidr_ipv4         = "10.0.0.0/8"
  from_port         = 443
  to_port           = 443
  ip_protocol       = "tcp"
}
