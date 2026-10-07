resource "aws_kms_key" "envelope" {
  region              = var.aws_region
  enable_key_rotation = true
}
