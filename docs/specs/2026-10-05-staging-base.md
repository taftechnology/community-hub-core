# Spec: Staging base

Slug: staging-base
Status: approved (2026-10-05, Abdus Salam)
Architecture refs: §7.3, ADR 0009, ADR 0010. Implements the `staging-base` row that replaces `first staging apply` in `docs/roadmap.md`. `docs/specs/2026-10-03-personal-data-on-aws.md`, `docs/specs/2026-10-03-foundations.md`, `docs/specs/2026-10-04-ingress.md`, and `docs/specs/2026-09-18-terraform-au-cell.md` are not edited.

## Problem

Staging has never been applied. There is no state bucket, no cell, and no record of what the custom domain returns when Cloud Map has no instances. `docs/runbooks/apply-staging-au.md` still describes the withdrawn Cloudflare apply and says not to run it. The AWS provider lock is 6.65.0 on some roots and modules and 6.67.0 on others.

The catalogue row `first staging apply` also requires a running task. That proof is a later chunk. This chunk applies the cell with no task, records the proofs that can be taken in that state, and parks.

## Scope

**In**

- Rewrite `docs/runbooks/apply-staging-au.md` as the AWS apply. The Cloudflare steps are deleted.
- Align every AWS provider lock to 6.67.0.
- `enable_database` on `infra/regions/au`, default true. False removes `module.rds` only.
- Move the SNS alarms topic and its email subscription out of `module.rds`. The module takes the topic ARN for its four alarms.
- A metric filter and alarm on `reason` = `missing_hostname_header` on the service log group.
- Apply from the branch, with `service_image` null and `desired_count` 0, then park. The runbook records both commit SHAs and the proofs below.
- The last commit updates `docs/roadmap.md` and the repository-state line in `AGENTS.md`.

**Out**

- `first-running-task`. That spec is written after this one merges. It owns unpark, the image push, `service_image`, `desired_count` 1, health, the database and KMS round trips, the VPC link proof, the `/tmp` write, the probe task, `SHOW max_connections`, the rolling-deploy and steady-traffic 5xx counts, one run with the KMS endpoint on, and the hostname alarm firing. The image is pushed by a person, from a clean checkout of a merged `main` commit, for `linux/arm64`, and only after `RUN_IMAGE_TESTS=1` passes against that exact local image. The push uses the `ch-admin` profile. `service_image` is the pushed `repository@sha256` digest. The runbook records the commit SHA, the digest, and the scan-on-push result. CI does not log in or push. No new IAM role or OIDC provider.
- `image-publish`. The catalogue row is added here. Its spec is later.
- Production. This runbook does not apply `environment = "prod"`.
- A running task, an ECS cluster, a task definition, or a pull policy. `service_image` stays null through both applies.
- Registering `communityhub-staging.net`. A person registers it before the first apply.

## Behaviour

### Prerequisites

A person does these before the first apply. This chunk does not do them.

1. Register `communityhub-staging.net` in Route 53. Registration creates the hosted zone. Terraform uses that zone id and does not create a second staging zone.
2. Use the `ch-admin` profile, an IAM Identity Center administrator, never the root user.
3. Choose the alarm email address. The address is not written in this spec, the plan, the tests, or the runbook.

`infra/bootstrap` is applied first. It is the only root that starts on local state (`docs/specs/2026-09-18-terraform-au-cell.md`, Bootstrap). The current runbook's steps sit under the withdrawn Cloudflare order, so they are not the procedure. The backend block is `backend "s3" {}`.

The first bootstrap apply uses a gitignored file `infra/bootstrap/backend_override.tf` whose contents are `terraform { backend "local" {} }`. Then `terraform init`, then `terraform apply -var-file=env/staging.tfvars`. Then delete the override. Then `terraform init -backend-config=backend/staging.hcl -migrate-state`. `terraform state list` must show the bootstrap resources from the bucket before anyone deletes the local state files. Terraform leaves a 0-byte `terraform.tfstate` and a full `terraform.tfstate.backup` after migration. The runbook deletes both only after that list succeeds, then confirms `git status` is clean. If the bucket name is taken (`BucketAlreadyExists`), stop and report.

