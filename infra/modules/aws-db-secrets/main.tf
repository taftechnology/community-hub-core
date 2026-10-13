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

  root_arn = "arn:aws:iam::${var.aws_account_id}:root"

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_kms_key" "secrets" {
  region              = var.aws_region
  description         = "Database role password key (${var.name})"
  enable_key_rotation = var.enable_key_rotation
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "Admin"
        Effect    = "Allow"
        Principal = { AWS = local.root_arn }
        Action    = local.admin_actions
        Resource  = "*"
      },
      {
        Sid       = "SecretsManagerUse"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${var.aws_account_id}:root" }
        Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource  = "*"
        Condition = {
          StringEquals = {
            "kms:ViaService" = "secretsmanager.ap-southeast-2.amazonaws.com"
          }
          StringLike = {
            "kms:EncryptionContext:SecretARN" = [
              "arn:aws:secretsmanager:ap-southeast-2:${var.aws_account_id}:secret:${var.name}-app-??????",
              "arn:aws:secretsmanager:ap-southeast-2:${var.aws_account_id}:secret:${var.name}-identity-??????",
              "arn:aws:secretsmanager:ap-southeast-2:${var.aws_account_id}:secret:${var.name}-platform-??????",
              "arn:aws:secretsmanager:ap-southeast-2:${var.aws_account_id}:secret:${var.name}-provision-owner-??????",
            ]
          }
        }
      },
    ]
  })

  tags = local.tags
}

ephemeral "random_password" "app" {
  length  = 32
  special = false
}

ephemeral "random_password" "identity" {
  length  = 32
  special = false
}

ephemeral "random_password" "platform" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  region     = var.aws_region
  name       = "${var.name}-app"
  kms_key_id = aws_kms_key.secrets.arn
  tags       = local.tags
}

resource "aws_secretsmanager_secret" "identity" {
  region     = var.aws_region
  name       = "${var.name}-identity"
  kms_key_id = aws_kms_key.secrets.arn
  tags       = local.tags
}

resource "aws_secretsmanager_secret" "platform" {
  region     = var.aws_region
  name       = "${var.name}-platform"
  kms_key_id = aws_kms_key.secrets.arn
  tags       = local.tags
}

resource "aws_secretsmanager_secret_version" "app" {
  region                   = var.aws_region
  secret_id                = aws_secretsmanager_secret.app.id
  secret_string_wo         = ephemeral.random_password.app.result
  secret_string_wo_version = 1
}

resource "aws_secretsmanager_secret_version" "identity" {
  region                   = var.aws_region
  secret_id                = aws_secretsmanager_secret.identity.id
  secret_string_wo         = ephemeral.random_password.identity.result
  secret_string_wo_version = 1
}

resource "aws_secretsmanager_secret_version" "platform" {
  region                   = var.aws_region
  secret_id                = aws_secretsmanager_secret.platform.id
  secret_string_wo         = ephemeral.random_password.platform.result
  secret_string_wo_version = 1
}
