# Runbook: apply staging-au

The human applies. An agent does not. Production is not applied from this runbook.

Any rebase onto origin/main happens before the first apply. After that apply there is no rebase, no amend, and no force-push. main is brought in with a merge commit. The pull request is merged with a merge commit, never squashed. The pull request body says this departs from AGENTS.md section 5, because a rebase would replace the SHAs recorded below.

## Human prerequisites

1. Every apply uses the ch-admin profile, an IAM Identity Center administrator, never the root user.
2. communityhub-staging.net is registered and its hosted zone exists. The zone id lives only in the gitignored tfvars file. Do not commit it.
3. Choose the alarm email. It goes in the same gitignored file. This runbook does not record it.
4. infra/bootstrap is already applied. The state bucket and lock exist, and state is migrated to S3. Do not run the Bootstrap section again. A re-run fails with BucketAlreadyExists.

## Local tfvars

Create infra/regions/au/env/staging.local.tfvars. It is gitignored. It holds aws_account_id, staging_zone_id, and alert_email. Pass it after env/staging.tfvars so it wins. The committed staging file keeps the synthetic account id 123456789012.

## Before each apply

1. git status is clean.
2. git rev-parse HEAD equals the SHA named for that apply, and that SHA is on origin.
3. terraform init uses -lockfile=readonly.

## Bootstrap

This is a one-time step and it is already complete.

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

- ea4d796693969b5a84ec026237e95a0f5acc79b4: partial. Metric filter failed (log group not yet created) and the auth and webhooks custom domains failed (certificate not yet ISSUED); the following plan showed 12 add, 3 change, 1 destroy, including a Cloud Map replacement and a parameter-group diff. Fixed on main by PR #28 and merged into this branch.
- 63bbf7c2891c898ce25f7d1bbee2dee3c95b20ff: completing apply. Apply complete: 13 added, 0 changed, 2 destroyed (Cloud Map service replaced to set failure_threshold 1; SNS subscription replaced because the placeholder address was corrected).

### Evidence

Evidence (against 63bbf7c, 2026-10-06 UTC)

1. SNS email subscription: confirmed. A second subscription from the replaced placeholder address remains PendingConfirmation; AWS cannot delete a pending subscription and removes it automatically.
2. Custom domain with no Cloud Map instances, 17:58:10Z: GET https://au.api.communityhub-staging.net/health returned HTTP 500. Access log: integrationStatus 500, integrationErrorMessage "No target endpoints found for integration arn:aws:servicediscovery:ap-southeast-2:<account>:service/<service-id>", routeKey $default.
3. Security-group rules, live, compared with declared, exact match:
   - ch-staging-rds inbound tcp 5432 from ch-staging-task
   - ch-staging-task egress tcp 443 to 0.0.0.0/0
   - ch-staging-task egress tcp 5432 to ch-staging-rds
   - ch-staging-vpc-link egress tcp 8080 to ch-staging-task
   - No other inbound or egress rules on the three groups.
4. Throttle, curl 8.7.1 via xargs, no body, no query string, no personal data.
   - Run A, 18:01:17Z to 18:01:21Z: 300 x GET / -> 3 x 429, 297 x 500; then 300 x POST / -> 196 x 429, 104 x 500. Shows write routes are throttled harder than the default route.
   - Run B, 18:49:13Z to 18:49:16Z: 600 x GET / (300 concurrent) -> 242 x 429, 358 x 500; immediately 10 x POST / -> 10 x 500.
   - Conclusion: the stage default route and the write routes do not share one bucket; each route has its own. Run A alone could not decide this, because the write route's own lower limit produces 429s either way.
5. Database: availability zone ap-southeast-2b; StorageEncrypted true; KmsKeyId matches the storage key (ARN not recorded); PubliclyAccessible false; BackupRetentionPeriod 0; master password managed by RDS. rds.force_ssl = 1 (source system, the PostgreSQL 17 default, equal to the declared value); parameter group ch-staging-postgres in-sync.
6. terraform plan after the completing apply: "No changes", exit code 0.

Notes for first-running-task:

- An empty or unhealthy Cloud Map returns 500, not 503; 5xx counts during rolling deploys will include these.
- Throttle buckets are per route.

## Park

Commit enable_database = false and enable_budgets = true in infra/regions/au/env/staging.tfvars first. That commit is the park SHA. Run the before-each-apply checks against it. Then, from infra/regions/au:

    terraform init -backend-config=backend/staging.hcl -lockfile=readonly
    terraform apply -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars

Record that SHA. Then terraform plan shows no changes. The plan still contains the topic, the subscription, the hostname alarm, and the staging budget. Record that the budget exists and that its tag filter is user:environment$staging.

A stopped database is still not parking. A VPC link with no traffic for 60 days becomes `INACTIVE`.

