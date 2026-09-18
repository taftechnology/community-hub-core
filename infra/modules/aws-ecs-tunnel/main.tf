locals {
  secret_name    = "${var.name}/cloudflare-tunnel-token"
  log_group_name = "/community-hub/${var.name}/connector"
  secret_arn     = "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${local.secret_name}"
  log_arn        = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:${local.log_group_name}"

  execution_statements = concat(
    [
      {
        Sid      = "GetTunnelToken"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = ["${local.secret_arn}*"]
      },
      {
        Sid      = "WriteLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${local.log_arn}:*"]
      },
    ],
    var.kms_key_arn == null ? [] : [
      {
        Sid      = "DecryptSecret"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [var.kms_key_arn]
      },
    ],
  )
}

resource "aws_ecs_cluster" "this" {
  region = var.aws_region
  name   = "${var.name}-connector"
}

resource "aws_cloudwatch_log_group" "connector" {
  region            = var.aws_region
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
}

resource "aws_secretsmanager_secret" "tunnel" {
  region      = var.aws_region
  name        = local.secret_name
  description = "Cloudflare Tunnel token for ${var.name}"
  kms_key_id  = var.kms_key_arn
}

resource "aws_secretsmanager_secret_version" "tunnel" {
  region        = var.aws_region
  secret_id     = aws_secretsmanager_secret.tunnel.id
  secret_string = var.tunnel_token
}

resource "aws_iam_role" "execution" {
  name = "${var.name}-connector-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "execution" {
  name = "connector-execution"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = local.execution_statements
  })
}

resource "aws_ecs_task_definition" "this" {
  region                   = var.aws_region
  family                   = "${var.name}-connector"
  cpu                      = "256"
  memory                   = "512"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name        = "cloudflared"
      image       = var.cloudflared_image
      essential   = true
      command     = ["tunnel", "--no-autoupdate", "run"]
      environment = []
      secrets = [
        {
          name      = "TUNNEL_TOKEN"
          valueFrom = aws_secretsmanager_secret.tunnel.arn
        },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = local.log_group_name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "cloudflared"
        }
      }
    },
  ])
}

resource "aws_ecs_service" "connector" {
  region          = var.aws_region
  name            = "${var.name}-connector"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [var.public_subnet_id]
    security_groups  = [var.connector_security_group_id]
    assign_public_ip = true
  }

  depends_on = [aws_iam_role_policy.execution, aws_secretsmanager_secret_version.tunnel]
}
