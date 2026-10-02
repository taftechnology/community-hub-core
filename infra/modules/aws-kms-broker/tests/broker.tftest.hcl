mock_provider "aws" {
  override_during = plan

  mock_resource "aws_ecr_repository" {
    defaults = {
      arn = "arn:aws:ecr:ap-southeast-2:123456789012:repository/ch-staging/kms-broker"
    }
  }
}

run "flag_off" {
  command = plan

  variables {
    aws_region                 = "ap-southeast-2"
    aws_account_id             = "123456789012"
    name                       = "ch-staging"
    public_subnet_id           = "subnet-mock"
    tunnel_secret_arn          = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging/kms-broker-tunnel-token-AbCdEf"
    execution_role_name        = "ch-staging-kms-broker-execution"
    execution_role_arn         = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-execution"
    log_group_name             = "/community-hub/ch-staging/kms-broker"
    task_role_arn              = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-task"
    broker_security_group_id   = "sg-broker"
    envelope_key_arn           = "arn:aws:kms:ap-southeast-2:123456789012:key/abc"
    enable_tasks               = false
    kms_broker_image           = null
  }

  assert {
    condition     = aws_ecr_repository.broker.name == "ch-staging/kms-broker"
    error_message = "ECR repository must always exist"
  }

  assert {
    condition     = aws_ecr_repository.broker.image_tag_mutability == "IMMUTABLE"
    error_message = "repository must use IMMUTABLE tags"
  }

  assert {
    condition     = aws_ecr_repository.broker.image_scanning_configuration[0].scan_on_push == true
    error_message = "repository must scan on push"
  }

  assert {
    condition     = aws_ecr_repository.broker.force_delete == null
    error_message = "repository must not set force_delete"
  }

  assert {
    condition     = length(aws_ecs_cluster.broker) == 0
    error_message = "flag off must not create a cluster"
  }

  assert {
    condition     = length(aws_ecs_task_definition.broker) == 0
    error_message = "flag off must not create a task definition"
  }

  assert {
    condition     = length(aws_ecs_service.broker) == 0
    error_message = "flag off must not create a service"
  }

  assert {
    condition     = length(aws_iam_role_policy.pull) == 0
    error_message = "flag off must not create a pull policy"
  }
}