Unpark happened in `first-running-task`, and staging is parked again. Do not unpark from this sentence. A later unpark uses the database ops task and needs a fresh image scan with no CRITICAL finding before any apply.

### Park apply

Commit: e16695548da171acd8135293db7365d391bc7698

### Park evidence

Apply complete: 1 added, 0 changed, 8 destroyed. The follow-up plan showed no changes, exit 0. The SNS topic, email subscription, hostname alarm, and budget remain. Budget ch-staging-cost, limit USD 50, filter user:environment$staging. Staging now costs about USD 6.30/month while parked.

## Change a database role

An operator runs the database ops task. A person does not open a master session. The database is on and `service_image` is set, because otherwise the task definition does not exist. The task uses the task security group, the staging public subnet, and a public address. The command is `["node", "/app/db-bootstrap.js"]`. Stdout is only the integer from `SHOW max_connections`. This procedure does not record a password, a connection string, or a secret ARN. There is no rotation function. The same task is how a later password change is applied.

## First running task

Both applies used `feat/2026-10-06-first-running-task` at `ba881554b5ca7d72d3faabbf9994f464df490f38`, profile ch-admin. `service_image` stayed in the gitignored file. The ops task ran `db-bootstrap.js`. A person did not open a master session.

### Image

run1, built from main `d4b22132d69ae02413d257b3bf3df1b6fa162a6f`, failed the scan gate and was never deployed. Findings: 5 CRITICAL, all Debian perl 5.36.0-7+deb12u3 from the pinned node:24-slim base, plus 15 HIGH, 6 MEDIUM, 3 LOW. PR #30 pinned `node:24-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20` and added a runtime `apt-get upgrade` (perl 5.36.0-7+deb12u4). Merged as main `3c77dd5e328779216b1bb1e3c4c2ea6724ce9bc4`.

run2, built from that main SHA, linux/arm64, `--provenance=false --sbom=false` (a single image manifest). `RUN_IMAGE_TESTS=1`: 2 passed. Digest `sha256:0d06f8418729f57423375e7650c77b7929e8aec59bbd89e1b179c1ee4757bd8c`. Scan COMPLETE: 0 CRITICAL, 8 HIGH, 2 MEDIUM, 3 LOW.

### Database apply

No image. 8 added, 0 changed, 0 destroyed (`module.rds[0]` only). Database available, PostgreSQL 17.9, storage encrypted true, publicly accessible false.

### Image apply

Same SHA, digest above, gitignored file only. 10 added, 0 changed, 0 destroyed: cluster, capacity providers, service task definition, service, ECR pull policy, task API ingress rule, ops task definition, ops execution role, ops task role, ops execution policy. Service stable, desired 1, running 1.

### Ops task

VPC link `ch-staging-link` was AVAILABLE. Family `ch-staging-db-ops`, command `["node", "/app/db-bootstrap.js"]`, task security group, staging public subnet, public address, command override only. Exit 0. The essential container exited. Stdout was exactly `79`.

### Proofs

1. `GET https://au.api.communityhub-staging.net/health` returned 200. Cloud Map has one HEALTHY instance.
2. Live rules, exact. `ch-staging-task`: egress 443 to 0.0.0.0/0, egress 5432 to `ch-staging-rds`, ingress 8080 from `ch-staging-vpc-link` (the only new rule). `ch-staging-rds`: ingress 5432 from `ch-staging-task` only. `ch-staging-vpc-link`: egress 8080 to `ch-staging-task` only. No other rule.
3. `/tmp` write one-off, exit 0. The service stayed 1/1. ECS Exec stayed off.
4. Probe one-off, stdout `pass`, stderr empty, exit 0. The task's own log stream carries both stdout and stderr and held exactly one line, `pass`. Database and KMS round trip, endpoint off.
5. `SHOW max_connections` is 79, the ops stdout above.
6. Forced rolling deploy of the same task definition. 113 requests to `/health` from before `update-service` until `services-stable`: 113 times 200, 0 times 5xx.
7. 60 requests over 60 seconds: 60 times 200, 0 times 5xx. `keepAliveTimeout` 65000 and `requestTimeout` 30000 were left unchanged.
8. A one-off with the task security group and the VPC link security group fetched the service task on port 8080 without `x-community-hub-hostname`. It printed 404 and exited 0. Service log: `{"method":"GET","path":"/health","status":404,"reason":"missing_hostname_header"}`. Alarm `ch-staging-missing-hostname-header` went from OK to ALARM.

### Operator notes

