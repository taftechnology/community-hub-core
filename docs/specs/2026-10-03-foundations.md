# Spec: Foundations before the first apply

Slug: foundations
Status: draft
Architecture refs: §7.3, §8.1, ADR 0009. Implements the foundations row named in `docs/specs/2026-10-03-personal-data-on-aws.md`. That spec is not edited.

## Problem

The tree still describes a broker. The envelope module has a task role and an execution role named for the broker, a broker log group, a broker security group, and an unconditional KMS endpoint whose key policy always requires `aws:SourceVpce`. The network module has one public subnet and a connector security group that is the only source allowed to reach RDS. The database module turns Multi-AZ, deletion protection, and backups on from `environment == "prod"` and ignores the root variables that claim to set the last two. There is no secrets key, no role passwords, no second public subnet, no `environment` and `project` tags, and no budget.

Staging has never been applied. There is no state bucket. A first apply of this tree would create a connector, Cloudflare egress, a single-Region envelope key, and a KMS endpoint that the staging budget assumes is off.

## Scope

**In**

Seven tasks, in this order. Each leaves CI green. Each updates the AU root's call site. There is no final task that wires the root.

1. Network. The second public subnet. One task security group replaces the connector. RDS ingress on 5432 comes only from that group, and the group has outbound 5432 to the RDS group. Outbound 443 to the internet stays, because staging calls KMS on the task's public address while the endpoint is off. Port 7844 goes. The connector name goes. The `terraform-invariants` connector rule and its `connector-ingress-rule` fixture are retired in this commit. The network test re-points the RDS assertion and covers both public subnets. The cell assertion that the envelope key policy must not contain `connector-execution` is retired.
2. Envelope. `multi_region = true`, with a test, in this commit, and no apply of the key before this commit is merged. The task role becomes `${name}-task` and the execution role becomes `${name}-execution`. The key policy names the new task-role ARN in the same commit. The broker log group becomes `/community-hub/${name}/service` and keeps the retention validation (`log_retention_days > 0`). The endpoint and its security group exist only when the flag is on. Production rejects the flag off. Staging defaults it off. `aws:SourceVpce` is present on the cryptographic statements if and only if the flag is on. When the endpoint exists, it accepts 443 only from the task group. The two storage-key assertions that reject the string `kms-broker-task` are re-pointed at `ch-staging-task`. Both tests set `name = "ch-staging"`, so that string is the role ARN's name.
3. Database. Class and Multi-AZ are variables. The class default becomes `db.t4g.micro`. Multi-AZ defaults to false and is no longer derived from `environment == "prod"`. The root's `deletion_protection` and `backup_retention_days` are passed into the module and used. Production cannot turn off backups of at least 7 days, deletion protection, storage-key encryption, forced TLS, or the private address. The storage ceiling and the two windows take the values the approved spec fixes. The four alarms are in this task.
4. Secrets. A secrets key and the `app`, `identity`, and `platform` passwords. `hashicorp/random` at `~> 3.7`. The task role and the execution role may read those three secrets.
5. Tags. `environment` and `project` on every resource, including bootstrap and the storage key.
6. Budgets. One budget per environment, behind `enable_budgets`, default false. A plan-only test runs with the flag on.
7. Roadmap. Foundations done. Next is ingress.

The service's task role, execution role, and log group stay in `aws-kms-envelope`. That is deliberate. The ingress chunk reads them from there.

This chunk is one chunk on purpose. It touches more than two modules and it will pass the ~800-line review guide. The approved row already kept this list together and split only ingress. The plan keeps each task readable on its own.

**Out**

- Any `terraform apply`, including bootstrap. This chunk does not apply.
- The envelope key, until the `multi_region` test from task 2 is merged. The runbook already says this.
- The task security group's inbound rule from the VPC link. The ingress chunk adds it.
- The KMS endpoint's second availability zone. That lands with the later move of production to two zones.
- Route 53, the API certificate, Cloud Map, the VPC link, the HTTP API, and the ECS service module.
- Reshaping the KMS adapter onto `KmsPort`, the ported server tests, and TLS `verify-full` in the process. The service chunk does those.
- Turnstile's secret. A person creates it later. It is not one of the three role secrets.
- A rotation Lambda for the role passwords. Automatic rotation stays an open item.
- Rewriting the withdrawn apply order in `docs/runbooks/apply-staging-au.md`. This chunk adds prerequisites only.
- Editing `docs/specs/2026-10-03-personal-data-on-aws.md` or its plan.

## Behaviour

### Network

`aws_subnet.public` stays the subnet in `availability_zones[0]`, CIDR index 0. A second public subnet uses `availability_zones[1]` and `cidrsubnet(var.vpc_cidr, 8, 3)`. Indexes 1 and 2 stay the private subnets. Both public subnets set `map_public_ip_on_launch`. The network test asserts that on both. The existing `public_subnet_id` output remains the first subnet, which is the subnet the endpoint uses while it has one zone. A `public_subnet_ids` output lists both.

