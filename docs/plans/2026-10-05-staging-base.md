# Staging base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply staging with no task, record the proofs that can be taken in that state, and park the database.

**Architecture:** Seven commits. Provider locks move to AWS 6.67.0. The AU root owns the alarms topic, and `module.rds` takes its ARN. `enable_database` removes only that module. A metric filter and alarm watch `reason` = `missing_hostname_header`. The runbook replaces the withdrawn Cloudflare apply. The human applies twice. The last commit updates the catalogue.

**Tech Stack:** Terraform 1.11.4, AWS provider 6.67.0, `terraform test`. No application code. No image push.

Spec: docs/specs/2026-10-05-staging-base.md

Status: approved (2026-10-05, Abdus Salam)

**Branch:** `feat/2026-10-05-staging-base` · one PR · 7 tasks, one commit each

## Global Constraints

- The spec is approved. Do not edit `docs/specs/2026-10-05-staging-base.md` except to leave its status line alone. Do not edit `docs/specs/2026-10-03-personal-data-on-aws.md`, `docs/specs/2026-10-03-foundations.md`, `docs/specs/2026-10-04-ingress.md`, or `docs/specs/2026-09-18-terraform-au-cell.md`.
- `service_image` stays null. `desired_count` stays 0. No ECS cluster, task definition, or pull policy is planned.
- `enable_database` defaults to true. False removes `module.rds` only. Production refuses false. False with `service_image` set fails the plan. The image value in that test is a valid digest.
- The topic is `${name}-alarms` on the AU root, with an email subscription to `alert_email`. Tags are `environment` and `project`. The metric filter has no tags and no `default_value`.
- The hostname alarm is Sum, period 300, `GreaterThanOrEqualToThreshold`, threshold 1, one evaluation period, `treat_missing_data` `notBreaching`, `alarm_actions` the root topic. The filter pattern is `{ $.reason = "missing_hostname_header" }`.
- Lock platforms are `linux_amd64` and `darwin_arm64`. The apply machine is already `darwin_arm64`. Do not float the provider past 6.67.0. `random` stays 3.9.1.
- No migration wave. The database this chunk creates is empty. Parking removes it by `count`. There is no expand, migrate, or contract step.
- The agent does not run `terraform apply`. Tasks 4 and 5 stop for the human.
- Any rebase onto `origin/main` happens before the first apply. After that apply: no rebase, no amend, no force-push. Bring `main` in with a merge commit. The PR is merged with a merge commit, never squashed.
- Real account id, hosted zone id, alarm email, and key ARNs never enter the repo, the plan, the tests, or the runbook evidence. Tests use `123456789012` and `alerts@example.com`.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Do not mark this plan approved yourself.
- This chunk touches residency and the storage key on the database. A second fresh-context review reads the final diff. Leave that line open in the PR. Do not write the second review yourself.

**Rollback:** Before the first apply, revert the PR. Nothing is deployed. After the first apply, a revert does not destroy the cell. Parking is `enable_database = false` on a later commit. Unpark is the next chunk, not a revert of this one.

## File map

| File                                                              | Responsibility                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `infra/bootstrap/.terraform.lock.hcl` and the 6.65.0 module locks | Select AWS provider 6.67.0 for `linux_amd64` and `darwin_arm64`.           |
| `infra/modules/aws-rds/`                                          | Four alarms take a topic ARN. No topic and no subscription in this module. |
| `infra/regions/au/`                                               | Topic, subscription, hostname filter and alarm, `enable_database`.         |
| `.gitignore`                                                      | Local tfvars and the bootstrap backend override.                           |
| `docs/runbooks/apply-staging-au.md`                               | The AWS apply, the proofs, and the park.                                   |
| `docs/roadmap.md`, `AGENTS.md`                                    | Catalogue. Last commit only.                                               |

---

### Task 1: Lock the AWS provider at 6.67.0

**Files:**

- Modify: `infra/bootstrap/.terraform.lock.hcl`
- Modify: `infra/regions/au/.terraform.lock.hcl`
- Modify: `infra/modules/aws-network/.terraform.lock.hcl`
- Modify: `infra/modules/aws-kms-storage/.terraform.lock.hcl`
- Modify: `infra/modules/aws-rds/.terraform.lock.hcl`

**Interfaces:**