### What is applied

The AU apply passes `env/staging.tfvars` and then `env/staging.local.tfvars`. The local file wins. It holds the real account id, the hosted zone id, and the alarm email. The committed staging file keeps the synthetic account id `123456789012`. `.gitignore` gains `infra/regions/au/env/*.local.tfvars` and `infra/bootstrap/backend_override.tf`. It does not ignore `*.tfvars`. `staging.tfvars` and `prod.tfvars` stay committed.

The branch is `feat/2026-10-05-staging-base`. Any rebase onto `origin/main` happens before the first apply. After the first apply there is no rebase, no amend, and no force-push. `main` is brought in with a merge commit. The pull request is merged with a merge commit, never squashed. The recorded SHAs are then the commits that ran. The pull request body states that this departs from AGENTS.md §5's rebase-before-PR rule, and why: a rebase would replace the SHAs the evidence names.

The first AU apply is the branch head at which `enable_database` is still the default true, `enable_budgets` is still the default false, `service_image` is null, and `desired_count` is 0. The runbook records that commit SHA with the proofs. The evidence redacts the account id, the hosted zone id, the alarm email, and any key ARN.

After that apply the human activates the `environment` cost-allocation tag in Billing. The tag can take up to 24 hours to appear and up to 24 hours more to become active. The check is that Billing's cost-allocation tags page shows `environment` as Active. A budget whose tag filter is not yet active is created and counts USD 0. It does not fail. If the tag is not Active when it is time to park, stop and report. Do not park without it.

### Proofs, before parking

Recorded in the runbook, in this order, against the first apply's commit SHA.

1. The SNS email subscription is confirmed.
2. The custom domain, while Cloud Map has no instances: the HTTP status and the integration error. This spec does not state them.
3. The live rules on the task security group, the RDS security group, and the VPC link security group, compared with the declared set. With no image, the task group has egress TCP 443 to `0.0.0.0/0` and egress TCP 5432 to the RDS group, and no inbound rule. The RDS group has inbound TCP 5432 from the task group only. The VPC link group has egress TCP 8080 to the task group and no inbound rule. That group exists with no image.
4. Throttle. 300 requests in about one second to `GET /` on a tenant hostname, which is a default route. Record the 429 count and the 503 count. Immediately, 300 requests to `POST /` on that same hostname, which is a write route. Record the same two counts. A 429 on the write route after the burst means one shared bucket. Record the tool, the counts, and the timestamps. No request carries a body, a query string, or personal data.
5. `describe-db-instances` shows region `ap-southeast-2`, `StorageEncrypted` true, `KmsKeyId` equal to the storage key, `PubliclyAccessible` false, backup retention 0, and `ManageMasterUserPassword` true. `rds.force_ssl` = `1` is read with `describe-db-parameters` on the parameter group the instance names, because the instance description does not include parameter values. The evidence says the key matches. It does not record the ARN.
6. A second `terraform plan` shows no changes.

### Parking

Commit `enable_database = false` and `enable_budgets = true` in `infra/regions/au/env/staging.tfvars` first. Apply from that commit. Record that SHA. Then a `terraform plan` shows no changes. That plan still contains the SNS topic, the email subscription, the hostname alarm, and the staging budget. The evidence records that the budget exists and that its tag filter is `user:environment$staging`.

Unpark is `first-running-task`: recreate the database, the `ALTER ROLE` procedure, and waiting until the VPC link is `AVAILABLE`. This chunk does not unpark.

### Alarms

The AU root has no provider `default_tags`. Tags are set on each resource. The root owns the topic `${name}-alarms` and its email subscription, both tagged `environment` and `project` like every other taggable resource. `module.rds` takes the topic ARN and keeps its four alarms. Nothing has been applied, so there are no `moved` blocks.

