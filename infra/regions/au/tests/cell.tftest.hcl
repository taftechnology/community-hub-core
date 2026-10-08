mock_provider "aws" {
  override_during = plan

  mock_resource "aws_db_instance" {
    defaults = {
      address = "ch-staging-postgres.xxxxx.ap-southeast-2.rds.amazonaws.com"
      port    = 5432
      master_user_secret = [
        {
          secret_arn    = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:master"
          secret_status = "active"
          kms_key_id    = "alias/aws/secretsmanager"
        },
      ]
    }
  }

  mock_resource "aws_security_group" {
    defaults = {
      id = "sg-mock"
    }
  }

  mock_resource "aws_vpc_endpoint" {
    defaults = {
      id = "vpce-mock"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn                 = "arn:aws:iam::123456789012:role/mock"
      id                  = "mock-role"
      managed_policy_arns = null
    }
  }

  mock_resource "aws_iam_openid_connect_provider" {
    defaults = {
      arn             = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
      thumbprint_list = null
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

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:ap-southeast-2:123456789012:ch-staging-alarms"
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

run "staging_happy" {
  command = plan

  variables {
    aws_region                 = "ap-southeast-2"
    aws_account_id             = "123456789012"
    environment                = "staging"
    deletion_protection        = false
    backup_retention_days      = 0
    alert_email                = "alerts@example.com"
    staging_zone_id            = "ZSTAGING"
    create_public_zone         = false
    attach_public_dns          = true
    github_repository_id       = "100000000001"
    github_repository_owner_id = "100000000002"
  }

  override_resource {
    target = module.ingress.aws_apigatewayv2_api.tenant
    values = {
      id = "api-tenant"
    }
    override_during = plan
  }

  override_resource {
    target = module.ingress.aws_apigatewayv2_api.ops
    values = {
      id = "api-ops"
    }
    override_during = plan
  }

  assert {
    condition     = length(regexall("(?m)^\\s*environment\\s*=\\s*\"staging\"", file("${path.module}/env/staging.tfvars"))) > 0
    error_message = "env/staging.tfvars must set environment = \"staging\""
  }

  assert {
    condition = (
      length(jsondecode(output.storage_key_policy).Statement) == 1 &&
      jsondecode(output.storage_key_policy).Statement[0].Sid == "Enable IAM User Permissions" &&
      jsondecode(output.storage_key_policy).Statement[0].Principal.AWS == "arn:aws:iam::123456789012:root" &&
      jsondecode(output.storage_key_policy).Statement[0].Action == "kms:*" &&
      jsondecode(output.storage_key_policy).Statement[0].Resource == "*"
    )
    error_message = "storage key policy must be the single account-root kms:* statement"
  }

  assert {
    condition     = !strcontains(output.storage_key_policy, "ch-staging-task")
    error_message = "storage key policy must not reference the envelope task role"
  }

  assert {
    condition = (
      length(jsondecode(output.envelope_key_policy).Statement) == 6 &&
      jsondecode(output.envelope_key_policy).Statement[5].Sid == "ReplicateToMelbourne" &&
      length([
        for statement in jsondecode(output.envelope_key_policy).Statement : statement
        if contains(["GenerateDataKeyOrg", "GenerateDataKeyIdentity", "DecryptOrg", "DecryptIdentity"], statement.Sid)
      ]) == 4 &&
      alltrue([
        for statement in jsondecode(output.envelope_key_policy).Statement :
        statement.Principal.AWS == "arn:aws:iam::123456789012:role/ch-staging-task"
        if contains(["GenerateDataKeyOrg", "GenerateDataKeyIdentity", "DecryptOrg", "DecryptIdentity"], statement.Sid)
      ]) &&
      !strcontains(output.envelope_key_policy, "aws:SourceVpce")
    )
    error_message = "default staging plan must bind four cryptographic statements to the task role and must not contain aws:SourceVpce"
  }

  assert {
    condition     = module.envelope.endpoint_id == null
    error_message = "endpoint_id must be null when the KMS endpoint is off"
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(output.execution_policy).Statement :
      alltrue([for action in statement.Action : !strcontains(action, "kms:")])
    ])
    error_message = "service execution log policy must not call kms"
  }

  assert {
    condition     = !strcontains(file("${path.module}/env/staging.tfvars"), "policy_probe_action")
    error_message = "env/staging.tfvars must not set policy_probe_action"
  }

  assert {
    condition     = !strcontains(file("${path.module}/env/prod.tfvars"), "policy_probe_action")
    error_message = "env/prod.tfvars must not set policy_probe_action"
  }

  assert {
    condition     = var.enable_budgets == false
    error_message = "enable_budgets must default to false when unset"
  }

  assert {
    condition     = module.ingress.api_hostname == "au.api.communityhub-staging.net" && module.ingress.ecs_service_desired_count == 0
    error_message = "staging root attaches the staging names and plans no ECS service"
  }

  assert {
    condition     = length(aws_ecs_task_definition.db_ops) == 0 && length(aws_iam_role.db_ops_execution) == 0
    error_message = "an unset image plans no ops task"
  }
}

run "budgets_on" {
  command = plan

  variables {
    aws_region                 = "ap-southeast-2"
    aws_account_id             = "123456789012"
    environment                = "staging"
    enable_budgets             = true
    alert_email                = "alerts@example.com"
    staging_zone_id            = "ZSTAGING"
    create_public_zone         = false
    attach_public_dns          = true
    github_repository_id       = "100000000001"
    github_repository_owner_id = "100000000002"
  }
}

run "staging_endpoint_on" {
  command = plan

  variables {
    aws_region                 = "ap-southeast-2"
    aws_account_id             = "123456789012"
    environment                = "staging"
    deletion_protection        = false
    backup_retention_days      = 0
    enable_kms_endpoint        = true
    alert_email                = "alerts@example.com"
    staging_zone_id            = "ZSTAGING"
    create_public_zone         = false
    attach_public_dns          = true
    github_repository_id       = "100000000001"
    github_repository_owner_id = "100000000002"
  }

  override_resource {
    target = module.envelope.aws_vpc_endpoint.kms[0]
    values = {
      id = "vpce-mock"
    }
    override_during = plan
  }

  assert {
    condition     = module.envelope.endpoint_id == "vpce-mock"
    error_message = "envelope endpoint id must be the mocked VPC endpoint id"
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(output.envelope_key_policy).Statement :
      statement.Condition.StringEquals["aws:SourceVpce"] == "vpce-mock"
      if contains(["GenerateDataKeyOrg", "GenerateDataKeyIdentity", "DecryptOrg", "DecryptIdentity"], statement.Sid)
    ])
    error_message = "cryptographic statements must bind aws:SourceVpce to the VPC endpoint"
  }
}

