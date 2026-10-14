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

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:ap-southeast-2:123456789012:certificate/mock"
      domain_validation_options = [
        {
          domain_name           = "au.api.example"
          resource_record_name  = "_x.au.api.example."
          resource_record_type  = "CNAME"
          resource_record_value = "_x.acm-validations.aws."
        },
      ]
    }
  }

  mock_resource "aws_apigatewayv2_domain_name" {
    defaults = {
      id = "domain-mock"
      domain_name_configuration = {
        target_domain_name = "d-mock.execute-api.ap-southeast-2.amazonaws.com"
        hosted_zone_id     = "ZMOCK"
      }
    }
  }
}

run "staging_unset" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    zone_name              = "communityhub-staging.net"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    service_image          = null
    attach_public_dns      = true
    create_public_zone     = false
    public_zone_id         = "ZSTAGING"
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

  override_resource {
    target = aws_apigatewayv2_api.tenant
    values = {
      id = "api-tenant"
    }
    override_during = plan
  }

  override_resource {
    target = aws_apigatewayv2_api.ops
    values = {
      id = "api-ops"
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
    condition     = aws_apigatewayv2_api.tenant.id == "api-tenant" && aws_apigatewayv2_api.ops.id == "api-ops" && aws_apigatewayv2_api.tenant.disable_execute_api_endpoint == true && aws_apigatewayv2_api.ops.disable_execute_api_endpoint == true
    error_message = "tenant and ops are two APIs and both disable execute-api"
  }

  assert {
    condition = (
      length(aws_apigatewayv2_api.tenant.cors_configuration) == 1 &&
      aws_apigatewayv2_api.tenant.cors_configuration[0].allow_credentials == false &&
      join(",", tolist(aws_apigatewayv2_api.tenant.cors_configuration[0].allow_origins)) == "https://admin.communityhub-staging.net" &&
      join(",", sort(tolist(aws_apigatewayv2_api.tenant.cors_configuration[0].allow_methods))) == "GET,OPTIONS,POST" &&
      join(",", sort(tolist(aws_apigatewayv2_api.tenant.cors_configuration[0].allow_headers))) == "authorization,content-type" &&
      length(aws_apigatewayv2_api.ops.cors_configuration) == 0
    )
    error_message = "tenant CORS allows the admin origin, GET, POST, and OPTIONS, and the authorization and content-type headers, without credentials"
  }

  assert {
    condition = (
      aws_apigatewayv2_integration.tenant.integration_uri == "arn:aws:servicediscovery:ap-southeast-2:123456789012:service/srv-mock" &&
      aws_apigatewayv2_integration.ops.integration_uri == "arn:aws:servicediscovery:ap-southeast-2:123456789012:service/srv-mock" &&
      aws_apigatewayv2_integration.tenant.connection_id == "vpclink-mock" &&
      aws_apigatewayv2_integration.ops.connection_id == "vpclink-mock" &&
      aws_apigatewayv2_integration.tenant.request_parameters["overwrite:header.x-community-hub-hostname"] == "$context.domainName" &&
      aws_apigatewayv2_integration.tenant.request_parameters["overwrite:header.x-community-hub-client-ip"] == "$context.identity.sourceIp" &&
      aws_apigatewayv2_integration.tenant.request_parameters["overwrite:header.x-community-hub-request-id"] == "$context.requestId" &&
      aws_apigatewayv2_integration.ops.request_parameters["overwrite:header.x-community-hub-hostname"] == "$context.domainName"
    )
    error_message = "both integrations target Cloud Map through the VPC link and overwrite the three trusted headers"
  }

  assert {
    condition = (
      aws_apigatewayv2_stage.tenant.name == "$default" &&
      aws_apigatewayv2_stage.ops.name == "$default" &&
      aws_apigatewayv2_stage.tenant.default_route_settings[0].throttling_rate_limit == 50 &&
      aws_apigatewayv2_stage.tenant.default_route_settings[0].throttling_burst_limit == 100 &&
      aws_apigatewayv2_stage.ops.default_route_settings[0].throttling_rate_limit == 10 &&
      aws_apigatewayv2_stage.ops.default_route_settings[0].throttling_burst_limit == 20 &&
      length(aws_apigatewayv2_stage.ops.route_settings) == 0 &&
      toset([for key, route in aws_apigatewayv2_route.tenant_write : route.route_key]) == toset(keys(output.tenant_write_throttle)) &&
      length(output.tenant_write_throttle) == 8 &&
      alltrue([for key, throttle in output.tenant_write_throttle : throttle.rate == 10 && throttle.burst == 20]) &&
      length([for setting in aws_apigatewayv2_stage.tenant.route_settings : setting.route_key]) == 8 &&
      toset([for setting in aws_apigatewayv2_stage.tenant.route_settings : setting.route_key]) == toset(keys(output.tenant_write_throttle)) &&
      alltrue([
        for setting in aws_apigatewayv2_stage.tenant.route_settings :
        setting.throttling_rate_limit == 10 && setting.throttling_burst_limit == 20
      ])
    )
    error_message = "the stage write caps are the eight keys at 10 and 20, the output matches, and ops has no write route"
  }

  assert {
    condition = (
      aws_cloudwatch_log_group.api_access.retention_in_days == 14 &&
      aws_cloudwatch_log_group.ops_access.retention_in_days == 14 &&
      strcontains(aws_apigatewayv2_stage.tenant.access_log_settings[0].format, "$context.integrationErrorMessage") &&
      strcontains(aws_apigatewayv2_stage.tenant.access_log_settings[0].format, "$context.integration.status") &&
      strcontains(aws_apigatewayv2_stage.tenant.access_log_settings[0].format, "$context.domainName") &&
      !strcontains(aws_apigatewayv2_stage.tenant.access_log_settings[0].format, "requestQueryString") &&
      !strcontains(aws_apigatewayv2_stage.ops.access_log_settings[0].format, "sourceIp") &&
      !strcontains(aws_apigatewayv2_stage.tenant.access_log_settings[0].format, "sourceIp")
    )
    error_message = "access logs keep the parent fields plus integration error, integration status, and domain name, and omit the query string and client IP"
  }

  assert {
    condition = (
      output.api_hostname == "au.api.communityhub-staging.net" &&
      output.auth_hostname == "auth.au.communityhub-staging.net" &&
      output.webhooks_hostname == "webhooks.au.communityhub-staging.net" &&
      output.ops_hostname == "ops.au.communityhub-staging.net" &&
      length(aws_acm_certificate.this) == 1 &&
      length(aws_route53_record.caa) == 1 &&
      one(aws_route53_record.caa[0].records) == "0 issue \"amazon.com\"" &&
      length(aws_route53_record.alias) == 4 &&
      length(aws_apigatewayv2_domain_name.hostname) == 4 &&
      length(aws_route53_zone.public) == 0 &&
      aws_apigatewayv2_api_mapping.hostname[output.ops_hostname].api_id == "api-ops" &&
      aws_apigatewayv2_api_mapping.hostname[output.api_hostname].api_id == "api-tenant" &&
      aws_apigatewayv2_api_mapping.hostname[output.auth_hostname].api_id == "api-tenant" &&
      aws_apigatewayv2_api_mapping.hostname[output.webhooks_hostname].api_id == "api-tenant"
    )
    error_message = "staging attaches one certificate, the Amazon CAA record, and four aliases; ops.au maps to the ops API and the other three map to the tenant API"
  }

  assert {
    condition     = length(aws_ecs_cluster.this) == 0 && length(aws_ecs_task_definition.this) == 0 && length(aws_ecs_service.this) == 0 && length(aws_vpc_security_group_ingress_rule.task_api) == 0
    error_message = "image unset plans no cluster, task definition, ECS service, or task-group inbound rule"
  }

  assert {
    condition     = aws_service_discovery_service.this.dns_config[0].dns_records[0].type == "SRV" && aws_service_discovery_service.this.health_check_custom_config[0].failure_threshold == 1
    error_message = "Cloud Map publishes SRV and sets failure_threshold 1"
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
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    zone_name              = "communityhub-staging.net"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    service_image          = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service:latest"
  }

  expect_failures = [var.service_image]
}