run "flag_on" {
  command = plan

  variables {
    aws_region                 = "ap-southeast-2"
    aws_account_id             = "123456789012"
    name                       = "ch-staging"
    public_subnet_id           = "subnet-mock"
    tunnel_secret_arn          = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging/kms-broker-tunnel-token-AbCdEf"
    execution_role_name        = "ch-staging-kms-broker-execution"
    execution_role_arn         = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-execution"
    log_group_name             = "/community-hub/ch-staging/kms-broker"
    task_role_arn              = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-task"
    broker_security_group_id   = "sg-broker"
    envelope_key_arn           = "arn:aws:kms:ap-southeast-2:123456789012:key/abc"
    enable_tasks               = true
    kms_broker_image           = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/kms-broker@sha256:${join("", [for _ in range(64) : "a"])}"
  }

  assert {
    condition     = aws_ecs_service.broker[0].desired_count == 2
    error_message = "broker service desired_count must be 2"
  }

  assert {
    condition = alltrue([
      for container in jsondecode(aws_ecs_task_definition.broker[0].container_definitions) : container.essential == true
    ])
    error_message = "both containers must be essential"
  }

  assert {
    condition = one([
      for container in jsondecode(aws_ecs_task_definition.broker[0].container_definitions) :
      container if container.name == "cloudflared"
    ]).dependsOn[0].containerName == "kms-broker" && one([
      for container in jsondecode(aws_ecs_task_definition.broker[0].container_definitions) :
      container if container.name == "cloudflared"
    ]).dependsOn[0].condition == "HEALTHY"
    error_message = "cloudflared must depend on kms-broker HEALTHY"
  }

  assert {
    condition = one([
      for container in jsondecode(aws_ecs_task_definition.broker[0].container_definitions) :
      container if container.name == "kms-broker"
    ]).healthCheck.command[1] == "node -e \"fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""
    error_message = "broker health check command must probe loopback /health"
  }

  assert {
    condition = one([
      for container in jsondecode(aws_ecs_task_definition.broker[0].container_definitions) :
      container if container.name == "cloudflared"
    ]).secrets[0].valueFrom == var.tunnel_secret_arn
    error_message = "cloudflared TUNNEL_TOKEN must come from tunnel_secret_arn"
  }

  assert {
    condition = alltrue([
      for container in jsondecode(aws_ecs_task_definition.broker[0].container_definitions) :
      container.logConfiguration.options["awslogs-group"] == var.log_group_name &&
      container.logConfiguration.options["awslogs-region"] == "ap-southeast-2"
    ])
    error_message = "both containers must log to the broker log group in ap-southeast-2"
  }

  assert {
    condition = one([
      for env in one([
        for container in jsondecode(aws_ecs_task_definition.broker[0].container_definitions) :
        container if container.name == "kms-broker"
      ]).environment : env if env.name == "ENVELOPE_KEY_ARN"
    ]).value == "arn:aws:kms:ap-southeast-2:123456789012:key/abc"
    error_message = "kms-broker container must set ENVELOPE_KEY_ARN from envelope_key_arn"
  }

  assert {
    condition     = strcontains(file("${path.module}/main.tf"), "depends_on = [aws_iam_role_policy.pull]")
    error_message = "ECS service must depend on the pull policy"
  }

  assert {
    condition = sort(flatten([
      for statement in jsondecode(aws_iam_role_policy.pull[0].policy).Statement : statement.Action
    ])) == sort([
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetAuthorizationToken",
      "ecr:GetDownloadUrlForLayer",
    ])
    error_message = "pull policy must allow exactly the four ECR read actions"
  }

  assert {
    condition = (
      !strcontains(aws_iam_role_policy.pull[0].policy, "ecr:PutImage") &&
      !strcontains(aws_iam_role_policy.pull[0].policy, "ecr:InitiateLayerUpload") &&
      !strcontains(aws_iam_role_policy.pull[0].policy, "ecr:UploadLayerPart") &&
      !strcontains(aws_iam_role_policy.pull[0].policy, "ecr:CompleteLayerUpload")
    )
    error_message = "pull policy must not grant ECR push actions"
  }
}

run "flag_on_null_image" {
  command = plan

  variables {
    aws_region               = "ap-southeast-2"
    aws_account_id           = "123456789012"
    name                     = "ch-staging"
    public_subnet_id         = "subnet-mock"
    tunnel_secret_arn        = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging/kms-broker-tunnel-token-AbCdEf"
    execution_role_name      = "ch-staging-kms-broker-execution"
    execution_role_arn       = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-execution"
    log_group_name           = "/community-hub/ch-staging/kms-broker"
    task_role_arn            = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-task"
    broker_security_group_id = "sg-broker"
    envelope_key_arn         = "arn:aws:kms:ap-southeast-2:123456789012:key/abc"
    enable_tasks             = true
    kms_broker_image         = null
  }

  expect_failures = [aws_ecs_task_definition.broker]
}

run "foreign_public_ecr" {
  command = plan

  variables {
    aws_region               = "ap-southeast-2"
    aws_account_id           = "123456789012"
    name                     = "ch-staging"
    public_subnet_id         = "subnet-mock"
    tunnel_secret_arn        = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging/kms-broker-tunnel-token-AbCdEf"
    execution_role_name      = "ch-staging-kms-broker-execution"
    execution_role_arn       = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-execution"
    log_group_name           = "/community-hub/ch-staging/kms-broker"
    task_role_arn            = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-task"
    broker_security_group_id = "sg-broker"
    envelope_key_arn         = "arn:aws:kms:ap-southeast-2:123456789012:key/abc"
    kms_broker_image         = "public.ecr.aws/cloudflare/cloudflared@sha256:${join("", [for _ in range(64) : "a"])}"
  }

  expect_failures = [var.kms_broker_image]
}

