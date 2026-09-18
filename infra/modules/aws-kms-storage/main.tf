resource "aws_kms_key" "storage" {
  region                  = var.aws_region
  description             = "RDS storage encryption (${var.name})"
  enable_key_rotation     = var.enable_key_rotation
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "storage" {
  region        = var.aws_region
  name          = "alias/${var.name}-storage"
  target_key_id = aws_kms_key.storage.key_id
}
