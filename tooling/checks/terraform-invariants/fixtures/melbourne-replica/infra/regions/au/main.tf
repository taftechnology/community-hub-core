provider "aws" {
  region = var.aws_region
}

module "envelope" {
  source     = "../../modules/aws-kms-envelope"
  aws_region = var.aws_region
}

terraform {
  backend "s3" {
    region = "ap-southeast-2"
  }
}
