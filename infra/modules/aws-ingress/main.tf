resource "aws_service_discovery_private_dns_namespace" "this" {
  region = var.aws_region
  name   = "${var.name}.local"
  vpc    = var.vpc_id

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_service_discovery_service" "this" {
  region = var.aws_region
  name   = "service"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.this.id

    dns_records {
      ttl  = 10
      type = var.cloud_map_record_type
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {}

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_security_group" "vpc_link" {
  region      = var.aws_region
  name        = "${var.name}-vpc-link"
  description = "VPC link. No inbound. Outbound TCP 8080 to the task group."
  vpc_id      = var.vpc_id

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_vpc_security_group_egress_rule" "vpc_link_task" {
  region                       = var.aws_region
  security_group_id            = aws_security_group.vpc_link.id
  referenced_security_group_id = var.task_security_group_id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  description                  = "HTTP to the task"
}

resource "aws_vpc_security_group_ingress_rule" "task_api" {
  count = 0

  region                       = var.aws_region
  security_group_id            = var.task_security_group_id
  referenced_security_group_id = aws_security_group.vpc_link.id
  ip_protocol                  = "tcp"
  from_port                    = 8080
  to_port                      = 8080
  description                  = "HTTP from the VPC link"
}

resource "aws_apigatewayv2_vpc_link" "this" {
  region             = var.aws_region
  name               = "${var.name}-link"
  subnet_ids         = var.private_subnet_ids
  security_group_ids = [aws_security_group.vpc_link.id]

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_ecr_repository" "service" {
  region               = var.aws_region
  name                 = "${var.name}/service"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_ecr_lifecycle_policy" "service" {
  region     = var.aws_region
  repository = aws_ecr_repository.service.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the 10 newest tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 10
        }
        action = {
          type = "expire"
        }
      }
    ]
  })
}

locals {
  tenant_write_rate  = 10
  tenant_write_burst = 20
  tenant_write_route_keys = flatten([
    for method in ["POST", "PUT", "PATCH", "DELETE"] : [
      "${method} /",
      "${method} /{proxy+}",
    ]
  ])

  access_log_format = jsonencode({
    httpMethod              = "$context.httpMethod"
    routeKey                = "$context.routeKey"
    status                  = "$context.status"
    responseLatency         = "$context.responseLatency"
    responseLength          = "$context.responseLength"
    requestId               = "$context.requestId"
    integrationErrorMessage = "$context.integrationErrorMessage"
    integrationStatus       = "$context.integration.status"
    domainName              = "$context.domainName"
  })

  header_parameters = merge(
    {
      "overwrite:header.x-community-hub-hostname"   = "$context.domainName"
      "overwrite:header.x-community-hub-client-ip"  = "$context.identity.sourceIp"
      "overwrite:header.x-community-hub-request-id" = "$context.requestId"
    },
    var.overwrite_request_path ? { "overwrite:path" = "$request.path" } : {},
  )
}

resource "aws_cloudwatch_log_group" "api_access" {
  region            = var.aws_region
  name              = "/community-hub/${var.name}/api-access"
  retention_in_days = var.access_log_retention_days

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_cloudwatch_log_group" "ops_access" {
  region            = var.aws_region
  name              = "/community-hub/${var.name}/ops-access"
  retention_in_days = var.access_log_retention_days

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_apigatewayv2_api" "tenant" {
  region                       = var.aws_region
  name                         = "${var.name}-tenant"
  protocol_type                = "HTTP"
  disable_execute_api_endpoint = var.disable_execute_api_endpoint

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_apigatewayv2_api" "ops" {
  region                       = var.aws_region
  name                         = "${var.name}-ops"
  protocol_type                = "HTTP"
  disable_execute_api_endpoint = var.disable_execute_api_endpoint

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_apigatewayv2_integration" "tenant" {
  region                 = var.aws_region
  api_id                 = aws_apigatewayv2_api.tenant.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.this.id
  integration_uri        = aws_service_discovery_service.this.arn
  timeout_milliseconds   = 30000
  payload_format_version = "1.0"
  request_parameters     = local.header_parameters
}

resource "aws_apigatewayv2_integration" "ops" {
  region                 = var.aws_region
  api_id                 = aws_apigatewayv2_api.ops.id
  integration_type       = "HTTP_PROXY"
  integration_method     = "ANY"
  connection_type        = "VPC_LINK"
  connection_id          = aws_apigatewayv2_vpc_link.this.id
  integration_uri        = aws_service_discovery_service.this.arn
  timeout_milliseconds   = 30000
  payload_format_version = "1.0"
  request_parameters     = local.header_parameters
}

resource "aws_apigatewayv2_route" "tenant_default" {
  region    = var.aws_region
  api_id    = aws_apigatewayv2_api.tenant.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.tenant.id}"
}

resource "aws_apigatewayv2_route" "ops_default" {
  region    = var.aws_region
  api_id    = aws_apigatewayv2_api.ops.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.ops.id}"
}

resource "aws_apigatewayv2_route" "tenant_write" {
  for_each = toset(local.tenant_write_route_keys)

  region    = var.aws_region
  api_id    = aws_apigatewayv2_api.tenant.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.tenant.id}"
}

resource "aws_apigatewayv2_stage" "tenant" {
  region      = var.aws_region
  api_id      = aws_apigatewayv2_api.tenant.id
  name        = var.stage_name
  auto_deploy = true

  depends_on = [aws_apigatewayv2_route.tenant_write]

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format          = local.access_log_format
  }

  default_route_settings {
    throttling_rate_limit  = 50
    throttling_burst_limit = 100
  }

  dynamic "route_settings" {
    for_each = toset(local.tenant_write_route_keys)
    content {
      route_key              = route_settings.value
      throttling_rate_limit  = local.tenant_write_rate
      throttling_burst_limit = local.tenant_write_burst
    }
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_apigatewayv2_stage" "ops" {
  region      = var.aws_region
  api_id      = aws_apigatewayv2_api.ops.id
  name        = var.stage_name
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.ops_access.arn
    format          = local.access_log_format
  }

  default_route_settings {
    throttling_rate_limit  = 10
    throttling_burst_limit = 20
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}
