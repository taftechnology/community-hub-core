resource "aws_s3_bucket" "state" {
  region = "ap-southeast-2"
  bucket = "ch-tfstate-staging-au"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_key" "state" {
  region              = "ap-southeast-2"
  enable_key_rotation = true

  lifecycle {
    prevent_destroy = true
  }
}
