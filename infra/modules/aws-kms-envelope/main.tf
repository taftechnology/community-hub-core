locals {
  admin_actions = tolist([
    "kms:DescribeKey",
    "kms:GetKeyPolicy",
    "kms:GetKeyRotationStatus",
    "kms:ListResourceTags",
    "kms:PutKeyPolicy",
    "kms:CreateAlias",
    "kms:DeleteAlias",
    "kms:EnableKey",
    "kms:DisableKey",
    "kms:EnableKeyRotation",
    "kms:DisableKeyRotation",
    "kms:UpdateKeyDescription",
    "kms:TagResource",
    "kms:UntagResource",
    "kms:ScheduleKeyDeletion",
    "kms:CancelKeyDeletion",
  ])

  expected_sids = [
    "Admin",
    "GenerateDataKeyOrg",
    "GenerateDataKeyIdentity",
    "DecryptOrg",
    "DecryptIdentity",
  ]

  task_role_arn = "arn:aws:iam::${var.aws_account_id}:role/${var.name}-task"
  root_arn      = "arn:aws:iam::${var.aws_account_id}:root"

  source_vpce = var.enable_kms_endpoint ? {
    "aws:SourceVpce" = aws_vpc_endpoint.kms[0].id
  } : {}

  admin_action_list = var.policy_probe_action == null ? local.admin_actions : concat(local.admin_actions, [var.policy_probe_action])

  policy_statements = [
    {
      Sid       = "Admin"
      Effect    = "Allow"
      Principal = { AWS = local.root_arn }
      Action    = local.admin_action_list
      Resource  = "*"
    },
    {
      Sid       = "GenerateDataKeyOrg"
      Effect    = "Allow"
      Principal = { AWS = local.task_role_arn }
      Action    = ["kms:GenerateDataKey"]
      Resource  = "*"
      Condition = {
        StringEquals = merge(
          {
            "kms:EncryptionContext:key_kind" = "org"
          },
          local.source_vpce,
        )
        "ForAllValues:StringEquals" = {
          "kms:EncryptionContextKeys" = ["key_kind", "org_id", "key_version"]
        }
        Null = {
          "kms:EncryptionContext:key_kind"    = "false"
          "kms:EncryptionContext:org_id"      = "false"
          "kms:EncryptionContext:key_version" = "false"
          "kms:EncryptionContext:region"      = "true"
        }
      }
    },
    {
      Sid       = "GenerateDataKeyIdentity"
      Effect    = "Allow"
      Principal = { AWS = local.task_role_arn }
      Action    = ["kms:GenerateDataKey"]
      Resource  = "*"
      Condition = {
        StringEquals = merge(
          {
            "kms:EncryptionContext:key_kind" = "identity"
          },
          local.source_vpce,
        )
        "ForAllValues:StringEquals" = {
          "kms:EncryptionContextKeys" = ["key_kind", "region", "key_version"]
        }
        Null = {
          "kms:EncryptionContext:key_kind"    = "false"
          "kms:EncryptionContext:region"      = "false"
          "kms:EncryptionContext:key_version" = "false"
          "kms:EncryptionContext:org_id"      = "true"
        }
      }
    },
    {
      Sid       = "DecryptOrg"
      Effect    = "Allow"
      Principal = { AWS = local.task_role_arn }
      Action    = ["kms:Decrypt"]
      Resource  = "*"
      Condition = {
        StringEquals = merge(
          {
            "kms:EncryptionContext:key_kind" = "org"
          },
          local.source_vpce,
        )
        "ForAllValues:StringEquals" = {
          "kms:EncryptionContextKeys" = ["key_kind", "org_id", "key_version"]
        }
        Null = {
          "kms:EncryptionContext:key_kind"    = "false"
          "kms:EncryptionContext:org_id"      = "false"
          "kms:EncryptionContext:key_version" = "false"
          "kms:EncryptionContext:region"      = "true"
        }
      }
    },
    {
      Sid       = "DecryptIdentity"
      Effect    = "Allow"
      Principal = { AWS = local.task_role_arn }
      Action    = ["kms:Decrypt"]
      Resource  = "*"
      Condition = {
        StringEquals = merge(
          {
            "kms:EncryptionContext:key_kind" = "identity"
          },
          local.source_vpce,
        )
        "ForAllValues:StringEquals" = {
          "kms:EncryptionContextKeys" = ["key_kind", "region", "key_version"]
        }
        Null = {
          "kms:EncryptionContext:key_kind"    = "false"
          "kms:EncryptionContext:region"      = "false"
          "kms:EncryptionContext:key_version" = "false"
          "kms:EncryptionContext:org_id"      = "true"
        }
      }
    },
  ]

  log_group_name = "/community-hub/${var.name}/service"
  log_arn        = "arn:aws:logs:${var.aws_region}:${var.aws_account_id}:log-group:${local.log_group_name}"
}