run "foreign_other_region" {
  command = plan

  variables {
    aws_region               = "ap-southeast-2"
    aws_account_id           = "123456789012"
    name                     = "ch-staging"
    public_subnet_id         = "subnet-mock"
    tunnel_secret_arn        = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging/kms-broker-tunnel-token-AbCdEf"
    execution_role_name      = "ch-staging-kms-broker-execution"
    execution_role_arn       = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-execution"
    log_group_name           = "/community-hub/ch-staging/kms-broker"
    task_role_arn            = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-task"
    broker_security_group_id = "sg-broker"
    envelope_key_arn         = "arn:aws:kms:ap-southeast-2:123456789012:key/abc"
    kms_broker_image         = "123456789012.dkr.ecr.us-east-1.amazonaws.com/ch-staging/kms-broker@sha256:${join("", [for _ in range(64) : "a"])}"
  }

  expect_failures = [var.kms_broker_image]
}

run "image_tag" {
  command = plan

  variables {
    aws_region               = "ap-southeast-2"
    aws_account_id           = "123456789012"
    name                     = "ch-staging"
    public_subnet_id         = "subnet-mock"
    tunnel_secret_arn        = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging/kms-broker-tunnel-token-AbCdEf"
    execution_role_name      = "ch-staging-kms-broker-execution"
    execution_role_arn       = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-execution"
    log_group_name           = "/community-hub/ch-staging/kms-broker"
    task_role_arn            = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-task"
    broker_security_group_id = "sg-broker"
    envelope_key_arn         = "arn:aws:kms:ap-southeast-2:123456789012:key/abc"
    kms_broker_image         = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/kms-broker:latest"
  }

  expect_failures = [var.kms_broker_image]
}

run "uppercase_hex" {
  command = plan

  variables {
    aws_region               = "ap-southeast-2"
    aws_account_id           = "123456789012"
    name                     = "ch-staging"
    public_subnet_id         = "subnet-mock"
    tunnel_secret_arn        = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging/kms-broker-tunnel-token-AbCdEf"
    execution_role_name      = "ch-staging-kms-broker-execution"
    execution_role_arn       = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-execution"
    log_group_name           = "/community-hub/ch-staging/kms-broker"
    task_role_arn            = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-task"
    broker_security_group_id = "sg-broker"
    envelope_key_arn         = "arn:aws:kms:ap-southeast-2:123456789012:key/abc"
    kms_broker_image         = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/kms-broker@sha256:${upper(join("", [for _ in range(64) : "a"]))}"
  }

  expect_failures = [var.kms_broker_image]
}

run "trailing_suffix" {
  command = plan

  variables {
    aws_region               = "ap-southeast-2"
    aws_account_id           = "123456789012"
    name                     = "ch-staging"
    public_subnet_id         = "subnet-mock"
    tunnel_secret_arn        = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging/kms-broker-tunnel-token-AbCdEf"
    execution_role_name      = "ch-staging-kms-broker-execution"
    execution_role_arn       = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-execution"
    log_group_name           = "/community-hub/ch-staging/kms-broker"
    task_role_arn            = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-task"
    broker_security_group_id = "sg-broker"
    envelope_key_arn         = "arn:aws:kms:ap-southeast-2:123456789012:key/abc"
    kms_broker_image         = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/kms-broker@sha256:${join("", [for _ in range(64) : "a"])}extra"
  }

  expect_failures = [var.kms_broker_image]
}

run "foreign_cloudflared" {
  command = plan

  variables {
    aws_region                 = "ap-southeast-2"
    aws_account_id             = "123456789012"
    name                       = "ch-staging"
    public_subnet_id           = "subnet-mock"
    tunnel_secret_arn          = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging/kms-broker-tunnel-token-AbCdEf"
    execution_role_name        = "ch-staging-kms-broker-execution"
    execution_role_arn         = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-execution"
    log_group_name             = "/community-hub/ch-staging/kms-broker"
    task_role_arn              = "arn:aws:iam::123456789012:role/ch-staging-kms-broker-task"
    broker_security_group_id   = "sg-broker"
    envelope_key_arn           = "arn:aws:kms:ap-southeast-2:123456789012:key/abc"
    kms_broker_cloudflared_image = "docker.io/anyone/cloudflared@sha256:${join("", [for _ in range(64) : "b"])}"
  }

  expect_failures = [var.kms_broker_cloudflared_image]
}