`aws_security_group.connector` is replaced by `aws_security_group.task`, named `${name}-task`. Its ingress is empty. Its egress is TCP 443 to `0.0.0.0/0`, described as public AWS APIs, not as Cloudflare. A separate `aws_vpc_security_group_egress_rule` allows TCP 5432 from the task group to the RDS group. There is no rule for port 7844. The RDS ingress rule's `referenced_security_group_id` is the task group, and the network test asserts that, including the ports 5432. The assertion that the connector group has no inbound is removed. The output `connector_security_group_id` becomes `task_security_group_id`.

`tooling/checks/terraform-invariants` drops `validateConnectorFile` and the `connector-ingress-rule` fixture in the same commit. The "no inbound" rule does not move onto the task group. The ingress chunk will add inbound from the VPC link, and a checker that forbids that inbound would be wrong. A checker with no live input is not left behind.

### Envelope

`aws_kms_key.envelope` sets `multi_region = true`. A Terraform test asserts the attribute. `prevent_destroy` stays.

Role names:

| Resource | Name |
| --- | --- |
| `aws_iam_role.task` | `${name}-task` |
| `aws_iam_role.execution` | `${name}-execution` |
| Execution role policy | no longer `kms-broker-execution` |
| Log group | `/community-hub/${name}/service` |

The key policy's task-role ARN uses `${name}-task`. The cryptographic statements stay the four that exist today (`GenerateDataKey` and `Decrypt`, each for `org` and `identity`), with the same encryption-context conditions. `aws:SourceVpce` is included only when the endpoint flag is on. When the flag is off, those statements do not reference `aws_vpc_endpoint.kms`, because that resource does not exist.

`enable_kms_endpoint` defaults to false. A validation fails when `environment` is `prod` and the flag is false. Staging tfvars leave it false. The endpoint and `aws_security_group.endpoint` are created only when the flag is on. The endpoint's ingress is TCP 443 from the task group and nothing else. `aws_security_group.broker` is deleted, including its 443 and 7844 egress.

The execution role may write to the service log group (`logs:CreateLogStream`, `logs:PutLogEvents`) and must not contain `kms:`. The task role is the only principal on the cryptographic statements.

`infra/modules/aws-kms-storage/tests/kms.tftest.hcl` and `infra/regions/au/tests/cell.tftest.hcl` change the storage-key assertion from `kms-broker-task` to `ch-staging-task`. The cell assertion that binds each cryptographic statement to `ch-staging-kms-broker-task` and `vpce-mock` is rewritten for `${name}-task` and for the flag. The flag-on run expects `aws:SourceVpce`. The flag-off run expects the four cryptographic statements and no `aws:SourceVpce`. The `connector-execution` assertion is deleted.

### Database

The RDS module gains `multi_az` (default false), `deletion_protection`, and `backup_retention_days`. The instance uses those variables. It stops deriving them from `environment == "prod"`. `instance_class` stays a variable and its default changes from `db.t4g.medium` to `db.t4g.micro`. The AU root passes `deletion_protection` and `backup_retention_days` into the module. The root check stays. It is no longer decorative, because the instance receives the values. The module rejects a `prod` environment that turns deletion protection off, sets backup retention below 7, or turns the public address on. `storage_encrypted` stays true and is not a variable. `rds.force_ssl = 1` stays. `publicly_accessible` stays false.

These values are fixed because the approved spec fixes them:

| Setting | Value |
| --- | --- |
| `allocated_storage` | 20 |
| `max_allocated_storage` | 100 |
| Backup window | 17:00–18:00 UTC |
| Maintenance window | Tue 15:00–16:00 UTC |

The four alarms are standard-resolution metric alarms on `AWS/RDS` for this instance. Each lists one metric. No metric math, no Metrics Insights, no anomaly detection. Period 300 seconds, three datapoints out of three. They do not change the instance. Moving to `db.t4g.small` stays the operator decision in the approved spec: the alarm has held through ordinary use for two weeks.

| Alarm | Metric | Threshold | Why this number |
| --- | --- | --- | --- |
| CPU credits | `CPUCreditBalance` less than 24 | 24 credits | `t4g.micro` earns 12 credits an hour and can accrue 288. Below 24 the balance is under two hours of earn, which is the tank nearly empty. |
| Free memory | `FreeableMemory` less than 104857600 | 100 MiB | The class is 1 GiB before RDS reserves memory. |
| Free storage | `FreeStorageSpace` less than 2147483648 | 2 GiB | Ten percent of the 20 GiB start, and the last 2 GiB at any size up to the 100 GiB ceiling. |
| Connections | `DatabaseConnections` greater than 30 | 30 | Half of the 60 `max_connections` floor. Production steady state in the approved table is 26, so it stays under the line. A rolling deploy of 50 crosses it, and that is not two weeks of ordinary use. |

