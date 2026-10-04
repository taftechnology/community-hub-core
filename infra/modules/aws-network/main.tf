locals {
  public_subnet_cidr   = cidrsubnet(var.vpc_cidr, 8, 0)
  private_subnet_cidrs = [cidrsubnet(var.vpc_cidr, 8, 1), cidrsubnet(var.vpc_cidr, 8, 2)]
}

resource "aws_vpc" "this" {
  region               = var.aws_region
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(
    { environment = var.environment, project = var.project },
    { Name = "${var.name}-vpc" },
  )
}

resource "aws_internet_gateway" "this" {
  region = var.aws_region
  vpc_id = aws_vpc.this.id

  tags = merge(
    { environment = var.environment, project = var.project },
    { Name = "${var.name}-igw" },
  )
}

resource "aws_subnet" "public" {
  region                  = var.aws_region
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_subnet_cidr
  availability_zone       = var.availability_zones[0]
  map_public_ip_on_launch = true

  tags = merge(
    { environment = var.environment, project = var.project },
    { Name = "${var.name}-public-${var.availability_zones[0]}" },
  )
}

resource "aws_subnet" "public_b" {
  region                  = var.aws_region
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 3)
  availability_zone       = var.availability_zones[1]
  map_public_ip_on_launch = true

  tags = merge(
    { environment = var.environment, project = var.project },
    { Name = "${var.name}-public-${var.availability_zones[1]}" },
  )
}

resource "aws_subnet" "private" {
  count = 2

  region            = var.aws_region
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = merge(
    { environment = var.environment, project = var.project },
    { Name = "${var.name}-private-${var.availability_zones[count.index]}" },
  )
}

resource "aws_route_table" "public" {
  region = var.aws_region
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(
    { environment = var.environment, project = var.project },
    { Name = "${var.name}-public" },
  )
}

resource "aws_route_table_association" "public" {
  region         = var.aws_region
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_b" {
  region         = var.aws_region
  subnet_id      = aws_subnet.public_b.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  region = var.aws_region
  vpc_id = aws_vpc.this.id

  tags = merge(
    { environment = var.environment, project = var.project },
    { Name = "${var.name}-private" },
  )
}

resource "aws_route_table_association" "private" {
  count = 2

  region         = var.aws_region
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "task" {
  region      = var.aws_region
  name        = "${var.name}-task"
  description = "Service task. No inbound. Egress to public AWS APIs and to RDS."
  vpc_id      = aws_vpc.this.id
  ingress     = []

  egress = [
    {
      description      = "HTTPS to public AWS APIs"
      from_port        = 443
      to_port          = 443
      protocol         = "tcp"
      cidr_blocks      = ["0.0.0.0/0"]
      ipv6_cidr_blocks = []
      prefix_list_ids  = []
      security_groups  = []
      self             = false
    },
  ]

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_security_group" "rds" {
  region      = var.aws_region
  name        = "${var.name}-rds"
  description = "Postgres. Inbound 5432 from the task only."
  vpc_id      = aws_vpc.this.id
  ingress     = []
  egress      = []

  tags = {
    environment = var.environment
    project     = var.project
  }
}

resource "aws_vpc_security_group_egress_rule" "task_rds" {
  region                       = var.aws_region
  security_group_id            = aws_security_group.task.id
  referenced_security_group_id = aws_security_group.rds.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres to RDS"
}

resource "aws_vpc_security_group_ingress_rule" "rds_postgres" {
  region                       = var.aws_region
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.task.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "Postgres from the task"
}