- `staging.local.tfvars` is gitignored and is removed with the apply worktree. It was rebuilt from AWS (account from sts, zone from Route 53, alert email from the confirmed SNS subscription), never typed or printed.
- Build the image with `--provenance=false --sbom=false` so the tag is a single scannable manifest. An attestation index is not scanned by ECR.
- `describe-images` may show no scan status right after push while the scan-on-push result exists. Read `describe-image-scan-findings`.
- In zsh write `${VAR}:text`, not `$VAR:text`. zsh treats `:t` and `:r` as modifiers.
- One transient DNS failure and one expired SSO session interrupted plans. Both were retried with no change.

## KMS endpoint proof

Same SHA `ba881554b5ca7d72d3faabbf9994f464df490f38`, applied with `-var enable_kms_endpoint=true`. That apply created the KMS interface endpoint and its security group, and updated the envelope key policy in place. While the endpoint exists, the module adds an `aws:SourceVpce` condition to the task-role `GenerateDataKey` and `Decrypt` statements. The probe printed `pass`, stderr empty, and exited 0. The task's own log stream carries both stdout and stderr and held exactly one line, `pass`. CloudTrail `GenerateDataKey` at 2026-10-07T01:38:00Z had `vpcEndpointId` present. Earlier events, from before the endpoint, had it absent. The id is not recorded.

The following apply used `-var enable_kms_endpoint=false`. The endpoint and its security group were destroyed, and the key-policy condition was removed. A plan with the committed values then showed no changes, detailed exit code 0. KMS endpoints remaining: 0. The committed tfvars never set `enable_kms_endpoint`.

## Re-park

Proof 10. SHA `e441c8bfbfded2d6308a42c3aef4ce4ee7fc1406`. `service_image` was removed from the gitignored file before the apply. It was not committed.

The plan listed exactly 18 resources, all destroyed, nothing created, updated, or replaced. Ten came from the image apply: the ECS cluster, capacity providers, the service, the service task definition, the ECR pull policy, the task API ingress rule, the ops task definition, the ops execution role, the ops task role, and the ops execution policy. Eight were under `module.rds[0]`: the instance, the parameter group, the subnet group, four alarms, and the prod-protection guard. The apply completed.

The following plan, with the committed values, showed no changes, detailed exit code 0. That plan refreshes against AWS. The re-park plan destroyed only the 18 resources listed above, so the email subscription and the `ch-staging-missing-hostname-header` alarm were not among them, and the empty following plan confirms both still exist. They were not queried individually. Live checks: RDS instances 0; ECS services in `ch-staging` 0; the `ch-staging-alarms` topic still exists; budget `ch-staging-cost` still exists; KMS endpoints 0. The lasting cost is the parked month, about USD 6.30.

## Image publish role

SHA `c9a7106fe54f4b2119359e79b0097074d0ed5d13`. Profile ch-admin. The apply added 4 resources, changed 0, and destroyed 0: `aws_iam_openid_connect_provider.github`, `aws_iam_role.image_publish`, `aws_iam_role_policy.image_publish`, and `terraform_data.github_ids`. The spec and the plan counted three and did not count the guard. `terraform_data.github_ids` is state-only and makes no AWS call. The following plan showed no changes. Both GitHub Actions secrets are set. Their values are not recorded here. The reviewer read the applied trust policy, the role policy, and the provider back from AWS and they match the spec.

This chunk does not set `service_image`. A later `service_image` is the digest from the publish job summary, not a laptop push.

A rollback that removes the guard destroys four: the provider, the role, the policy, and `terraform_data.github_ids`. If that plan shows anything else, answer no and stop.

## Melbourne key replica

SHA `341cdc056f7684a08f6ef9b6750145808e11c2cd`. Profile ch-admin. The first apply succeeded with no retry: 2 added, 1 changed, 0 destroyed.

- `module.envelope.aws_kms_replica_key.envelope` was added.
- `module.envelope.aws_kms_alias.envelope_replica` was added.
- `module.envelope.aws_kms_key.envelope` changed in place, the policy only. The key was not replaced.

`module.envelope.terraform_data.envelope_key_policy` was not in the change set. The following plan showed no changes.

The reviewer ran a read-only plan against staging before the apply. It showed the same three addresses. After the apply the reviewer read both keys back from AWS. The replica's Region is `ap-southeast-4` and it is a replica of the envelope key. Its policy is the Admin statement only. The primary has six statements. `ReplicateToMelbourne` allows `kms:ReplicateKey` only into `ap-southeast-4`.

A rollback that removes the two replica resources destroys only those two. The primary stays. The sixth statement stays until a separate policy change.

The production apply runbook, which this chunk does not write, enables `ap-southeast-4` in the production account before the first production apply.

## Restore drill

Quarterly, and only against staging. Restore the staging database to a new instance from point-in-time recovery. Record the time taken against the 4-hour target. Then delete the restored instance, because it bills by the hour. This drill does not restore production. Reading `SHOW max_connections` belongs to `first-running-task`, not to this drill.
