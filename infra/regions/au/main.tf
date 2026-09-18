provider "aws" {
  region = var.aws_region
}

provider "cloudflare" {}

locals {
  name = "ch-${var.environment}"
}

resource "terraform_data" "prod_tls" {
  lifecycle {
    precondition {
      condition     = var.environment != "prod" || var.cert_verification_mode == "verify_full"
      error_message = "prod must use verify_full."
    }
  }
}

resource "terraform_data" "prod_backup" {
  lifecycle {
    precondition {
      condition     = var.environment != "prod" || (var.deletion_protection && var.backup_retention_days >= 7)
      error_message = "prod must set deletion protection and backup retention."
    }
  }
}

check "prod_tls" {
  assert {
    condition     = var.environment != "prod" || var.cert_verification_mode == "verify_full"
    error_message = "prod must use verify_full."
  }
}

check "prod_backup" {
  assert {
    condition     = var.environment != "prod" || (var.deletion_protection && var.backup_retention_days >= 7)
    error_message = "prod must set deletion protection and backup retention."
  }
}

module "network" {
  source = "../../modules/aws-network"

  aws_region = var.aws_region
  name       = local.name
}

module "kms" {
  source = "../../modules/aws-kms-storage"

  aws_region = var.aws_region
  name       = local.name
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

module "tunnel" {
  source = "../../modules/cf-tunnel"

  account_id = var.cloudflare_account_id
  name       = "${local.name}-au"
}

module "ecs" {
  source = "../../modules/aws-ecs-tunnel"

  aws_region                  = var.aws_region
  aws_account_id              = var.aws_account_id
  name                        = local.name
  public_subnet_id            = module.network.public_subnet_id
  connector_security_group_id = module.network.connector_security_group_id
  tunnel_token                = module.tunnel.tunnel_token
}

module "vpc_service" {
  source = "../../modules/cf-vpc-service"

  account_id             = var.cloudflare_account_id
  name                   = "${local.name}-postgres"
  tunnel_id              = module.tunnel.tunnel_id
  rds_hostname           = module.rds.address
  cert_verification_mode = var.cert_verification_mode
}

module "hyperdrive" {
  source = "../../modules/cf-hyperdrive"

  account_id        = var.cloudflare_account_id
  name              = local.name
  service_id        = module.vpc_service.service_id
  enable_hyperdrive = var.enable_hyperdrive
  origin_password   = var.hyperdrive_origin_password
}

module "regional_hostname" {
  count  = var.enable_regional_hostnames ? 1 : 0
  source = "../../modules/cf-regional-hostname"

  zone_id  = var.zone_id
  hostname = "au.api.${var.zone_name}"
}