run "foreign_registry_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    zone_name              = "communityhub-staging.net"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    service_image          = "public.ecr.aws/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  expect_failures = [var.service_image]
}

run "other_region_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    zone_name              = "communityhub-staging.net"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    service_image          = "123456789012.dkr.ecr.us-east-1.amazonaws.com/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  expect_failures = [var.service_image]
}

run "uppercase_digest_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    zone_name              = "communityhub-staging.net"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    service_image          = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service@sha256:0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  expect_failures = [var.service_image]
}

run "trailing_suffix_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    zone_name              = "communityhub-staging.net"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    service_image          = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef-extra"
  }

  expect_failures = [var.service_image]
}

run "record_type_a_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    zone_name              = "communityhub-staging.net"
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
    zone_name              = "communityhub-staging.net"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a"]
    task_security_group_id = "sg-task"
  }

  expect_failures = [var.private_subnet_ids]
}

run "named_stage_without_overwrite_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    zone_name              = "communityhub-staging.net"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    stage_name             = "v1"
    overwrite_request_path = false
  }

  expect_failures = [var.stage_name]
}

run "execute_api_on_fails" {
  command = plan

  variables {
    aws_region                   = "ap-southeast-2"
    aws_account_id               = "123456789012"
    name                         = "ch-staging"
    environment                  = "staging"
    project                      = "community-hub"
    zone_name                    = "communityhub-staging.net"
    vpc_id                       = "vpc-example"
    private_subnet_ids           = ["subnet-a", "subnet-b"]
    task_security_group_id       = "sg-task"
    disable_execute_api_endpoint = false
  }

  expect_failures = [var.disable_execute_api_endpoint]
}