run "prod_tfvars" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    environment           = "prod"
    deletion_protection   = true
    backup_retention_days = 7
    enable_kms_endpoint   = true
    alert_email           = "alerts@example.com"
    create_public_zone    = true
    attach_public_dns     = false
  }

  assert {
    condition     = length(regexall("(?m)^\\s*environment\\s*=\\s*\"prod\"", file("${path.module}/env/prod.tfvars"))) > 0
    error_message = "env/prod.tfvars must set environment = \"prod\""
  }

  assert {
    condition     = length(regexall("(?m)^\\s*enable_kms_endpoint\\s*=\\s*true", file("${path.module}/env/prod.tfvars"))) > 0
    error_message = "env/prod.tfvars must set enable_kms_endpoint = true"
  }

  assert {
    condition     = module.ingress.api_hostname == "au.api.communityhub.one" && module.ingress.ecs_service_desired_count == 0
    error_message = "production root creates hostnames for communityhub.one and plans no ECS service"
  }

  assert {
    condition = (
      length(aws_iam_openid_connect_provider.github) == 0 &&
      length(aws_iam_role.image_publish) == 0 &&
      length(aws_iam_role_policy.image_publish) == 0
    )
    error_message = "prod plans no image publish provider or role"
  }

  assert {
    condition = (
      length(module.admin_static) == 0 &&
      length(aws_iam_role.admin_publish) == 0 &&
      length(aws_iam_role_policy.admin_publish) == 0
    )
    error_message = "prod plans no admin shell and no admin publish role"
  }
}

