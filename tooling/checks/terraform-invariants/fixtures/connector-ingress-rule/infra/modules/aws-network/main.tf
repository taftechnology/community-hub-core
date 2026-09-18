resource "aws_security_group" "connector" {
  region  = "ap-southeast-2"
  vpc_id  = "vpc-example"
  ingress = []
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  security_group_id = aws_security_group.connector.id
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
  cidr_ipv4         = "0.0.0.0/0"
}
