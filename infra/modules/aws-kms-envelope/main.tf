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

  task_role_arn = "arn:aws:iam::${var.aws_account_id}:role/${var.name}-kms-broker-task"
  root_arn      = "arn:aws:iam::${var.aws_account_id}:root"

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
        StringEquals = {
          "aws:SourceVpce"                 = aws_vpc_endpoint.kms.id
          "kms:EncryptionContext:key_kind" = "org"
        }
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
        StringEquals = {
          "aws:SourceVpce"                 = aws_vpc_endpoint.kms.id
          "kms:EncryptionContext:key_kind" = "identity"
        }
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
        StringEquals = {
          "aws:SourceVpce"                 = aws_vpc_endpoint.kms.id
          "kms:EncryptionContext:key_kind" = "org"
        }
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
        StringEquals = {
          "aws:SourceVpce"                 = aws_vpc_endpoint.kms.id
          "kms:EncryptionContext:key_kind" = "identity"
        }
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

  secret_name    = "${var.name}/kms-broker-tunnel-token"
  log_group_name = "/community-hub/${var.name}/kms-broker"
  secret_arn     = "arn:aws:secretsmanager:${var.aws_region}:${var.aws_account_id}:secret:${local.secret_name}"
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
  enable_key_rotation                = var.enable_key_rotation
  deletion_window_in_days            = 30
  bypass_policy_lockout_safety_check = false
  policy                             = jsonencode({ Version = "2012-10-17", Statement = local.policy_statements })

  depends_on = [aws_iam_role.task]

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "envelope" {
  region        = var.aws_region
  name          = "alias/${var.name}-envelope"
  target_key_id = aws_kms_key.envelope.key_id
}

resource "aws_iam_role" "task" {
  name = "${var.name}-kms-broker-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_security_group" "broker" {
  region      = var.aws_region
  name        = "${var.name}-kms-broker"
  description = "broker task, no inbound"
  vpc_id      = var.vpc_id
  ingress     = []

  egress = [
    {
      description      = "HTTPS to Cloudflare"
      from_port        = 443
      to_port          = 443
      protocol         = "tcp"
      cidr_blocks      = ["0.0.0.0/0"]
      ipv6_cidr_blocks = []
      prefix_list_ids  = []
      security_groups  = []
      self             = false
    },
    {
      description      = "Cloudflare QUIC / tunnel"
      from_port        = 7844
      to_port          = 7844
      protocol         = "tcp"
      cidr_blocks      = ["0.0.0.0/0"]
      ipv6_cidr_blocks = []
      prefix_list_ids  = []
      security_groups  = []
      self             = false
    },
  ]
}

resource "aws_security_group" "endpoint" {
  region      = var.aws_region
  name        = "${var.name}-kms-endpoint"
  description = "KMS interface endpoint. TCP 443 from the broker task only."
  vpc_id      = var.vpc_id
  egress      = []

  ingress = [
    merge(
      {
        description      = "HTTPS from the broker task"
        from_port        = 443
        to_port          = 443
        protocol         = "tcp"
        cidr_blocks      = []
        ipv6_cidr_blocks = []
        prefix_list_ids  = []
        self             = false
      },
      {
        security_groups = [aws_security_group.broker.id]
      },
    ),
  ]
}

resource "aws_vpc_endpoint" "kms" {
  region              = var.aws_region
  vpc_id              = var.vpc_id
  service_name        = "com.amazonaws.ap-southeast-2.kms"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = [var.public_subnet_id]
  private_dns_enabled = true
  security_group_ids  = [aws_security_group.endpoint.id]
}

resource "aws_secretsmanager_secret" "broker_tunnel" {
  region      = var.aws_region
  name        = local.secret_name
  description = "Cloudflare Tunnel token for the KMS broker (${var.name})"
}

resource "aws_secretsmanager_secret_version" "broker_tunnel" {
  region        = var.aws_region
  secret_id     = aws_secretsmanager_secret.broker_tunnel.id
  secret_string = var.broker_tunnel_token
}

resource "aws_cloudwatch_log_group" "broker" {
  region            = var.aws_region
  name              = local.log_group_name
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "execution" {
  name = "${var.name}-kms-broker-execution"
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
  name = "kms-broker-execution"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "GetBrokerTunnelToken"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = ["${local.secret_arn}*"]
      },
      {
        Sid      = "WriteBrokerLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["${local.log_arn}:*"]
      },
    ]
  })
}