- Consumes: the existing `~> 6.0` constraint in each `versions.tf`.
- Produces: every `infra/**/.terraform.lock.hcl` has `version = "6.67.0"` for `hashicorp/aws`.

Leave these files alone. They are already 6.67.0: `infra/modules/aws-ingress`, `infra/modules/aws-kms-envelope`, `infra/modules/aws-budgets`, `infra/modules/aws-db-secrets`.

- [ ] **Step 1: Confirm which locks are behind**

Run:

```bash
grep -n 'version     = ' infra/bootstrap/.terraform.lock.hcl infra/regions/au/.terraform.lock.hcl infra/modules/aws-network/.terraform.lock.hcl infra/modules/aws-kms-storage/.terraform.lock.hcl infra/modules/aws-rds/.terraform.lock.hcl
```

Expected: each AWS provider block says `6.65.0`. The `random` blocks, where present, say `3.9.1`.

- [ ] **Step 2: Select 6.67.0 without floating past it**

Do the four directories that have no `random` provider first, one at a time: `infra/bootstrap`, `infra/modules/aws-network`, `infra/modules/aws-kms-storage`, `infra/modules/aws-rds`. Example for `infra/bootstrap`:

```bash
cd infra/bootstrap
```

In `versions.tf`, change the AWS provider `version = "~> 6.0"` to `version = "6.67.0"`.

```bash
terraform init -backend=false -upgrade
terraform providers lock -platform=linux_amd64 -platform=darwin_arm64
```

Restore `version = "~> 6.0"`. Do not run `terraform providers lock` again.

```bash
terraform init -backend=false -lockfile=readonly
grep -A2 'provider "registry.terraform.io/hashicorp/aws"' .terraform.lock.hcl
```

Expected: init exits 0 and the AWS provider line is `version     = "6.67.0"`.

`infra/regions/au` is different. `terraform init -upgrade` upgrades every provider, so `random` (`~> 3.7`) can move off `3.9.1`. While AWS is pinned to `6.67.0`, also pin `random` to `3.9.1` in `infra/regions/au/versions.tf`:

```hcl
    aws = {
      source  = "hashicorp/aws"
      version = "6.67.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "3.9.1"
    }
```

```bash
cd infra/regions/au
terraform init -backend=false -upgrade
terraform providers lock -platform=linux_amd64 -platform=darwin_arm64
```

Restore both constraints: AWS `version = "~> 6.0"` and random `version = "~> 3.7"`. Do not run `terraform providers lock` again. `versions.tf` is unchanged in the commit.

```bash
terraform init -backend=false -lockfile=readonly
grep -A2 'provider "registry.terraform.io/hashicorp/aws"' .terraform.lock.hcl
grep -A2 'provider "registry.terraform.io/hashicorp/random"' .terraform.lock.hcl
```

Expected: init exits 0, the AWS line is `version     = "6.67.0"`, and the random line is `version     = "3.9.1"`.

- [ ] **Step 3: Readonly init**

```bash
for d in infra/bootstrap infra/regions/au infra/modules/aws-network infra/modules/aws-kms-storage infra/modules/aws-rds infra/modules/aws-ingress infra/modules/aws-kms-envelope infra/modules/aws-budgets infra/modules/aws-db-secrets; do
  terraform -chdir="$d" init -backend=false -lockfile=readonly
done
```

Expected: each init exits 0.

```bash
grep -R 'version     = "6.65.0"' infra --include '.terraform.lock.hcl'
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add infra/bootstrap/.terraform.lock.hcl infra/regions/au/.terraform.lock.hcl infra/modules/aws-network/.terraform.lock.hcl infra/modules/aws-kms-storage/.terraform.lock.hcl infra/modules/aws-rds/.terraform.lock.hcl
git commit -m "$(cat <<'EOF'
build(infra): lock the AWS provider at 6.67.0

The AU root, bootstrap, network, RDS, and the storage key were on 6.65.0.
Ingress and the other modules were already on 6.67.0.

EOF
)"
```

---

### Task 2: Move the topic out of the RDS module and plan the hostname alarm

**Files:**

- Modify: `infra/modules/aws-rds/variables.tf`
- Modify: `infra/modules/aws-rds/main.tf`
- Modify: `infra/modules/aws-rds/tests/rds.tftest.hcl`
- Modify: `infra/modules/aws-budgets/outputs.tf`
- Modify: `infra/regions/au/variables.tf`
- Modify: `infra/regions/au/main.tf`
- Modify: `infra/regions/au/outputs.tf`
- Modify: `infra/regions/au/tests/cell.tftest.hcl`

