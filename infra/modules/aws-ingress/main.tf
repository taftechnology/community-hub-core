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