An alarm with no action notifies nobody. The four alarms share one SNS topic in `ap-southeast-2`, and each alarm's action is that topic. The topic has an email subscription to `alert_email`. Terraform cannot confirm that subscription. Until a person confirms it, the alarm is visible in the console and the email does not arrive. `alert_email` is required and has no default. The same variable is the budget notification address.

### Secrets

New module `infra/modules/aws-db-secrets`. Its key is a customer-managed key in `ap-southeast-2`, not the envelope key and not the storage key. `enable_key_rotation` cannot be false. Decrypt is allowed only through `secretsmanager.ap-southeast-2.amazonaws.com`, and only when the encryption context secret ARN is one of the three role secrets.

`hashicorp/random` `~> 3.7` generates each password with ephemeral `random_password`. Each secret version uses `secret_string_wo`. `secret_string_wo_version` is what triggers a new write. A later apply does not rewrite a secret while that version stays unchanged. State holds ARNs, not passwords.

The master user stays the RDS-managed secret. The service never connects as master. A person still sets each role password with `ALTER ROLE`, as the approved spec describes. This chunk does not add that procedure to the runbook beyond the prerequisite that already says passwords are not written into Terraform.

The execution role and the task role, which stay in `aws-kms-envelope`, each gain `secretsmanager:GetSecretValue` on the three ARNs. Decrypt on the secrets key is limited to those three secrets and does not extend to the envelope key. The AU root passes the ARNs in. The secrets module does not create the roles.

### Tags

Every resource in bootstrap, network, storage, envelope, RDS, and the secrets module carries `environment` (`staging` or `prod`) and `project` (`community-hub`). The budgets module does not exist yet. Its resources carry the same two tags in the budgets commit. Bootstrap has not been applied. The backend file names `ch-tfstate-staging-au`, and that bucket does not exist. Tagging bootstrap is a code change. The first bootstrap apply, later and by a person, creates the bucket already tagged. It is not an in-place change of a live bucket.

### Budgets

New module `infra/modules/aws-budgets`. One cost budget per environment. Staging's limit is USD 50. Production's limit is USD 110. The notification is email at 80 percent of actual spend, so the lines are USD 40 and USD 88. No budget action and no budget report.

Both environment tfvars use the account ID `123456789012`, and the approved spec speaks of one account. Each budget filters on the user tag `environment` with that environment's value. AWS will not filter on a user tag until the tag is activated. After a billed resource carries the tag, the key can take up to 24 hours to appear on the cost-allocation tags page, and up to 24 hours more to become active. A filtered budget in the first apply would fail.

`enable_budgets` defaults to false. The first apply of the AU root does not create the budget. A person activates `environment` in Billing, then a later apply sets the flag true. The module's Terraform test includes a plan-only run with `enable_budgets = true` that asserts the limit, the 80 percent email notification, and the `environment` tag filter. The default-off run asserts that no budget is planned.

AWS Budgets is a global billing API. Its endpoint is `https://budgets.amazonaws.com`, and AWS routes that endpoint to `us-east-1`. The budget holds the amount and `alert_email`. It does not hold tenant data. Architecture §7.3 and the exception list in ADR 0009 gain a line for it, in the same commit as the module. The budgets module does not use the `aws_region == "ap-southeast-2"` validation on that API. The Sydney resources keep theirs. ADR 0009 is amended in place for this list. It does not get a new ADR.

### CI

`.github/workflows/ci.yml` lists the Terraform directories in a static matrix. A new module is not tested until its directory is added. The secrets commit adds `infra/modules/aws-db-secrets`. The budgets commit adds `infra/modules/aws-budgets`. Each new module has its own `.tflint.hcl` (the AWS ruleset already used, plugin `0.48.0`) and its own `.terraform.lock.hcl`.

`hashicorp/random` is locked in the secrets module and in `infra/regions/au`, because the root configuration includes the module. The lock is regenerated with Terraform 1.11.4 `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`. CI runs `terraform init -backend=false -lockfile=readonly` on Linux. A lock produced by a plain `terraform init` on a Mac does not carry the Linux hashes and will be refused. Hashes are not hand-edited.

## Data

No new table and no column. No migration. Passwords exist only as write-only secret versions. The spec, the plan, the tests, and the logs do not contain a password, the alert address, or a real account ID.

## Rules touched

Residency. The envelope key becomes a multi-Region primary in `ap-southeast-2`. No replica is created. The KMS endpoint stays in `ap-southeast-2` and defaults off in staging. AWS Budgets is the new exception outside that region, and it holds no tenant data. Personal data is not copied.

