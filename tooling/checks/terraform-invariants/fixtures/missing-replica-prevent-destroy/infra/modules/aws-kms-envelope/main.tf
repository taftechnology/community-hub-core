resource "aws_kms_replica_key" "envelope" {
  region          = "ap-southeast-4"
  primary_key_arn = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-envelope"
}