run "access_log_retention_zero_fails" {
  command = plan

  variables {
    aws_region                = "ap-southeast-2"
    aws_account_id            = "123456789012"
    name                      = "ch-staging"
    environment               = "staging"
    project                   = "community-hub"
    zone_name                 = "communityhub-staging.net"
    vpc_id                    = "vpc-example"
    private_subnet_ids        = ["subnet-a", "subnet-b"]
    task_security_group_id    = "sg-task"
    access_log_retention_days = 0
  }

  expect_failures = [var.access_log_retention_days]
}

run "production_zone_only" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-prod"
    environment            = "prod"
    project                = "community-hub"
    zone_name              = "communityhub.one"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    create_public_zone     = true
    attach_public_dns      = false
    public_zone_id         = null
  }

  assert {
    condition = (
      length(aws_route53_zone.public) == 1 &&
      length(aws_acm_certificate.this) == 0 &&
      length(aws_acm_certificate_validation.this) == 0 &&
      length(aws_apigatewayv2_domain_name.hostname) == 0 &&
      length(aws_apigatewayv2_api_mapping.hostname) == 0 &&
      length(aws_route53_record.caa) == 0 &&
      output.api_hostname == "au.api.communityhub.one"
    )
    error_message = "production creates the zone only and still sets the four hostnames"
  }

  assert {
    condition     = length(aws_ecs_cluster.this) == 0 && length(aws_ecs_task_definition.this) == 0 && length(aws_ecs_service.this) == 0 && length(aws_vpc_security_group_ingress_rule.task_api) == 0
    error_message = "image unset plans no cluster, task definition, ECS service, or task-group inbound rule"
  }
}

run "tls_below_1_2_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    zone_name              = "communityhub-staging.net"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    minimum_tls_version    = "TLS_1_0"
  }

  expect_failures = [var.minimum_tls_version]
}

run "attach_without_zone_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    zone_name              = "communityhub-staging.net"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    attach_public_dns      = true
    create_public_zone     = false
    public_zone_id         = null
  }

  expect_failures = [var.attach_public_dns]
}

run "zone_id_with_create_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    zone_name              = "communityhub-staging.net"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    create_public_zone     = true
    public_zone_id         = "ZSTAGING"
    attach_public_dns      = false
  }

  expect_failures = [var.create_public_zone]
}

