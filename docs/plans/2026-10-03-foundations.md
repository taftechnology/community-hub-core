# Foundations before the first apply Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the pre-apply AWS resources in the tree: the task security group, the multi-Region envelope key, the database shape, the three role secrets, tags, and budgets that stay off until the environment tag is active.

**Architecture:** Seven commits, in the spec's order. Each updates the AU root in that same commit. The task role, the execution role, and the log group stay in `aws-kms-envelope`. The secrets key grants `Decrypt` and `GenerateDataKey` to the account root, under the Secrets Manager conditions, and names no role. The policies that read the secrets are separate `aws_iam_role_policy` resources.

**Tech Stack:** Terraform 1.11.4, AWS provider `~> 6.0`, `hashicorp/random` `~> 3.7`, tflint AWS ruleset 0.48.0. No cloud apply.

Spec: docs/specs/2026-10-03-foundations.md

Status: approved (2026-10-03, Abdus Salam)

**Branch:** `feat/2026-10-03-foundations` · one PR · 7 tasks, one commit each

## Global Constraints

- The spec is approved. Do not edit it. Do not edit `docs/specs/2026-10-03-personal-data-on-aws.md`, its plan, or a merged ADR. ADR 0009 is not edited.
- Do not run `terraform apply` or any command that creates, changes, or deletes a cloud resource. Do not print a password, `alert_email`, or a real account ID.
- Staging and production are one AWS account. Do not add an unfiltered account-wide budget.
- `enable_budgets` defaults to false. `enable_kms_endpoint` defaults to false. Prod tfvars set the endpoint flag true. The envelope module does not use `environment` for the endpoint check. Task 5 adds `environment` on that module only as a tag value. The spec says the module does not gain the variable. The PR body records that difference.
- The envelope key sets `multi_region = true` in task 2, with the test in that commit. Do not apply the key.
- Provider `default_tags` are not used. Modules take `environment` and `project` and set them on taggable resources only.
- The SNS topic is not encrypted and has no `kms_master_key_id`.
- The storage alarm threshold is 2147483648 (2 GiB). Do not use 10 GiB.
- Lock `hashicorp/random` with Terraform 1.11.4 `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`. Do not hand-edit hashes. A plain `terraform init` on one machine is not enough.
- No migration. There is no expand, migrate, or contract wave.
- This chunk is the size exception in the spec: more than two modules, past the ~800-line guide, one chunk. Keep each task to the files that task names.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- The human reviews each commit before the next task starts. A second fresh-context review of the final diff is required before merge, because this chunk touches encryption and residency. Record the configurations in the PR body. Do not pin a model name in `AGENTS.md`.
- AGENTS.md §8's staging-hostname check does not apply. Nothing is deployed. Say that in the PR body.
- The human steps in the spec's Out-of-band section are not tasks. Do not invent `alert_email` in tfvars.
- Do not mark this plan approved yourself. Traceability stays red until the plan is approved and the PR body links the spec and the plan.
- Every task runs `pnpm format` before its commit. `format` is `prettier --check .`. If it fails, run `pnpm exec prettier --write` on the files that task touched and run `pnpm format` again.
- Every task then runs `pnpm lint && pnpm typecheck && pnpm check:boundaries`. Task 1 also runs `pnpm test --filter @community-hub/check-terraform-invariants`. Tasks 2 to 7 touch no package and run `pnpm test` with no filter. Those tests need Postgres: `docker compose -f packages/db/test/docker-compose.yml up -d postgres`.
- Every task that touches Terraform also runs, in each directory it changes: `terraform fmt -check`, `terraform init -backend=false -lockfile=readonly`, `terraform validate`, `tflint --init && tflint`, `terraform test`. Use Terraform 1.11.4.

**Rollback:** Revert the PR. Staging has never been applied, so there is no state to move.

---

### Task 1: Task security group and the second public subnet

**Files:**

- Modify: `infra/modules/aws-network/main.tf`
- Modify: `infra/modules/aws-network/outputs.tf`
- Modify: `infra/modules/aws-network/tests/network.tftest.hcl`
- Modify: `infra/regions/au/tests/cell.tftest.hcl`
- Modify: `tooling/checks/terraform-invariants/check.ts`
- Modify: `tooling/checks/terraform-invariants/selftest.ts`
- Delete: `tooling/checks/terraform-invariants/fixtures/connector-ingress-rule/`

**Interfaces:**

- Consumes: nothing from a later task.
- Produces: `aws_subnet.public` unchanged (AZ index 0, CIDR index 0). New `aws_subnet.public_b` in `var.availability_zones[1]` with `cidrsubnet(var.vpc_cidr, 8, 3)`, associated with `aws_route_table.public`. Output `public_subnet_id` stays `aws_subnet.public.id`. Output `public_subnet_ids` is `[aws_subnet.public.id, aws_subnet.public_b.id]`. Output `connector_security_group_id` is replaced by `task_security_group_id` = `aws_security_group.task.id`. The RDS ingress rule references that group. The AU root does not need a new argument yet. `module.network.rds_security_group_id` stays.

**Rule this must not break:** residency. Both subnets stay in `ap-southeast-2`. Do not add a NAT gateway. Do not give the task group an inbound rule. Do not keep port 7844.

- [ ] **Step 1: Rewrite the network test first**

In `network.tftest.hcl`, replace the connector override and the two connector assertions. Keep the port assertions. The happy run becomes:

```hcl
  override_resource {
    target = aws_security_group.task
    values = {
      id = "sg-task"
    }
    override_during = plan
  }

  override_resource {
    target = aws_security_group.rds
    values = {
      id = "sg-rds"
    }
    override_during = plan
  }

  assert {
    condition     = aws_subnet.public.map_public_ip_on_launch == true && aws_subnet.public_b.map_public_ip_on_launch == true
    error_message = "both public subnets must auto-assign public IPs"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.rds_postgres.referenced_security_group_id == "sg-task"
    error_message = "RDS ingress must be limited to the task security group"
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.rds_postgres.from_port == 5432 && aws_vpc_security_group_ingress_rule.rds_postgres.to_port == 5432
    error_message = "RDS ingress must be port 5432"
  }

  assert {
    condition     = aws_vpc_security_group_egress_rule.task_rds.from_port == 5432 && aws_vpc_security_group_egress_rule.task_rds.to_port == 5432 && aws_vpc_security_group_egress_rule.task_rds.referenced_security_group_id == "sg-rds"
    error_message = "task group must reach RDS on 5432"
  }

  assert {
    condition = anytrue([
      for rule in aws_security_group.task.egress :
      rule.from_port == 443 && rule.to_port == 443 && contains(rule.cidr_blocks, "0.0.0.0/0")
    ])
    error_message = "task group must allow outbound 443 to the internet"
  }

  assert {
    condition     = !strcontains(jsonencode(aws_security_group.task.egress), "7844")
    error_message = "task group must not allow port 7844"
  }
```

Delete the assertion `length(aws_security_group.connector.ingress) == 0`.

In `cell.tftest.hcl` `staging_happy`, delete the assertion whose error is `envelope key policy must not reference the connector execution role`.

- [ ] **Step 2: Run the network test and confirm it fails**

```bash
terraform -chdir=infra/modules/aws-network init -backend=false
terraform -chdir=infra/modules/aws-network test
```

Expected: fail because `aws_security_group.task` and `aws_subnet.public_b` do not exist.

- [ ] **Step 3: Replace the connector group and add the subnet**

Add `aws_subnet.public_b` after `aws_subnet.public`, and associate it with `aws_route_table.public`. Replace `aws_security_group.connector` with:

```hcl
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
}
```

Replace `aws_vpc_security_group_egress_rule.connector_rds` with `aws_vpc_security_group_egress_rule.task_rds` whose `security_group_id` is `aws_security_group.task.id`. Point `aws_vpc_security_group_ingress_rule.rds_postgres.referenced_security_group_id` at `aws_security_group.task.id` and set its description to `Postgres from the task`. Replace output `connector_security_group_id` with `task_security_group_id`. Add `public_subnet_ids`. Change the `public_subnet_id` description so it no longer says tunnel connector. Change the RDS output description so it says the task group.

- [ ] **Step 4: Retire the connector checker in the same commit**

Delete the call `violations.push(...validateConnectorFile(...))` and delete `validateConnectorFile`. Remove `"connector-ingress-rule"` from `mustFail` in `selftest.ts`. Delete the directory `tooling/checks/terraform-invariants/fixtures/connector-ingress-rule`. Do not add a rule that the task group has no inbound. Leave `fixtures/valid` as it is, even though it still contains a connector resource. The checker no longer reads that name.

- [ ] **Step 5: Run the gate**

`terraform test` in `infra/modules/aws-network` and `infra/regions/au` exits 0. `pnpm test --filter @community-hub/check-terraform-invariants` exits 0. Then `pnpm format`, lint, typecheck, and `pnpm check:boundaries`.

- [ ] **Step 6: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(network): replace the connector group with the task group

RDS ingress comes from the task security group, a second public subnet
is associated with the public route table, and the connector invariant
is retired because nothing named connector remains to check.

Refs: docs/plans/2026-10-03-foundations.md task 1
EOF
)"
```

---

### Task 2: Multi-Region envelope key, renamed roles, endpoint flag

**Files:**

- Modify: `infra/modules/aws-kms-envelope/main.tf`
- Modify: `infra/modules/aws-kms-envelope/variables.tf`
- Modify: `infra/modules/aws-kms-envelope/outputs.tf`
- Modify: `infra/modules/aws-kms-envelope/tests/envelope.tftest.hcl`
- Modify: `infra/regions/au/outputs.tf`
- Modify: `infra/modules/aws-kms-storage/tests/kms.tftest.hcl`
- Modify: `infra/regions/au/main.tf`
- Modify: `infra/regions/au/variables.tf`
- Modify: `infra/regions/au/env/prod.tfvars`
- Modify: `infra/regions/au/tests/cell.tftest.hcl`

**Interfaces:**

- Consumes: `module.network.task_security_group_id` and `module.network.public_subnet_id` from task 1.
- Produces: `aws_iam_role.task` named `${var.name}-task`. `aws_iam_role.execution` named `${var.name}-execution`. Log group `/community-hub/${var.name}/service`. Outputs `task_role_name`, `execution_role_name`, and `log_group_name` use those names. Output `broker_security_group_id` is deleted. Output `endpoint_id` is `one(aws_vpc_endpoint.kms[*].id)`, null when the flag is off. The root output `kms_endpoint_id` stays wired to it. `enable_kms_endpoint` bool, default false, on the module and on the AU root. This task does not add `environment` to the module. The root check `prod_kms_endpoint` fails when `environment` is `prod` and the flag is false, both as a precondition and as a `check` block. `aws_kms_key.envelope.multi_region` is true.

**Rule this must not break:** the envelope key's encryption-context conditions. Do not add or remove a cryptographic statement. Do not drop `prevent_destroy`. The execution role policy must not contain `kms:`.

- [ ] **Step 1: Add the variables and the root check**

On the envelope module:

```hcl
variable "enable_kms_endpoint" {
  type        = bool
  description = "Create the KMS interface endpoint. Staging defaults off."
  default     = false
}

