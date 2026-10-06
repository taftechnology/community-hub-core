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

Unpark is `first-running-task`: recreate the database, the ALTER ROLE procedure, and wait until the VPC link is AVAILABLE. This runbook does not unpark.

### Park apply

Commit: (filled by Task 5)

### Park evidence

(filled by Task 6)

## Change a database role

When a role's password changes, an operator runs `ALTER ROLE` for that role. The password comes from the secret's current version. This procedure does not record the password, the secret ARN, or a connection string. The master user is used only for bootstrap and for `ALTER ROLE`. There is no rotation function.

## Restore drill

Quarterly, and only against staging. Restore the staging database to a new instance from point-in-time recovery. Record the time taken against the 4-hour target. Then delete the restored instance, because it bills by the hour. This drill does not restore production. Reading `SHOW max_connections` belongs to `first-running-task`, not to this drill.
