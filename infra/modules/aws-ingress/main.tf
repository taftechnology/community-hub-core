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

  health_check_custom_config {
    failure_threshold = 1
  }

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
  count = var.service_image == null ? 0 : 1

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
  admin_origin      = "https://admin.${var.zone_name}"
  api_hostname      = "au.api.${var.zone_name}"
  auth_hostname     = "auth.au.${var.zone_name}"
  webhooks_hostname = "webhooks.au.${var.zone_name}"
  ops_hostname      = "ops.au.${var.zone_name}"
  public_zone_id    = var.create_public_zone ? aws_route53_zone.public[0].zone_id : var.public_zone_id
  hostname_to_api_id = var.attach_public_dns ? {
    (local.api_hostname)      = aws_apigatewayv2_api.tenant.id
    (local.auth_hostname)     = aws_apigatewayv2_api.tenant.id
    (local.webhooks_hostname) = aws_apigatewayv2_api.tenant.id
    (local.ops_hostname)      = aws_apigatewayv2_api.ops.id
  } : {}

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

  cors_configuration {
    allow_credentials = false
    allow_headers     = ["authorization", "content-type"]
    allow_methods     = ["GET", "POST", "OPTIONS"]
    allow_origins     = [local.admin_origin]
  }

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

resource "aws_route53_zone" "public" {
  count = var.create_public_zone ? 1 : 0
  name  = var.zone_name

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_acm_certificate" "this" {
  count             = var.attach_public_dns ? 1 : 0
  region            = var.aws_region
  domain_name       = local.api_hostname
  validation_method = "DNS"
  subject_alternative_names = [
    local.auth_hostname,
    local.webhooks_hostname,
    local.ops_hostname,
  ]

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_route53_record" "validation" {
  for_each = var.attach_public_dns ? {
    for option in aws_acm_certificate.this[0].domain_validation_options : option.domain_name => {
      name  = option.resource_record_name
      type  = option.resource_record_type
      value = option.resource_record_value
    }
  } : {}

  zone_id = local.public_zone_id
  name    = each.value.name
  type    = each.value.type
  ttl     = 60
  records = [each.value.value]
}

resource "aws_acm_certificate_validation" "this" {
  count                   = var.attach_public_dns ? 1 : 0
  region                  = var.aws_region
  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]
}

resource "aws_apigatewayv2_domain_name" "hostname" {
  for_each = local.hostname_to_api_id

  region      = var.aws_region
  domain_name = each.key

  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.this[0].certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = var.minimum_tls_version
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_apigatewayv2_api_mapping" "hostname" {
  for_each = local.hostname_to_api_id

  region      = var.aws_region
  api_id      = each.value
  domain_name = aws_apigatewayv2_domain_name.hostname[each.key].id
  stage       = each.key == local.ops_hostname ? aws_apigatewayv2_stage.ops.name : aws_apigatewayv2_stage.tenant.name
}