**Interfaces:**

- Consumes: `module.envelope.log_group_name`, `var.alert_email`, `var.service_image`, `local.name`.
- Produces: `var.enable_database` (bool, default true). `module.rds` is a list of 0 or 1. `rds_hostname` is null when the database is off. `aws_sns_topic.alarms.arn` is the topic the four RDS alarms and the hostname alarm use. `module.budgets.budget_name` is `one(aws_budgets_budget.environment[*].name)`.

- [ ] **Step 1: Write the failing RDS test**

In `infra/modules/aws-rds/tests/rds.tftest.hcl`, delete the `mock_resource "aws_sns_topic"` block, the `override_resource` whose target is `aws_sns_topic.alarms`, and the assert that `aws_sns_topic.alarms.kms_master_key_id == null`. That assert moves to the cell test. Do not drop it.

In every `variables` block, replace `alert_email = "alerts@example.com"` with:

```hcl
alarm_topic_arn = "arn:aws:sns:ap-southeast-2:123456789012:ch-staging-alarms"
```

Replace each `alarm_actions == toset([aws_sns_topic.alarms.arn])` with `alarm_actions == toset([var.alarm_topic_arn])`.

- [ ] **Step 2: Run the RDS test and confirm it fails**

```bash
terraform -chdir=infra/modules/aws-rds init -backend=false -lockfile=readonly
terraform -chdir=infra/modules/aws-rds test
```

Expected: FAIL. The test refers to `var.alarm_topic_arn`, which the module does not declare.

- [ ] **Step 3: Change the RDS module**

Delete `variable "alert_email"` from `infra/modules/aws-rds/variables.tf`. Add:

```hcl
variable "alarm_topic_arn" {
  type        = string
  description = "SNS topic ARN for the four database alarms. The root owns the topic."
}
```

Delete `aws_sns_topic.alarms` and `aws_sns_topic_subscription.alarms` from `infra/modules/aws-rds/main.tf`. On each of the four `aws_cloudwatch_metric_alarm` resources, set:

```hcl
alarm_actions = [var.alarm_topic_arn]
```

- [ ] **Step 4: Run the RDS test**

```bash
terraform -chdir=infra/modules/aws-rds fmt
terraform -chdir=infra/modules/aws-rds test
```

Expected: PASS. `rg 'resource \"aws_sns_topic\"' infra/modules/aws-rds` prints nothing.

- [ ] **Step 5: Write the failing cell tests**

Append these runs to `infra/regions/au/tests/cell.tftest.hcl`. The valid digest is the one ingress already accepts in its tests.

```hcl
run "database_off" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    environment           = "staging"
    deletion_protection   = false
    backup_retention_days = 0
    alert_email           = "alerts@example.com"
    staging_zone_id       = "ZSTAGING"
    create_public_zone    = false
    attach_public_dns     = true
    enable_database       = false
    enable_budgets        = true
  }

  assert {
    condition     = length(module.rds) == 0
    error_message = "parking removes the RDS module"
  }

  assert {
    condition     = output.rds_hostname == null
    error_message = "rds_hostname is null when the database is off"
  }

  assert {
    condition     = aws_sns_topic.alarms.name == "ch-staging-alarms"
    error_message = "the alarms topic stays when the database is parked"
  }

  assert {
    condition     = aws_sns_topic.alarms.tags["environment"] == "staging" && aws_sns_topic.alarms.tags["project"] == "community-hub"
    error_message = "the alarms topic carries environment and project"
  }

  assert {
    condition     = aws_sns_topic.alarms.kms_master_key_id == null
    error_message = "alarm SNS topic must not use a KMS key"
  }

  assert {
    condition     = aws_sns_topic_subscription.alarms.endpoint == "alerts@example.com"
    error_message = "the email subscription stays when the database is parked"
  }

  assert {
    condition     = aws_cloudwatch_log_metric_filter.missing_hostname_header.pattern == "{ $.reason = \"missing_hostname_header\" }"
    error_message = "the hostname filter matches the reason field"
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.missing_hostname_header.comparison_operator == "GreaterThanOrEqualToThreshold" &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.threshold == 1 &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.period == 300 &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.evaluation_periods == 1 &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.statistic == "Sum" &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.treat_missing_data == "notBreaching" &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.alarm_actions == toset([aws_sns_topic.alarms.arn]) &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.tags["environment"] == "staging" &&
      aws_cloudwatch_metric_alarm.missing_hostname_header.tags["project"] == "community-hub"
    )
    error_message = "the hostname alarm must match the spec"
  }

  assert {
    condition     = module.budgets.budget_name == "ch-staging-cost"
    error_message = "the park plan creates the staging budget"
  }
}

run "prod_database_off_fails" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    environment           = "prod"
    enable_database       = false
    enable_kms_endpoint   = true
    deletion_protection   = true
    backup_retention_days = 7
    alert_email           = "alerts@example.com"
    create_public_zone    = true
    attach_public_dns     = false
  }

  expect_failures = [terraform_data.prod_database]
}

run "image_without_database_fails" {
  command = plan

  variables {
    aws_region            = "ap-southeast-2"
    aws_account_id        = "123456789012"
    environment           = "staging"
    deletion_protection   = false
    backup_retention_days = 0
    alert_email           = "alerts@example.com"
    staging_zone_id       = "ZSTAGING"
    create_public_zone    = false
    attach_public_dns     = true
    enable_database       = false
    service_image         = "123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }

  expect_failures = [terraform_data.image_needs_database]
}
```

