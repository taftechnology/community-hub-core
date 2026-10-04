mock_provider "aws" {}

run "staging_happy" {
  command = plan

  variables {
    aws_region  = "ap-southeast-2"
    name        = "ch-staging"
    environment = "staging"
    project     = "community-hub"
  }

  override_resource {
    target = aws_security_group.task
    values = {
      id = "sg-task"
    }
    override_during = plan
  }

  override_resource {
    target = aws_security_group.rds
    values = {
      id = "sg-rds"
    }
    override_during = plan
  }

  override_resource {
    target = aws_route_table.public
    values = {
      id = "rtb-public-mock"
    }
    override_during = plan
  }

  override_resource {
    target = aws_subnet.public_b
    values = {
      id = "subnet-public-b-mock"
    }
    override_during = plan
  }

  assert {
    condition     = aws_subnet.public_b.cidr_block == "10.64.3.0/24"
    error_message = "second public subnet CIDR must be 10.64.3.0/24"
  }

  assert {
    condition     = aws_subnet.public_b.availability_zone == "ap-southeast-2b"
    error_message = "second public subnet must be in ap-southeast-2b"
  }

  assert {
    condition     = aws_route_table_association.public_b.subnet_id == "subnet-public-b-mock"
    error_message = "public_b route table association must use the public_b subnet"
  }

  assert {
    condition     = aws_route_table_association.public_b.route_table_id == "rtb-public-mock"
    error_message = "public_b route table association must use the public route table"
  }

  assert {
    condition     = aws_vpc.this.region == "ap-southeast-2"
    error_message = "VPC region argument must be ap-southeast-2"
  }

  assert {
    condition = (
      aws_vpc.this.tags["environment"] == "staging" &&
      aws_vpc.this.tags["project"] == "community-hub"
    )
    error_message = "VPC tags must be environment=staging and project=community-hub"
  }

  assert {
    condition     = aws_subnet.public.map_public_ip_on_launch == true && aws_subnet.public_b.map_public_ip_on_launch == true
    error_message = "both public subnets must auto-assign public IPs"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.rds_postgres.referenced_security_group_id == "sg-task"
    error_message = "RDS ingress must be limited to the task security group"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.rds_postgres.from_port == 5432 && aws_vpc_security_group_ingress_rule.rds_postgres.to_port == 5432
    error_message = "RDS ingress must be port 5432"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.task_rds.from_port == 5432 && aws_vpc_security_group_egress_rule.task_rds.to_port == 5432 && aws_vpc_security_group_egress_rule.task_rds.referenced_security_group_id == "sg-rds"
    error_message = "task group must reach RDS on 5432"
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.task_https.from_port == 443 &&
      aws_vpc_security_group_egress_rule.task_https.to_port == 443 &&
      aws_vpc_security_group_egress_rule.task_https.cidr_ipv4 == "0.0.0.0/0"
    )
    error_message = "task group must allow outbound 443 to the internet"
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.task_https.from_port != 7844 &&
      aws_vpc_security_group_egress_rule.task_rds.from_port != 7844 &&
      aws_vpc_security_group_ingress_rule.rds_postgres.from_port != 7844
    )
    error_message = "task group must not allow port 7844"
  }
}

run "wrong_region_fails" {
  command = plan

  variables {
    aws_region  = "us-east-1"
    name        = "ch-staging"
    environment = "staging"
    project     = "community-hub"
  }

  expect_failures = [var.aws_region]
}
