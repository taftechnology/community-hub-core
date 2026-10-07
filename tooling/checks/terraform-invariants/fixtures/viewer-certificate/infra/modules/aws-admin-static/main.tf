resource "aws_acm_certificate" "admin" {
  region = "us-east-1"
}

resource "aws_acm_certificate_validation" "admin" {
  region = "us-east-1"
}

resource "aws_s3_bucket" "admin" {
  region = var.aws_region
}

resource "aws_cloudfront_distribution" "admin" {
  enabled = true
}