`database_off` references resources the root does not have yet.

- [ ] **Step 6: Run the cell test and confirm the new runs fail**

```bash
terraform -chdir=infra/regions/au init -backend=false -lockfile=readonly
terraform -chdir=infra/regions/au test
```

Expected: FAIL on `database_off` because `var.enable_database` and `aws_sns_topic.alarms` do not exist. Existing runs must not be the reason. If an existing run fails, stop and report.

- [ ] **Step 7: Add the root variable and the guards**

In `infra/regions/au/variables.tf`, after `enable_budgets`:

```hcl
variable "enable_database" {
  type        = bool
  description = "Plan the RDS module. False parks staging by removing it. Production refuses false."
  default     = true
}
```

In `infra/regions/au/main.tf`, next to the other `terraform_data` guards:

```hcl
resource "terraform_data" "prod_database" {
  lifecycle {
    precondition {
      condition     = var.environment != "prod" || var.enable_database
      error_message = "prod must keep the database."
    }
  }
}

check "prod_database" {
  assert {
    condition     = var.environment != "prod" || var.enable_database
    error_message = "prod must keep the database."
  }
}

resource "terraform_data" "image_needs_database" {
  lifecycle {
    precondition {
      condition     = var.enable_database || var.service_image == null
      error_message = "a set image needs the database."
    }
  }
}

check "image_needs_database" {
  assert {
    condition     = var.enable_database || var.service_image == null
    error_message = "a set image needs the database."
  }
}
```

`expect_failures` must name the resources Terraform actually reports. If the test fails on `check.prod_database` as well as `terraform_data.prod_database`, add both, matching `prod_endpoint_off_fails` in the same file.

- [ ] **Step 8: Own the topic and pass it into RDS**

In `infra/regions/au/main.tf`:

```hcl
resource "aws_sns_topic" "alarms" {
  region = var.aws_region
  name   = "${local.name}-alarms"

  tags = {
    environment = var.environment
    project     = "community-hub"
  }
}

resource "aws_sns_topic_subscription" "alarms" {
  region    = var.aws_region
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_log_metric_filter" "missing_hostname_header" {
  region         = var.aws_region
  name           = "${local.name}-missing-hostname-header"
  log_group_name = module.envelope.log_group_name
  pattern        = "{ $.reason = \"missing_hostname_header\" }"

  metric_transformation {
    name      = "MissingHostnameHeader"
    namespace = "CommunityHub/Service"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "missing_hostname_header" {
  region              = var.aws_region
  alarm_name          = "${local.name}-missing-hostname-header"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "MissingHostnameHeader"
  namespace           = "CommunityHub/Service"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]

  tags = {
    environment = var.environment
    project     = "community-hub"
  }
}
```

Do not set `default_value` on the metric transformation. A default would publish a value every period.

Change `module "rds"` to:

```hcl
module "rds" {
  count  = var.enable_database ? 1 : 0
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
  alarm_topic_arn        = aws_sns_topic.alarms.arn
}
```

Remove `alert_email` from that module block. The budgets module still takes `var.alert_email`.

Point ingress at the module only when it exists:

```hcl
db_host = var.enable_database ? module.rds[0].address : ""
db_port = var.enable_database ? module.rds[0].port : 5432
```

In `infra/modules/aws-budgets/outputs.tf`, add:

```hcl
output "budget_name" {
  description = "Name of the environment budget when enable_budgets is true. Null when the budget is off."
  value       = one(aws_budgets_budget.environment[*].name)
}
```

`terraform test` cannot address a resource inside a child module. The cell test asserts this output.

In `infra/regions/au/outputs.tf`:

```hcl
output "rds_hostname" {
  description = "RDS hostname. Null when enable_database is false."
  value       = var.enable_database ? module.rds[0].address : null
}
```

- [ ] **Step 9: Run the cell test**

```bash
terraform -chdir=infra/regions/au fmt
terraform -chdir=infra/modules/aws-rds fmt
terraform -chdir=infra/regions/au test
terraform -chdir=infra/modules/aws-rds test
```

Expected: both PASS. `database_off` plans no `aws_db_instance` and `module.budgets.budget_name` is `ch-staging-cost`. If `length(module.rds)` is not addressable that way, assert `module.rds == []` or the address Terraform test prints, and keep the failure message.

- [ ] **Step 10: Commit**

```bash
git add infra/modules/aws-rds infra/modules/aws-budgets/outputs.tf infra/regions/au
git commit -m "$(cat <<'EOF'
feat(infra): park the database without dropping the alarms topic

The root owns the topic, the email subscription, and the hostname
alarm. enable_database false removes only the RDS module.

EOF
)"
```

---

### Task 3: Rewrite the apply runbook

**Files:**

- Modify: `.gitignore`
- Modify: `docs/runbooks/apply-staging-au.md`

**Interfaces:**

- Consumes: `enable_database`, `enable_budgets`, the topic name `${name}-alarms`, and the proof list in the spec.
- Produces: the procedure Tasks 4 and 5 follow. Evidence sections start empty, with the headings the later tasks fill.

- [ ] **Step 1: Confirm the old runbook is still the withdrawn procedure**

```bash
grep -n "cloudflared\|Do not apply the steps below\|enable_hyperdrive" docs/runbooks/apply-staging-au.md
```

Expected: matches. Those sections are what this task deletes.

- [ ] **Step 2: Ignore the local files**

Append to `.gitignore`:

```
infra/regions/au/env/*.local.tfvars
infra/bootstrap/backend_override.tf
```

Do not add `*.tfvars`.

- [ ] **Step 3: Replace the runbook**

Delete everything from the opening through `## Never`, including the Cloudflare apply order, the tunnel, the broker, and the feature-flag table.

Keep `## Change a database role` as it stands. In `## Restore drill`, change "the first staging apply" to `first-running-task`. Leave the rest of that section.

Replace the opening, the prerequisites, and `## Park and unpark` with the procedure below. Evidence headings stay empty until Tasks 4 and 5.

