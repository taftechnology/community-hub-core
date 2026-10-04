resource "aws_security_group" "endpoint" {
  region = "ap-southeast-2"
  vpc_id = "vpc-example"
  egress = []

  ingress = [
    {
      from_port       = 443
      to_port         = 443
      protocol        = "tcp"
      cidr_blocks     = []
      security_groups = ["sg-task"]
    },
  ]
}