variable "task_security_group_id" {
  type        = string
  description = "Task security group allowed into the KMS endpoint on 443."
}
```

On the AU root, next to `prod_backup`:

```hcl
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
```

`variable "enable_kms_endpoint"` on the root has default false. `env/prod.tfvars` sets `enable_kms_endpoint = true`. `env/staging.tfvars` does not set it. Pass `enable_kms_endpoint` and `task_security_group_id = module.network.task_security_group_id` into `module "envelope"`.

- [ ] **Step 2: Rewrite the envelope tests, then the cell and storage tests**

Every existing envelope run gains `task_security_group_id = "sg-task"`. `happy` is the flag-off run: it does not set `enable_kms_endpoint`, and it asserts the role name `ch-staging-task`, the execution role name `ch-staging-execution`, the log group `/community-hub/ch-staging/service`, `aws_kms_key.envelope.multi_region == true`, `length(aws_vpc_endpoint.kms) == 0`, `output.endpoint_id == null`, and that the key policy does not contain `aws:SourceVpce`. Keep the assertion that the execution policy contains `logs:PutLogEvents` and does not contain `kms:`.

Add `run "endpoint_on"` with `enable_kms_endpoint = true`. Move the existing `override_resource` for `aws_vpc_endpoint.kms` onto that run only, and address the counted resource as `aws_vpc_endpoint.kms[0]` with `id = "vpce-mock"`. Assert `length(aws_vpc_endpoint.kms) == 1`, `output.endpoint_id == "vpce-mock"`, and that each non-Admin statement has `Condition.StringEquals["aws:SourceVpce"] == "vpce-mock"`. Assert the endpoint security group's ingress references `sg-task`.

In `kms.tftest.hcl` and in `cell.tftest.hcl` `staging_happy`, replace `kms-broker-task` with `ch-staging-task`. `staging_happy` becomes the flag-off run. Move its `override_resource` for `module.envelope.aws_vpc_endpoint.kms` and the assertion `module.envelope.endpoint_id == "vpce-mock"` out of that run. Rewrite the cell assertion that requires `ch-staging-kms-broker-task` and `vpce-mock` so the default staging plan has four cryptographic statements whose principal is `arn:aws:iam::123456789012:role/ch-staging-task` and whose policy text does not contain `aws:SourceVpce`. Assert `module.envelope.endpoint_id == null` on that run.

Add `run "staging_endpoint_on"` that sets `enable_kms_endpoint = true`. That run holds the moved override, addressed as `module.envelope.aws_vpc_endpoint.kms[0]`, the assertion `module.envelope.endpoint_id == "vpce-mock"`, and the `aws:SourceVpce` assertion. Add `run "prod_endpoint_off_fails"` with `environment = "prod"`, `enable_kms_endpoint = false`, `deletion_protection = true`, `backup_retention_days = 7`, and both failure addresses:

```hcl
expect_failures = [
  check.prod_kms_endpoint,
  terraform_data.prod_kms_endpoint,
]
```

Set `enable_kms_endpoint = true` on the existing `prod_tfvars` run so that run still plans.

- [ ] **Step 3: Run the envelope test and confirm it fails**

```bash
terraform -chdir=infra/modules/aws-kms-envelope init -backend=false
terraform -chdir=infra/modules/aws-kms-envelope test
```

Expected: fail on the missing variable or on `multi_region`.

- [ ] **Step 4: Implement the module**

Set `multi_region = true` on `aws_kms_key.envelope`. Rename the role, the execution role, and the execution policy so the names are `${var.name}-task`, `${var.name}-execution`, and `service-execution`. Set `local.task_role_arn` to `arn:aws:iam::${var.aws_account_id}:role/${var.name}-task`. Set `local.log_group_name` to `/community-hub/${var.name}/service`.

Build `StringEquals` as a merge. When `var.enable_kms_endpoint` is false, the cryptographic statements do not contain the key `aws:SourceVpce` and do not reference `aws_vpc_endpoint.kms`. When it is true, merge `"aws:SourceVpce" = aws_vpc_endpoint.kms[0].id` into those statements. Keep the encryption-context keys as they are.

```hcl
resource "aws_security_group" "endpoint" {
  count = var.enable_kms_endpoint ? 1 : 0
  # ingress TCP 443 from var.task_security_group_id only, egress empty
}