resource "terraform_data" "envelope_key_policy" {
  lifecycle {
    precondition {
      condition = (
        var.policy_probe_action == null &&
        length(local.policy_statements) == 5 &&
        [for statement in local.policy_statements : statement.Sid] == local.expected_sids &&
        local.policy_statements[0].Action == local.admin_actions &&
        local.policy_statements[1].Action == ["kms:GenerateDataKey"] &&
        local.policy_statements[2].Action == ["kms:GenerateDataKey"] &&
        local.policy_statements[3].Action == ["kms:Decrypt"] &&
        local.policy_statements[4].Action == ["kms:Decrypt"]
      )
      error_message = "envelope key policy must be exactly five statements with the allowed actions."
    }
  }
}

resource "aws_kms_key" "envelope" {
  region                             = var.aws_region
  description                        = "Envelope wrapping key (${var.name})"
  multi_region                       = true
  enable_key_rotation                = var.enable_key_rotation
  deletion_window_in_days            = 30
  bypass_policy_lockout_safety_check = false
  policy                             = jsonencode({ Version = "2012-10-17", Statement = local.policy_statements })

  depends_on = [aws_iam_role.task]

  lifecycle {
    prevent_destroy = true
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_kms_alias" "envelope" {
  region        = var.aws_region
  name          = "alias/${var.name}-envelope"
  target_key_id = aws_kms_key.envelope.key_id
}

resource "aws_iam_role" "task" {
  name = "${var.name}-task"
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
    project     = var.project
  }
}

resource "aws_security_group" "endpoint" {
  count = var.enable_kms_endpoint ? 1 : 0

  region      = var.aws_region
  name        = "${var.name}-kms-endpoint"
  description = "KMS interface endpoint. TCP 443 from the task security group only."
  vpc_id      = var.vpc_id
  egress      = []

  ingress = [
    {
      description      = "HTTPS from the task"
      from_port        = 443
      to_port          = 443
      protocol         = "tcp"
      cidr_blocks      = []
      ipv6_cidr_blocks = []
      prefix_list_ids  = []
      security_groups  = [var.task_security_group_id]
      self             = false
    },
  ]

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_vpc_endpoint" "kms" {
  count = var.enable_kms_endpoint ? 1 : 0

  region              = var.aws_region
  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.ap-southeast-2.kms"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [var.public_subnet_id]
  private_dns_enabled = true
  security_group_ids  = [aws_security_group.endpoint[0].id]

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_cloudwatch_log_group" "broker" {
  region            = var.aws_region
  name              = local.log_group_name
  retention_in_days = var.log_retention_days

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_iam_role" "execution" {
  name = "${var.name}-execution"
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
    project     = var.project
  }
}

resource "aws_iam_role_policy" "execution" {
  name = "service-execution"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteBrokerLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${local.log_arn}:*"]
      },
    ]
  })
}

resource "aws_iam_role_policy" "task_secrets" {
  name = "task-secrets"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadDbSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.db_secret_arns
      },
      {
        Sid      = "DecryptDbSecrets"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.db_secrets_key_arn
      },
    ]
  })
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "execution-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadDbSecrets"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.db_secret_arns
      },
      {
        Sid      = "DecryptDbSecrets"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.db_secrets_key_arn
      },
    ]
  })
}