run "prod_endpoint_off_fails" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    environment           = "prod"
    enable_kms_endpoint   = false
    deletion_protection   = true
    backup_retention_days = 7
    alert_email           = "alerts@example.com"
    create_public_zone    = true
    attach_public_dns     = false
  }

  expect_failures = [
    check.prod_kms_endpoint,
    terraform_data.prod_kms_endpoint,
  ]
}

run "wrong_region_fails" {
  command = plan

  variables {
    aws_region                 = "us-east-1"
    aws_account_id             = "123456789012"
    environment                = "staging"
    alert_email                = "alerts@example.com"
    staging_zone_id            = "ZSTAGING"
    create_public_zone         = false
    attach_public_dns          = true
    github_repository_id       = "100000000001"
    github_repository_owner_id = "100000000002"
  }

  expect_failures = [var.aws_region]
}

run "staging_without_zone_id_fails" {
  command = plan

  variables {
    aws_region                 = "ap-southeast-2"
    aws_account_id             = "123456789012"
    environment                = "staging"
    deletion_protection        = false
    backup_retention_days      = 0
    alert_email                = "alerts@example.com"
    staging_zone_id            = null
    create_public_zone         = false
    attach_public_dns          = false
    github_repository_id       = "100000000001"
    github_repository_owner_id = "100000000002"
  }

  expect_failures = [
    check.staging_zone,
    terraform_data.staging_zone,
  ]
}