resource "aws_vpc_endpoint" "kms" {
  count               = var.enable_kms_endpoint ? 1 : 0
  security_group_ids  = [aws_security_group.endpoint[0].id]
  subnet_ids          = [var.public_subnet_id]
  # service_name, private_dns_enabled, vpc_id unchanged
}
```

Delete `aws_security_group.broker` and delete output `broker_security_group_id`. Set output `endpoint_id` to `one(aws_vpc_endpoint.kms[*].id)`. Update the root output `kms_endpoint_id` description so it no longer says broker. The key's `depends_on` stays `[aws_iam_role.task]`, because the envelope policy still names that role. Do not add `environment` to this module.

- [ ] **Step 5: Run the gate**

`terraform test` exits 0 in `infra/modules/aws-kms-envelope`, `infra/modules/aws-kms-storage`, and `infra/regions/au`. Then fmt, init readonly, validate, and tflint in those directories. Then `pnpm format`, lint, typecheck, unfiltered `pnpm test`, and `pnpm check:boundaries`.

- [ ] **Step 6: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(envelope): make the wrapping key multi-Region

The task role and the log group drop the broker names in the same
commit as the key policy that cites the new role ARN. The endpoint
exists only when the flag is on, and production cannot turn it off.

Refs: docs/plans/2026-10-03-foundations.md task 2
EOF
)"
```

---

### Task 3: Database variables, windows, and alarms

**Files:**

- Modify: `infra/modules/aws-rds/main.tf`
- Modify: `infra/modules/aws-rds/variables.tf`
- Modify: `infra/modules/aws-rds/tests/rds.tftest.hcl`
- Modify: `infra/regions/au/main.tf`
- Modify: `infra/regions/au/variables.tf`
- Modify: `infra/regions/au/tests/cell.tftest.hcl`
- Modify: `docs/runbooks/apply-staging-au.md`

**Interfaces:**

- Consumes: the AU root variables `deletion_protection` and `backup_retention_days`, which already exist and are not passed today.
- Produces: module variables `multi_az` (default false), `deletion_protection`, `backup_retention_days`, and `alert_email` (no default). `instance_class` default is `db.t4g.micro`. Root variable `alert_email` has no default and is not set in either tfvars file. Tests pass `alerts@example.com`, which is not the owner's address.

**Rule this must not break:** production protections. A prod plan with deletion protection false or backup retention below 7 fails inside the module. `storage_encrypted` stays the literal `true`. `publicly_accessible` stays validated false. `rds.force_ssl` stays `1`.

- [ ] **Step 1: Extend the RDS tests**

`staging_happy` asserts `instance_class == "db.t4g.micro"`, `multi_az == false`, `max_allocated_storage == 100`, `backup_window == "17:00-18:00"`, `maintenance_window == "tue:15:00-tue:16:00"`, and the four alarm thresholds: `CPUCreditBalance` less than 24, `FreeableMemory` less than 104857600, `FreeStorageSpace` less than 2147483648, `DatabaseConnections` greater than 30. Each alarm has `period == 300`, `evaluation_periods == 3`, `datapoints_to_alarm == 3`, and `alarm_actions` equal to the SNS topic ARN. The topic has no `kms_master_key_id`. Pass `alert_email = "alerts@example.com"`, `deletion_protection = false`, `backup_retention_days = 0`.

`prod_protection` passes `deletion_protection = true`, `backup_retention_days = 7`, and the same email. Add `run "prod_backup_off_fails"` with `environment = "prod"`, `deletion_protection = false`, `backup_retention_days = 7`, and `expect_failures` on the module precondition. Add the email variable to every existing run, including `public_rds_fails`.

- [ ] **Step 2: Run the RDS test and confirm it fails**

```bash
terraform -chdir=infra/modules/aws-rds init -backend=false
terraform -chdir=infra/modules/aws-rds test
```

Expected: fail because `alert_email` and `max_allocated_storage` are absent, and the class default is still `db.t4g.medium`.

- [ ] **Step 3: Wire the instance and the alarms**

Change `instance_class` default to `db.t4g.micro`. Add the three variables. Replace the three derived attributes:

```hcl
  multi_az                = var.multi_az
  deletion_protection     = var.deletion_protection
  backup_retention_period = var.backup_retention_days
  max_allocated_storage   = 100
  backup_window           = "17:00-18:00"
  maintenance_window      = "tue:15:00-tue:16:00"
```

Add a `terraform_data` precondition: if `var.environment == "prod"`, then `var.deletion_protection` is true and `var.backup_retention_days >= 7`. The AU root passes `deletion_protection = var.deletion_protection`, `backup_retention_days = var.backup_retention_days`, `multi_az = false`, and `alert_email = var.alert_email`. Keep the root `prod_backup` check.

One `aws_sns_topic.alarms` in `var.aws_region`, no encryption key. One `aws_sns_topic_subscription.alarms` with `protocol = "email"` and `endpoint = var.alert_email`. Four `aws_cloudwatch_metric_alarm` resources on namespace `AWS/RDS`, dimension `DBInstanceIdentifier = aws_db_instance.this.identifier`, `alarm_actions = [aws_sns_topic.alarms.arn]`. No metric math.

Every `cell.tftest.hcl` run that plans the root gains `alert_email = "alerts@example.com"`.

Under **Human prerequisites** in the runbook, add one item and do not edit the withdrawn apply order: a person confirms the SNS email subscription after apply, or the alarms stay console-only.

- [ ] **Step 4: Run the gate**

`terraform test` exits 0 in `infra/modules/aws-rds` and `infra/regions/au`. Then the Terraform checks in those directories, `pnpm format`, lint, typecheck, unfiltered `pnpm test`, and `pnpm check:boundaries`.

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(rds): pass the backup settings through and alarm on the instance

Production can no longer pretend the tfvars protect a database that
derives those flags itself. The four alarms share one unencrypted topic.