The hostname alarm is a metric filter on the envelope service log group for `{ $.reason = "missing_hostname_header" }`, and one standard alarm on that metric. The alarm is Sum, period 300 seconds, `comparison_operator` `GreaterThanOrEqualToThreshold`, threshold 1, one evaluation period, `treat_missing_data` = `notBreaching`, and `alarm_actions` is the root topic. The alarm carries `environment` and `project`. The metric filter resource has no tags argument. It costs USD 0.

The log carries no remote address, and it must not (AGENTS.md §1 rule 5). `reason` alone is enough. Loopback `GET /health` is exempt from the hostname check, so that line is never written for it. This chunk declares the alarm. It does not fire it. No task is running, so no log line is written.

### Database flag

`enable_database` defaults to true. False sets `count` to 0 on `module.rds` only. The root then passes an empty `db_host`, and `rds_hostname` is null. The db-secrets module stays. The three role secrets stay. The RDS-managed master secret goes away with the instance.

Production refuses false, with a `terraform_data` precondition of the same shape as the deletion-protection guard. A plan with `enable_database` false and `service_image` set fails on a root precondition: the database is on, or the image is null. The image value in that test is a valid digest, so the image check is not what fails.

### Provider lock

Every `.terraform.lock.hcl` under `infra/` selects `hashicorp/aws` 6.67.0. Ingress, the envelope, budgets, and db-secrets are already on that version. Bootstrap, the AU root, network, RDS, and the storage key are on 6.65.0 and are regenerated. The platforms are `linux_amd64` and `darwin_arm64`, plus the human's apply platform if it is neither of those. The apply machine is `darwin` `arm64`, so `darwin_arm64` is already in that list. The `random` provider stays 3.9.1. CI runs `terraform init -backend=false -lockfile=readonly`, so a mismatched lock fails that job.

## Data

No new table and no new column. The metric filter counts a reason code. That code is not personal data. The throttle requests carry no personal data. Access logs stay the fields ingress already allows: no query string and no client IP. The local tfvars file is gitignored. The evidence does not contain the account id, the hosted zone id, the alarm email, or a key ARN.

## Rules touched

Residency. Bootstrap, the cell, the database, the topic, and the alarm are in `ap-southeast-2`. The budget uses the `us-east-1` billing endpoint already allowed by ADR 0010. Route 53 stays the global-service exception the parent spec allows. Personal data is not written to the access logs.

Children. No new public path, directory, or projection.

Tenancy. No query is added.

Encryption. The database proof checks that storage encryption is on and that the key is the storage key. The evidence does not record the key ARN.

Secrets. The real account id, the hosted zone id, and the alarm email stay out of the repo, the plan, the tests, and the evidence.

Rule 5. The hostname alarm matches `reason` only. The log has no remote address.

## Contracts

