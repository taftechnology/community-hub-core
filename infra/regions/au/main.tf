provider "aws" {
  region = var.aws_region
}

locals {
  name = "ch-${var.environment}"
}

resource "terraform_data" "prod_backup" {
  lifecycle {
    precondition {
      condition     = var.environment != "prod" || (var.deletion_protection && var.backup_retention_days >= 7)
      error_message = "prod must set deletion protection and backup retention."
    }
  }
}

check "prod_backup" {
  assert {
    condition     = var.environment != "prod" || (var.deletion_protection && var.backup_retention_days >= 7)
    error_message = "prod must set deletion protection and backup retention."
  }
}

resource "terraform_data" "prod_kms_endpoint" {
  lifecycle {
    precondition {
      condition     = var.environment != "prod" || var.enable_kms_endpoint
      error_message = "prod must enable the KMS endpoint."
    }
  }
}

check "prod_kms_endpoint" {
  assert {
    condition     = var.environment != "prod" || var.enable_kms_endpoint
    error_message = "prod must enable the KMS endpoint."
  }
}

module "network" {
  source = "../../modules/aws-network"

  aws_region = var.aws_region
  name       = local.name
}

module "kms" {
  source = "../../modules/aws-kms-storage"

  aws_region     = var.aws_region
  aws_account_id = var.aws_account_id
  name           = local.name
}

module "rds" {
  source = "../../modules/aws-rds"

  aws_region             = var.aws_region
  name                   = local.name
  environment            = var.environment
  subnet_ids             = module.network.private_subnet_ids
  vpc_security_group_ids = [module.network.rds_security_group_id]
  kms_key_arn            = module.kms.key_arn
}

module "envelope" {
  source = "../../modules/aws-kms-envelope"

  aws_region             = var.aws_region
  aws_account_id         = var.aws_account_id
  name                   = local.name
  vpc_id                 = module.network.vpc_id
  public_subnet_id       = module.network.public_subnet_id
  enable_kms_endpoint    = var.enable_kms_endpoint
  task_security_group_id = module.network.task_security_group_id
}