Refs: docs/plans/2026-10-03-foundations.md task 3
EOF
)"
```

---

### Task 4: Secrets key and the three role passwords

**Files:**

- Create: `infra/modules/aws-db-secrets/main.tf`
- Create: `infra/modules/aws-db-secrets/variables.tf`
- Create: `infra/modules/aws-db-secrets/outputs.tf`
- Create: `infra/modules/aws-db-secrets/versions.tf`
- Create: `infra/modules/aws-db-secrets/tests/secrets.tftest.hcl`
- Create: `infra/modules/aws-db-secrets/.tflint.hcl`
- Create: `infra/modules/aws-db-secrets/.terraform.lock.hcl`
- Modify: `infra/modules/aws-kms-envelope/main.tf`
- Modify: `infra/modules/aws-kms-envelope/variables.tf`
- Modify: `infra/modules/aws-kms-envelope/tests/envelope.tftest.hcl`
- Modify: `infra/regions/au/main.tf`
- Modify: `infra/regions/au/versions.tf`
- Modify: `infra/regions/au/.terraform.lock.hcl`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: the role resources from task 2, `${var.name}-task` and `${var.name}-execution`. This task does not recreate them and the secrets key does not name them.
- Produces: outputs `app_secret_arn`, `identity_secret_arn`, `platform_secret_arn`, and `key_arn`. Secret names `${var.name}-app`, `${var.name}-identity`, `${var.name}-platform`. New envelope variables `db_secret_arns` (list of three strings) and `db_secrets_key_arn` (string). New resources `aws_iam_role_policy.task_secrets` and `aws_iam_role_policy.execution_secrets`. Those policies are not arguments of `aws_iam_role`. This task also owns the tags on this module: variables `environment` and `project` on the key and the three secrets. Task 5 does not reopen this module.

**Key policy:** One admin statement for the account root, using the envelope key's 16-name admin list, which has no `kms:Decrypt` and no `kms:GenerateDataKey`. One use statement, also for the account root, with actions `kms:Decrypt` and `kms:GenerateDataKey`, under `kms:ViaService` and the three `SecretARN` patterns. No role principal. The key does not `depends_on` the roles. Terraform creates the secret versions with the operator's credentials, and Secrets Manager calls `GenerateDataKey` as that account. The person who later reads a secret for `ALTER ROLE` is in the same account. The role policies grant `GetSecretValue` and `kms:Decrypt` on this key only. The secret ARNs appear only in those role policies, which reference `var.db_secret_arns`. The AU root passes the secrets-module outputs into those variables. The secrets module does not take a role resource.

**Rule this must not break:** the envelope key policy. Do not add `kms:Decrypt` for the secrets key onto the envelope key. Do not set `secret_string`.

- [ ] **Step 1: Write the secrets test**

`secrets.tftest.hcl` plans `aws_region = "ap-southeast-2"`, `aws_account_id = "123456789012"`, `name = "ch-staging"`, `environment = "staging"`, `project = "community-hub"`, `enable_key_rotation = true`. Assert the use statement's principal is `arn:aws:iam::123456789012:root`, its actions are `kms:Decrypt` and `kms:GenerateDataKey`, and the policy contains `secretsmanager.ap-southeast-2.amazonaws.com` and these three strings:

```text
arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-app-??????
arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-identity-??????
arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-platform-??????
```

Assert the policy text does not contain `role/ch-staging-task` or `role/ch-staging-execution`. Assert each `aws_secretsmanager_secret_version` has `secret_string == null`. Assert the key's tags are `environment = "staging"` and `project = "community-hub"`. Add `run "rotation_off_fails"` with `enable_key_rotation = false` and `expect_failures = [var.enable_key_rotation]`.

- [ ] **Step 2: Implement the module**

`versions.tf` requires Terraform `~> 1.11.0`, `hashicorp/aws` `~> 6.0`, and `hashicorp/random` `~> 3.7`. Copy `.tflint.hcl` from `infra/modules/aws-rds/.tflint.hcl`.

`enable_key_rotation` defaults true and validates true. The key is in `var.aws_region`, which validates `ap-southeast-2`. Variables `environment` and `project` have no defaults. Tag the key and each secret with those two values. The use statement:

```hcl
{
  Sid       = "SecretsManagerUse"
  Effect    = "Allow"
  Principal = { AWS = "arn:aws:iam::${var.aws_account_id}:root" }
  Action    = ["kms:Decrypt", "kms:GenerateDataKey"]
  Resource  = "*"
  Condition = {
    StringEquals = {
      "kms:ViaService" = "secretsmanager.ap-southeast-2.amazonaws.com"
    }
    StringLike = {
      "kms:EncryptionContext:SecretARN" = [
        "arn:aws:secretsmanager:ap-southeast-2:${var.aws_account_id}:secret:${var.name}-app-??????",
        "arn:aws:secretsmanager:ap-southeast-2:${var.aws_account_id}:secret:${var.name}-identity-??????",
        "arn:aws:secretsmanager:ap-southeast-2:${var.aws_account_id}:secret:${var.name}-platform-??????",
      ]
    }
  }
}
```

Three `ephemeral "random_password"` blocks, `length = 32`, `special = false`. Three secrets and three `aws_secretsmanager_secret_version` resources with `secret_string_wo = ephemeral.random_password.<role>.result` and `secret_string_wo_version = 1`. `kms_key_id` is the new key. Do not set `secret_string`.

- [ ] **Step 3: Attach separate role policies and wire the root**

Envelope variables `db_secret_arns` and `db_secrets_key_arn` have no defaults. Each existing envelope test run sets three fake ARNs ending in `AbCdEf` and a fake key ARN `arn:aws:kms:ap-southeast-2:123456789012:key/mock-secrets`. Assert `aws_iam_role_policy.task_secrets` contains `secretsmanager:GetSecretValue` and the app secret ARN, and its only `kms:Decrypt` resource is `var.db_secrets_key_arn`. Assert the same for `aws_iam_role_policy.execution_secrets`. The execution policy for logs stays the resource it already is. Do not fold the secret statements into `aws_iam_role.task` or `aws_iam_role.execution`.

```hcl
module "db_secrets" {
  source = "../../modules/aws-db-secrets"