run "staging_image_set" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    zone_name              = "communityhub-staging.net"
    attach_public_dns      = true
    create_public_zone     = false
    public_zone_id         = "ZSTAGING"
    service_image          = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    task_subnet_ids        = ["subnet-public"]
    execution_role_arn     = "arn:aws:iam::123456789012:role/ch-staging-execution"
    execution_role_name    = "ch-staging-execution"
    task_role_arn          = "arn:aws:iam::123456789012:role/ch-staging-task"
    log_group_name         = "/community-hub/ch-staging/service"
    db_host                = "ch-staging-postgres.example.ap-southeast-2.rds.amazonaws.com"
    db_port                = 5432
    envelope_key_arn       = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
    app_secret_arn         = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app"
    identity_secret_arn    = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity"
    platform_secret_arn    = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform"
    capacity_provider      = "FARGATE_SPOT"
    desired_count          = 0
  }

  override_resource {
    target = aws_security_group.vpc_link
    values = {
      id = "sg-vpc-link"
    }
    override_during = plan
  }

  assert {
    condition = (
      aws_ecs_task_definition.this[0].runtime_platform[0].cpu_architecture == "ARM64" &&
      aws_ecs_task_definition.this[0].cpu == "256" &&
      aws_ecs_task_definition.this[0].memory == "512" &&
      aws_ecs_service.this[0].desired_count == 0 &&
      aws_ecs_service.this[0].deployment_minimum_healthy_percent == 100 &&
      aws_ecs_service.this[0].deployment_maximum_percent == 200 &&
      aws_ecs_service.this[0].deployment_circuit_breaker[0].enable == true &&
      aws_ecs_service.this[0].deployment_circuit_breaker[0].rollback == true &&
      one(aws_ecs_cluster.this[0].setting).value == "disabled" &&
      one(aws_ecs_service.this[0].capacity_provider_strategy).capacity_provider == "FARGATE_SPOT" &&
      aws_ecs_task_definition.this[0].execution_role_arn == "arn:aws:iam::123456789012:role/ch-staging-execution" &&
      aws_ecs_task_definition.this[0].task_role_arn == "arn:aws:iam::123456789012:role/ch-staging-task" &&
      aws_ecs_service.this[0].service_registries[0].container_name == "service" &&
      aws_ecs_service.this[0].service_registries[0].container_port == 8080
    )
    error_message = "the task is ARM64 at 0.25 vCPU and 0.5 GB, desired count 0, with the deployment cap and Container Insights off"
  }

  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.this[0].container_definitions)[0].environment == [
        { name = "PORT", value = "8080" },
        { name = "AWS_REGION", value = "ap-southeast-2" },
        { name = "NODE_ENV", value = "production" },
        { name = "COMMUNITY_HUB_ENVIRONMENT", value = "staging" },
        { name = "PGHOST", value = "ch-staging-postgres.example.ap-southeast-2.rds.amazonaws.com" },
        { name = "PGPORT", value = "5432" },
        { name = "PGDATABASE", value = "communityhub" },
        { name = "PGUSER_APP", value = "app" },
        { name = "PGUSER_IDENTITY", value = "identity" },
        { name = "PGUSER_PLATFORM", value = "platform" },
        { name = "ENVELOPE_KEY_ARN", value = "arn:aws:kms:ap-southeast-2:123456789012:key/mock" },
        { name = "API_HOSTNAME", value = "au.api.communityhub-staging.net" },
        { name = "AUTH_HOSTNAME", value = "auth.au.communityhub-staging.net" },
        { name = "WEBHOOKS_HOSTNAME", value = "webhooks.au.communityhub-staging.net" },
        { name = "OPS_HOSTNAME", value = "ops.au.communityhub-staging.net" },
        { name = "APP_SECRET_ARN", value = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app" },
        { name = "IDENTITY_SECRET_ARN", value = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity" },
        { name = "PLATFORM_SECRET_ARN", value = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform" },
      ] &&
      [for secret in jsondecode(aws_ecs_task_definition.this[0].container_definitions)[0].secrets : secret.name] == ["PGPASSWORD_APP", "PGPASSWORD_IDENTITY", "PGPASSWORD_PLATFORM"] &&
      jsondecode(aws_ecs_task_definition.this[0].container_definitions)[0].healthCheck.command == ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
    )
    error_message = "environment, secret names, PGDATABASE, and the health command match the contract table"
  }

  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.this[0].container_definitions)[0].user == "node" &&
      jsondecode(aws_ecs_task_definition.this[0].container_definitions)[0].readonlyRootFilesystem == true &&
      jsondecode(aws_ecs_task_definition.this[0].container_definitions)[0].stopTimeout == 30 &&
      length([
        for mount in jsondecode(aws_ecs_task_definition.this[0].container_definitions)[0].mountPoints :
        mount if mount.containerPath == "/tmp"
      ]) == 1 &&
      jsondecode(aws_ecs_task_definition.this[0].container_definitions)[0].logConfiguration.options["awslogs-group"] == "/community-hub/ch-staging/service" &&
      jsondecode(aws_ecs_task_definition.this[0].container_definitions)[0].logConfiguration.options["awslogs-stream-prefix"] == "service"
    )
    error_message = "the container runs as node, writes only /tmp, stops in 30 seconds, and logs to the service group"
  }

  assert {
    condition     = aws_ecs_service.this[0].network_configuration[0].assign_public_ip == true
    error_message = "the service assigns a public IP"
  }

  assert {
    condition     = toset(aws_ecs_cluster_capacity_providers.this[0].capacity_providers) == toset(["FARGATE", "FARGATE_SPOT"])
    error_message = "the cluster associates FARGATE and FARGATE_SPOT exactly"
  }

  assert {
    condition = (
      length(jsondecode(aws_iam_role_policy.pull[0].policy).Statement) == 2 &&
      jsondecode(aws_iam_role_policy.pull[0].policy).Statement[0].Action == "ecr:GetAuthorizationToken" &&
      toset(jsondecode(aws_iam_role_policy.pull[0].policy).Statement[1].Action) == toset([
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
      ])
    )
    error_message = "the pull policy has exactly the four pull actions and no push action"
  }

  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.task_api[0].from_port == 8080 &&
      aws_vpc_security_group_ingress_rule.task_api[0].to_port == 8080 &&
      aws_vpc_security_group_ingress_rule.task_api[0].ip_protocol == "tcp" &&
      aws_vpc_security_group_ingress_rule.task_api[0].security_group_id == "sg-task" &&
      aws_vpc_security_group_ingress_rule.task_api[0].referenced_security_group_id == "sg-vpc-link"
    )
    error_message = "task_api is TCP 8080 from the VPC link group onto the task group"
  }
}

