resource "aws_kms_key" "storage" {
  region                  = var.aws_region
  description             = "RDS storage encryption (${var.name})"
  enable_key_rotation     = var.enable_key_rotation
  deletion_window_in_days = 30

  policy = jsonencode({
    Version = "2012-10-17"
    Id      = "key-default-1"
    Statement = [
      {
        Sid       = "EnableIAMUserPermissions"
        Effect    = "Allow"
        Principal = {
          AWS = "arn:aws:iam::${var.aws_account_id}:root"
        }
        Action   = "kms:*"
        Resource = "*"
      },
    ]
  })
}

resource "aws_kms_alias" "storage" {
  region        = var.aws_region
  name          = "alias/${var.name}-storage"
  target_key_id = aws_kms_key.storage.key_id
}
