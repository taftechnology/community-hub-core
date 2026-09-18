mock_provider "aws" {}

run "staging_happy" {
  command = plan

  variables {
    aws_region = "ap-southeast-2"
    name       = "ch-staging"
  }

  override_resource {
    target = aws_security_group.connector
    values = {
      id = "sg-connector"
    }
    override_during = plan
  }

  assert {
    condition     = aws_vpc.this.region == "ap-southeast-2"
    error_message = "VPC region argument must be ap-southeast-2"
  }

  assert {
    condition     = length(aws_security_group.connector.ingress) == 0
    error_message = "connector security group must set ingress = []"
  }

  assert {
    condition     = aws_subnet.public.map_public_ip_on_launch == true
    error_message = "connector subnet must auto-assign public IPs"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.rds_postgres.from_port == 5432
    error_message = "RDS ingress must be port 5432"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.rds_postgres.to_port == 5432
    error_message = "RDS ingress must be port 5432"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.rds_postgres.referenced_security_group_id == "sg-connector"
    error_message = "RDS ingress must be limited to the connector security group"
  }
}

run "wrong_region_fails" {
  command = plan

  variables {
    aws_region = "us-east-1"
    name       = "ch-staging"
  }

  expect_failures = [var.aws_region]
}