resource "aws_route53_record" "alias" {
  for_each = local.hostname_to_api_id

  zone_id = local.public_zone_id
  name    = each.key
  type    = "A"

  alias {
    name                   = aws_apigatewayv2_domain_name.hostname[each.key].domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.hostname[each.key].domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "caa" {
  count = var.attach_public_dns ? 1 : 0

  zone_id = local.public_zone_id
  name    = var.zone_name
  type    = "CAA"
  ttl     = 300
  records = ["0 issue \"amazon.com\""]
}

resource "aws_ecs_cluster" "this" {
  count  = var.service_image == null ? 0 : 1
  region = var.aws_region
  name   = var.name

  setting {
    name  = "containerInsights"
    value = "disabled"
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_ecs_task_definition" "this" {
  count                    = var.service_image == null ? 0 : 1
  region                   = var.aws_region
  family                   = var.name
  cpu                      = "256"
  memory                   = "512"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  runtime_platform {
    cpu_architecture        = var.cpu_architecture
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "service"
      image     = var.service_image
      essential = true
      user      = "node"
      portMappings = [{
        containerPort = 8080
        protocol      = "tcp"
        name          = "service"
      }]
      readonlyRootFilesystem = true
      stopTimeout            = 30
      mountPoints = [{
        sourceVolume  = "tmp"
        containerPath = "/tmp"
        readOnly      = false
      }]
      environment = concat(
        [
          { name = "PORT", value = "8080" },
          { name = "AWS_REGION", value = "ap-southeast-2" },
          { name = "NODE_ENV", value = "production" },
          { name = "COMMUNITY_HUB_ENVIRONMENT", value = var.environment },
          { name = "PGHOST", value = var.db_host },
          { name = "PGPORT", value = tostring(var.db_port) },
          { name = "PGDATABASE", value = "communityhub" },
          { name = "PGUSER_APP", value = "app" },
          { name = "PGUSER_IDENTITY", value = "identity" },
          { name = "PGUSER_PLATFORM", value = "platform" },
          { name = "ENVELOPE_KEY_ARN", value = var.envelope_key_arn },
          { name = "API_HOSTNAME", value = local.api_hostname },
          { name = "AUTH_HOSTNAME", value = local.auth_hostname },
          { name = "WEBHOOKS_HOSTNAME", value = local.webhooks_hostname },
          { name = "OPS_HOSTNAME", value = local.ops_hostname },
          { name = "APP_SECRET_ARN", value = var.app_secret_arn },
          { name = "IDENTITY_SECRET_ARN", value = var.identity_secret_arn },
          { name = "PLATFORM_SECRET_ARN", value = var.platform_secret_arn },
        ],
        var.mail_from_address == null ? [] : [{ name = "MAIL_FROM_ADDRESS", value = var.mail_from_address }],
        var.ses_configuration_set == null ? [] : [{ name = "SES_CONFIGURATION_SET", value = var.ses_configuration_set }],
        var.billing_secret_arn == null ? [] : [{ name = "ADMIN_ORIGIN", value = local.admin_origin }, { name = "BILLING_SECRET_ARN", value = var.billing_secret_arn }],
      )
      secrets = concat(
        [
          { name = "PGPASSWORD_APP", valueFrom = var.app_secret_arn },
          { name = "PGPASSWORD_IDENTITY", valueFrom = var.identity_secret_arn },
          { name = "PGPASSWORD_PLATFORM", valueFrom = var.platform_secret_arn },
        ],
        var.turnstile_secret_arn == null ? [] : [{ name = "TURNSTILE_SECRET", valueFrom = var.turnstile_secret_arn }],
      )
      healthCheck = {
        command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = var.log_group_name
          awslogs-region        = "ap-southeast-2"
          awslogs-stream-prefix = "service"
        }
      }
    }
  ])

  volume {
    name = "tmp"
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  count        = var.service_image == null ? 0 : 1
  region       = var.aws_region
  cluster_name = aws_ecs_cluster.this[0].name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

resource "aws_ecs_service" "this" {
  count                  = var.service_image == null ? 0 : 1
  region                 = var.aws_region
  name                   = var.name
  cluster                = aws_ecs_cluster.this[0].id
  task_definition        = aws_ecs_task_definition.this[0].arn
  desired_count          = var.desired_count
  enable_execute_command = false

  depends_on = [
    aws_ecs_cluster_capacity_providers.this,
    aws_iam_role_policy.pull,
    aws_vpc_security_group_ingress_rule.task_api,
  ]

  capacity_provider_strategy {
    capacity_provider = var.capacity_provider
    weight            = 1
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.task_subnet_ids
    security_groups  = [var.task_security_group_id]
    assign_public_ip = true
  }

  service_registries {
    registry_arn   = aws_service_discovery_service.this.arn
    container_name = "service"
    container_port = 8080
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_iam_role_policy" "pull" {
  count = var.service_image == null ? 0 : 1
  name  = "${var.name}-ecr-pull"
  role  = var.execution_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ]
        Resource = aws_ecr_repository.service.arn
      },
    ]
  })
}
