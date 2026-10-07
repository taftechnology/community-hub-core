resource "aws_s3_bucket" "state" {
  region = var.aws_region
  bucket = "ch-tfstate-staging-au"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_key" "state" {
  region              = var.aws_region
  enable_key_rotation = true

  lifecycle {
    prevent_destroy = true
  }
}
