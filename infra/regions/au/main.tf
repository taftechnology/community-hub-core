provider "aws" {
  region = var.aws_region
}

locals {
  name           = "ch-${var.environment}"
  db_ops_count   = var.service_image != null && var.enable_database ? 1 : 0
  db_ops_log_arn = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:${module.envelope.log_group_name}"
}

resource "terraform_data" "prod_backup" {
  lifecycle {
    precondition {
      condition     = var.environment != "prod" || (var.deletion_protection && var.backup_retention_days >= 7)
      error_message = "prod must set deletion protection and backup retention."
    }
  }
}

check "prod_backup" {
  assert {
    condition     = var.environment != "prod" || (var.deletion_protection && var.backup_retention_days >= 7)
    error_message = "prod must set deletion protection and backup retention."
  }
}

resource "terraform_data" "prod_kms_endpoint" {
  lifecycle {
    precondition {
      condition     = var.environment != "prod" || var.enable_kms_endpoint
      error_message = "prod must enable the KMS endpoint."
    }
  }
}

check "prod_kms_endpoint" {
  assert {
    condition     = var.environment != "prod" || var.enable_kms_endpoint
    error_message = "prod must enable the KMS endpoint."
  }
}

resource "terraform_data" "staging_zone" {
  lifecycle {
    precondition {
      condition     = var.environment != "staging" || var.staging_zone_id != null
      error_message = "staging must pass the registered communityhub-staging.net zone id."
    }
  }
}

check "staging_zone" {
  assert {
    condition     = var.environment != "staging" || var.staging_zone_id != null
    error_message = "staging must pass the registered communityhub-staging.net zone id."
  }
}

resource "terraform_data" "prod_database" {
  lifecycle {
    precondition {
      condition     = var.environment != "prod" || var.enable_database
      error_message = "prod must keep the database."
    }
  }
}

check "prod_database" {
  assert {
    condition     = var.environment != "prod" || var.enable_database
    error_message = "prod must keep the database."
  }
}

resource "terraform_data" "image_needs_database" {
  lifecycle {
    precondition {
      condition     = var.enable_database || var.service_image == null
      error_message = "a set image needs the database."
    }
  }
}

check "image_needs_database" {
  assert {
    condition     = var.enable_database || var.service_image == null
    error_message = "a set image needs the database."
  }
}

module "network" {
  source = "../../modules/aws-network"

  aws_region  = var.aws_region
  name        = local.name
  environment = var.environment
  project     = "community-hub"
}

module "kms" {
  source = "../../modules/aws-kms-storage"

  aws_region     = var.aws_region
  aws_account_id = var.aws_account_id
  name           = local.name
  environment    = var.environment
  project        = "community-hub"
}

module "rds" {
  count  = var.enable_database ? 1 : 0
  source = "../../modules/aws-rds"

  aws_region             = var.aws_region
  name                   = local.name
  environment            = var.environment
  project                = "community-hub"
  subnet_ids             = module.network.private_subnet_ids
  vpc_security_group_ids = [module.network.rds_security_group_id]
  kms_key_arn            = module.kms.key_arn
  deletion_protection    = var.deletion_protection
  backup_retention_days  = var.backup_retention_days
  multi_az               = false
  alarm_topic_arn        = aws_sns_topic.alarms.arn
}

module "db_secrets" {
  source = "../../modules/aws-db-secrets"

  aws_region     = var.aws_region
  aws_account_id = var.aws_account_id
  name           = local.name
  environment    = var.environment
  project        = "community-hub"
}

module "budgets" {
  source = "../../modules/aws-budgets"

  enable_budgets = var.enable_budgets
  environment    = var.environment
  project        = "community-hub"
  name           = local.name
  alert_email    = var.alert_email
}

module "envelope" {
  source = "../../modules/aws-kms-envelope"

  aws_region             = var.aws_region
  aws_account_id         = var.aws_account_id
  name                   = local.name
  environment            = var.environment
  project                = "community-hub"
  vpc_id                 = module.network.vpc_id
  public_subnet_id       = module.network.public_subnet_id
  enable_kms_endpoint    = var.enable_kms_endpoint
  task_security_group_id = module.network.task_security_group_id
  db_secret_arns = [
    module.db_secrets.app_secret_arn,
    module.db_secrets.identity_secret_arn,
    module.db_secrets.platform_secret_arn,
  ]
  db_secrets_key_arn = module.db_secrets.key_arn
}

resource "aws_sns_topic" "alarms" {
  region = var.aws_region
  name   = "${local.name}-alarms"

  tags = {
    environment = var.environment
    project     = "community-hub"
  }
}