  aws_region     = var.aws_region
  aws_account_id = var.aws_account_id
  name           = local.name
  environment    = var.environment
  project        = "community-hub"
}

# inside module "envelope":
db_secret_arns = [
  module.db_secrets.app_secret_arn,
  module.db_secrets.identity_secret_arn,
  module.db_secrets.platform_secret_arn,
]
db_secrets_key_arn = module.db_secrets.key_arn
```

Add `infra/modules/aws-db-secrets` to the Terraform matrix in `.github/workflows/ci.yml` in this commit.

- [ ] **Step 4: Lock the random provider**

From `infra/modules/aws-db-secrets` and from `infra/regions/au`:

```bash
terraform providers lock -platform=linux_amd64 -platform=darwin_arm64
```

Use Terraform 1.11.4. Confirm both lock files contain `hashicorp/random` and two `h1:` lines. Do not edit the hashes by hand.

- [ ] **Step 5: Run the gate**

`terraform test` exits 0 in `infra/modules/aws-db-secrets`, `infra/modules/aws-kms-envelope`, and `infra/regions/au`. Readonly init must succeed in all three. Then `pnpm format`, lint, typecheck, unfiltered `pnpm test`, and `pnpm check:boundaries`.

- [ ] **Step 6: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(secrets): add the role passwords and their key

The key lets the account call Decrypt and GenerateDataKey through
Secrets Manager. The task and execution roles read the three secrets
from policies that are separate from the role resources.

Refs: docs/plans/2026-10-03-foundations.md task 4
EOF
)"
```

---

### Task 5: Tags on taggable resources

**Files:**

- Modify: `infra/bootstrap/main.tf`
- Modify: `infra/bootstrap/tests/bootstrap.tftest.hcl`
- Modify: `infra/modules/aws-network/main.tf`
- Modify: `infra/modules/aws-network/variables.tf`
- Modify: `infra/modules/aws-network/tests/network.tftest.hcl`
- Modify: `infra/modules/aws-kms-storage/main.tf`
- Modify: `infra/modules/aws-kms-storage/variables.tf`
- Modify: `infra/modules/aws-kms-storage/tests/kms.tftest.hcl`
- Modify: `infra/modules/aws-kms-envelope/main.tf`
- Modify: `infra/modules/aws-kms-envelope/variables.tf`
- Modify: `infra/modules/aws-kms-envelope/tests/envelope.tftest.hcl`
- Modify: `infra/modules/aws-rds/main.tf`
- Modify: `infra/modules/aws-rds/variables.tf`
- Modify: `infra/modules/aws-rds/tests/rds.tftest.hcl`
- Modify: `infra/regions/au/main.tf`
- Modify: `infra/regions/au/tests/cell.tftest.hcl`

**Interfaces:**

- Consumes: the resources from tasks 1 to 3, plus the envelope roles. `aws-db-secrets` is already tagged in task 4. Do not open `infra/modules/aws-db-secrets`. The budgets module does not exist yet. Task 6 tags it.
- Produces: every taggable resource in bootstrap, network, storage, envelope, and RDS carries `environment` and `project = "community-hub"`, merged with any existing `Name` tag. Non-taggable resources are unchanged: security group rules, route-table associations, `aws_kms_alias`, bucket versioning, the public-access block, the bucket policy, and IAM role policies. Envelope's new `environment` variable is a tag value only. It is not an input to the endpoint check. The PR body says the spec forbade the variable and this task uses it for tags.

**Rule this must not break:** `Name` tags that already exist stay. Do not add `default_tags` to a provider.

- [ ] **Step 1: Add one assertion per module test**

Each module test passes `environment = "staging"` and `project = "community-hub"` and asserts those two attributes on one taggable resource: the VPC, the storage key, the envelope key, and the DB instance. The bootstrap test asserts them on `aws_s3_bucket.state`. The cell test asserts `module.network` received `project = "community-hub"` by checking a tagged output only if one exists. If no tagged output exists, assert the root passes the variables by planning, and keep the module-level assertions as the proof. Do not add an output only for the test if the module test already sees `aws_vpc.this.tags`.

- [ ] **Step 2: Run one module test and confirm it fails**

```bash
terraform -chdir=infra/modules/aws-network test
```

Expected: fail because `project` is not a variable.

- [ ] **Step 3: Add the variables and merge the tags**

Each of network, storage, envelope, and RDS gains:

```hcl
variable "environment" {
  type = string
}

variable "project" {
  type = string
}
```

Network already has no `environment` variable. Envelope gains `environment` here as a tag value and does not read it in the endpoint check, which stays on the AU root. The root passes `environment = var.environment` and `project = "community-hub"` into network, storage, envelope, and RDS. `module "db_secrets"` already receives both from task 4. Bootstrap writes the same two tags in the resource, using `var.environment` and the literal `community-hub`.

