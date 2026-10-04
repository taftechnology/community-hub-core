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

resource "terraform_data" "staging_zone" {
  lifecycle {
    precondition {
      condition     = var.environment != "staging" || var.staging_zone_id != null
      error_message = "staging must pass the registered communityhub-staging.net zone id."
    }
  }
}

check "staging_zone" {
  assert {
    condition     = var.environment != "staging" || var.staging_zone_id != null
    error_message = "staging must pass the registered communityhub-staging.net zone id."
  }
}

module "network" {
  source = "../../modules/aws-network"

  aws_region  = var.aws_region
  name        = local.name
  environment = var.environment
  project     = "community-hub"
}

module "kms" {
  source = "../../modules/aws-kms-storage"

  aws_region     = var.aws_region
  aws_account_id = var.aws_account_id
  name           = local.name
  environment    = var.environment
  project        = "community-hub"
}

module "rds" {
  source = "../../modules/aws-rds"

  aws_region             = var.aws_region
  name                   = local.name
  environment            = var.environment
  project                = "community-hub"
  subnet_ids             = module.network.private_subnet_ids
  vpc_security_group_ids = [module.network.rds_security_group_id]
  kms_key_arn            = module.kms.key_arn
  deletion_protection    = var.deletion_protection
  backup_retention_days  = var.backup_retention_days
  multi_az               = false
  alert_email            = var.alert_email
}

module "db_secrets" {
  source = "../../modules/aws-db-secrets"

  aws_region     = var.aws_region
  aws_account_id = var.aws_account_id
  name           = local.name
  environment    = var.environment
  project        = "community-hub"
}

module "budgets" {
  source = "../../modules/aws-budgets"

  enable_budgets = var.enable_budgets
  environment    = var.environment
  project        = "community-hub"
  name           = local.name
  alert_email    = var.alert_email
}

module "envelope" {
  source = "../../modules/aws-kms-envelope"

  aws_region             = var.aws_region
  aws_account_id         = var.aws_account_id
  name                   = local.name
  environment            = var.environment
  project                = "community-hub"
  vpc_id                 = module.network.vpc_id
  public_subnet_id       = module.network.public_subnet_id
  enable_kms_endpoint    = var.enable_kms_endpoint
  task_security_group_id = module.network.task_security_group_id
  db_secret_arns = [
    module.db_secrets.app_secret_arn,
    module.db_secrets.identity_secret_arn,
    module.db_secrets.platform_secret_arn,
  ]
  db_secrets_key_arn = module.db_secrets.key_arn
}

module "ingress" {
  source = "../../modules/aws-ingress"

  aws_region             = var.aws_region
  aws_account_id         = var.aws_account_id
  name                   = local.name
  environment            = var.environment
  project                = "community-hub"
  vpc_id                 = module.network.vpc_id
  private_subnet_ids     = module.network.private_subnet_ids
  task_security_group_id = module.network.task_security_group_id
  zone_name              = var.environment == "prod" ? "communityhub.one" : "communityhub-staging.net"
  create_public_zone     = var.create_public_zone
  attach_public_dns      = var.attach_public_dns
  public_zone_id         = var.create_public_zone ? null : var.staging_zone_id
  desired_count          = var.desired_count
  service_image          = var.service_image
  turnstile_secret_arn   = var.turnstile_secret_arn
  capacity_provider      = var.environment == "prod" ? "FARGATE" : "FARGATE_SPOT"
  task_subnet_ids        = var.environment == "prod" ? module.network.public_subnet_ids : [module.network.public_subnet_id]
  execution_role_arn     = module.envelope.execution_role_arn
  execution_role_name    = module.envelope.execution_role_name
  task_role_arn          = module.envelope.task_role_arn
  log_group_name         = module.envelope.log_group_name
  db_host                = module.rds.address
  db_port                = module.rds.port
  envelope_key_arn       = module.envelope.key_arn
  app_secret_arn         = module.db_secrets.app_secret_arn
  identity_secret_arn    = module.db_secrets.identity_secret_arn
  platform_secret_arn    = module.db_secrets.platform_secret_arn
}
