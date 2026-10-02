resource "aws_kms_key" "envelope" {
  region              = "ap-southeast-2"
  enable_key_rotation = true
}