```hcl
tags = merge(
  { environment = var.environment, project = var.project },
  { Name = "${var.name}-vpc" },
)
```

Use that merge on every taggable resource that already has a `Name` tag. Resources with no `Name` get only the two keys.

- [ ] **Step 4: Run the gate**

`terraform test` exits 0 in bootstrap, network, storage, envelope, RDS, and `infra/regions/au`. Then `pnpm format`, lint, typecheck, unfiltered `pnpm test`, and `pnpm check:boundaries`.

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(infra): tag resources with environment and project

Module tests pass the two tag values in, so the tags do not depend on
a root provider default.

Refs: docs/plans/2026-10-03-foundations.md task 5
EOF
)"
```

---

### Task 6: Budgets, ADR 0010, and the residency line

**Files:**

- Create: `infra/modules/aws-budgets/main.tf`
- Create: `infra/modules/aws-budgets/variables.tf`
- Create: `infra/modules/aws-budgets/outputs.tf`
- Create: `infra/modules/aws-budgets/versions.tf`
- Create: `infra/modules/aws-budgets/tests/budgets.tftest.hcl`
- Create: `infra/modules/aws-budgets/.tflint.hcl`
- Create: `infra/modules/aws-budgets/.terraform.lock.hcl`
- Create: `docs/adr/0010-aws-budgets-exception.md`
- Modify: `infra/regions/au/main.tf`
- Modify: `infra/regions/au/variables.tf`
- Modify: `infra/regions/au/tests/cell.tftest.hcl`
- Modify: `.github/workflows/ci.yml`
- Modify: `architecture.md`
- Modify: `docs/runbooks/apply-staging-au.md`

**Interfaces:**

- Consumes: `var.environment`, `var.alert_email`, and the tag value `environment` from task 5.
- Produces: `enable_budgets` on the root, default false. When true, one `aws_budgets_budget` filtered on the exact string `user:environment$<environment>`. Limit USD 50 when `environment` is `staging`, USD 110 when `prod`. Notification at 80 percent actual, email `var.alert_email`, no action and no report. The budget resource carries `environment` and `project`. The module declares no provider. ADR 0010 and the §7.3 sentence exist. ADR 0009 does not change.

**Rule this must not break:** the Sydney region check on the data resources. The budgets module does not validate `aws_region == "ap-southeast-2"` for the Budgets API. Do not put tenant data in the budget.

- [ ] **Step 1: Write the budget test**

Default run: `enable_budgets` unset, `environment = "staging"`, `project = "community-hub"`, `alert_email = "alerts@example.com"`. Assert `length(aws_budgets_budget.environment) == 0`.

`run "enabled"`: `enable_budgets = true`. Assert the limit amount is `"50"`, the notification threshold is `80`, the subscriber is the email, and `aws_budgets_budget.environment[0].cost_filter[0].values` contains the exact string `user:environment$staging`. Assert the budget tags are `environment = "staging"` and `project = "community-hub"`.

`run "prod_enabled"`: `environment = "prod"`, `enable_budgets = true`. Assert the limit amount is `"110"` and the filter value is the exact string `user:environment$prod`.

- [ ] **Step 2: Implement the module**

The module does not declare a provider. The caller's AWS provider reaches Budgets. No `us-east-1` alias in the module and none in the AU root.

```hcl
variable "name" {
  type = string
}

variable "environment" {
  type = string
}

variable "project" {
  type = string
}

variable "alert_email" {
  type = string
}

variable "enable_budgets" {
  type    = bool
  default = false
}

