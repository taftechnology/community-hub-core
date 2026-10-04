resource "aws_security_group" "worker" {
  region = "ap-southeast-2"
  vpc_id = "vpc-example"

  dynamic "ingress" {
    for_each = []
    content {
      from_port = 80
      to_port   = 80
      protocol  = "tcp"
    }
  }

  dynamic "egress" {
    for_each = []
    content {
      from_port = 443
      to_port   = 443
      protocol  = "tcp"
    }
  }
}