run "staging_image_set" {
  command = plan

  variables {
    aws_region                 = "ap-southeast-2"
    aws_account_id             = "123456789012"
    environment                = "staging"
    deletion_protection        = false
    backup_retention_days      = 0
    alert_email                = "alerts@example.com"
    staging_zone_id            = "ZSTAGING"
    create_public_zone         = false
    attach_public_dns          = true
    desired_count              = 0
    service_image              = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    github_repository_id       = "100000000001"
    github_repository_owner_id = "100000000002"
  }

  override_resource {
    target = module.db_secrets.aws_secretsmanager_secret.app
    values = {
      arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:app"
    }
    override_during = plan
  }

  override_resource {
    target = module.db_secrets.aws_secretsmanager_secret.identity
    values = {
      arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:identity"
    }
    override_during = plan
  }

  override_resource {
    target = module.db_secrets.aws_secretsmanager_secret.platform
    values = {
      arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:platform"
    }
    override_during = plan
  }

  override_resource {
    target = module.db_secrets.aws_kms_key.secrets
    values = {
      arn = "arn:aws:kms:ap-southeast-2:123456789012:key/role-secrets"
    }
    override_during = plan
  }

  override_resource {
    target = module.kms.aws_kms_key.storage
    values = {
      arn = "arn:aws:kms:ap-southeast-2:123456789012:key/storage"
    }
    override_during = plan
  }

  override_resource {
    target = module.envelope.aws_kms_key.envelope
    values = {
      arn = "arn:aws:kms:ap-southeast-2:123456789012:key/envelope"
    }
    override_during = plan
  }

  override_resource {
    target = aws_iam_role.db_ops_execution
    values = {
      id  = "role-db-ops-execution"
      arn = "arn:aws:iam::123456789012:role/db-ops-execution"
    }
    override_during = plan
  }

  override_resource {
    target = aws_iam_role.db_ops_task
    values = {
      id  = "role-db-ops-task"
      arn = "arn:aws:iam::123456789012:role/db-ops-task"
    }
    override_during = plan
  }

  override_resource {
    target = module.ingress.aws_ecr_repository.service
    values = {
      arn = "arn:aws:ecr:ap-southeast-2:123456789012:repository/ch-staging/service"
    }
    override_during = plan
  }

  assert {
    condition     = module.ingress.ecs_service_desired_count == 0 && length(module.ingress.task_subnet_ids) == 1
    error_message = "a set staging image plans desired count 0 and one task subnet"
  }

  assert {
    condition     = length(aws_ecs_task_definition.db_ops) == 1 && length(aws_iam_role.db_ops_execution) == 1 && length(aws_iam_role.db_ops_task) == 1
    error_message = "a set image with the database on plans the ops task and both roles"
  }

  assert {
    condition = (
      aws_iam_role_policy.db_ops_execution[0].role == aws_iam_role.db_ops_execution[0].id &&
      length(aws_iam_role.db_ops_task[0].inline_policy) == 0 &&
      !strcontains(file("${path.module}/main.tf"), "managed_policy_arns") &&
      length(regexall("aws_iam_role\\.db_ops_task\\[0\\]\\.(id|name)", file("${path.module}/main.tf"))) == 0 &&
      !strcontains(file("${path.module}/main.tf"), "aws_iam_role_policy_attachment")
    )
    error_message = "the ops execution policy attaches only to the execution role, and the task role has no policy"
  }

  assert {
    condition = (
      length([
        for statement in jsondecode(aws_iam_role_policy.db_ops_execution[0].policy).Statement :
        statement
        if contains(tolist(statement.Action), "secretsmanager:GetSecretValue")
      ]) == 1 &&
      toset(one([
        for statement in jsondecode(aws_iam_role_policy.db_ops_execution[0].policy).Statement :
        statement.Resource
        if contains(tolist(statement.Action), "secretsmanager:GetSecretValue")
        ])) == toset([
        module.rds[0].master_user_secret_arn,
        module.db_secrets.app_secret_arn,
        module.db_secrets.identity_secret_arn,
        module.db_secrets.platform_secret_arn,
      ]) &&
      length([
        for statement in jsondecode(aws_iam_role_policy.db_ops_execution[0].policy).Statement :
        statement
        if contains(tolist(statement.Action), "kms:Decrypt")
      ]) == 1 &&
      one([
        for statement in jsondecode(aws_iam_role_policy.db_ops_execution[0].policy).Statement :
        statement.Resource
        if contains(tolist(statement.Action), "kms:Decrypt")
      ]) == module.db_secrets.key_arn &&
      !strcontains(aws_iam_role_policy.db_ops_execution[0].policy, module.kms.key_arn) &&
      !strcontains(aws_iam_role_policy.db_ops_execution[0].policy, module.envelope.key_arn) &&
      one([
        for statement in jsondecode(aws_iam_role_policy.db_ops_execution[0].policy).Statement :
        statement.Resource
        if contains(tolist(statement.Action), "ecr:GetAuthorizationToken")
      ]) == "*" &&
      one([
        for statement in jsondecode(aws_iam_role_policy.db_ops_execution[0].policy).Statement :
        statement.Resource
        if contains(tolist(statement.Action), "ecr:BatchGetImage")
      ]) == module.ingress.repository_arn &&
      one([
        for statement in jsondecode(aws_iam_role_policy.db_ops_execution[0].policy).Statement :
        statement
        if contains(tolist(statement.Action), "logs:CreateLogStream")
      ]).Action == ["logs:CreateLogStream", "logs:PutLogEvents"] &&
      one([
        for statement in jsondecode(aws_iam_role_policy.db_ops_execution[0].policy).Statement :
        statement
        if contains(tolist(statement.Action), "logs:CreateLogStream")
      ]).Resource == ["arn:aws:logs:ap-southeast-2:123456789012:log-group:/community-hub/ch-staging/service:*"]
    )
    error_message = "the ops execution role reads the four secrets, decrypts only the role-secrets key, and pulls the one repository"
  }

  assert {
    condition = (
      aws_ecs_task_definition.db_ops[0].family == "ch-staging-db-ops" &&
      aws_ecs_task_definition.db_ops[0].cpu == "256" &&
      aws_ecs_task_definition.db_ops[0].memory == "512" &&
      aws_ecs_task_definition.db_ops[0].runtime_platform[0].cpu_architecture == "ARM64" &&
      jsondecode(aws_ecs_task_definition.db_ops[0].container_definitions)[0].command == ["node", "/app/db-bootstrap.js"] &&
      jsondecode(aws_ecs_task_definition.db_ops[0].container_definitions)[0].image == var.service_image &&
      jsondecode(aws_ecs_task_definition.db_ops[0].container_definitions)[0].user == "node" &&
      jsondecode(aws_ecs_task_definition.db_ops[0].container_definitions)[0].readonlyRootFilesystem == true &&
      length(try(jsondecode(aws_ecs_task_definition.db_ops[0].container_definitions)[0].portMappings, [])) == 0 &&
      length([
        for mount in jsondecode(aws_ecs_task_definition.db_ops[0].container_definitions)[0].mountPoints :
        mount if mount.containerPath == "/tmp" && mount.readOnly == false
      ]) == 1 &&
      [for item in jsondecode(aws_ecs_task_definition.db_ops[0].container_definitions)[0].environment : item.name] == ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER"] &&
      alltrue([
        for item in jsondecode(aws_ecs_task_definition.db_ops[0].container_definitions)[0].environment :
        !strcontains(item.value, "arn:")
      ]) &&
      one([
        for item in jsondecode(aws_ecs_task_definition.db_ops[0].container_definitions)[0].environment :
        item.value if item.name == "PGUSER"
      ]) == "postgres" &&
      [for secret in jsondecode(aws_ecs_task_definition.db_ops[0].container_definitions)[0].secrets : secret.name] == ["PGPASSWORD_MASTER", "PGPASSWORD_APP", "PGPASSWORD_IDENTITY", "PGPASSWORD_PLATFORM"] &&
      one([
        for secret in jsondecode(aws_ecs_task_definition.db_ops[0].container_definitions)[0].secrets :
        secret.valueFrom if secret.name == "PGPASSWORD_MASTER"
      ]) == "${module.rds[0].master_user_secret_arn}:password::" &&
      one([
        for secret in jsondecode(aws_ecs_task_definition.db_ops[0].container_definitions)[0].secrets :
        secret.valueFrom if secret.name == "PGPASSWORD_APP"
      ]) == module.db_secrets.app_secret_arn &&
      jsondecode(aws_ecs_task_definition.db_ops[0].container_definitions)[0].logConfiguration.options["awslogs-stream-prefix"] == "db-ops"
    )
    error_message = "the ops container runs db-bootstrap.js with passwords injected and no secret ARN in the environment"
  }
}

