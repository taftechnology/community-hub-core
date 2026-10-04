mock_provider "aws" {
  override_during = plan

  mock_resource "aws_ecr_repository" {
    defaults = {
      id  = "ecr-service"
      arn = "arn:aws:ecr:ap-southeast-2:123456789012:repository/ch-staging/service"
    }
  }

  mock_resource "aws_service_discovery_service" {
    defaults = {
      arn = "arn:aws:servicediscovery:ap-southeast-2:123456789012:service/srv-mock"
    }
  }
}

run "staging_unset" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    name           = "ch-staging"
    environment    = "staging"
    project        = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    service_image  = null
  }

  override_resource {
    target = aws_security_group.vpc_link
    values = {
      id = "sg-vpc-link"
    }
    override_during = plan
  }

  override_resource {
    target = aws_apigatewayv2_vpc_link.this
    values = {
      id = "vpclink-mock"
    }
    override_during = plan
  }

  assert {
    condition     = length(aws_apigatewayv2_vpc_link.this.subnet_ids) == 2 && contains(aws_apigatewayv2_vpc_link.this.security_group_ids, "sg-vpc-link")
    error_message = "VPC link uses both private subnets and its own security group"
  }

  assert {
    condition = (
      aws_vpc_security_group_egress_rule.vpc_link_task.ip_protocol == "tcp" &&
      aws_vpc_security_group_egress_rule.vpc_link_task.from_port == 8080 &&
      aws_vpc_security_group_egress_rule.vpc_link_task.to_port == 8080 &&
      aws_vpc_security_group_egress_rule.vpc_link_task.referenced_security_group_id == "sg-task"
    )
    error_message = "VPC link egress is TCP 8080 to the task group only"
  }

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.task_api) == 0
    error_message = "image unset plans no task-group inbound rule"
  }

  assert {
    condition = (
      length(regexall("(?m)^resource \"aws_security_group\" \"vpc_link\"", file("${path.module}/main.tf"))) == 1 &&
      length(regexall("(?m)^\\s*(ingress|egress)\\s*(=|\\{)", file("${path.module}/main.tf"))) == 0 &&
      length(regexall("(?m)^\\s*dynamic\\s+\"(ingress|egress)\"", file("${path.module}/main.tf"))) == 0
    )
    error_message = "the VPC link security group must not set inline or dynamic ingress or egress"
  }

  assert {
    condition     = aws_service_discovery_service.this.dns_config[0].dns_records[0].type == "SRV" && length(aws_service_discovery_service.this.health_check_custom_config) == 1
    error_message = "Cloud Map publishes SRV and sets the ECS custom-health block"
  }

  assert {
    condition     = aws_ecr_repository.service.image_tag_mutability == "IMMUTABLE" && aws_ecr_repository.service.force_delete == false && aws_ecr_repository.service.image_scanning_configuration[0].scan_on_push == true
    error_message = "ECR tags are immutable, scan on push is on, and the repository is not force-deleted"
  }

  assert {
    condition     = strcontains(aws_ecr_lifecycle_policy.service.policy, "\"tagStatus\":\"tagged\"") && strcontains(aws_ecr_lifecycle_policy.service.policy, "\"countNumber\":10") && !strcontains(aws_ecr_lifecycle_policy.service.policy, "untagged")
    error_message = "lifecycle policy keeps 10 tagged images and does not expire untagged manifests"
  }
}

run "image_tag_fails" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    name           = "ch-staging"
    environment    = "staging"
    project        = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    service_image  = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service:latest"
  }

  expect_failures = [var.service_image]
}

run "foreign_registry_fails" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    name           = "ch-staging"
    environment    = "staging"
    project        = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    service_image  = "public.ecr.aws/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  expect_failures = [var.service_image]
}

run "other_region_fails" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    name           = "ch-staging"
    environment    = "staging"
    project        = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    service_image  = "123456789012.dkr.ecr.us-east-1.amazonaws.com/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  expect_failures = [var.service_image]
}

run "uppercase_digest_fails" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    name           = "ch-staging"
    environment    = "staging"
    project        = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    service_image  = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service@sha256:0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  expect_failures = [var.service_image]
}

run "trailing_suffix_fails" {
  command = plan

  variables {
    aws_region     = "ap-southeast-2"
    aws_account_id = "123456789012"
    name           = "ch-staging"
    environment    = "staging"
    project        = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    service_image  = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef-extra"
  }

  expect_failures = [var.service_image]
}

run "record_type_a_fails" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    name                  = "ch-staging"
    environment           = "staging"
    project               = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    cloud_map_record_type  = "A"
  }

  expect_failures = [var.cloud_map_record_type]
}

run "one_subnet_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a"]
    task_security_group_id = "sg-task"
  }

  expect_failures = [var.private_subnet_ids]
}