| Contract             | Value                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enable_database`    | Root variable, default true. False removes `module.rds` only. Production refuses false. False with `service_image` set fails the plan.                                                       |
| `enable_budgets`     | Stays the foundations variable, default false. The park commit sets it true in `staging.tfvars`.                                                                                             |
| `service_image`      | Null on both applies.                                                                                                                                                                        |
| `desired_count`      | 0 on both applies.                                                                                                                                                                           |
| Topic                | Root resource `${name}-alarms`, email subscription to `alert_email`, tags `environment` and `project`.                                                                                       |
| RDS alarms           | The four existing alarms, `alarm_actions` the topic ARN input. The module plans no topic and no subscription, and it no longer takes `alert_email`.                                          |
| Hostname filter      | Log group is the envelope service log group. Pattern `{ $.reason = "missing_hostname_header" }`. No tags.                                                                                    |
| Hostname alarm       | Sum, period 300, `GreaterThanOrEqualToThreshold`, threshold 1, one evaluation period, `treat_missing_data` `notBreaching`, `alarm_actions` the root topic, tags `environment` and `project`. |
| Local tfvars         | `infra/regions/au/env/staging.local.tfvars`, gitignored, passed after `staging.tfvars`. Holds the account id, the hosted zone id, and the alarm email.                                       |
| Bootstrap override   | `infra/bootstrap/backend_override.tf`, gitignored, `backend "local" {}`, deleted before migrate.                                                                                             |
| Task group, no image | Egress TCP 443 to `0.0.0.0/0`. Egress TCP 5432 to the RDS group. No inbound rule.                                                                                                            |
| RDS group            | Inbound TCP 5432 from the task group only.                                                                                                                                                   |
| VPC link group       | Egress TCP 8080 to the task group. No inbound rule. Exists with no image.                                                                                                                    |

## Cost

Prices for the cell are the parent spec's figures from 2026-10-03, plus the CloudWatch and Budgets lines below. The parent mode-3 total is USD 40.40. This apply has no task (USD 8.64), no public address (USD 3.65), no Cloud Map registration (USD 0.10), and no Turnstile secret (USD 0.40). Those four lines come out. Five standard alarms go in at list price.

CloudWatch, read 2026-10-05 from the [pricing page](https://aws.amazon.com/cloudwatch/pricing/) and the `ap-southeast-2` offer file: a standard alarm is USD 0.10 per alarm-metric month (`APS2-CW:AlarmMonitorUsage`). A custom metric is USD 0.30 in the first 10,000 (`APS2-CW:MetricMonitorUsage`). A custom metric is billed only in an hour when a value is published. This chunk runs no task and writes no matching log, so the filter's metric publishes nothing and its line is USD 0. The first 10 alarm metrics and the first 10 custom metrics are a free tier. That allowance is account-wide and shared with any other alarms in the account. It is a note. The totals use list prices, as the parent spec does.

AWS Budgets, read 2026-10-05 from the [pricing page](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/): monitoring and notifications are free. The daily USD 0.10 charge applies to an action-enabled budget after the first two. This budget has an email notification and no action, so its line is USD 0.00. The limit is USD 50 and the notification is 80 percent, so the alert is at USD 40. The filter is `user:environment$staging`.

Database up. The budget is not created yet.

| Line                                          |   USD |
| --------------------------------------------- | ----: |
| Four KMS key versions                         |  4.00 |
| Three role secrets plus the RDS master secret |  1.60 |
| Two hosted zones                              |  1.00 |
| Database instance                             | 18.25 |
| 20 GB storage                                 |  2.76 |
| Five standard alarms                          |  0.50 |
| Custom metric                                 |  0.00 |
| Total                                         | 28.11 |

Parked. The park apply creates the budget and removes the database, the master secret, and the four RDS alarms.

| Line                  |  USD |
| --------------------- | ---: |
| Four KMS key versions | 4.00 |
| Three role secrets    | 1.20 |
| Two hosted zones      | 1.00 |
| Hostname alarm        | 0.10 |
| Custom metric         | 0.00 |
| Staging budget        | 0.00 |
| Total                 | 6.30 |

This apply creates no ECS cluster: `aws_ecs_cluster` has `count` 0 while `service_image` is null. The VPC, subnets, internet gateway, security groups, an empty ECR repository, both HTTP APIs, the VPC link, the certificate, empty log groups, and the SNS topic have no monthly charge. No task, no public address, no Cloud Map registration, no KMS endpoint, and no Turnstile secret.

Usage during the proofs — API requests, access-log ingestion from the burst, KMS calls, and state-bucket storage — is billed per use, not monthly, and is well under USD 1. It stays outside the monthly totals, as in the parent spec. The domain registration stays USD 17 a year, outside the monthly total.

The budget's tag filter does not count untagged spend, including the domain registration and the hosted zone that registration created, or tax. The foundations spec already says the filter misses untagged spend and tax. The USD 40 alert is not a cap on all of staging.

No NAT gateway, no load balancer, and no interface endpoint.

## Risks

The empty Cloud Map status is unconfirmed. The runbook records the status the custom domain returns. It does not treat a guessed status as the result.

The throttle proof records counts. A 429 on the write route after the burst is what shows one shared bucket. This spec does not state that result ahead of the measurement.

`BucketAlreadyExists` on the state bucket stops the apply. A different bucket name is a change to the backend, and it is not made in this chunk.

A budget whose tag filter is not yet active is created and counts USD 0. It does not fail. The runbook still stops, because that budget would not see the cell's tagged spend. The check is that Billing's cost-allocation tags page shows `environment` as Active.

The filter misses untagged spend and tax, so a month can pass USD 40 on the account while the staging budget stays quiet. That gap is the one foundations accepted. This chunk does not add an unfiltered budget.

The VPC link's subnets and security groups are fixed at create. A link with no traffic for 60 days becomes `INACTIVE`. Unpark belongs to the next chunk, which waits until the link is `AVAILABLE`.

The applied commits are the ones the evidence names. A later commit that changes Terraform would make the parked plan show changes. The last commit on this branch changes the catalogue and `AGENTS.md` only.

Those SHAs have to survive the merge. A rebase, an amend, a force-push, or a squash replaces them, and the evidence would name commits that are no longer on `main`. Any rebase onto `origin/main` happens before the first apply. After that apply there is no rebase, no amend, and no force-push. `main` is brought in with a merge commit, and the pull request is merged with a merge commit. The pull request body states that this departs from AGENTS.md §5's rebase-before-PR rule, and why.

## Out-of-band

- The second fresh-context review. This chunk applies the cell and checks the storage key on the database. A new session reads only the final diff. The review that writes this spec does not count.
- Register `communityhub-staging.net` and pass the zone id in the gitignored tfvars file.
- Activate the `environment` cost-allocation tag after the first apply and before the park apply.
- Confirm the alarm email. The runbook records that the subscription is confirmed. It does not record the address.
- The human applies. This chunk's agent does not run `terraform apply`.
- No password, alarm email, real account id, hosted zone id, or key ARN in this spec, the plan, the tests, the runbook evidence, or the logs. Tests that need an account id use `123456789012`.

## Tests

Terraform tests are mocked plans. No test uses a real account id.

- Staging, `enable_database` false: the plan has no `aws_db_instance`. It has the topic, the subscription, and the hostname alarm.
- Production, `enable_database` false: the plan fails.
- `enable_database` false and `service_image` set to a valid digest: the plan fails on the root precondition.
- The hostname alarm is Sum, period 300, `GreaterThanOrEqualToThreshold`, threshold 1, one evaluation period, `treat_missing_data` `notBreaching`, and `alarm_actions` is the root topic. The filter pattern is `{ $.reason = "missing_hostname_header" }`.
- The topic and the hostname alarm each carry `environment` and `project`.
- `module.rds` plans no topic and no subscription. Its four alarms use the topic ARN input.
- `enable_budgets` true plans the staging budget at USD 50, the 80 percent email, and the `environment` tag filter. That assertion already exists in the budgets module. The cell plan with both park flags set contains the budget.

Every `infra/` lock file selects AWS provider 6.67.0. `terraform init -backend=false -lockfile=readonly` is the check.

## Catalogue

The last commit on this branch updates `docs/roadmap.md` and the repository-state line in `AGENTS.md`. Phase 0 becomes 22 rows: 18 done, 1 superseded (`api-au-hostname`), 3 not started.

`first staging apply` is replaced by three rows, in this order:

| Status      | Chunk                | What                                                                                                                                                                                                                             |
| ----------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| done        | `staging-base`       | This spec. Staging applied with no task, proofs recorded, then parked.                                                                                                                                                           |
| not started | `first-running-task` | The running-task proofs listed under Scope. Next chunk.                                                                                                                                                                          |
| not started | `image-publish`      | CI builds, tests, and pushes by digest through a GitHub OIDC role scoped to this one repository. `AGENTS.md` §10 requires production to promote that exact CI build. After `first-running-task` and before any production apply. |

`kms-mrk-replica` stays last. The snapshot's next chunk is `first-running-task`.