run "prod_image_set" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    environment           = "prod"
    deletion_protection   = true
    backup_retention_days = 7
    enable_kms_endpoint   = true
    alert_email           = "alerts@example.com"
    create_public_zone    = true
    attach_public_dns     = false
    desired_count         = 0
    service_image         = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-prod/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  assert {
    condition     = length(module.ingress.task_subnet_ids) == 2
    error_message = "a set production image plans both public subnets"
  }

  assert {
    condition     = length(aws_ecs_task_definition.db_ops) == 1
    error_message = "a set production image plans the ops task"
  }
}

run "database_off" {
  command = plan

  variables {
    aws_region                 = "ap-southeast-2"
    aws_account_id             = "123456789012"
    environment                = "staging"
    deletion_protection        = false
    backup_retention_days      = 0
    alert_email                = "alerts@example.com"
    staging_zone_id            = "ZSTAGING"
    create_public_zone         = false
    attach_public_dns          = true
    enable_database            = false
    enable_budgets             = true
    desired_count              = 0
    github_repository_id       = "100000000001"
    github_repository_owner_id = "100000000002"
  }

  assert {
    condition     = length(module.rds) == 0
    error_message = "parking removes the RDS module"
  }

  assert {
    condition     = module.ingress.ecs_service_desired_count == 0
    error_message = "re-park values plan no ECS service"
  }

  assert {
    condition     = length(aws_ecs_task_definition.db_ops) == 0 && length(aws_iam_role.db_ops_execution) == 0
    error_message = "a parked database plans no ops task"
  }

  assert {
    condition     = output.rds_hostname == null
    error_message = "rds_hostname is null when the database is off"
  }

  assert {
    condition     = aws_sns_topic.alarms.name == "ch-staging-alarms"
    error_message = "the alarms topic stays when the database is parked"
  }

  assert {
    condition     = aws_sns_topic.alarms.tags["environment"] == "staging" && aws_sns_topic.alarms.tags["project"] == "community-hub"
    error_message = "the alarms topic carries environment and project"
  }

  assert {
    condition     = aws_sns_topic.alarms.kms_master_key_id == null
    error_message = "alarm SNS topic must not use a KMS key"
  }

  assert {
    condition     = aws_sns_topic_subscription.alarms.endpoint == "alerts@example.com"
    error_message = "the email subscription stays when the database is parked"
  }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.missing_hostname_header.pattern == "{ $.reason = \"missing_hostname_header\" }"
    error_message = "the hostname filter matches the reason field"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.missing_hostname_header.comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.threshold == 1 &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.period == 300 &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.treat_missing_data == "notBreaching" &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.alarm_actions == toset([aws_sns_topic.alarms.arn]) &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.tags["environment"] == "staging" &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.tags["project"] == "community-hub"
    )
    error_message = "the hostname alarm must match the spec"
  }

  assert {
    condition     = module.budgets.budget_name == "ch-staging-cost"
    error_message = "the park plan creates the staging budget"
  }

  assert {
    condition = (
      !strcontains(file("${path.module}/env/staging.tfvars"), "service_image") &&
      !strcontains(file("${path.module}/env/staging.tfvars"), "enable_kms_endpoint")
    )
    error_message = "committed staging tfvars must not set service_image or enable_kms_endpoint"
  }
}

