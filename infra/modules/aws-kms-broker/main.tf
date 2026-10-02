resource "aws_ecr_repository" "broker" {
  region               = var.aws_region
  name                 = "${var.name}/kms-broker"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecs_cluster" "broker" {
  count  = var.enable_tasks ? 1 : 0
  region = var.aws_region
  name   = "${var.name}-kms-broker"
}

resource "aws_iam_role_policy" "pull" {
  count = var.enable_tasks ? 1 : 0
  name  = "kms-broker-ecr-pull"
  role  = var.execution_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ]
        Resource = aws_ecr_repository.broker.arn
      },
    ]
  })
}

resource "aws_ecs_task_definition" "broker" {
  count                    = var.enable_tasks ? 1 : 0
  region                   = var.aws_region
  family                   = "${var.name}-kms-broker"
  cpu                      = "512"
  memory                   = "1024"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  lifecycle {
    precondition {
      condition     = var.kms_broker_image != null
      error_message = "kms_broker_image is required when enable_tasks is true."
    }
  }

  container_definitions = jsonencode([
    {
      name      = "kms-broker"
      image     = var.kms_broker_image
      essential = true
      environment = [
        {
          name  = "ENVELOPE_KEY_ARN"
          value = var.envelope_key_arn
        },
      ]
      healthCheck = {
        command = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = var.log_group_name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "kms-broker"
        }
      }
    },
    {
      name      = "cloudflared"
      image     = var.kms_broker_cloudflared_image
      essential = true
      command   = ["tunnel", "--no-autoupdate", "run"]
      dependsOn = [
        {
          containerName = "kms-broker"
          condition     = "HEALTHY"
        },
      ]
      secrets = [
        {
          name      = "TUNNEL_TOKEN"
          valueFrom = var.tunnel_secret_arn
        },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = var.log_group_name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "cloudflared"
        }
      }
    },
  ])
}

resource "aws_ecs_service" "broker" {
  count           = var.enable_tasks ? 1 : 0
  region          = var.aws_region
  name            = "${var.name}-kms-broker"
  cluster         = aws_ecs_cluster.broker[0].id
  task_definition = aws_ecs_task_definition.broker[0].arn
  desired_count   = 2
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = [var.public_subnet_id]
    security_groups  = [var.broker_security_group_id]
    assign_public_ip = true
  }

  depends_on = [aws_iam_role_policy.pull]
}