```markdown
# Runbook: apply staging-au

The human applies. An agent does not. Production is not applied from this runbook.

Any rebase onto origin/main happens before the first apply. After that apply there is no rebase, no amend, and no force-push. main is brought in with a merge commit. The pull request is merged with a merge commit, never squashed. The pull request body says this departs from AGENTS.md section 5, because a rebase would replace the SHAs recorded below.

## Human prerequisites

1. Every apply uses the ch-admin profile, an IAM Identity Center administrator, never the root user.
2. Register communityhub-staging.net in Route 53. Registration creates the hosted zone. Pass that zone id in the gitignored tfvars file. Do not commit it.
3. Choose the alarm email. It goes in the same gitignored file. This runbook does not record it.
4. infra/bootstrap has not been applied. Apply it before the AU root.

## Local tfvars

Create infra/regions/au/env/staging.local.tfvars. It is gitignored. It holds aws_account_id, staging_zone_id, and alert_email. Pass it after env/staging.tfvars so it wins. The committed staging file keeps the synthetic account id 123456789012.

## Before each apply

1. git status is clean.
2. git rev-parse HEAD equals the SHA named for that apply, and that SHA is on origin.
3. terraform init uses -lockfile=readonly.

## Bootstrap

infra/bootstrap declares backend "s3" {} and creates the bucket. The named SHA is the first-apply commit. From infra/bootstrap, write a gitignored backend_override.tf:

    terraform { backend "local" {} }

Then:

    terraform init -lockfile=readonly
    terraform apply -var-file=env/staging.tfvars

Delete backend_override.tf. Then:

    terraform init -backend-config=backend/staging.hcl -lockfile=readonly -migrate-state

terraform state list must show the state bucket and the state KMS key from the bucket. Only then delete the local terraform.tfstate and terraform.tfstate.backup. Confirm git status is clean. If apply returns BucketAlreadyExists, stop and report. Do not pick another bucket name.

## First AU apply

From infra/regions/au, on the commit this runbook names under "First apply". enable_database is still the default true. enable_budgets is still the default false. service_image is null. desired_count is 0. Run the before-each-apply checks. Then:

    terraform init -backend-config=backend/staging.hcl -lockfile=readonly
    terraform apply -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars

## After the first apply

Activate the environment cost-allocation tag in Billing. The check is that the cost-allocation tags page shows environment as Active. A budget whose tag filter is not yet active is created and counts USD 0. It does not fail. If the tag is not Active, stop. Do not park.

## Proofs

Recorded against the first-apply commit. Redact the account id, the hosted zone id, the alarm email, and any key ARN.

1. SNS subscription confirmed.
2. Custom domain while Cloud Map has no instances: HTTP status and integration error.
3. Task group, RDS group, and VPC link group, compared with the declared set. With no image the task group has egress TCP 443 to 0.0.0.0/0 and egress TCP 5432 to the RDS group, and no inbound rule. The RDS group has inbound TCP 5432 from the task group only. The VPC link group has egress TCP 8080 to the task group and no inbound rule.
4. Throttle. 300 requests in about one second to GET / on a tenant hostname. Record 429 and 503. Immediately, 300 requests to POST / on that hostname. Record 429 and 503. A 429 on POST / after the burst means one shared bucket. Record the tool, the counts, and the timestamps. No body, no query string, no personal data.
5. describe-db-instances: region ap-southeast-2, StorageEncrypted true, KmsKeyId matches the storage key, PubliclyAccessible false, backup retention 0, ManageMasterUserPassword true. describe-db-parameters on that instance's parameter group: rds.force_ssl = 1. Write "matches". Do not write the key ARN.
6. A second terraform plan shows no changes.

### First apply

Commit: (filled by Task 4)

### Evidence

(filled by Task 4)

## Park

Commit enable_database = false and enable_budgets = true in infra/regions/au/env/staging.tfvars first. That commit is the park SHA. Run the before-each-apply checks against it. Then, from infra/regions/au:

    terraform init -backend-config=backend/staging.hcl -lockfile=readonly
    terraform apply -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars

Record that SHA. Then terraform plan shows no changes. The plan still contains the topic, the subscription, the hostname alarm, and the staging budget. Record that the budget exists and that its tag filter is user:environment$staging.

Unpark is the next chunk: recreate the database, the ALTER ROLE procedure, and wait until the VPC link is AVAILABLE. This runbook does not unpark.

### Park apply

Commit: (filled by Task 5)

### Park evidence

(filled by Task 6)
```

Update `## Park and unpark` so the long park is `enable_database = false`, not a console delete. A stopped database is still not parking. The 60-day `INACTIVE` VPC link note stays. The unpark steps stay as a pointer to `first-running-task`.

- [ ] **Step 4: Confirm the withdrawn procedure is gone**

```bash
grep -n "cloudflared\|enable_hyperdrive\|hyperdrive_origin_password\|Do not apply the steps below" docs/runbooks/apply-staging-au.md
```

Expected: no output. `grep BucketAlreadyExists docs/runbooks/apply-staging-au.md` matches. `git check-ignore -v infra/regions/au/env/staging.local.tfvars infra/bootstrap/backend_override.tf` prints both paths. `git check-ignore infra/regions/au/env/staging.tfvars` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add .gitignore docs/runbooks/apply-staging-au.md
git commit -m "$(cat <<'EOF'
docs(infra): rewrite the staging apply runbook

The Cloudflare apply is withdrawn. Bootstrap starts from a local backend
override, and the proofs are recorded before the database is parked.