run "prod_database_off_fails" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    environment           = "prod"
    enable_database       = false
    enable_kms_endpoint   = true
    deletion_protection   = true
    backup_retention_days = 7
    alert_email           = "alerts@example.com"
    create_public_zone    = true
    attach_public_dns     = false
  }

  expect_failures = [
    check.prod_database,
    terraform_data.prod_database,
  ]
}

run "image_without_database_fails" {
  command = plan

  variables {
    aws_region                 = "ap-southeast-2"
    aws_account_id             = "123456789012"
    environment                = "staging"
    deletion_protection        = false
    backup_retention_days      = 0
    alert_email                = "alerts@example.com"
    staging_zone_id            = "ZSTAGING"
    create_public_zone         = false
    attach_public_dns          = true
    enable_database            = false
    service_image              = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    github_repository_id       = "100000000001"
    github_repository_owner_id = "100000000002"
  }

  override_module {
    target = module.ingress
  }

  expect_failures = [
    check.image_needs_database,
    terraform_data.image_needs_database,
  ]
}

run "staging_unpark" {
  command = plan

  variables {
    aws_region                 = "ap-southeast-2"
    aws_account_id             = "123456789012"
    environment                = "staging"
    deletion_protection        = false
    backup_retention_days      = 0
    alert_email                = "alerts@example.com"
    staging_zone_id            = "ZSTAGING"
    create_public_zone         = false
    attach_public_dns          = true
    enable_database            = true
    desired_count              = 1
    service_image              = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    github_repository_id       = "100000000001"
    github_repository_owner_id = "100000000002"
  }

  assert {
    condition     = length(module.rds) == 1
    error_message = "unpark plans the database"
  }

  assert {
    condition     = module.ingress.ecs_service_desired_count == 1
    error_message = "unpark plans the service at count 1"
  }

  assert {
    condition     = length(module.ingress.task_subnet_ids) == 1
    error_message = "unpark plans the staging public subnet"
  }

  assert {
    condition     = length(aws_ecs_task_definition.db_ops) == 1
    error_message = "unpark plans the ops task"
  }

  assert {
    condition     = module.envelope.endpoint_id == null
    error_message = "unpark leaves the KMS endpoint off"
  }
}