resource "aws_budgets_budget" "environment" {
  count        = var.enable_budgets ? 1 : 0
  name         = "${var.name}-cost"
  budget_type  = "COST"
  limit_amount = var.environment == "prod" ? "110" : "50"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "TagKeyValue"
    values = [format("user:environment$%s", var.environment)]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alert_email]
  }

  tags = {
    environment = var.environment
    project     = var.project
  }
}
```

Do not filter on a second tag. `$${` is not used. That escape writes a literal `${` and does not interpolate.

The AU root calls the module with `enable_budgets = var.enable_budgets`, `environment = var.environment`, `project = "community-hub"`, `name = local.name`, and `alert_email = var.alert_email`. Root `enable_budgets` defaults false. Neither tfvars file sets it. Add a cell assertion on `staging_happy` that `var.enable_budgets` is false by not setting it and planning. Add `run "budgets_on"` with `enable_budgets = true` and `alert_email = "alerts@example.com"` that plans. The module test is the assertion of the filter. The cell run only proves the root accepts the flag.

Add `infra/modules/aws-budgets` to the CI matrix. Lock the AWS provider in that directory with `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`.

- [ ] **Step 3: Write ADR 0010 and edit §7.3**

Create `docs/adr/0010-aws-budgets-exception.md`:

```markdown
# ADR 0010: AWS Budgets is a global billing exception

- Status: accepted
- Date: 2026-10-03
- Spec: `docs/specs/2026-10-03-foundations.md`
- Amends: the exception list in ADR 0009. ADR 0009 is not edited.

## Context

ADR 0009 allows four kinds of resource outside `ap-southeast-2`, and it says no others. AWS Budgets uses `https://budgets.amazonaws.com`, which AWS routes to `us-east-1`. The budget holds an amount and an alert address. It does not hold tenant data.

## Decision

AWS Budgets is allowed outside `ap-southeast-2`. The budgets module does not reuse the Sydney region validation for that API. The Sydney resources keep theirs.

## Consequences

Architecture §7.3 lists this exception. A filtered budget still waits until the `environment` cost-allocation tag is active.

## Alternatives rejected

- **Edit ADR 0009 in place.** That ADR is merged, and its list says "and no others."
- **An unfiltered account-wide budget.** One amount cannot be both the staging line and the production line.
```

In `architecture.md` §7.3, add AWS Budgets to the sentence that lists the exceptions, so that sentence no longer says four. The same count is in §3 principle 10 and in §7.5. Update those two sentences in this commit so they do not still say four. Do not edit ADR 0009, and do not edit the parent Sydney spec or its plan.

Add two runbook prerequisites: activate the `environment` cost-allocation tag after it appears, which can take up to 24 hours to appear and up to 24 hours more to activate, then apply again with `enable_budgets = true`. Do not rewrite the withdrawn apply order.

- [ ] **Step 4: Run the gate**

`terraform test` exits 0 in `infra/modules/aws-budgets` and `infra/regions/au`. Readonly init succeeds. Then `pnpm format`, lint, typecheck, unfiltered `pnpm test`, and `pnpm check:boundaries`.

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(budgets): add a per-environment budget that stays off

The first apply does not create it. ADR 0010 allows the Budgets API
outside Sydney, and ADR 0009 is left as merged.

Refs: docs/plans/2026-10-03-foundations.md task 6
EOF
)"
```

---

### Task 7: Roadmap, repository state, and the full CI sequence

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Consumes: tasks 1 to 6 are on this branch.
- Produces: foundations row **done**. Where we are: last shipped `foundations`, next chunk `ingress`, Phase 0 `14 done`, `1 superseded`, `4 not started`. The Next spec paragraph names ingress. `AGENTS.md` repository-state cell matches those counts and says next is ingress.

**Rule this must not break:** the row count stays 19. Do not mark ingress done. Do not edit the approved spec or ADR 0009.

- [ ] **Step 1: Update the catalogue**

In `docs/roadmap.md`, set the foundations row to **done** and replace its What cell with one sentence: task group, multi-Region envelope key, database alarms, secrets key, tags, and budgets behind `enable_budgets`. Set Last shipped to `foundations`, Next chunk to `ingress`, and the phase counts to 14 done, 1 superseded (`api-au-hostname`), 4 not started. Replace the Next spec paragraph with: The next approved chunk on this list is **ingress**, unless the human picks another remaining Phase 0 row.

Replace the `AGENTS.md` repository-state cell with:

```text
Phase 0: 19 rows, 14 done, 1 superseded (`api-au-hostname`), 4 not started. Next is ingress. `packages/kernel`, `packages/observability`, `packages/db`, `tooling/checks`, CI Stages 1–3, and `apps/api` are on `main`. Workers were superseded by ADR 0009, and that layout is not the design.
```

- [ ] **Step 2: Run the CI sequence**

The §8 gate is the lint, typecheck, test, and boundaries lines. The rest is the CI sequence those four do not cover. Postgres is up before `pnpm test`. Then, in order:

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm check:boundaries
pnpm audit --audit-level=high
pnpm test
pnpm --filter @community-hub/api... build
```

If `gitleaks` is on `PATH`, run `gitleaks detect --source . --config .gitleaks.toml --verbose --redact --exit-code 1`. The CI job downloads the Linux binary; do not substitute a different scanner.

Then in each of these directories, `terraform init -backend=false -lockfile=readonly`, `terraform fmt -check`, `terraform validate`, `tflint --init && tflint`, and `terraform test`:

- `infra/bootstrap`
- `infra/regions/au`
- `infra/modules/aws-network`
- `infra/modules/aws-kms-storage`
- `infra/modules/aws-kms-envelope`
- `infra/modules/aws-rds`
- `infra/modules/aws-db-secrets`
- `infra/modules/aws-budgets`

Do not apply. Do not open the PR in this task.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
docs(roadmap): mark foundations done

Last shipped is foundations. Next is ingress. The phase counts are
14 done, 1 superseded, and 4 not started.

Refs: docs/plans/2026-10-03-foundations.md task 7
EOF
)"
```

---

## Plan self-review

- Spec tasks 1 to 7 each have a task. The secrets key's use statement is the account root, with `Decrypt` and `GenerateDataKey` under the Secrets Manager conditions. Role access is the separate `aws_iam_role_policy` resources.
- Tags: task 4 owns `aws-db-secrets`. Task 5 owns bootstrap, network, storage, envelope, and RDS. Task 6 owns the budget.
- The envelope module takes `environment` in task 5 as a tag only. The endpoint check stays on the AU root. The PR records the spec difference.
- `prod_endpoint_off_fails` expects both `check.prod_kms_endpoint` and `terraform_data.prod_kms_endpoint`. The endpoint override lives on the flag-on cell run. `endpoint_id` uses `one()`.
- The budget filter is `format("user:environment$%s", var.environment)`. The module declares no provider.
- The second public subnet is associated with the public route table. The spec required a public subnet. An unassociated subnet would not have a route.
- No `multi_region` checker. The Terraform test in task 2 is the guard.
- No unfiltered budget. The gap stays in the spec's Risks, which this plan does not restate as a task.
- Placeholder scan: no TBD.