EOF
)"
```

- [ ] **Step 6: Last rebase, then a draft pull request**

This is the last point a rebase is allowed. It happens before the first apply.

```bash
git fetch origin
git rebase origin/main
git push -u origin HEAD
```

If `origin/main` has moved, the rebase rewrites this commit. The first-apply SHA is the pushed HEAD, not the hash from before the rebase. Do not rebase again after this.

Open a draft pull request. The body starts with:

```markdown
Spec: docs/specs/2026-10-05-staging-base.md
Plan: docs/plans/2026-10-05-staging-base.md
```

State that this departs from AGENTS.md §5: after this push the branch is not rebased, and the pull request is merged with a merge commit, never squashed, because the runbook names the SHAs that were applied. State that the human applies and the agent does not. The two SHAs are filled in when Task 7 marks the pull request ready.

```bash
gh pr create --draft --title "feat(infra): apply staging with no task" --body "$(cat <<'EOF'
Spec: docs/specs/2026-10-05-staging-base.md
Plan: docs/plans/2026-10-05-staging-base.md

## Summary

Staging is applied with no task, the proofs are recorded, and the database is then parked.

This departs from AGENTS.md §5. After this push the branch is not rebased, amended, or force-pushed. main is brought in with a merge commit. This pull request is merged with a merge commit, never squashed. A rebase would replace the SHAs the runbook names.

The human applies. The agent does not.

EOF
)"
```

Confirm every check is green on that SHA:

```bash
gh pr checks --watch
```

Expected: every check passes. If one fails, stop. Do not tell the human to apply.

The green SHA is the first-apply SHA. Do not apply it in this task.

---

### Task 4: Record the first apply

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md` (the "First apply" and "Evidence" headings only)

**Interfaces:**

- Consumes: the runbook from Task 3. The human's redacted proof notes.
- Produces: the first-apply SHA and the six proofs in the runbook.

The agent does not run `terraform apply`, `terraform state`, or any AWS command.

- [ ] **Step 1: Stop**

The draft pull request's checks are already green on the SHA from Task 3. Tell the human: apply bootstrap, then the AU root, from that SHA, using the runbook. Ask them to paste the redacted proofs. Do not invent a status, a count, or a timestamp. If they report `BucketAlreadyExists`, or that `environment` is not Active, stop. Do not continue to Task 5.

- [ ] **Step 2: Write only what they returned**

Under `### First apply`, the pushed SHA whose checks were green.

Under `### Evidence`, the six proofs in order. Redact an account id, a hosted zone id, an email address, or a key ARN if one slipped into the paste. A 429 count, a 503 count, an HTTP status, and "matches" for the storage key are safe.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/apply-staging-au.md
git commit -m "$(cat <<'EOF'
docs(infra): record the first staging apply

The proofs were taken with no task running. The commit SHA is the one
that was applied.

EOF
)"
```

Do not rebase, amend, or force-push this commit or any parent back through Task 3.

---

### Task 5: Commit the park

**Files:**

- Modify: `infra/regions/au/env/staging.tfvars`

**Interfaces:**

- Consumes: `enable_database` and `enable_budgets` from Task 2.
- Produces: the park SHA the human applies.

- [ ] **Step 1: Confirm the tag is Active**

The human has already said Billing shows `environment` as Active, in Task 4. If they have not, stop.

- [ ] **Step 2: Set the flags**

Append to `infra/regions/au/env/staging.tfvars`:

```
enable_database = false
enable_budgets  = true
```

Leave `aws_account_id = "123456789012"`. Do not add the zone id or the email.

- [ ] **Step 3: Commit**

```bash
git add infra/regions/au/env/staging.tfvars
git commit -m "$(cat <<'EOF'
feat(infra): park staging and create the budget

enable_database is false and enable_budgets is true. The human applies
this commit. The tag is already Active.

EOF
)"
```

- [ ] **Step 4: Stop**

Tell the human to apply this commit with both var files, then run `terraform plan` and confirm it shows no changes. Ask them to confirm the plan still contains the topic, the subscription, the hostname alarm, and the budget with tag filter `user:environment$staging`. Do not apply it yourself.

---

### Task 6: Record the park

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md` (the "Park apply" and "Park evidence" headings only)

**Interfaces:**