run "x86_64_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    zone_name              = "communityhub-staging.net"
    cpu_architecture       = "X86_64"
  }

  expect_failures = [var.cpu_architecture]
}

run "spot_in_prod_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-prod"
    environment            = "prod"
    project                = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    zone_name              = "communityhub.one"
    create_public_zone     = true
    attach_public_dns      = false
    capacity_provider      = "FARGATE_SPOT"
  }

  expect_failures = [var.capacity_provider]
}

run "mail_address_alone_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    zone_name              = "communityhub-staging.net"
    mail_from_address      = "no-reply@mail.communityhub-staging.net"
  }

  expect_failures = [var.mail_from_address]
}

run "mail_set_alone_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    zone_name              = "communityhub-staging.net"
    ses_configuration_set  = "ch-staging-mail"
  }

  expect_failures = [var.mail_from_address]
}

run "mail_malformed_address_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    zone_name              = "communityhub-staging.net"
    mail_from_address      = "not-an-email"
    ses_configuration_set  = "ch-staging-mail"
  }

  expect_failures = [var.mail_from_address]
}

run "mail_malformed_set_fails" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    zone_name              = "communityhub-staging.net"
    mail_from_address      = "no-reply@mail.communityhub-staging.net"
    ses_configuration_set  = "invalid set name with spaces!"
  }

  expect_failures = [var.ses_configuration_set]
}

run "mail_variables_into_task" {
  command = plan

  variables {
    aws_region             = "ap-southeast-2"
    aws_account_id         = "123456789012"
    name                   = "ch-staging"
    environment            = "staging"
    project                = "community-hub"
    vpc_id                 = "vpc-example"
    private_subnet_ids     = ["subnet-a", "subnet-b"]
    task_security_group_id = "sg-task"
    zone_name              = "communityhub-staging.net"
    attach_public_dns      = true
    create_public_zone     = false
    public_zone_id         = "ZSTAGING"
    service_image          = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    task_subnet_ids        = ["subnet-public"]
    execution_role_arn     = "arn:aws:iam::123456789012:role/ch-staging-execution"
    execution_role_name    = "ch-staging-execution"
    task_role_arn          = "arn:aws:iam::123456789012:role/ch-staging-task"
    log_group_name         = "/community-hub/ch-staging/service"
    db_host                = "ch-staging-postgres.example.ap-southeast-2.rds.amazonaws.com"
    db_port                = 5432
    envelope_key_arn       = "arn:aws:kms:ap-southeast-2:123456789012:key/mock"
    app_secret_arn         = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app"
    identity_secret_arn    = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity"
    platform_secret_arn    = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform"
    capacity_provider      = "FARGATE_SPOT"
    desired_count          = 0
    mail_from_address      = "no-reply@mail.communityhub-staging.net"
    ses_configuration_set  = "ch-staging-mail"
  }

  override_resource {
    target = aws_security_group.vpc_link
    values = {
      id = "sg-vpc-link"
    }
    override_during = plan
  }

  assert {
    condition = (
      output.service_environment["MAIL_FROM_ADDRESS"] == "no-reply@mail.communityhub-staging.net" &&
      output.service_environment["SES_CONFIGURATION_SET"] == "ch-staging-mail"
    )
    error_message = "the task definition environment contains MAIL_FROM_ADDRESS and SES_CONFIGURATION_SET"
  }
}