run "staging_image_null" {
  command = plan

  variables {
    aws_region                 = "ap-southeast-2"
    aws_account_id             = "123456789012"
    environment                = "staging"
    deletion_protection        = false
    backup_retention_days      = 0
    alert_email                = "alerts@example.com"
    staging_zone_id            = "ZSTAGING"
    create_public_zone         = false
    attach_public_dns          = true
    enable_database            = true
    desired_count              = 1
    github_repository_id       = "100000000001"
    github_repository_owner_id = "100000000002"
  }

  assert {
    condition     = length(module.rds) == 1
    error_message = "an unset image still plans the database"
  }

  assert {
    condition     = module.ingress.ecs_service_desired_count == 0
    error_message = "an unset image plans no ECS service"
  }

  assert {
    condition     = length(aws_ecs_task_definition.db_ops) == 0
    error_message = "an unset image plans no ops task"
  }

  assert {
    condition     = length(aws_iam_role.db_ops_execution) == 0
    error_message = "an unset image plans no ops execution role"
  }
}

run "staging_without_github_ids_fails" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    environment           = "staging"
    deletion_protection   = false
    backup_retention_days = 0
    alert_email           = "alerts@example.com"
    staging_zone_id       = "ZSTAGING"
    create_public_zone    = false
    attach_public_dns     = true
  }

  expect_failures = [
    check.github_ids,
    terraform_data.github_ids,
  ]
}