- Consumes: the human's park result.
- Produces: the park SHA and the no-changes plan, recorded in the runbook.

- [ ] **Step 1: Stop until the human reports**

If the plan showed changes, stop and report the resource addresses. Do not edit Terraform to silence a real diff.

- [ ] **Step 2: Write the record**

Under `### Park apply`, the Task 5 SHA.

Under `### Park evidence`: plan showed no changes; the topic, the subscription, the hostname alarm, and the budget were present; the budget's tag filter is `user:environment$staging`.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/apply-staging-au.md
git commit -m "$(cat <<'EOF'
docs(infra): record the staging park

The park commit was applied and the following plan showed no changes.
The budget is present with its tag filter.

EOF
)"
```

---

### Task 7: Update the catalogue and mark the pull request ready

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Consumes: Tasks 1–6 are on the branch. The two SHAs are in the runbook.
- Produces: Phase 0 is 22 rows: 18 done, 1 superseded (`api-au-hostname`), 3 not started. Next chunk is `first-running-task`.

- [ ] **Step 1: Update the snapshot and the rows**

In `docs/roadmap.md`, set Last shipped to `` `staging-base` ``, Next chunk to `` `first-running-task` ``, and Phase 0 to `22 rows: 18 done, 1 superseded (`api-au-hostname`), 3 not started`.

Replace the `first staging apply` row with these three rows, in order, and leave `kms-mrk-replica` last:

```markdown
| done | `staging-base` | Staging applied with no task, proofs recorded, then parked. Spec `docs/specs/2026-10-05-staging-base.md`. |
| not started | `first-running-task` | Image pushed by a person from a merged main commit, service_image set, desired_count 1, health, database and KMS round trips, VPC link to a public-subnet task, /tmp write, probe task, SHOW max_connections, rolling-deploy and steady-traffic 5xx counts, one run with the KMS endpoint on, and the hostname alarm firing. |
| not started | `image-publish` | CI builds, tests, and pushes by digest through a GitHub OIDC role scoped to this one repository. AGENTS.md section 10 requires production to promote that exact CI build. After `first-running-task` and before any production apply. |
```

Update the "Next spec" sentence to name `first-running-task`.

In `AGENTS.md`, replace the repository-state sentence with: Phase 0: 22 rows, 18 done, 1 superseded (`api-au-hostname`), 3 not started. Next is `first-running-task`. Leave the rest of that cell as it stands.

- [ ] **Step 2: Full CI, in workflow order**

Static, from `.github/workflows/ci.yml`:

```bash
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm typecheck
pnpm check:boundaries
pnpm audit --audit-level=high
```

Secret scanning uses gitleaks 8.30.1 as the workflow does. If the binary is not installed, say so. Do not treat a missing local binary as a pass.

Test:

```bash
docker compose -f packages/db/test/docker-compose.yml up -d postgres
pnpm test
```

Terraform, Terraform 1.11.4, for each of the nine directories in the workflow matrix:

```bash
terraform init -backend=false -lockfile=readonly
terraform fmt -check
terraform validate
tflint --init
tflint
terraform test
```

Build preview is the ARM image and `RUN_IMAGE_TESTS=1` on `apps/api/src/image.test.ts`. This chunk does not change that image. Run it if Docker is available. If it is not, say so.

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark the staging base done

Phase 0 is 22 rows. Next is the first running task. Image publish sits
before any production apply.

EOF
)"
```

- [ ] **Step 4: Mark the pull request ready**

The draft pull request already exists. Push this commit. Edit the body so it names the first-apply SHA and the park SHA, and says the evidence redacts the account id, the zone id, the alarm email, and key ARNs. Keep the Spec and Plan lines and the AGENTS.md §5 departure.

```bash
gh pr ready
```

Do not open a second pull request. Do not merge.

---

## Self-review

Spec coverage: locks (Task 1), topic move, hostname alarm, `enable_database`, `budget_name`, tests (Task 2), gitignore and runbook (Task 3), draft pull request before the first apply (Task 3), first apply and six proofs (Task 4), park flags (Task 5), park evidence (Task 6), catalogue and marking the pull request ready (Task 7). The VPC link group is in the runbook proof. The Active-tag stop is in the runbook. List-price totals live in the spec and are not recalculated here.

Placeholder scan: evidence headings are filled from the human's paste, not from invented counts.

No database migration wave.
