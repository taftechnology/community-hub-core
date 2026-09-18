resource "aws_db_subnet_group" "this" {
  region     = var.aws_region
  name       = "${var.name}-postgres"
  subnet_ids = var.subnet_ids
}

resource "aws_db_parameter_group" "this" {
  region = var.aws_region
  name   = "${var.name}-postgres"
  family = var.parameter_group_family

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

resource "aws_db_instance" "this" {
  region     = var.aws_region
  identifier = "${var.name}-postgres"

  engine                 = "postgres"
  engine_version         = var.engine_version
  instance_class         = var.instance_class
  allocated_storage      = 20
  db_subnet_group_name   = aws_db_subnet_group.this.name
  parameter_group_name   = aws_db_parameter_group.this.name
  vpc_security_group_ids = var.vpc_security_group_ids

  storage_encrypted           = true
  kms_key_id                  = var.kms_key_arn
  publicly_accessible         = var.publicly_accessible
  manage_master_user_password = true
  username                    = "postgres"
  ca_cert_identifier          = var.ca_cert_identifier

  multi_az                = var.environment == "prod"
  deletion_protection     = var.environment == "prod"
  backup_retention_period = var.environment == "prod" ? 7 : 0
  skip_final_snapshot     = var.environment != "prod"
  copy_tags_to_snapshot   = true
  apply_immediately       = var.environment != "prod"

  tags = {
    Name = "${var.name}-postgres"
  }
}