run "staging_image_publish" {
  command = plan

  override_resource {
    target = module.ingress.aws_ecr_repository.service
    values = {
      arn = "arn:aws:ecr:ap-southeast-2:123456789012:repository/ch-staging/service"
    }
    override_during = plan
  }

  variables {
    aws_region                 = "ap-southeast-2"
    aws_account_id             = "123456789012"
    environment                = "staging"
    deletion_protection        = false
    backup_retention_days      = 0
    alert_email                = "alerts@example.com"
    staging_zone_id            = "ZSTAGING"
    create_public_zone         = false
    attach_public_dns          = true
    github_repository_id       = "100000000001"
    github_repository_owner_id = "100000000002"
  }

  assert {
    condition = (
      length(aws_iam_openid_connect_provider.github) == 1 &&
      aws_iam_openid_connect_provider.github[0].url == "https://token.actions.githubusercontent.com" &&
      aws_iam_openid_connect_provider.github[0].client_id_list == toset(["sts.amazonaws.com"]) &&
      aws_iam_openid_connect_provider.github[0].thumbprint_list == null
    )
    error_message = "the provider url, audience, and unset thumbprint must match"
  }

  assert {
    condition     = length(aws_iam_role.image_publish) == 1 && length(aws_iam_role_policy.image_publish) == 1
    error_message = "staging plans one publish role and one role policy"
  }

  assert {
    condition = (
      length(jsondecode(aws_iam_role.image_publish[0].assume_role_policy).Statement) == 1 &&
      jsondecode(aws_iam_role.image_publish[0].assume_role_policy).Statement[0].Effect == "Allow" &&
      jsondecode(aws_iam_role.image_publish[0].assume_role_policy).Statement[0].Action == "sts:AssumeRoleWithWebIdentity" &&
      jsondecode(aws_iam_role.image_publish[0].assume_role_policy).Statement[0].Principal == { Federated = aws_iam_openid_connect_provider.github[0].arn } &&
      keys(jsondecode(aws_iam_role.image_publish[0].assume_role_policy).Statement[0].Condition) == ["StringEquals"] &&
      jsondecode(aws_iam_role.image_publish[0].assume_role_policy).Statement[0].Condition.StringEquals == {
        "token.actions.githubusercontent.com:aud"                 = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub"                 = "repo:taftechnology@100000000002/community-hub-core@100000000001:ref:refs/heads/main"
        "token.actions.githubusercontent.com:job_workflow_ref"    = "taftechnology/community-hub-core/.github/workflows/ci.yml@refs/heads/main"
        "token.actions.githubusercontent.com:repository_id"       = "100000000001"
        "token.actions.githubusercontent.com:repository_owner_id" = "100000000002"
      }
    )
    error_message = "the trust must be one Allow statement with exactly the five StringEquals claims"
  }

  assert {
    condition = (
      length(jsondecode(aws_iam_role_policy.image_publish[0].policy).Statement) == 2 &&
      alltrue([
        for statement in jsondecode(aws_iam_role_policy.image_publish[0].policy).Statement :
        statement.Effect == "Allow"
      ])
    )
    error_message = "the role policy has exactly two Allow statements"
  }

  assert {
    condition = (
      length([
        for statement in jsondecode(aws_iam_role_policy.image_publish[0].policy).Statement : statement
        if statement.Action == "ecr:GetAuthorizationToken" && statement.Resource == "*"
      ]) == 1 &&
      length([
        for statement in jsondecode(aws_iam_role_policy.image_publish[0].policy).Statement : statement
        if(
          try(toset(statement.Action), toset([])) == toset([
            "ecr:BatchCheckLayerAvailability",
            "ecr:InitiateLayerUpload",
            "ecr:UploadLayerPart",
            "ecr:CompleteLayerUpload",
            "ecr:PutImage",
            "ecr:BatchGetImage",
            "ecr:DescribeImages",
            "ecr:DescribeImageScanFindings",
          ]) &&
          statement.Resource == module.ingress.repository_arn
        )
      ]) == 1
    )
    error_message = "GetAuthorizationToken is the only star action, and the other statement is the repository set"
  }

  assert {
    condition = (
      length(module.admin_static) == 1 &&
      length(aws_iam_role.admin_publish) == 1 &&
      length(aws_iam_role_policy.admin_publish) == 1 &&
      issensitive(output.admin_bucket) &&
      issensitive(output.admin_distribution_id)
    )
    error_message = "staging plans one admin shell, and the bucket and distribution outputs are sensitive"
  }

  assert {
    condition = (
      length(regexall("resource \"aws_iam_role_policy\" \"admin_publish\"", file("${path.module}/main.tf"))) == 1 &&
      length(regexall("role\\s*=\\s*aws_iam_role\\.admin_publish\\[count\\.index\\]\\.id", file("${path.module}/main.tf"))) == 1 &&
      length(regexall("policy\\s*=\\s*module\\.admin_static\\[count\\.index\\]\\.publish_policy", file("${path.module}/main.tf"))) == 1
    )
    error_message = "the admin publish role has exactly one policy, and it is the module publish policy"
  }

  assert {
    condition = (
      length(jsondecode(aws_iam_role.admin_publish[0].assume_role_policy).Statement) == 1 &&
      jsondecode(aws_iam_role.admin_publish[0].assume_role_policy).Statement[0].Effect == "Allow" &&
      jsondecode(aws_iam_role.admin_publish[0].assume_role_policy).Statement[0].Action == "sts:AssumeRoleWithWebIdentity" &&
      jsondecode(aws_iam_role.admin_publish[0].assume_role_policy).Statement[0].Principal == { Federated = aws_iam_openid_connect_provider.github[0].arn } &&
      keys(jsondecode(aws_iam_role.admin_publish[0].assume_role_policy).Statement[0].Condition) == ["StringEquals"] &&
      jsondecode(aws_iam_role.admin_publish[0].assume_role_policy).Statement[0].Condition.StringEquals == {
        "token.actions.githubusercontent.com:aud"                 = "sts.amazonaws.com"
        "token.actions.githubusercontent.com:sub"                 = "repo:taftechnology@100000000002/community-hub-core@100000000001:ref:refs/heads/main"
        "token.actions.githubusercontent.com:job_workflow_ref"    = "taftechnology/community-hub-core/.github/workflows/ci.yml@refs/heads/main"
        "token.actions.githubusercontent.com:repository_id"       = "100000000001"
        "token.actions.githubusercontent.com:repository_owner_id" = "100000000002"
      }
    )
    error_message = "the admin trust must be one Allow statement with exactly the five StringEquals claims"
  }
}
