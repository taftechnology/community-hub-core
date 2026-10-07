resource "aws_kms_key" "envelope" {
  region       = var.aws_region
  multi_region = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_replica_key" "envelope" {
  region          = "ap-southeast-4"
  primary_key_arn = aws_kms_key.envelope.arn

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "envelope_replica" {
  region        = "ap-southeast-4"
  name          = "alias/example-envelope"
  target_key_id = aws_kms_replica_key.envelope.key_id

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_cloudwatch_log_group" "example" {
  region         = var.aws_region
  awslogs-region = "ap-southeast-2"
}