resource "aws_sns_topic_subscription" "alarms" {
  region    = var.aws_region
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_log_metric_filter" "missing_hostname_header" {
  region         = var.aws_region
  name           = "${local.name}-missing-hostname-header"
  log_group_name = module.envelope.log_group_name
  pattern        = "{ $.reason = \"missing_hostname_header\" }"

  metric_transformation {
    name      = "MissingHostnameHeader"
    namespace = "CommunityHub/Service"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "missing_hostname_header" {
  region              = var.aws_region
  alarm_name          = "${local.name}-missing-hostname-header"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "MissingHostnameHeader"
  namespace           = "CommunityHub/Service"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  tags = {
    environment = var.environment
    project     = "community-hub"
  }
}

module "ingress" {
  source = "../../modules/aws-ingress"

  aws_region             = var.aws_region
  aws_account_id         = var.aws_account_id
  name                   = local.name
  environment            = var.environment
  project                = "community-hub"
  vpc_id                 = module.network.vpc_id
  private_subnet_ids     = module.network.private_subnet_ids
  task_security_group_id = module.network.task_security_group_id
  zone_name              = var.environment == "prod" ? "communityhub.one" : "communityhub-staging.net"
  create_public_zone     = var.create_public_zone
  attach_public_dns      = var.attach_public_dns
  public_zone_id         = var.create_public_zone ? null : var.staging_zone_id
  desired_count          = var.desired_count
  service_image          = var.service_image
  turnstile_secret_arn   = var.turnstile_secret_arn
  capacity_provider      = var.environment == "prod" ? "FARGATE" : "FARGATE_SPOT"
  task_subnet_ids        = var.environment == "prod" ? module.network.public_subnet_ids : [module.network.public_subnet_id]
  execution_role_arn     = module.envelope.execution_role_arn
  execution_role_name    = module.envelope.execution_role_name
  task_role_arn          = module.envelope.task_role_arn
  log_group_name         = module.envelope.log_group_name
  db_host                = var.enable_database ? module.rds[0].address : ""
  db_port                = var.enable_database ? module.rds[0].port : 5432
  envelope_key_arn       = module.envelope.key_arn
  app_secret_arn         = module.db_secrets.app_secret_arn
  identity_secret_arn    = module.db_secrets.identity_secret_arn
  platform_secret_arn    = module.db_secrets.platform_secret_arn
}

resource "aws_iam_role" "db_ops_execution" {
  count = local.db_ops_count
  name  = "${local.name}-db-ops-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    environment = var.environment
    project     = "community-hub"
  }
}

resource "aws_iam_role" "db_ops_task" {
  count = local.db_ops_count
  name  = "${local.name}-db-ops-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    environment = var.environment
    project     = "community-hub"
  }
}

resource "aws_iam_role_policy" "db_ops_execution" {
  count = local.db_ops_count
  name  = "db-ops-execution"
  role  = aws_iam_role.db_ops_execution[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadDbSecrets"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          module.rds[0].master_user_secret_arn,
          module.db_secrets.app_secret_arn,
          module.db_secrets.identity_secret_arn,
          module.db_secrets.platform_secret_arn,
        ]
      },
      {
        Sid      = "DecryptRoleSecrets"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = module.db_secrets.key_arn
      },
      {
        Sid      = "PullAuth"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "PullImage"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ]
        Resource = module.ingress.repository_arn
      },
      {
        Sid      = "WriteServiceLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${local.db_ops_log_arn}:*"]
      },
    ]
  })
}

resource "aws_ecs_task_definition" "db_ops" {
  count                    = local.db_ops_count
  region                   = var.aws_region
  family                   = "${local.name}-db-ops"
  cpu                      = "256"
  memory                   = "512"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.db_ops_execution[0].arn
  task_role_arn            = aws_iam_role.db_ops_task[0].arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name                   = "db-ops"
      image                  = var.service_image
      essential              = true
      user                   = "node"
      command                = ["node", "/app/db-bootstrap.js"]
      readonlyRootFilesystem = true
      mountPoints = [{
        sourceVolume  = "tmp"
        containerPath = "/tmp"
        readOnly      = false
      }]
      environment = [
        { name = "PGHOST", value = module.rds[0].address },
        { name = "PGPORT", value = tostring(module.rds[0].port) },
        { name = "PGDATABASE", value = "communityhub" },
        { name = "PGUSER", value = "postgres" },
      ]
      secrets = [
        { name = "PGPASSWORD_MASTER", valueFrom = "${module.rds[0].master_user_secret_arn}:password::" },
        { name = "PGPASSWORD_APP", valueFrom = module.db_secrets.app_secret_arn },
        { name = "PGPASSWORD_IDENTITY", valueFrom = module.db_secrets.identity_secret_arn },
        { name = "PGPASSWORD_PLATFORM", valueFrom = module.db_secrets.platform_secret_arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = module.envelope.log_group_name
          awslogs-region        = "ap-southeast-2"
          awslogs-stream-prefix = "db-ops"
        }
      }
    }
  ])

  volume {
    name = "tmp"
  }

  tags = {
    environment = var.environment
    project     = "community-hub"
  }
}