Encryption. The task role remains the only cryptographic principal for `GenerateDataKey` and `Decrypt`. The encryption-context conditions stay. The secrets key is a different key. Its decrypt is limited to the three role secrets through Secrets Manager.

Tenancy. No query, no role grant, and no `app` table change.

Children, money, analytics. No new path. Amounts in this chunk are budget limits in US dollars, not payment amounts.

Secrets. No secret is written into the repo, a fixture, or a log. The Cloudflare tunnel token stays deleted.

## Contracts

No route and no event. The names ingress will read from `aws-kms-envelope`:

- Task role `${name}-task`
- Execution role `${name}-execution`
- Log group `/community-hub/${name}/service`
- Task security group id from `aws-network`'s `task_security_group_id`

## Cost

Prices checked on 2026-10-03. USD, before GST.

| Resource | Monthly cost | Source |
| --- | --- | --- |
| Secrets key, before any rotation | 1.00 | The KMS price already used for the other keys. The same rotation steps apply. |
| Three role secrets | 1.20 | Secrets Manager, USD 0.40 each. The approved tables already count these inside the four-key and five-secret lines. |
| Budget notifications, no actions and no reports | 0.00 | AWS Budgets pricing. Monitoring and notifications are free. Actions and reports are not used. |
| Four standard alarms, list price | 0.40 per environment | CloudWatch pricing. USD 0.10 per standard-resolution alarm-metric. One metric each. |
| Four standard alarms, this account | 0.00 while the account stays within 10 standard alarm metrics | The same page's free tier includes 10 standard alarm metrics. |
| SNS email at this volume | 0.00 | Email delivery is priced per 100,000. These alarms do not approach that. |

The approved staging full month is USD 40.40 with the endpoint off, and it does not include alarms. Adding the list price makes USD 40.80. The staging budget stays USD 50, so the alert stays at USD 40. Both 40.40 and 40.80 are above 40, so the alert still fires only if staging is left running all month. This chunk does not change the budget amounts. Production's USD 0.40 list price does not move the USD 88 alert relative to the launch month.

The KMS endpoint, when someone turns it on, stays about USD 9.49 a month for one zone. Staging defaults it off. This chunk does not add a NAT gateway, a load balancer, or a second interface endpoint.

## Risks

A first apply before task 2 is merged would create a single-Region envelope key. AWS does not convert that key later. The test lands in the same commit as `multi_region = true`, and the runbook already forbids the apply until both are merged.

A filtered budget applied before the `environment` tag is active fails. The flag defaults off so the first apply does not create it.

The task role can call KMS and can read the three database secrets. Both are scoped. A compromised task can still decrypt what the process can decrypt. That is the accepted trade in ADR 0009.

The task group has outbound 443 to the internet. That is the path to the public KMS endpoint while the interface endpoint is off. It is not Cloudflare egress. Port 7844 is not on the group.

The alarms page an operator only after the SNS subscription is confirmed. Until then they are console-only.

## Out-of-band

- The second fresh-context review. This chunk touches encryption and residency. A new session reads only the final diff. The review that writes this spec does not count.
- `alert_email`, chosen by the owner. This spec does not invent it.
- Confirming the SNS email subscription.
- Activating the `environment` cost-allocation tag, then applying again with `enable_budgets = true`.
- `ALTER ROLE` for the three passwords, after the secrets exist. The values are not written into the repo, a log, or Terraform.
- No apply of this chunk, and no apply of the envelope key before the `multi_region` test is merged.

## Tests

Terraform tests only. No package test changes.

- Network: both public subnets assign public addresses. RDS ingress on 5432 references only the task group. The task group has outbound 443 and outbound 5432 to the RDS group, and no 7844.
- Invariants: the connector fixture is gone, and the checker no longer looks for a resource named `connector`.
- Envelope: `multi_region` is true. Role names and the log group use the names above. Flag on includes `aws:SourceVpce` and creates the endpoint. Flag off includes neither the condition nor the endpoint. Prod with the flag off fails. The execution policy writes logs and does not contain `kms:`. Storage-key tests reject `ch-staging-task`.
- RDS: prod cannot turn the protections off. Staging can set Multi-AZ false, deletion protection false, and backup retention 0. The class default is `db.t4g.micro`. The ceiling is 100 and the windows match the table. Each alarm has the threshold in the table and an SNS action.
- Secrets: rotation cannot be false. The key policy names Secrets Manager in `ap-southeast-2` and the three secret ARNs. A plan does not show a password.
- Budgets: the default run plans no budget. The run with `enable_budgets = true` plans the limit, the 80 percent email, and the `environment` tag filter.
- Tags: a resource in each module carries `environment` and `project`.
