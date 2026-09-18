resource "aws_security_group" "connector" {
  region = "ap-southeast-2"
  vpc_id = "vpc-example"
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
