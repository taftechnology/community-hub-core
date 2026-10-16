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

Unpark happened in `first-running-task` and again in `staging-proof-run`. Staging is parked again. Do not unpark from this sentence. A later unpark follows **Staging proof run** below (pre-checks, apply 1, apply 2, proofs, then re-park) and needs a fresh image scan with no CRITICAL finding before any apply.

### Park apply

Commit: e16695548da171acd8135293db7365d391bc7698

### Park evidence

Apply complete: 1 added, 0 changed, 8 destroyed. The follow-up plan showed no changes, exit 0. The SNS topic, email subscription, hostname alarm, and budget remain. Budget ch-staging-cost, limit USD 50, filter user:environment$staging. Staging now costs about USD 6.30/month while parked.

## Change a database role

An operator runs the database ops task. A person does not open a master session. The database is on and `service_image` is set, because otherwise the task definition does not exist. The task uses the task security group, the staging public subnet, and a public address. The command is `["node", "/app/db-bootstrap.js"]`. Stdout is only the integer from `SHOW max_connections`. This procedure does not record a password, a connection string, or a secret ARN. There is no rotation function. The same task is how a later password change is applied.

## Apply product migrations

The database accepts connections only from the task security group, so a person cannot run the migrations from a laptop. The command is `/app/db-migrate.js` in the service image. It runs as a one-off ops task, as `db-bootstrap.js` does. A human runs it. An agent does not. This section adds no bastion, no public database, no NAT gateway, and no ECS Exec.

### Prerequisites

- Staging is unparked in a chunk whose approved spec says so.
- The `db-bootstrap` one-off has exited 0 on this database. The command refuses to run before that and prints `not_bootstrapped`.
- The image is the digest from the `publish` job summary, built from the `main` that contains this command. The ops task definition points at that image.

### Run

Run the existing ops task definition with a command override. `entryPoint` is not set. Use the task security group, the staging public subnet, and a public address. The override sets only `command`. In zsh write `${VAR}:text`, not `$VAR:text`.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${OPS_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"db-ops","command":["node","/app/db-migrate.js"]}]}' \
      --query 'tasks[0].taskArn' --output text)
    aws ecs wait tasks-stopped --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN}
    aws ecs describe-tasks --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN} \
      --query 'tasks[0].[containers[0].exitCode,stoppedReason]' --output text
    LOG_STREAM="db-ops/db-ops/${TASK_ARN##*/}"
    aws logs get-log-events --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} \
      --log-stream-name ${LOG_STREAM} --query 'events[].message' --output text | tr '\t' '\n'

The describe step prints the exit code and the stopped reason on one line, separated by a tab. `${LOG_GROUP}` is the service log group. The stream name is the `awslogs-stream-prefix` (`db-ops`), the container name (`db-ops`) and the task id, which is the last path segment of the task ARN. Both names come from the `db_ops` task definition. `get-log-events` with `--output text` prints the messages joined by tabs on one line, and `tr` puts one message on each line. The task writes only the lines below. It never writes a host, a port, a database name, a user, a password, SQL text, or a driver message.

### Results

| Exit | Stdout                                                           | Stderr               | Meaning and what to do                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ---------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `applied <tag>` per migration, then `done applied=<n> total=<m>` | empty                | Those migrations are now applied.                                                                                                                                                                                                                                                                                                                                                                                      |
| 0    | `done applied=0 total=<m>`                                       | empty                | Nothing to apply. The database already has every migration in this image.                                                                                                                                                                                                                                                                                                                                              |
| 1    | empty                                                            | `env`                | An environment variable is missing or malformed, or the image's CA bundle could not be read. Check the ops task definition.                                                                                                                                                                                                                                                                                            |
| 1    | empty                                                            | `connect`            | The master connection failed with no database error: a network, DNS or TLS problem. Check the task security group and the subnet.                                                                                                                                                                                                                                                                                      |
| 1    | empty                                                            | `connect 28P01`      | The master password was refused.                                                                                                                                                                                                                                                                                                                                                                                       |
| 1    | empty                                                            | `connect <SQLSTATE>` | The master connection or a role login failed with that database error code.                                                                                                                                                                                                                                                                                                                                            |
| 1    | empty                                                            | `not_bootstrapped`   | A role is missing, or a role login was refused. A wrong role password gives the same word. Run `db-bootstrap`, then run this again.                                                                                                                                                                                                                                                                                    |
| 1    | empty                                                            | `migrate <SQLSTATE>` | A migration or the runner's own SQL failed with that database error code. Nothing from this run is applied.                                                                                                                                                                                                                                                                                                            |
| 1    | empty                                                            | `migrate`            | One of the runner's own checks failed: a changed migration file, a journal entry older than an applied one, a lost session, or a connection dropped mid-run. There is no code and no message. For a check, the image is older or different from the database. Run it again if the connection dropped.                                                                                                                  |
| none | no log stream                                                    | none                 | The task never started. The exit code prints `None` and the stopped reason names the cause, for example an image pull or a secret injection failure. No command ran and nothing was applied. Fix the cause the reason names (the image reference, access to the registry, or access to a secret), then run the command again. The stopped reason can name a registry or a secret, so do not copy it into the evidence. |

A failed run applies nothing from that run. The pending set is one transaction. Migrations committed by an earlier run stay. The failing migration is not named. The code is the only evidence of which statement failed. Fix the cause and run the command again.

### Waiting

A second run waits for the first to release the migration lock, with no bound. If the first task hangs, stop it. Stopping it closes its connection and releases the lock. If the stopped task was itself waiting for the lock, its server session can linger until it reaches the front of the queue, because Postgres does not notice a dead client while the backend waits on a lock. A re-run is safe.

### Re-park

If the cause cannot be fixed inside the unpark window, re-park. That destroys a staging database that holds no data. There is no down-migration and none is added.

### Evidence

The journal table records each file's `when` value, not the time it ran. The ECS task's stop time and the log stream are the record of a run. Copy the exit code and the lines into the evidence of the chunk that ran it.

## Provision the first owner

The organisation slug, the community slug, and the owner email reach the task only inside a short-lived Secrets Manager secret under the one fixed name `${PROVISION_SECRET_NAME}`. The task reads it once, by ARN, passed as the `PROVISION_SECRET_ARN` environment override. A human runs every step. An agent does not. This runs as a one-off override of the service task definition, not the `db_ops` task definition; it adds no HTTP route and no change to the `db_ops` task role. This section is written and reviewed in this chunk; its first live execution on `staging-au` is deferred to the email chunk's own staging run, the same way **Apply product migrations** shipped its command before a later chunk exercised it (spec Definition of done).

Shell variables and placeholders only, as in the rest of this file: never paste an account id, an ARN, a hostname, the resolved secret name, or the email into the file or the evidence. The slug and email values are prompted for at run time so they never land in shell history as typed command text. In zsh write `${VAR}:text`, not `$VAR:text`.

### Prerequisites

- The Terraform change for this chunk (the `ReadProvisionSecret` IAM statement and the secrets-key key-policy pattern) is applied. This can happen while staging stays parked.
- A live run of this section happens only as part of the email chunk's own staging proof run, after `db-bootstrap` and `db-migrate` have both already exited 0 on that database. This command assumes a working service, a working database, and the product schema already exist; it is not a bootstrap step itself.
- This chunk (`first-owner`) does not unpark staging itself.
- Only one run of this section happens at a time. The design uses one fixed secret name, reusable only because **Delete and verify** destroys it every run; two concurrent runs would race on that one name.

### Create

The operator is prompted for each value, so none is typed as a command-line argument or left in shell history. The three values are assembled into JSON with `jq` and piped straight into `create-secret`; nothing is echoed, printed, or left in a variable that is later printed. The create output is discarded. End by unsetting the three prompted variables.

This secret is never Terraform-managed, and **Delete and verify** below fully destroys it with `--force-delete-without-recovery`, so by the time this step runs again the secret genuinely does not exist. `put-secret-value` only writes a new version to an _already-existing_ secret and would fail with `ResourceNotFoundException`; `create-secret` is the correct call every time this step runs. (Proof 7b's rotation uses `put-secret-value` because that secret is Terraform-managed and already exists — a different situation, not a precedent for this one.)

`create-secret` must name the customer-managed secrets key with `--kms-key-id ${SECRETS_KEY_ARN}`. Without it the secret is encrypted under the account's AWS-managed key, and the task 5 key-policy grant — which covers only this one secret name on the customer-managed key — would cover nothing. Hold `${SECRETS_KEY_ARN}` from a read-only describe or Terraform output, the same source proof 7a uses; it is never recorded.

Type the prompt and the commands that use the variable directly into one terminal; do not use an editor's Run button while a prompt is waiting, because the button's command text becomes the answer.

    read -r "ORG_SLUG?Organisation slug: "

    read -r "COMMUNITY_SLUG?Community slug: "

    read -rs "OWNER_EMAIL?Owner email: "

    print

    jq -n --arg o "${ORG_SLUG}" --arg c "${COMMUNITY_SLUG}" --arg e "${OWNER_EMAIL}" \
      '{organisationSlug: $o, communitySlug: $c, email: $e}' \
      | aws secretsmanager create-secret --profile ${AWS_PROFILE} \
        --name ${PROVISION_SECRET_NAME} --kms-key-id ${SECRETS_KEY_ARN} \
        --secret-string file:///dev/stdin >/dev/null

    unset ORG_SLUG COMMUNITY_SLUG OWNER_EMAIL

`${PROVISION_SECRET_NAME}` is the one fixed name the task 5 Terraform grants on (`${name}-provision-owner`); its resolved value is never written here. The secret value carries the email, so it is `confidential`; it is deleted in **Delete and verify** immediately after the run.

### Run

Hold `${PROVISION_SECRET_ARN}` from a read-only describe of the secret, the same way the proof run holds `${IDENTITY_SECRET_ARN}` and the other ARNs. It is never recorded.

    PROVISION_SECRET_ARN=$(aws secretsmanager describe-secret --profile ${AWS_PROFILE} \
      --secret-id ${PROVISION_SECRET_NAME} --query 'ARN' --output text)

Run the service task definition as a one-off, same network pattern as **Apply product migrations** (task security group, staging public subnet, public address). `entryPoint` is not set. The override sets `command` to `["node","/app/provision-owner.js"]` and one environment entry, `PROVISION_SECRET_ARN`, to the ARN held above — the only input the script reads.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${SERVICE_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides "{\"containerOverrides\":[{\"name\":\"service\",\"command\":[\"node\",\"/app/provision-owner.js\"],\"environment\":[{\"name\":\"PROVISION_SECRET_ARN\",\"value\":\"${PROVISION_SECRET_ARN}\"}]}]}" \
      --query 'tasks[0].taskArn' --output text)

Then, as after every service-container one-off in this file, wait for it to stop, read the exit code and stopped reason, and read the one log stream. The container name and the `awslogs-stream-prefix` are both `service`, so the stream is `service/service/` followed by the task id.

    aws ecs wait tasks-stopped --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN}

    aws ecs describe-tasks --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN} --query 'tasks[0].[containers[0].exitCode,stoppedReason]' --output text

    aws logs get-log-events --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} --log-stream-name "service/service/${TASK_ARN##*/}" --query 'events[].message' --output text | tr '\t' '\n'

The describe step prints the exit code and the stopped reason on one line, separated by a tab. The task writes only the one line in **Results**. It never writes the slugs, the email, the resolved ids, the secret value, a host, a port, SQL text, or a driver message. Read the stopped reason; do not paste it when it can name a registry or a secret.

### Results

**Create** always runs before **Run**, so by the time any outcome below is read the secret already exists — on success, on any failure word, and even when the task never started. Every row therefore ends at **Delete and verify**.

| Exit | Stdout                 | Stderr               | Meaning and what to do                                                                                                                                                                                                                                                                                                                                      |
| ---- | ---------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | `created`              | empty                | No owner existed. The organisation and community were created if both were absent; the identity user was created if it did not already exist; the owner grants were created. Go to **Delete and verify**.                                                                                                                                                   |
| 0    | `already_bootstrapped` | empty                | An owner already existed for this organisation/community and it is the same user as the named email. Nothing was created or changed. Go to **Delete and verify**.                                                                                                                                                                                           |
| 1    | empty                  | `env`                | `PROVISION_SECRET_ARN` is missing, malformed, or does not name the one fixed secret. Check the environment override and the secret name. Nothing was created. Go to **Delete and verify**.                                                                                                                                                                  |
| 1    | empty                  | `secret`             | The secret could not be read, or its JSON is missing `organisationSlug`, `communitySlug`, or `email`. Delete and verify, then Create again. Nothing was created.                                                                                                                                                                                            |
| 1    | empty                  | `organisation`       | The slug pair is inconsistent: one of the two exists without the other, or the community belongs to a different organisation than the one named. Fix the slugs and run again. Nothing was created. Go to **Delete and verify**.                                                                                                                             |
| 1    | empty                  | `owner`              | An owner already exists and it is not the user for the named email. Nothing was created — in particular no new identity user. Do not retry with another email; this command never reassigns, demotes, or adds owners. Go to **Delete and verify**.                                                                                                          |
| 1    | empty                  | `kms`                | The envelope-key `GenerateDataKey` or `Decrypt` call failed. Check the envelope-key grant, then run again. Go to **Delete and verify**.                                                                                                                                                                                                                     |
| 1    | empty                  | `connect`            | The database connection failed with no database error: a network, DNS, or TLS problem. Check the task security group and the subnet. Go to **Delete and verify**.                                                                                                                                                                                           |
| 1    | empty                  | `connect <SQLSTATE>` | The database connection failed with that database error code. Nothing was created. Go to **Delete and verify**.                                                                                                                                                                                                                                             |
| 1    | empty                  | `fail`               | Anything else. The code is the only evidence; there is no message. The organisation and community may already exist if this run got that far; re-run with the same slugs, as the resolve-or-create step is idempotent. Go to **Delete and verify**.                                                                                                         |
| none | no log stream          | none                 | The task never started. The exit code prints `None` and the stopped reason names the cause (an image pull or a secret injection failure). No command ran and nothing was provisioned. Fix the cause the reason names, then run again. Go to **Delete and verify**. The stopped reason can name a registry or a secret, so do not copy it into the evidence. |

### Delete and verify

Delete the secret immediately after the run, without a recovery window, so the one fixed name is free for the next run. Then confirm it is gone.

    aws secretsmanager delete-secret --profile ${AWS_PROFILE} \
      --secret-id ${PROVISION_SECRET_NAME} --force-delete-without-recovery

    aws secretsmanager describe-secret --profile ${AWS_PROFILE} \
      --secret-id ${PROVISION_SECRET_NAME}

The `describe-secret` call is expected to fail with a not-found error — that failure is the confirmation the secret is gone, so this is the one step in this file whose "success" is an AWS error, not a clean result. Record that it failed as expected; do not record the error body. Then `unset PROVISION_SECRET_ARN`.

## SES sign-in proof

This section is the operator path for `docs/specs/2026-10-14-email-provider.md`. **Apply 0 ran on that chunk and is recorded under Evidence below. The live part (Apply 1, one-offs, proofs P1–P5, and the re-park) runs in the follow-up chunk `ses-sign-in-proof`**, after `email-provider` merges and `main` publishes an image that contains the merge commit.

The human owner runs every apply, recipient verification, and ECS run-task. The owner's assistant is read-only: it describes resources, queries CloudWatch Logs, and calls the staging hostnames over HTTP. An agent does not apply. Stop after any failed proof, or after a second failure on the same step (AGENTS.md section 12). Then re-park before further attempts. The 48-hour hard stop is measured from apply 1 completion; the owner runs the re-park at that hard stop even if proofs remain.

Shell variables and placeholders only. Never paste an account id, ARN, hostname, email address, OTP code, registry host, secret name, or key id into evidence. Say "the api hostname", "the auth hostname", and "the sender address". Values that come from AWS at run time are held in shell variables and never recorded. In zsh write `${VAR}:text`, not `$VAR:text`. Do not put an inline `#` comment inside a command string. One pasteable command per indented block. Evidence rules: counts, statuses, and lengths only.

General rules:

- A Spot interruption is not a failure. Wait for the replacement task and rerun that step once. A rerun of P1 counts toward its cap.
- Stream-scoped `get-log-events` calls for one-offs are exempt from `--start-time`, because each stream is unique to its task. Every `filter-log-events` call carries `--start-time`.

### Prerequisites (before Apply 1)

Apply 1 needs a service image published from a `main` commit that contains the `email-provider` merge (`81f4960` or a later `main` commit that contains it; so the image includes `apps/api/src/mail/ses-otp-mail.ts` and the mail wiring). The newest image from before that merge does not contain this chunk's code; an unpark against it would run a service that ignores the mail settings.

Hold `${DEPLOY_SHA}` as that `main` commit (`81f4960` or later). Confirm the image with the same pre-check commands under **Staging proof run → Pre-checks** below: the `publish` job conclusion for that commit, then the image digest and scan for tag `${DEPLOY_SHA}` (repository `ch-staging/service`). Record conclusion, digest, and CRITICAL count only — never a registry host. **Stop if** publish failed, the scan is not `COMPLETE`, or `CRITICAL` is above 0.

Read-only pre-checks (before Apply 1; any failure is a stop before spend):

Pre-check 1. Confirm the SES domain identity and DKIM status show `SUCCESS`:

    aws sesv2 get-email-identity --profile ${AWS_PROFILE} --email-identity "mail.${ZONE_NAME}" --query 'DkimAttributes.Status' --output text

Expected: `SUCCESS`.

Pre-check 2. Confirm SES account production access is off:

    aws sesv2 get-account --profile ${AWS_PROFILE} --region ap-southeast-2 --query 'ProductionAccessEnabled' --output text

Expected: `False`. Stop if `True`.

Pre-check 3. Confirm the owner address is verified. The owner checks, in his own shell at a silent prompt, that the lowercase owner address shows `VerificationStatus` `SUCCESS`, then unsets it. Record the status only:

    read -rs "OWNER_EMAIL?Lowercase owner email: "

    print

    aws sesv2 get-email-identity --profile ${AWS_PROFILE} --email-identity "${OWNER_EMAIL}" --query 'VerificationStatus' --output text

    unset OWNER_EMAIL

Expected: `SUCCESS`.

### Shell variables

Hold these in the shell. Never record their values.

| Variable                     | Meaning                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `${AWS_PROFILE}`             | Apply and one-off profile (default `ch-admin`)                                                   |
| `${ZONE_NAME}`               | Apex hosted zone name from `staging_zone_id` (`communityhub-staging.net`)                        |
| `${AUTH_HOST}`               | Auth hostname (`auth.au.${ZONE_NAME}`)                                                           |
| `${API_HOST}`                | Tenant API hostname (`au.api.${ZONE_NAME}`)                                                      |
| `${DB_INSTANCE_ID}`          | RDS database instance identifier (`ch-staging-postgres`)                                         |
| `${CLUSTER}`                 | ECS cluster name for staging (`ch-staging`)                                                      |
| `${SERVICE}`                 | ECS service name for staging (`ch-staging`)                                                      |
| `${SERVICE_TASK_DEFINITION}` | Service task definition family (`ch-staging`)                                                    |
| `${OPS_TASK_DEFINITION}`     | Ops task definition family (`ch-staging-db-ops`)                                                 |
| `${SUBNET}`                  | Staging public subnet id (from Terraform / describe; never recorded)                             |
| `${TASK_SECURITY_GROUP}`     | Task security group id (from Terraform / describe; never recorded)                               |
| `${LOG_GROUP}`               | Service log group `/community-hub/ch-staging/service` (streams use prefixes `service`, `db-ops`) |
| `${API_ACCESS_LOG_GROUP}`    | API access log group `/community-hub/ch-staging/api-access`                                      |
| `${PLAN_FILE}`               | Saved plan file path outside the repository (never committed; deleted after apply)               |
| `${WINDOW_START_MS}`         | Proof window start in epoch milliseconds (set before P1; never recorded)                         |
| `${WINDOW_END_MS}`           | Proof window end in epoch milliseconds (set in P5; never recorded)                               |

### Apply 0 — SES identity and policy (parked)

Apply 0 runs while staging is parked (`enable_database = false`, `desired_count = 0`, `service_image = null`). The plan creates the SES domain identity, Easy DKIM records, custom MAIL FROM attributes and DNS records, DMARC TXT record, configuration set, and the task-role send policy.

Run before-each-apply checks against the SHA named for that apply on origin.

Initialize Terraform with the staging backend:

    terraform init -backend-config=backend/staging.hcl -lockfile=readonly

Plan to the saved file outside the repository:

    terraform plan -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars -out=${PLAN_FILE} -input=false | grep --line-buffered '^Plan:'

Expected plan summary: exactly 10 to add, 0 to change, 0 to destroy. List addresses and actions from the plan file:

    terraform show -json ${PLAN_FILE} | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | "\(.change.actions | join(" ")) \(.address)"'

Expected addresses:

- `aws_sesv2_email_identity.mail[0]` (create)
- `aws_sesv2_email_identity_mail_from_attributes.mail[0]` (create)
- `aws_sesv2_configuration_set.mail[0]` (create)
- `aws_route53_record.ses_dkim[0]` (create)
- `aws_route53_record.ses_dkim[1]` (create)
- `aws_route53_record.ses_dkim[2]` (create)
- `aws_route53_record.ses_mail_from_mx[0]` (create)
- `aws_route53_record.ses_mail_from_txt[0]` (create)
- `aws_route53_record.ses_dmarc_txt[0]` (create)
- `aws_iam_role_policy.ses_send[0]` (create)

Apply that file:

    terraform apply -input=false ${PLAN_FILE} | grep --line-buffered -E ': (Creating|Still creating|Creation complete|Modifying|Still modifying|Modification complete|Destroying|Still destroying|Destruction complete)|Apply complete' | sed -l -E 's/ \[id=[^]]+\]//'

Delete the plan file:

    rm -f ${PLAN_FILE}

### Sandbox recipient verification and DKIM

While in the SES sandbox, SES delivers only to verified recipient addresses. The owner verifies the recipient address(es) used for the live proof. The address is held in a shell variable and never written down.

Prompt for the sandbox recipient address. Type the prompt and the commands that use the variable directly into one terminal; do not use an editor's Run button while a prompt is waiting, because the button's command text becomes the answer:

    read -rs "RECIPIENT_EMAIL?Sandbox recipient email: "

    print

Request verification for that email identity:

    aws sesv2 create-email-identity --profile ${AWS_PROFILE} --email-identity "${RECIPIENT_EMAIL}"

Open the verification email sent to that inbox by Amazon SES and click the confirmation link.

Confirm verification status shows `SUCCESS`:

    aws sesv2 get-email-identity --profile ${AWS_PROFILE} --email-identity "${RECIPIENT_EMAIL}" --query 'VerificationStatus' --output text

Unset the recipient address variable:

    unset RECIPIENT_EMAIL

Wait for the domain Easy DKIM to show verified:

    aws sesv2 get-email-identity --profile ${AWS_PROFILE} --email-identity "mail.${ZONE_NAME}" --query 'DkimAttributes.Status' --output text

Expected: `SUCCESS`. Repeat until `SUCCESS` before proceeding to Apply 1.

### Apply 1 — Unpark and cost clock

The branch moves to the unpark commit (`enable_database = true`, `desired_count = 1` in `infra/regions/au/env/staging.tfvars`). The owner sets `service_image` in the gitignored `infra/regions/au/env/staging.local.tfvars`.

Run before-each-apply checks against the SHA named for that apply on origin.

Plan to the saved file outside the repository:

    terraform plan -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars -out=${PLAN_FILE} -input=false | grep --line-buffered '^Plan:'

Expected plan summary: exactly 18 to add, 0 to change, 0 to destroy. List addresses and actions:

    terraform show -json ${PLAN_FILE} | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | "\(.change.actions | join(" ")) \(.address)"'

Expected addresses:

- `module.rds[0].aws_cloudwatch_metric_alarm.cpu_credit_balance` (create)
- `module.rds[0].aws_cloudwatch_metric_alarm.database_connections` (create)
- `module.rds[0].aws_cloudwatch_metric_alarm.free_storage_space` (create)
- `module.rds[0].aws_cloudwatch_metric_alarm.freeable_memory` (create)
- `module.rds[0].aws_db_instance.this` (create)
- `module.rds[0].aws_db_parameter_group.this` (create)
- `module.rds[0].aws_db_subnet_group.this` (create)
- `module.rds[0].terraform_data.prod_protection` (create)
- `aws_ecs_task_definition.db_ops[0]` (create)
- `aws_iam_role.db_ops_execution[0]` (create)
- `aws_iam_role.db_ops_task[0]` (create)
- `aws_iam_role_policy.db_ops_execution[0]` (create)
- `module.ingress.aws_ecs_cluster.this[0]` (create)
- `module.ingress.aws_ecs_cluster_capacity_providers.this[0]` (create)
- `module.ingress.aws_ecs_service.this[0]` (create)
- `module.ingress.aws_ecs_task_definition.this[0]` (create)
- `module.ingress.aws_iam_role_policy.pull[0]` (create)
- `module.ingress.aws_vpc_security_group_ingress_rule.task_api[0]` (create)

Any other address is a stop before apply.

Apply that file:

    terraform apply -input=false ${PLAN_FILE} | grep --line-buffered -E ': (Creating|Still creating|Creation complete|Modifying|Still modifying|Modification complete|Destroying|Still destroying|Destruction complete)|Apply complete' | sed -l -E 's/ \[id=[^]]+\]//'

Record the UTC completion time under **Cost clock** below. The 24-hour target and 48-hour hard stop start at this instant. Rate: USD 0.0468 per hour.

Delete the plan file:

    rm -f ${PLAN_FILE}

Wait until the RDS instance is available:

    aws rds describe-db-instances --profile ${AWS_PROFILE} --db-instance-identifier ${DB_INSTANCE_ID} --query 'DBInstances[0].DBInstanceStatus' --output text

### One-offs

Run the one-off tasks in order on the freshly unparked database. These commands connect directly to RDS and require only the database instance to be available.

Run `db-bootstrap`:

    TASK_ARN=$(aws ecs run-task --profile ${AWS_PROFILE} --cluster ${CLUSTER} --task-definition ${OPS_TASK_DEFINITION} --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" --overrides '{"containerOverrides":[{"name":"db-ops","command":["node","/app/db-bootstrap.js"]}]}' --query 'tasks[0].taskArn' --output text)

Wait for `db-bootstrap` to stop and read the exit code:

    aws ecs wait tasks-stopped --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN}

    aws ecs describe-tasks --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN} --query 'tasks[0].[containers[0].exitCode,stoppedReason]' --output text

    aws logs get-log-events --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} --log-stream-name "db-ops/db-ops/${TASK_ARN##*/}" --query 'events[].message' --output text | tr '\t' '\n'

Expected: exit 0, stdout exactly one integer (`max_connections`), stderr empty.

Run `db-migrate`:

    TASK_ARN=$(aws ecs run-task --profile ${AWS_PROFILE} --cluster ${CLUSTER} --task-definition ${OPS_TASK_DEFINITION} --launch-type FARGATE --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" --overrides '{"containerOverrides":[{"name":"db-ops","command":["node","/app/db-migrate.js"]}]}' --query 'tasks[0].taskArn' --output text)

Wait for `db-migrate` to stop and read the exit code:

    aws ecs wait tasks-stopped --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN}

    aws ecs describe-tasks --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN} --query 'tasks[0].[containers[0].exitCode,stoppedReason]' --output text

    aws logs get-log-events --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} --log-stream-name "db-ops/db-ops/${TASK_ARN##*/}" --query 'events[].message' --output text | tr '\t' '\n'

Expected: exit 0, stdout ten `applied <tag>` lines for 0000–0009 in journal order, then `done applied=10 total=10`, with stderr empty.

Provision the first owner following the **Provision the first owner** procedure above (Create secret, Run one-off `provision-owner.js`, Delete and verify secret). Use the same lowercase verified address. Use synthetic slugs with a random suffix, for example `proof-` plus 8 hex characters, so that P5's substring counts cannot match a route name. The slugs are never recorded. (The provision procedure unsets `${COMMUNITY_SLUG}`; P2 prompts for it.)
Expected: exit 0, stdout `created`, stderr empty. (This proves P4).

### Running-task check (assistant, read-only)

Before starting HTTP proofs P1–P3, wait until the ECS service is stable. The service container launched during Apply 1 and its `/health` check does not touch the database, but the auth and session routes tested in P1–P3 require the service to be stable and running against the bootstrapped and migrated database:

    aws ecs wait services-stable --profile ${AWS_PROFILE} --cluster ${CLUSTER} --services ${SERVICE}

Check that the running task's image digest matches the pre-checked digest:

    SERVICE_TASK_ARN=$(aws ecs list-tasks --profile ${AWS_PROFILE} --cluster ${CLUSTER} --service-name ${SERVICE} --query 'taskArns[0]' --output text)

    aws ecs describe-tasks --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks "${SERVICE_TASK_ARN}" --query 'tasks[0].containers[0].imageDigest' --output text

Expected: equals the pre-checked digest.

Check the container environment variable names. Hold the active task definition ARN in a variable:

    TASK_DEF_ARN=$(aws ecs describe-services --profile ${AWS_PROFILE} --cluster ${CLUSTER} --services ${SERVICE} --query 'services[0].taskDefinition' --output text)

    aws ecs describe-task-definition --profile ${AWS_PROFILE} --task-definition "${TASK_DEF_ARN}" --query 'taskDefinition.containerDefinitions[?name==`service`].environment[].name' --output text

Expected: output lists both `MAIL_FROM_ADDRESS` and `SES_CONFIGURATION_SET` (names only; otherwise the service uses `rejectingOtpMail` and P1 cannot pass).

Never run an unqualified describe, because that prints values.

Unset helper variables:

    unset SERVICE_TASK_ARN TASK_DEF_ARN

### Proofs

Proofs P1–P5 verify transactional email delivery, authentication flow, error isolation, first-owner provisioning, and log hygiene.

#### P1: Start challenge for verified owner address

Before P1, set the proof window start timestamp in epoch milliseconds:

    WINDOW_START_MS=$(( $(date +%s) * 1000 ))

Prompt for the verified owner address in lowercase. Type the prompt and the commands that use the variable directly into one terminal; do not use an editor's Run button while a prompt is waiting, because the button's command text becomes the answer:

    read -rs "OWNER_EMAIL?Lowercase verified owner email: "

    print

Cap: at most 3 `start` calls for that address in this run.

Call the start endpoint:

    curl -s -S -o /dev/null -w '%{http_code}\n' -X POST "https://${AUTH_HOST}/v1/auth/email-otp/start" -H 'content-type: application/json' -d "{\"email\":\"${OWNER_EMAIL}\"}"

Expected: HTTP status `204`.

Check the recipient inbox:

- Exactly one email arrives from the configured sender address (`no-reply@mail.<zone>`).
- The email subject is "Your sign-in code" (the subject contains no code).
- The email body contains an eight-digit numeric code.

Guards:

Rule (a): if no mail arrives within 5 minutes, the assistant counts the `mail` lines by `outcome` since `${WINDOW_START_MS}`, before any further `start`. The owner prints `${WINDOW_START_MS}` (an epoch integer, not personal data) and gives it to the assistant, who sets `WINDOW_START_MS` in their own shell:

    read -r "WINDOW_START_MS?Window start (epoch ms): "

    aws logs filter-log-events --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} --start-time ${WINDOW_START_MS} --query 'events[].message' --output text | tr '\t' '\n' | jq -rR 'fromjson? | select(.message=="mail") | .outcome' | sort | uniq -c

Rule (b): a 204 with no new `mail` line is the five-an-hour limit (`modules/core/identity/infrastructure/email-otp.ts:63-71`): stop.

#### P2: Verify challenge with code and call session route

Verify within 10 minutes of the mail. A 401 or 403 is a stop. Do not retry with a guessed code.

Prompt for the eight-digit code from the received email. Type the prompt and the commands that use the variable directly into one terminal; do not use an editor's Run button while a prompt is waiting, because the button's command text becomes the answer:

    read -rs "OTP_CODE?One-time code: "

    print

Call the verify endpoint:

    TOKENS=$(curl -s -S -X POST "https://${AUTH_HOST}/v1/auth/email-otp/verify" -H 'content-type: application/json' -d "{\"email\":\"${OWNER_EMAIL}\",\"code\":\"${OTP_CODE}\"}")

Read the access token:

    ACCESS_TOKEN=$(print -r -- "${TOKENS}" | jq -r '.accessToken')

Prompt for the community slug from the first-owner provisioning:

    read -rs "COMMUNITY_SLUG?Community slug: "

    print

Call one route that requires a session:

    curl -s -S -o /dev/null -w '%{http_code}\n' -X POST "https://${API_HOST}/v1/access/grants/list" -H "authorization: Bearer ${ACCESS_TOKEN}" -H 'content-type: application/json' -d "{\"communitySlug\":\"${COMMUNITY_SLUG}\"}"

Expected: HTTP status `200`.

#### P3: Unverified recipient rejected

Set the unverified recipient address placeholder (spec S4):

    UNVERIFIED_EMAIL=proof-unverified@example.com

Call the start endpoint for the unverified address:

    curl -s -S -o /dev/null -w '%{http_code}\n' -X POST "https://${AUTH_HOST}/v1/auth/email-otp/start" -H 'content-type: application/json' -d "{\"email\":\"${UNVERIFIED_EMAIL}\"}"

Expected: HTTP status `503`.

Inspect the service's `mail` log event for that request:

    aws logs filter-log-events --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} --start-time ${WINDOW_START_MS} --filter-pattern '{ $.message = "mail" }' --query 'events[].message' --output text | tr '\t' '\n' | jq -rR 'fromjson? | select(.outcome=="failed") | {operation,outcome,errorClass}'

Expected: `operation` is `send_email`, `outcome` is `failed`, and `errorClass` is `MessageRejected` (SES recipient rejection in sandbox), NOT `AccessDeniedException` (IAM denial). Note that `outcome` can also be `timeout`, which is a stop.
Note on CloudTrail: According to AWS documentation ([Logging Amazon SES API calls using AWS CloudTrail](https://docs.aws.amazon.com/ses/latest/dg/logging-using-cloudtrail.html)), SES data-plane sending calls (`SendEmail`) are not recorded in CloudTrail by default. The service's structured `mail` log event is the primary evidence. If CloudTrail data events are active, CloudTrail may be checked as supplementary verification.

#### P4: First-owner execution

Proven by the one-off step: `node /app/provision-owner.js` exited 0 with stdout `created` and empty stderr.

#### P5: Log hygiene and privacy

The owner runs P5 in the same shell. Start with `setopt pipefail`, then set the proof window end timestamp:

    setopt pipefail

    WINDOW_END_MS=$(( $(date +%s) * 1000 ))

Pull each log group once into a shell variable, held in memory and never written to disk. Do not use `--filter-pattern`. Directly after each pull, `print $?` must print `0` (with `pipefail` set this is the status of the whole pipeline). Anything else is a stop:

    SERVICE_MSGS=$(aws logs filter-log-events --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} --start-time ${WINDOW_START_MS} --end-time ${WINDOW_END_MS} --query 'events[].message' --output text | tr '\t' '\n')

    print $?

    ACCESS_MSGS=$(aws logs filter-log-events --profile ${AWS_PROFILE} --log-group-name ${API_ACCESS_LOG_GROUP} --start-time ${WINDOW_START_MS} --end-time ${WINDOW_END_MS} --query 'events[].message' --output text | tr '\t' '\n')

    print $?

Expected: `0` for both pipeline exit statuses.

Mandatory positive controls (content counts, not `wc -l`):

    print -r -- "${SERVICE_MSGS}" | grep -c '"message":"mail"'

Expected: at least the number of `start` calls in this run (e.g. `>= 2`).

    print -r -- "${ACCESS_MSGS}" | grep -c '"routeKey"'

Expected: at least the number of P1–P3 requests in this run.

Either control below its minimum is a stop.

If `${ORG_SLUG}` or `${COMMUNITY_SLUG}` was unset by the provision procedure, prompt for them again at silent prompts:

    [[ -n "${ORG_SLUG}" ]] || read -rs "ORG_SLUG?Organisation slug: "

    print

    [[ -n "${COMMUNITY_SLUG}" ]] || read -rs "COMMUNITY_SLUG?Community slug: "

    print

Run privacy counts against service logs (one command per value; expected `0` each; record the printed integer; `grep` exiting with status 1 on a count of 0 is normal):

    print -r -- "${SERVICE_MSGS}" | grep -c -i -F -- "${OWNER_EMAIL}"

    print -r -- "${SERVICE_MSGS}" | grep -c -i -F -- "${UNVERIFIED_EMAIL}"

    print -r -- "${SERVICE_MSGS}" | grep -c -i -F -- "${OTP_CODE}"

    print -r -- "${SERVICE_MSGS}" | grep -c -i -F -- "${ORG_SLUG}"

    print -r -- "${SERVICE_MSGS}" | grep -c -i -F -- "${COMMUNITY_SLUG}"

    print -r -- "${SERVICE_MSGS}" | grep -c -i -F -- "${ACCESS_TOKEN}"

    print -r -- "${SERVICE_MSGS}" | grep -c -i -F -- "Bearer"

    print -r -- "${SERVICE_MSGS}" | grep -c -i -F -- "@"

Run privacy counts against API access logs (one command per value; expected `0` each; record the printed integer; `grep` exiting with status 1 on a count of 0 is normal):

    print -r -- "${ACCESS_MSGS}" | grep -c -i -F -- "${OWNER_EMAIL}"

    print -r -- "${ACCESS_MSGS}" | grep -c -i -F -- "${UNVERIFIED_EMAIL}"

    print -r -- "${ACCESS_MSGS}" | grep -c -i -F -- "${OTP_CODE}"

    print -r -- "${ACCESS_MSGS}" | grep -c -i -F -- "${ORG_SLUG}"

    print -r -- "${ACCESS_MSGS}" | grep -c -i -F -- "${COMMUNITY_SLUG}"

    print -r -- "${ACCESS_MSGS}" | grep -c -i -F -- "${ACCESS_TOKEN}"

    print -r -- "${ACCESS_MSGS}" | grep -c -i -F -- "Bearer"

    print -r -- "${ACCESS_MSGS}" | grep -c -i -F -- "@"

Inspect all `mail` log lines emitted during the window:

    print -r -- "${SERVICE_MSGS}" | jq -cR 'fromjson? | select(.message=="mail")'

Expected:

- `outcome` `ok` once per `start` call that sent mail;
- exactly one `failed` with `errorClass` `MessageRejected`;
- 0 `timeout`.

Verify key sets for `mail` lines:

    print -r -- "${SERVICE_MSGS}" | jq -cR 'fromjson? | select(.message=="mail") | keys'

Expected: prints exactly `["level","message","operation","outcome"]` for each `ok` line, and `["errorClass","level","message","operation","outcome"]` for the failed line.

Finish by unsetting all test and helper variables:

    unset SERVICE_MSGS ACCESS_MSGS OWNER_EMAIL UNVERIFIED_EMAIL OTP_CODE ORG_SLUG COMMUNITY_SLUG ACCESS_TOKEN TOKENS

### Apply 2 — Re-park

The branch moves to the re-park commit (`enable_database = false`, `desired_count = 0` in `infra/regions/au/env/staging.tfvars`). The owner removes `service_image` from the gitignored `infra/regions/au/env/staging.local.tfvars`.

Run before-each-apply checks against the SHA named for that apply on origin.

Plan to the saved file outside the repository:

    terraform plan -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars -out=${PLAN_FILE} -input=false | grep --line-buffered '^Plan:'

Expected plan summary: 0 to add, 0 to change, 18 to destroy. List addresses and actions:

    terraform show -json ${PLAN_FILE} | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | "\(.change.actions | join(" ")) \(.address)"'

Expected addresses (each delete):

- `module.rds[0].aws_cloudwatch_metric_alarm.cpu_credit_balance`
- `module.rds[0].aws_cloudwatch_metric_alarm.database_connections`
- `module.rds[0].aws_cloudwatch_metric_alarm.free_storage_space`
- `module.rds[0].aws_cloudwatch_metric_alarm.freeable_memory`
- `module.rds[0].aws_db_instance.this`
- `module.rds[0].aws_db_parameter_group.this`
- `module.rds[0].aws_db_subnet_group.this`
- `module.rds[0].terraform_data.prod_protection`
- `aws_ecs_task_definition.db_ops[0]`
- `aws_iam_role.db_ops_execution[0]`
- `aws_iam_role.db_ops_task[0]`
- `aws_iam_role_policy.db_ops_execution[0]`
- `module.ingress.aws_ecs_cluster.this[0]`
- `module.ingress.aws_ecs_cluster_capacity_providers.this[0]`
- `module.ingress.aws_ecs_service.this[0]`
- `module.ingress.aws_ecs_task_definition.this[0]`
- `module.ingress.aws_iam_role_policy.pull[0]`
- `module.ingress.aws_vpc_security_group_ingress_rule.task_api[0]`

Apply that file:

    terraform apply -input=false ${PLAN_FILE} | grep --line-buffered -E ': (Creating|Still creating|Creation complete|Modifying|Still modifying|Modification complete|Destroying|Still destroying|Destruction complete)|Apply complete' | sed -l -E 's/ \[id=[^]]+\]//'

Delete the plan file:

    rm -f ${PLAN_FILE}

Run a follow-up plan to confirm staging is cleanly parked:

    terraform plan -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars

Expected: `No changes. Your infrastructure matches the configuration.`

Record the UTC completion time under **Cost clock** below and calculate the total unpark duration.

### Cost clock and applies

- Apply 0 SHA: `edeaaca` (see Evidence)
- Apply 0 completed: about 20:11 UTC on 2026-10-14 (see Evidence)
- Apply 1 SHA: _(deferred to `ses-sign-in-proof`)_
- Apply 1 completed (cost anchor): _(deferred)_
- Apply 2 SHA: _(deferred)_
- Apply 2 completed: _(deferred)_
- Total unpark window: _(deferred; no unpark on the `email-provider` branch)_

### Evidence

Evidence (Apply 0 against `edeaaca`, 2026-10-14 UTC). Counts, statuses, and lengths only. No account id, ARN, hostname, email address, or registry host.

- Applied by the owner at `edeaaca` on 2026-10-14, completed about 20:11 UTC, using a saved plan file outside the repository. Plan: 10 to add, 2 to change, 0 to destroy. Applied: 10 added, 2 changed, 0 destroyed.
- Created: `aws_sesv2_configuration_set.mail[0]`, `aws_sesv2_email_identity.mail[0]`, `aws_sesv2_email_identity_mail_from_attributes.mail[0]`, `aws_iam_role_policy.ses_send[0]`, `aws_route53_record.ses_dkim[0]`, `[1]`, `[2]`, `aws_route53_record.ses_mail_from_mx[0]`, `aws_route53_record.ses_mail_from_txt[0]`, `aws_route53_record.ses_dmarc_txt[0]`.
- Changed in place: `module.db_secrets.aws_kms_key.secrets` and `module.envelope.aws_iam_role_policy.task_secrets` — the first-owner policy change from pull request 52, applied here for the first time.
- No existing DNS record was updated, replaced or deleted.
- Read-only checks at about 23:22 UTC: the mail domain identity `SUCCESS` with sending enabled; DKIM `SUCCESS`; MAIL FROM `SUCCESS`; one sandbox recipient verified (`SUCCESS`). The account is still in the SES sandbox (production access off, 200 messages a day).
- The recipient address was entered at a silent prompt and is in no file.
- Apply 1 was not run on the `email-provider` branch: no published image contained that chunk's code. The live proof (Apply 1 onward) is `ses-sign-in-proof`.

## Staging proof run

This section is the operator path for `docs/specs/2026-10-12-staging-proof-run.md`. The human owner runs every apply, every `aws ecs run-task`, and `put-secret-value`. The owner's assistant is read-only: it describes resources, reads CloudTrail and CloudWatch Logs, calls the staging hostnames over HTTP, and runs the signed-out browser pass. An agent does not. Stop after any failed proof, or after a second failure on the same step (AGENTS.md section 12). Then re-park before more attempts. The 48-hour hard stop is measured from apply 1 completion; the owner, not the assistant, runs the re-park at that hard stop even if proofs remain.

Shell variables and placeholders only. Never paste an account id, ARN, hostname, registry host, secret name, key id, task id, IP address or email address into evidence. Say "the api hostname", "the auth hostname", and "the admin origin". Values that come from AWS at run time (a subnet, a security group, a task definition revision, a secret id, a role ARN, a window timestamp) are held in shell variables and never recorded. In zsh write `${VAR}:text`, not `$VAR:text`. Do not put an inline `#` comment inside a command string. Single-quoted JSON for `--overrides`. One pasteable command per indented block.

Every one-off this section defines (2a, 2b, 2c, both row-count commands, and the Secrets Manager read in 7a) prints only its fixed success form on success. On any failure it prints exactly the word `fail` to stderr, exits 1, and never prints an error object, a message, a stack, a host, a port, a secret name or an ARN. The image has no shell: every one-off is a `node` invocation.

### Pre-checks (assistant, read-only)

Hold `${DEPLOY_SHA}` as the latest `main` SHA that contains `db-migrate-command`, `fix/2026-10-12-request-error-log`, and `entitlements-plans` (`cd19f0b` or later). Confirm all three are on that SHA. Never record registry hosts or URLs.

1. Publish and admin-publish conclusions for that commit (record conclusion only). Hold the run id for that commit, then print the two jobs' conclusions. Expected: both `success`.

   RUN_ID=$(gh run list --commit ${DEPLOY_SHA} --workflow ci.yml --json databaseId --jq '.[0].databaseId')

   gh run view ${RUN_ID} --json jobs --jq '.jobs[] | select(.name=="publish" or .name=="admin-publish") | {name,conclusion}'

2. Image digest for that tag (record the digest only; never the registry host). Repository name is `ch-staging/service` (`infra/modules/aws-ingress/main.tf`):

   aws ecr describe-images --profile ${AWS_PROFILE} --repository-name ch-staging/service --image-ids imageTag=${DEPLOY_SHA} --query 'imageDetails[0].imageDigest' --output text

3. Scan status and CRITICAL count for that tag (record status and the CRITICAL count only). An absent CRITICAL count means zero findings of that severity.

   aws ecr describe-image-scan-findings --profile ${AWS_PROFILE} --repository-name ch-staging/service --image-id imageTag=${DEPLOY_SHA} --query '{status:imageScanStatus.status,critical:imageScanFindings.findingSeverityCounts.CRITICAL || `0`}' --output json

4. Confirm repository variables `ADMIN_API_ORIGIN` and `ADMIN_AUTH_ORIGIN` are set. Record "both origins present" and "no placeholder"; never URLs.

5. Migration tags in the journal at that commit (record the tags in order; those are the expected `applied <tag>` lines for proof 3):

   git show ${DEPLOY_SHA}:packages/db/drizzle/meta/_journal.json | jq -r '.entries[].tag'

**Stop if:** publish failed, the scan is not `COMPLETE`, or `CRITICAL` is above 0.

### Cost anchor

The owner records the UTC time when apply 1 completes (after the apply returns, not when the plan was shown). The 24-hour target and the 48-hour hard stop are measured from that instant to the start of the re-park apply. At the hard stop the owner re-parks even if proofs remain. The assistant does not act on the hard stop.

### Before each apply

Run the checks under **Before each apply** above: clean tree, `git rev-parse HEAD` equals the SHA named for that apply and that SHA is on origin, both var files passed with the gitignored file last, `terraform init` with `-lockfile=readonly`.

### Apply 1 and apply 2

Profile `${AWS_PROFILE}` (default `ch-admin`). Region `ap-southeast-2`. From `infra/regions/au`.

Hold `${PLAN_FILE}` as a path outside this repository. The plan file holds sensitive values. It lives outside the repository and is deleted after the apply.

**Apply 1 (owner)** — Task 2 SHA, no `service_image` in either var file.

1. Run the before-each-apply checks.
2. `terraform init -backend-config=backend/staging.hcl -lockfile=readonly`
3. Plan to the saved file. Only the summary line is shown. Expected: eight `module.rds[0]` creates, nothing else.

   terraform plan -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars -out=${PLAN_FILE} -input=false | grep --line-buffered '^Plan:'

4. List addresses and actions from that file:

   terraform show -json ${PLAN_FILE} | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | "\(.change.actions | join(" ")) \(.address)"'

5. **Stop** if the plan changes `module.admin_static[0].aws_cloudfront_response_headers_policy.admin` or `module.ingress.aws_apigatewayv2_api.tenant`, or if the counts differ from eight RDS creates. Reconcile state first; the cost window has not started.
6. Apply that file. Progress lines show as they happen; resource ids are stripped. Record the UTC completion time under **Cost anchor**.

   terraform apply -input=false ${PLAN_FILE} | grep --line-buffered -E ': (Creating|Still creating|Creation complete|Modifying|Still modifying|Modification complete|Destroying|Still destroying|Destruction complete)|Apply complete' | sed -l -E 's/ \[id=[^]]+\]//'

7. Delete the plan file:

   rm -f ${PLAN_FILE}

8. Wait until the RDS instance status is `available` (read-only describe; do not record identifiers).

**Abandoning after apply 1 only** (apply 2 never ran): commit and push the re-park flags (`enable_database = false`, `desired_count = 0`), leave no `service_image` in the gitignored file, then plan and apply with the same saved-plan method above. Expect the eight database resources under `module.rds[0]` destroyed.

**Apply 2 (owner)** — digest in the gitignored `staging.local.tfvars` only.

1. Set `service_image` to the digest URI from the pre-check (`<registry>/ch-staging/service@sha256:<digest>`). The registry host stays only in that gitignored file.
2. Plan to the saved file. Only the summary line is shown. Expected: exactly ten new ECS-related resources (cluster, capacity providers, service task definition, service, ECR pull policy, task API ingress rule, ops task definition, ops execution role, ops task role, ops execution policy). **Stop** if the plan shows anything else.

   terraform plan -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars -out=${PLAN_FILE} -input=false | grep --line-buffered '^Plan:'

3. List addresses and actions from that file:

   terraform show -json ${PLAN_FILE} | jq -r '.resource_changes[] | select(.change.actions != ["no-op"]) | "\(.change.actions | join(" ")) \(.address)"'

4. Apply that file. Progress lines show as they happen; resource ids are stripped.

   terraform apply -input=false ${PLAN_FILE} | grep --line-buffered -E ': (Creating|Still creating|Creation complete|Modifying|Still modifying|Modification complete|Destroying|Still destroying|Destruction complete)|Apply complete' | sed -l -E 's/ \[id=[^]]+\]//'

5. Delete the plan file:

   rm -f ${PLAN_FILE}

6. Wait until the ECS service is stable and the VPC link name `ch-staging-link` is `AVAILABLE`.

### Retrospective record (CSP and CORS, 2026-10-12)

The owner applied the admin content-security-policy change and the gateway CORS change to staging on 2026-10-12 at about 09:01 UTC from commit `836a3f9`, before those commits merged. Plan for that apply: 0 to add, 2 to change, 0 to destroy. CloudTrail shows one update to the tenant gateway API and one update to the CloudFront response-headers policy in the same second, made through Terraform with no error. The apply worktree was moved to `836a3f9` two minutes earlier and stayed there until this run; no later commit on that branch touched `infra/`. Apply 1 of this run planned no change to either resource. Record counts and addresses with action only; no ARNs.

### One-off network

Hold these in the shell. Never record their values.

| Variable                     | Meaning                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `${AWS_PROFILE}`             | Apply and one-off profile (default `ch-admin`)                                                                               |
| `${CLUSTER}`                 | ECS cluster name for staging (`ch-staging`; `aws_ecs_cluster.this` name = `var.name` in `infra/modules/aws-ingress/main.tf`) |
| `${SERVICE}`                 | ECS service name for staging (`ch-staging`; `aws_ecs_service.this` name = `var.name`)                                        |
| `${SERVICE_TASK_DEFINITION}` | Service task definition family (`ch-staging`, from `aws_ecs_task_definition.this` family = `var.name`)                       |
| `${OPS_TASK_DEFINITION}`     | Ops task definition family (`ch-staging-db-ops`)                                                                             |
| `${SUBNET}`                  | Staging public subnet id (from Terraform / describe; never recorded)                                                         |
| `${TASK_SECURITY_GROUP}`     | Task security group id (from Terraform / describe; never recorded)                                                           |
| `${LOG_GROUP}`               | Service log group `/community-hub/ch-staging/service` (streams use prefixes `service` and `db-ops`)                          |
| `${API_ACCESS_LOG_GROUP}`    | Tenant API access log group `/community-hub/ch-staging/api-access`                                                           |
| `${API_HOSTNAME}`            | Api hostname from Terraform / DNS (never recorded; say "the api hostname" in evidence)                                       |

Same network pattern as **Apply product migrations**: task security group, staging public subnet, public address. Command override only; do not set `entryPoint`. Service container name is `service` (`awslogs-stream-prefix` `service`). Ops container name is `db-ops` (`awslogs-stream-prefix` `db-ops`). Each start command ends with `&& print ${#TASK_ARN}`; the number printed is the length of the task id. After each one-off, wait stopped, describe the exit code, and read the log stream. The stopped reason is read and never pasted when it can name a registry or a secret.

**After a service-container one-off** (2a, 2b, 2c, 2e, 7a), run these three in order:

    aws ecs wait tasks-stopped --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN}

    aws ecs describe-tasks --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN} --query 'tasks[0].[containers[0].exitCode,stoppedReason]' --output text

    aws logs get-log-events --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} --log-stream-name "service/service/${TASK_ARN##*/}" --query 'events[].message' --output text | tr '\t' '\n'

**After a db-ops-container one-off** (2d, both row-count commands, and migrate under **Apply product migrations**), run these three in order:

    aws ecs wait tasks-stopped --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN}

    aws ecs describe-tasks --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN} --query 'tasks[0].[containers[0].exitCode,stoppedReason]' --output text

    aws logs get-log-events --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} --log-stream-name "db-ops/db-ops/${TASK_ARN##*/}" --query 'events[].message' --output text | tr '\t' '\n'

### Proof 1 — service healthy

After apply 2 is stable. Owner applied; assistant runs every read-only step below. Record the image digest only, and say "the api hostname" for the health requests. Hold `${EXPECTED_DIGEST}` from the pre-check (the `sha256:…` value only).

1. Running and pending counts (expected `1` and `0`):

   aws ecs describe-services --profile ${AWS_PROFILE} --cluster ${CLUSTER} --services ${SERVICE} --query 'services[0].[runningCount,pendingCount]' --output text

2. Running task last status, health, and image digest (expected `RUNNING`, `HEALTHY`, digest equal to `${EXPECTED_DIGEST}`):

   aws ecs list-tasks --profile ${AWS_PROFILE} --cluster ${CLUSTER} --service-name ${SERVICE} --desired-status RUNNING --query 'taskArns[0]' --output text

Hold the printed ARN in `${TASK_ARN}` (never recorded). Then:

    aws ecs describe-tasks --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN} --query 'tasks[0].[lastStatus,healthStatus,containers[0].imageDigest]' --output text

3. No stopped task for this service since apply 2 (expected empty task ARN list, or only tasks that stopped before apply 2 — if any ARN prints, describe it and stop unless it clearly predates apply 2; do not record ARNs):

    aws ecs list-tasks --profile ${AWS_PROFILE} --cluster ${CLUSTER} --service-name ${SERVICE} --desired-status STOPPED --query 'taskArns' --output text

4. Five `GET /health` on the api hostname (expected five lines of `200`):

    curl -sS -o /dev/null -w '%{http_code}\n' "https://${API_HOSTNAME}/health"

    curl -sS -o /dev/null -w '%{http_code}\n' "https://${API_HOSTNAME}/health"

    curl -sS -o /dev/null -w '%{http_code}\n' "https://${API_HOSTNAME}/health"

    curl -sS -o /dev/null -w '%{http_code}\n' "https://${API_HOSTNAME}/health"

    curl -sS -o /dev/null -w '%{http_code}\n' "https://${API_HOSTNAME}/health"

5. Cloud Map instance count and custom health status. Namespace name is `ch-staging.local` (`aws_service_discovery_private_dns_namespace.this` name = `${var.name}.local` in `infra/modules/aws-ingress/main.tf`); discovery service name is `service` (`aws_service_discovery_service.this`). ECS registers the task through `service_registries` on `aws_ecs_service.this` and manages custom health via `health_check_custom_config` (failure_threshold 1). Hold ids in shell variables; never record them. Pass: print shows count `1` and status `HEALTHY` only (a count and a status; never an id). This check was added after the 2026-10-13 run and has not yet been run against a live service.

    NAMESPACE_ID=$(aws servicediscovery list-namespaces --profile ${AWS_PROFILE} --filters Name=NAME,Values=ch-staging.local --query 'Namespaces[0].Id' --output text)

    DISCOVERY_SERVICE_ID=$(aws servicediscovery list-services --profile ${AWS_PROFILE} --filters Name=NAMESPACE_ID,Values=${NAMESPACE_ID} --query "Services[?Name=='service'].Id | [0]" --output text)

    aws servicediscovery get-instances-health-status --profile ${AWS_PROFILE} --service-id ${DISCOVERY_SERVICE_ID} --query '{count: length(keys(Status || `{}`)), statuses: values(Status || `{}`)}' --output json

**Stop if** any check fails: stop the proofs and re-park.

### Proof 2a–2e command overrides

Owner runs each `aws ecs run-task`. Assistant reads exit codes and log lines. Do not set `entryPoint`. Paste only exit code and the command's own stdout or stderr when this section fixes their form.

**2a — `/tmp` write (service).** Expected: exit 0, stderr empty. The service stays at 1 of 1.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${SERVICE_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"service","command":["node","--input-type=module","-e","import{writeFileSync}from'\''node:fs'\'';try{writeFileSync('\''/tmp/proof-write'\'','\''ok'\'');}catch{console.error('\''fail'\'');process.exit(1);}"]}]}' \
      --query 'tasks[0].taskArn' --output text) && print ${#TASK_ARN}

Next: the three **After a service-container one-off** commands.

**2b — uid and gid (service).** Expected: stdout exactly `1000 1000`, stderr empty, exit 0.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${SERVICE_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"service","command":["node","--input-type=module","-e","try{console.log(String(process.getuid())+'\'' '\''+String(process.getgid()));}catch{console.error('\''fail'\'');process.exit(1);}"]}]}' \
      --query 'tasks[0].taskArn' --output text) && print ${#TASK_ARN}

Next: the three **After a service-container one-off** commands.

**2c — read-only root (service).** Tries to write under `/app` and exits 0 only if the write is refused. Expected: exit 0, stderr empty.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${SERVICE_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"service","command":["node","--input-type=module","-e","import{writeFileSync}from'\''node:fs'\'';try{writeFileSync('\''/app/proof-write'\'','\''ok'\'');console.error('\''fail'\'');process.exit(1);}catch{}"]}]}' \
      --query 'tasks[0].taskArn' --output text) && print ${#TASK_ARN}

Next: the three **After a service-container one-off** commands.

**2d — bootstrap (ops).** After 2a–2c. Command `["node","/app/db-bootstrap.js"]`. Expected: exit 0, stdout exactly one integer and one newline, stderr empty. A non-integer or a non-zero exit stops the run.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${OPS_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"db-ops","command":["node","/app/db-bootstrap.js"]}]}' \
      --query 'tasks[0].taskArn' --output text) && print ${#TASK_ARN}

Next: the three **After a db-ops-container one-off** commands.

**2e — probe (service).** After 2d succeeds. Command `["node","/app/probe.js"]`. Expected: stdout `pass`, stderr empty, exit 0.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${SERVICE_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"service","command":["node","/app/probe.js"]}]}' \
      --query 'tasks[0].taskArn' --output text) && print ${#TASK_ARN}

Next: the three **After a service-container one-off** commands.

**Stop if:** proof 1 (service healthy) or any of 2a–2e fails — go to re-park.

### Proof 3

Run **Apply product migrations** twice (same network as 2d). First run: one `applied <tag>` per journal entry from the pre-check, then `done applied=<n> total=<m>`. Second run: stdout exactly `done applied=0 total=<m>`, no `applied` lines. Exit 0 and stderr empty both times.

**Stop if:** exit 1.

### HTTP proofs (assistant)

Shapes only. Never paste hostnames or the synthetic address into evidence.

**Proof 4 — preflight.** `OPTIONS` to `/v1/access/grants/list` on the api hostname and again on the auth hostname. Headers: `Origin` set to the admin origin, `Access-Control-Request-Method: POST`, `Access-Control-Request-Headers: authorization,content-type`. Repeat both with an origin that is not the admin origin. Expected for the admin origin: status 204; CORS headers match `cors_configuration` in `infra/modules/aws-ingress/main.tf` (`access-control-allow-origin` reflects the admin origin, methods include `GET`, `POST` and `OPTIONS`, headers include `authorization` and `content-type`, no `access-control-allow-credentials`). Record status and that the headers match; do not paste origin strings or full header values. Other origin: no `access-control-allow-origin`; record status, do not assert it. Control: the same preflight to the ops hostname `/health` → expect 404 and no `access-control-allow-origin`. Record whether the service log group shows an `OPTIONS` line. The webhooks hostname answer is recorded and not asserted.

**Proof 5 — email OTP.** Two `POST` requests to the auth hostname path `/v1/auth/email-otp/start`, header `content-type: application/json`, body `{"email":"<synthetic>"}`. The synthetic address uses local part `proof` plus eight random hex digits and a domain reserved for tests under RFC 2606; generate it for the run and never write it into the runbook. Then one `POST` with a malformed address. Expected: both valid requests return 503 with an empty body; malformed returns 400 with an empty body. A 500 means stop and record `errorClass` / `errorCode` from the request log at once. A 204 means a mail port other than the boot port is running; stop.

Hold `${WINDOW_START}` and `${WINDOW_END}` as ISO-8601 timestamps for the CloudTrail window (set from the request times; never recorded in evidence beyond "the proof 5 window"). Hold `${TASK_ROLE_ARN}` from a read-only role describe (never recorded). CloudTrail event history can lag by about 15 minutes; wait before treating a missing event as a failure.

After the first request, count `GenerateDataKey` (expected 1) and list encryption-context key names only (expected `key_kind`, `region`, `key_version`):

    aws cloudtrail lookup-events --profile ${AWS_PROFILE} --lookup-attributes AttributeKey=EventName,AttributeValue=GenerateDataKey --start-time ${WINDOW_START} --end-time ${WINDOW_END} --output json | jq --arg role "${TASK_ROLE_ARN}" '[.Events[] | (.CloudTrailEvent | fromjson) as $e | select(($e.userIdentity.arn // $e.userIdentity.sessionContext.sessionIssuer.arn // "") | tostring | contains($role | split("/") | last))] | {count: length, context_keys: ([.[].CloudTrailEvent | fromjson | .requestParameters.encryptionContext // {} | keys[]] | unique)}'

After the first request, count `Decrypt` (expected 1) with the same context key names:

    aws cloudtrail lookup-events --profile ${AWS_PROFILE} --lookup-attributes AttributeKey=EventName,AttributeValue=Decrypt --start-time ${WINDOW_START} --end-time ${WINDOW_END} --output json | jq --arg role "${TASK_ROLE_ARN}" '[.Events[] | (.CloudTrailEvent | fromjson) as $e | select(($e.userIdentity.arn // $e.userIdentity.sessionContext.sessionIssuer.arn // "") | tostring | contains($role | split("/") | last))] | {count: length, context_keys: ([.[].CloudTrailEvent | fromjson | .requestParameters.encryptionContext // {} | keys[]] | unique)}'

After the second request, re-run the same two lookups on the widened window: expect one more `Decrypt` (count increases by 1) and no second `GenerateDataKey` (count stays 1).

Service log: `kms` lines with fields `operation` (`generate_data_key` or `decrypt`), `outcome` (`ok`), `key_kind` (`identity`); no `errorClass` on those lines. Then continue to proofs 6a–6f as needed, and run **Row counts (counts only)** only after both valid sign-in-code requests have returned 503 (and the CloudTrail and `kms` checks above).

**Proof 6 — refused routes.** All `POST` with `content-type: application/json`. Placeholder slug e.g. `proof-run-no-community`. Where a bearer is required, use 43 random base64url characters.

- 6a. Api hostname `/v1/access/grants/list`, body `{"communitySlug":"<slug>"}`, no `Authorization`. Expected: 401, empty body.
- 6b. Same path and body with `Authorization: Bearer` plus 43 random base64url characters. Expected: 401, empty body (needs proof 3).
- 6c. Same body to the auth hostname. Expected: 404, empty body.
- 6d. Body with an extra key on the api hostname: `{"communitySlug":"proof-run-no-community","extra":true}`. Expected: 400, empty body (`apps/api/src/access-routes.ts` / test).
- 6e. Api hostname `/v1/entitlements/list`, body `{"communitySlug":"<slug>"}`, no `Authorization`. Expected: 401, empty body.
- 6f. Api hostname `/v1/entitlements/toggle`, body `{"communitySlug":"<slug>","key":"people.directory","enabled":true}`, no `Authorization`. Expected: 401. With a bearer of 43 random base64url characters, also 401 (needs proof 3). On the auth hostname, either body returns 404.

### Row counts (counts only)

Do not run these one-offs until both valid sign-in-code requests have returned 503. Proof 5, after the OTP requests, their CloudTrail and `kms` log checks, and before proof 7b. Owner runs two ops one-offs on family `${OPS_TASK_DEFINITION}`, container `db-ops`, same network as 2d. The ops task already injects `PGHOST`, `PGPORT`, `PGDATABASE`, `PGPASSWORD_IDENTITY`, and `PGPASSWORD_PLATFORM` (`apps/api/src/db-ops-env.ts` and `aws_ecs_task_definition.db_ops`). Login `identity` reads `PGPASSWORD_IDENTITY`. Login `platform` reads `PGPASSWORD_PLATFORM`. CA file is `/app/certs/rds-ap-southeast-2-bundle.pem` (`IMAGE_CERT_PATH` in `apps/api/src/env.ts`). Each command uses `@community-hub/db` `createDirectSql` the same way `apps/api/src/probe.ts` does: omit `servername` because ops `PGHOST` is DNS, not an IP. Output is one line of space-separated integers in the fixed table order only.

**Identity** — tables in order: `identity_keys`, `otp_challenges`, `users`, `sessions`, `passkey_challenges`, `passkey_credentials`. Expected after proof 3 and the proof 5 OTP posts: `1 0 0 0 0 0`.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${OPS_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"db-ops","command":["node","--input-type=module","-e","import{createDirectSql}from'\''@community-hub/db'\'';import{readFileSync}from'\''node:fs'\'';try{const pem=readFileSync('\''/app/certs/rds-ap-southeast-2-bundle.pem'\'','\''utf8'\'');const e=process.env;const sql=createDirectSql({host:e.PGHOST,port:Number(e.PGPORT),database:e.PGDATABASE,user:'\''identity'\'',password:e.PGPASSWORD_IDENTITY,ca:pem});const t=['\''identity_keys'\'','\''otp_challenges'\'','\''users'\'','\''sessions'\'','\''passkey_challenges'\'','\''passkey_credentials'\''];const o=[];for(const n of t){const r=await sql.unsafe('\''select count(*)::int c from identity.'\''+n);o.push(r[0].c);}console.log(o.join('\'' '\''));await sql.end({timeout:1});}catch{console.error('\''fail'\'');process.exit(1);}"]}]}' \
      --query 'tasks[0].taskArn' --output text) && print ${#TASK_ARN}

Next: the three **After a db-ops-container one-off** commands.

**Platform** — tables in order: `organisations`, `communities`, `plans`, `plan_entitlements`, `add_ons`, `add_on_entitlements`, `organisation_plans`, `organisation_add_ons`, `community_allocations`, `community_toggles`, `entitlement_overrides`, `feature_flags`. Expected on a fresh database: twelve zeros.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${OPS_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"db-ops","command":["node","--input-type=module","-e","import{createDirectSql}from'\''@community-hub/db'\'';import{readFileSync}from'\''node:fs'\'';try{const pem=readFileSync('\''/app/certs/rds-ap-southeast-2-bundle.pem'\'','\''utf8'\'');const e=process.env;const sql=createDirectSql({host:e.PGHOST,port:Number(e.PGPORT),database:e.PGDATABASE,user:'\''platform'\'',password:e.PGPASSWORD_PLATFORM,ca:pem});const t=['\''organisations'\'','\''communities'\'','\''plans'\'','\''plan_entitlements'\'','\''add_ons'\'','\''add_on_entitlements'\'','\''organisation_plans'\'','\''organisation_add_ons'\'','\''community_allocations'\'','\''community_toggles'\'','\''entitlement_overrides'\'','\''feature_flags'\''];const o=[];for(const n of t){const r=await sql.unsafe('\''select count(*)::int c from platform.'\''+n);o.push(r[0].c);}console.log(o.join('\'' '\''));await sql.end({timeout:1});}catch{console.error('\''fail'\'');process.exit(1);}"]}]}' \
      --query 'tasks[0].taskArn' --output text) && print ${#TASK_ARN}

Next: the three **After a db-ops-container one-off** commands.

### Proof 7a

Hold `${TASK_ROLE_ARN}`, `${APP_SECRET_ARN}`, `${IDENTITY_SECRET_ARN}`, `${PLATFORM_SECRET_ARN}`, and `${SECRETS_KEY_ARN}` from read-only describes / Terraform outputs (never recorded). Assistant tries `iam:SimulatePrincipalPolicy` in two calls and records the decisions only:

    aws iam simulate-principal-policy --profile ${AWS_PROFILE} --policy-source-arn ${TASK_ROLE_ARN} --action-names secretsmanager:GetSecretValue --resource-arns ${APP_SECRET_ARN} ${IDENTITY_SECRET_ARN} ${PLATFORM_SECRET_ARN} --query 'EvaluationResults[0].ResourceSpecificResults[].EvalResourceDecision' --output text

Expected: `allowed allowed allowed`.

    aws iam simulate-principal-policy --profile ${AWS_PROFILE} --policy-source-arn ${TASK_ROLE_ARN} --action-names kms:Decrypt --resource-arns ${SECRETS_KEY_ARN} --query 'EvaluationResults[0].EvalDecision' --output text

Expected: `allowed`. If either call is refused, the human pastes a table of action and effect per statement from the attached policy, with each resource shown as redacted; the assistant reads that table against `secretsmanager:GetSecretValue` on the three database secrets and `kms:Decrypt` on the secrets key.

Then the owner runs a one-off of the **service** task definition (task role, not the execution role). The service container already has `IDENTITY_SECRET_ARN` in its environment (`infra/modules/aws-ingress/main.tf`). Confirm the name with `describe-task-definition` if needed; never record the value. The command calls `GetSecretValue` with `VersionStage` `AWSCURRENT` via `@aws-sdk/client-secrets-manager` and prints `pass` only when a non-empty string comes back. On any failure: stdout empty, stderr exactly `fail`, exit 1.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${SERVICE_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"service","command":["node","--input-type=module","-e","import{GetSecretValueCommand,SecretsManagerClient}from'\''@aws-sdk/client-secrets-manager'\'';try{const id=process.env.IDENTITY_SECRET_ARN;if(!id)throw 0;const r=await new SecretsManagerClient({}).send(new GetSecretValueCommand({SecretId:id,VersionStage:'\''AWSCURRENT'\''}));if(typeof r.SecretString!=='\''string'\''||r.SecretString.length===0)throw 0;console.log('\''pass'\'');}catch{console.error('\''fail'\'');process.exit(1);}"]}]}' \
      --query 'tasks[0].taskArn' --output text) && print ${#TASK_ARN}

Next: the three **After a service-container one-off** commands.

**Stop if:** non-zero exit or denied simulate with no matching redacted policy table.

### Proof 7b

Order: after proofs 5 and 6b and 6f and **Row counts (counts only)**. The rotation must never display a secret. The identity secret's string is a bare password (not JSON): Terraform writes `secret_string_wo` from `ephemeral.random_password` with `length = 32` and `special = false` (`infra/modules/aws-db-secrets/main.tf`). **Change a database role** applies a later password by running the ops bootstrap task after the secret changes; it does not open a master session.

**Warnings (read before acting):** send no request to the service between the forced deployment and the post-rotation request — an open pooled connection survives the password change and the re-read is not demonstrated. After the bootstrap, confirm the service task is the one that was running before the secret change; if it was replaced, start again from the forced deployment (a replacement task starts with the new password). Read-only command that shows the running service task's start time without printing an id (hold the task ARN in `${TASK_ARN}` from a list-tasks query, never record it):

    aws ecs describe-tasks --profile ${AWS_PROFILE} --cluster ${CLUSTER} --tasks ${TASK_ARN} --query 'tasks[0].startedAt' --output text

1. Owner forces a new deployment of the service and waits until it is stable, so the pool is empty and start-time environment holds the current password:

   aws ecs update-service --profile ${AWS_PROFILE} --cluster ${CLUSTER} --service ${SERVICE} --force-new-deployment --query 'service.serviceName' --output text

   aws ecs wait services-stable --profile ${AWS_PROFILE} --cluster ${CLUSTER} --services ${SERVICE}

2. Owner generates a new 32-character letters-and-digits password and puts it on the identity secret in one pipeline, with nothing echoed and nothing left in a shell variable. Hold `${IDENTITY_SECRET_ID}` from a read-only describe (never recorded). Nothing is displayed because the value is written only to the command's stdin and is never assigned or printed:

   LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32 | aws secretsmanager put-secret-value --profile ${AWS_PROFILE} --secret-id ${IDENTITY_SECRET_ID} --secret-string file:///dev/stdin

3. Owner re-runs proof 2d (`node /app/db-bootstrap.js`). That one-off reads the secrets at task start and runs `ALTER ROLE` so the database role passwords match the secrets (`setLoginPasswords` in the bootstrap path). **If this step fails:** the secret holds a value the role does not; the running service still works on its old start-time password. Re-run 2d, or re-park. Do not print the secret. Do not leave the mismatch for a later day without re-parking.

4. Assistant repeats one proof 5 `POST /v1/auth/email-otp/start`. Expected: 503, not 500. CloudTrail (read-only, may lag about 15 minutes). Hold `${ROTATION_WINDOW_START}` and `${ROTATION_WINDOW_END}` for this request window. Count `GetSecretValue` by the task role (expected 2):

   aws cloudtrail lookup-events --profile ${AWS_PROFILE} --lookup-attributes AttributeKey=EventName,AttributeValue=GetSecretValue --start-time ${ROTATION_WINDOW_START} --end-time ${ROTATION_WINDOW_END} --output json | jq --arg role "${TASK_ROLE_ARN}" '[.Events[] | (.CloudTrailEvent | fromjson) as $e | select(($e.userIdentity.arn // $e.userIdentity.sessionContext.sessionIssuer.arn // "") | tostring | contains($role | split("/") | last))] | length'

**Stop if:** OTP is not 503.

### Proof 8–9

**Proof 8 (assistant).** Admin origin `GET /`: expect 200 and one `h1` named Dashboard. For `content-security-policy`, record "both origins present" in `connect-src` and "no other origin"; do not paste the header. Confirm other directives still match `local.content_security_policy` in `infra/modules/aws-admin-static/main.tf` without pasting values. Fetch the page's script asset and record "both origins present" and "no other origin" in the bundle. Browser pass (signed out): open `/`, follow Users & Roles, Module Toggles, Sign in; enter the synthetic address; press Send code. Direct loads of `/sign-in`, `/settings/users` and `/settings/modules` return 403 from CloudFront (no `custom_error_response`); start at `/`. Expected while signed out: each Settings page shows the heading and `Sign in required`. After Send code: page shows `Sign-in failed`; record that one preflight returned 204 and one `POST` returned 503 (status only). Record CloudFront 403 on deep links as a finding only; do not fix here.

**Proof 9 (assistant).** CloudWatch Logs filter patterns are not regular expressions. Download each log group's messages for the whole window to a scratch file outside the repository, then count with `grep -cE`. Hold `${LOG_START_MS}` and `${LOG_END_MS}` as Unix epoch milliseconds for `--start-time` / `--end-time`. Hold scratch paths such as `${SCRATCH_SERVICE_LOGS}` and `${SCRATCH_API_ACCESS_LOGS}` under a directory outside this repository (never under the worktree). Delete both scratch files afterwards; never commit them.

Download the service log group (stream prefixes `service` and `db-ops`):

    aws logs filter-log-events --profile ${AWS_PROFILE} --log-group-name ${LOG_GROUP} --start-time ${LOG_START_MS} --end-time ${LOG_END_MS} --query 'events[].message' --output text | tr '\t' '\n' > ${SCRATCH_SERVICE_LOGS}

Download the tenant API access log group:

    aws logs filter-log-events --profile ${AWS_PROFILE} --log-group-name ${API_ACCESS_LOG_GROUP} --start-time ${LOG_START_MS} --end-time ${LOG_END_MS} --query 'events[].message' --output text | tr '\t' '\n' > ${SCRATCH_API_ACCESS_LOGS}

Run each search below on both scratch files (pass = count `0`, unless every hit is only inside `errorClass`, `errorCode`, `requestId`, or `gatewayRequestId` on a `request` or `kms` line — those hits are read by eye; record the field name, never the line). Hold `${SYNTHETIC_LOCAL}` as the synthetic address's local part for the run (never recorded in evidence). Hold `${COMMUNITY_SLUG}` as `proof-run-no-community`.

`proof` followed by hex (pass count 0, else eye-check exception fields):

    grep -cE 'proof[0-9a-fA-F]+' ${SCRATCH_SERVICE_LOGS} ${SCRATCH_API_ACCESS_LOGS}

The `@` character:

    grep -cE '@' ${SCRATCH_SERVICE_LOGS} ${SCRATCH_API_ACCESS_LOGS}

The word `Bearer`:

    grep -cE '\bBearer\b' ${SCRATCH_SERVICE_LOGS} ${SCRATCH_API_ACCESS_LOGS}

Any run of eight digits (pass count 0 outside `requestId` / `gatewayRequestId`; a hit inside those two fields is read by eye):

    grep -cE '[0-9]{8}' ${SCRATCH_SERVICE_LOGS} ${SCRATCH_API_ACCESS_LOGS}

The synthetic address's local part:

    grep -cE "${SYNTHETIC_LOCAL}" ${SCRATCH_SERVICE_LOGS} ${SCRATCH_API_ACCESS_LOGS}

The community slug placeholder:

    grep -cE "${COMMUNITY_SLUG}" ${SCRATCH_SERVICE_LOGS} ${SCRATCH_API_ACCESS_LOGS}

The string `identity.`:

    grep -cE 'identity\.' ${SCRATCH_SERVICE_LOGS} ${SCRATCH_API_ACCESS_LOGS}

The string `password`:

    grep -cE 'password' ${SCRATCH_SERVICE_LOGS} ${SCRATCH_API_ACCESS_LOGS}

The string `secret`:

    grep -cE 'secret' ${SCRATCH_SERVICE_LOGS} ${SCRATCH_API_ACCESS_LOGS}

Request log fields (`packages/kernel` via `apps/api/src/gate.ts`): message `request`, plus `method`, `path` (route pattern), `status`, `duration`, `requestId`, optional `gatewayRequestId`, and on a thrown 500 also `errorClass` and optional `errorCode`. KMS log fields (`apps/api/src/kms/aws-kms-adapter.ts`): message `kms`, plus `operation`, `outcome`, optional `key_kind`, and `errorClass` when outcome is `failed`. Never paste `hostname` from gate not-found lines. If any proof produced a 500, record `status`, `path`, `errorClass` and `errorCode` at once; if none did, say so.

### Proof 10

Pointer: follow **Re-park** / the re-park apply for this chunk. Expected plan: eighteen destroys (ten from apply 2, eight under `module.rds[0]`), nothing created, updated or replaced. Apply. Following plan shows no changes, detailed exit code 0. Live read-only: RDS instances 0; ECS services in `ch-staging` 0; KMS interface endpoints 0. The topic, subscription, hostname alarm and budget remain. Clear `service_image` from the gitignored file before the apply.

### Evidence rules

The repository never commits an account id, ARN, hostname, registry host, secret name, key id, task id, IP address or email address. Record only:

- **Terraform plans:** add/change/destroy counts and Terraform resource addresses with their action only. Never plan JSON, attribute lines, or anything containing an ARN, an endpoint or an id.
- **One-off tasks:** exit code and the command's own stdout or stderr only when this section fixes their form. Read the stopped reason; do not paste it when it can name a registry or a secret.
- **CloudTrail:** event name, count, and encryption-context key names only. Never the event JSON.
- **IAM policy fallback (proof 7a):** action and effect per statement, resource shown as redacted.
- **Admin CSP and published bundle:** "both origins present" and "no other origin"; never the header value or a URL.
- **The image:** digest only; never the registry host.
- **Service log lines:** field names and the values of `status`, `path` (route pattern), `errorClass`, `errorCode`, `operation`, `outcome` and `key_kind` only. Never paste `hostname` from gate not-found lines.
- **Browser pass:** status and what is rendered; no screenshot of a request body and no URL with a hostname.
- **Synthetic email address:** never written into the runbook, the pull request or a commit.

Use "the api hostname", "the auth hostname" and "the admin origin" in every evidence note.

### Evidence (2026-10-13)

- Deploy commit (image): `cd19f0b`. Image digest `sha256:4c4515f95a20ac24950df43b297257be2ece3ede1b79b6a10203ddefde07e50c`.
- Pre-checks: `publish` success, `admin-publish` success, scan `COMPLETE` with no findings (CRITICAL 0), ten journal tags `0000_schemas` to `0009_flippant_bedlam`; repository variables: both origins present, no placeholder.
- A read-only plan of the unpark commit taken before the day showed 8 to add, 0 to change, 0 to destroy.
- **Apply 1** at commit `c88d6f3`, no `service_image`. Saved plan outside the repository, then apply that file. Plan: 8 to add, 0 to change, 0 to destroy:
  - create `module.rds[0].aws_cloudwatch_metric_alarm.cpu_credit_balance`
  - create `module.rds[0].aws_cloudwatch_metric_alarm.database_connections`
  - create `module.rds[0].aws_cloudwatch_metric_alarm.free_storage_space`
  - create `module.rds[0].aws_cloudwatch_metric_alarm.freeable_memory`
  - create `module.rds[0].aws_db_instance.this`
  - create `module.rds[0].aws_db_parameter_group.this`
  - create `module.rds[0].aws_db_subnet_group.this`
  - create `module.rds[0].terraform_data.prod_protection`
  - No change to `module.admin_static[0].aws_cloudfront_response_headers_policy.admin` or `module.ingress.aws_apigatewayv2_api.tenant`. Apply complete: 8 added, 0 changed, 0 destroyed. Instance `available`, storage encrypted, not publicly accessible, four RDS alarms present.
- **Cost anchor:** apply 1 completed at about 03:44Z. Target 2026-10-14T03:44Z; hard stop 2026-10-15T03:44Z.
- **Apply 2** at commit `c88d6f3`, `service_image` set to the digest above in the gitignored file only. Plan: 10 to add, 0 to change, 0 to destroy:
  - create `aws_ecs_task_definition.db_ops[0]`
  - create `aws_iam_role.db_ops_execution[0]`
  - create `aws_iam_role.db_ops_task[0]`
  - create `aws_iam_role_policy.db_ops_execution[0]`
  - create `module.ingress.aws_ecs_cluster.this[0]`
  - create `module.ingress.aws_ecs_cluster_capacity_providers.this[0]`
  - create `module.ingress.aws_ecs_service.this[0]`
  - create `module.ingress.aws_ecs_task_definition.this[0]`
  - create `module.ingress.aws_iam_role_policy.pull[0]`
  - create `module.ingress.aws_vpc_security_group_ingress_rule.task_api[0]`
  - Apply complete at about 03:50Z: 10 added, 0 changed, 0 destroyed.
- **Retrospective record, CSP and CORS:** the owner applied both changes on 2026-10-12 at about 09:01 UTC from commit `836a3f9`; plan 0 to add, 2 to change, 0 to destroy; CloudTrail shows one update to the tenant gateway API and one update to the CloudFront response-headers policy in the same second, made through Terraform with no error; the apply worktree was moved to `836a3f9` two minutes earlier and stayed there until this run; no later commit on that branch touched `infra/`; apply 1 of this run planned no change to either resource.
- **Proof 1:** pass. Desired 1, running 1, pending 0; task `RUNNING`, health `HEALTHY`; stopped-task list for the service was empty at proof-1 time; running digest equals pre-check; five `GET /health` on the api hostname returned 200; VPC link `AVAILABLE`. Cloud Map instance health was not read during the run, because the operator steps did not include it; five 200 answers through the gateway, which routes through Cloud Map, are the only indication.
- **Proof 2a:** pass. Exit 0, stdout and stderr empty. Service stayed at 1.
- **Proof 2b:** pass. Exit 0, stdout `1000 1000`.
- **Proof 2c:** pass. Exit 0, stdout and stderr empty (write under `/app` refused).
- **Proof 2d:** pass. Exit 0, stdout `79`.
- **Proof 2e:** pass. Exit 0, stdout `pass`.
- **Proof 3 (first run):** pass. Exit 0. Applied tags `0000_schemas` through `0009_flippant_bedlam`; `done applied=10 total=10`.
- **Proof 3 (second run):** pass. Exit 0. Stdout `done applied=0 total=10` only.
- **Proof 4:** pass. Preflight to `/v1/access/grants/list` with the admin origin: api hostname 204, auth hostname 204; allow-origin reflects the admin origin; methods include GET, POST, OPTIONS; headers include authorization and content-type; no allow-credentials. Other origin: 204 on both, no allow-origin. Ops hostname `/health`: 404, no allow-origin. Service log shows `OPTIONS` with path `unmatched` and status 204. Webhooks hostname (recorded, not asserted): 404 with allow-origin reflecting the admin origin.
- **Proof 5:** pass. Two valid sign-in-code requests: 503 and 503, empty bodies. Malformed address: 400, empty body. Service log: `kms` `generate_data_key` `ok` `identity`, then `kms` `decrypt` `ok` `identity`, then `request` `POST /v1/auth/email-otp/start` 503 with no `errorClass`; after the second request one more `kms` `decrypt` `ok` `identity`, no second `generate_data_key`. CloudTrail by the task role: `GenerateDataKey` 1, `Decrypt` 2; encryption-context keys `key_kind`, `key_version`, `region`. No 500 and no 204.
- **Proof 6:** pass. 6a 401; 6b 401; 6c 404; 6d 400; 6e 401; 6f without token 401, with random token 401; auth hostname entitlement list and toggle 404 and 404. All bodies empty. Each random-token request produced one `kms` `decrypt` `ok` line.
- **Row counts:** pass. Identity stdout `1 0 0 0 0 0`. Platform stdout `0 0 0 0 0 0 0 0 0 0 0 0`.
- **Proof 7a:** pass. IAM simulate: `secretsmanager:GetSecretValue` on the three database secrets `allowed allowed allowed`; `kms:Decrypt` on the secrets key `allowed`. One-off stdout `pass`. CloudTrail: one `GetSecretValue` by the task role, stage `AWSCURRENT`.
- **Proof 7b:** pass on the third attempt. Attempts 1–2 failed to demonstrate the re-read (Spot interruption replaced the task; then a pre-change check left an open pooled connection). Attempt 3: forced deployment, no request before rotation, bootstrap exit 0 stdout `79`, service task unchanged; post-rotation sign-in-code 503 empty body; CloudTrail two `GetSecretValue` by the task role (`AWSCURRENT` and `AWSPREVIOUS`), no error.
- **Proof 8a:** pass. Admin origin `GET /`: 200. Content-security-policy present with expected directives; `connect-src` holds self and both origins and no other origin. Referrer-policy, x-content-type-options and strict-transport-security present.
- **Proof 8b:** pass. Script bundle holds both origins, exactly two origins under the staging zone, no placeholder.
- **Proof 8c:** pass (owner browser). Home shows Dashboard with Settings links; Users & Roles and Module Toggles show heading, `Sign in required` and Sign in link; after Send code: `Sign-in failed`. Service log: `OPTIONS` 204 then `POST /v1/auth/email-otp/start` 503, twice. Direct loads of `/sign-in`, `/settings/users` and `/settings/modules`: 403 each.
- **Proof 9:** pass. Service log 177 lines, tenant API access log 33 lines. Count 0 in both for: `proof` followed by hex, `@`, `Bearer`, both synthetic local parts, the test domain, the community slug placeholder, `identity.`, `password`, `secret`. Eight digits: 11 lines in the service log, every one inside `requestId` only; 0 in the access log. Request statuses: 200 ×118, 204 ×6, 400 ×2, 401 ×5, 404 ×7, 503 ×7. `kms` lines: `decrypt` `ok` ×9, `generate_data_key` `ok` ×1. No `errorClass`. No `hostname` field. Access log: no integration error.
- No request returned 500 at any point in the run.
- **Proof 10 (re-park)** at commit `c2bfd97`, 2026-10-13 UTC. No `service_image` in the gitignored file (line removed; count-only grep showed 0). Saved plan outside the repository, then apply that file. Plan: 0 to add, 0 to change, 18 to destroy:
  - delete `aws_ecs_task_definition.db_ops[0]`
  - delete `aws_iam_role.db_ops_execution[0]`
  - delete `aws_iam_role.db_ops_task[0]`
  - delete `aws_iam_role_policy.db_ops_execution[0]`
  - delete `module.ingress.aws_ecs_cluster.this[0]`
  - delete `module.ingress.aws_ecs_cluster_capacity_providers.this[0]`
  - delete `module.ingress.aws_ecs_service.this[0]`
  - delete `module.ingress.aws_ecs_task_definition.this[0]`
  - delete `module.ingress.aws_iam_role_policy.pull[0]`
  - delete `module.ingress.aws_vpc_security_group_ingress_rule.task_api[0]`
  - delete `module.rds[0].aws_cloudwatch_metric_alarm.cpu_credit_balance`
  - delete `module.rds[0].aws_cloudwatch_metric_alarm.database_connections`
  - delete `module.rds[0].aws_cloudwatch_metric_alarm.free_storage_space`
  - delete `module.rds[0].aws_cloudwatch_metric_alarm.freeable_memory`
  - delete `module.rds[0].aws_db_instance.this`
  - delete `module.rds[0].aws_db_parameter_group.this`
  - delete `module.rds[0].aws_db_subnet_group.this`
  - delete `module.rds[0].terraform_data.prod_protection`
  - Apply started at about 04:56Z and completed at about 05:00Z: 0 added, 0 changed, 18 destroyed. The service took 1m43s to destroy and the database instance 1m53s. A plan straight afterwards showed no changes. Read-only checks at 05:01Z: database instances 0, snapshots 0, automated backups 0; ECS clusters 0; RDS alarms 0, the one other staging alarm still present; interface endpoints 0, NAT gateways 0, public IPv4 addresses in use 0, load balancers 0; ops roles 0; secrets 3 (the three role secrets; the RDS-managed master secret is gone); budget 1; alert topic 1. The api hostname `/health` answers 500, as it does whenever staging is parked. The three saved plan files were deleted by the owner.
- **Apply history for this chunk:** apply 1 at `c88d6f3`, completed about 03:44Z; apply 2 at `c88d6f3` with the image in the gitignored file, completed about 03:50Z; re-park at `c2bfd97`, completed about 05:00Z.
- **Window:** about 1 hour 15 minutes from the cost anchor (03:44Z) to the start of the re-park apply, against a 24-hour target and a 48-hour hard stop. At the spec's rate of USD 0.0468 an hour that is about USD 0.06, with the one-off tasks and per-use lines outside the total as the spec says.
- The identity secret was changed three times during proof 7b and now holds the last value; the database it matched is destroyed. The next unpark's `db-bootstrap` sets the role passwords from the secrets, so nothing needs correcting.

### Findings from the 2026-10-13 run

1. Fargate Spot interrupted the service task twice in eight minutes (stop code `SpotInterruption`, container exit 0). With one task on `FARGATE_SPOT`, staging goes down on every interruption until ECS starts a replacement.
2. The webhooks hostname answers a preflight with the admin origin allowed (status 404, allow-origin reflecting the admin origin), because the gateway's CORS configuration is shared by the api, auth and webhooks hostnames.
3. Reloading a deep link returns 403 from CloudFront (`/sign-in`, `/settings/users`, `/settings/modules`). The browser pass must start at `/`.
4. The admin shell has no layout or styling to speak of. Functional, but too poor to use as is.
5. Unsolicited requests from the internet reached the service at unknown paths during the window (`GET`, path `unmatched`, 404). Expected for a public gateway.
6. The pooled checkout still logs nothing when it re-reads a secret; CloudTrail was the only evidence of the re-read.
7. The rotation steps need two warnings: send no request to the service between the forced deployment and the post-rotation request (an open pooled connection survives the password change); and after the bootstrap confirm the service task is the same one that was running before the secret change (a replacement starts with the new password).
8. The one-off start commands print nothing, so a failed start is silent. Append `&& print ${#TASK_ARN}` so a task id length prints without showing the id.
9. Applying a saved plan (plan to a file outside the repository, list addresses and actions with `terraform show -json` and `jq`, then apply that file with output filtered to progress lines) kept every identifier off the terminal. Plain plan and apply would have printed them.
10. The browser pass (proof 8c) was run by the owner, not the assistant as the spec's decision 12 says, to keep the admin hostname out of the assistant's transcript; the assistant corroborated it from the service log (preflight 204, request 503).
11. Proof 7b passed on a third attempt, after the spec's stop rule of two failed attempts; the owner chose to try once more once both failures were understood to come from the procedure and not the product.
12. The browser pass did not record two things the spec lists: whether the console showed a content-security-policy violation, and whether the typed address was held anywhere other than the input.

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

## Admin shell

SHA `8a68085746eb345753fcbcd66b986135ac560fef`. Profile ch-admin. The apply added 14, changed 0, and destroyed 0. IPv6 is off. There is no AAAA record and no `terraform_data`.

- `module.admin_static[0].aws_s3_bucket.admin`
- `module.admin_static[0].aws_s3_bucket_public_access_block.admin`
- `module.admin_static[0].aws_s3_bucket_server_side_encryption_configuration.admin`
- `module.admin_static[0].aws_s3_bucket_ownership_controls.admin`
- `module.admin_static[0].aws_s3_bucket_policy.admin`
- `module.admin_static[0].aws_cloudfront_origin_access_control.admin`
- `module.admin_static[0].aws_cloudfront_response_headers_policy.admin`
- `module.admin_static[0].aws_cloudfront_distribution.admin`
- `module.admin_static[0].aws_acm_certificate.admin`
- `module.admin_static[0].aws_route53_record.validation["admin.<zone>"]`
- `module.admin_static[0].aws_acm_certificate_validation.admin`
- `module.admin_static[0].aws_route53_record.admin`
- `aws_iam_role.admin_publish[0]`
- `aws_iam_role_policy.admin_publish[0]`

The validation key is `admin.` concatenated with the zone name. A read-only plan after the apply showed no changes. Abdus built that SHA and synced it with profile ch-admin, assets first, then `index.html`. The three GitHub Actions secrets are set. Their values are not recorded here.

The reviewer loaded `https://admin.<zone>/` before merge. The four checks passed:

1. One `h1`, Dashboard.
2. The nav named Admin has one link, Dashboard to `/`. None of the other 15 labels is in the page.
3. The five response headers match the spec's exact values.
4. The console has no message and no policy violation.

Also confirmed: only same-origin requests; `index.html` is `no-cache` and the assets are immutable; the script is served gzip-compressed; `/enquires` returns 403 and is not rewritten to `index.html`; the bucket's direct URL returns 403; HTTP redirects to HTTPS. The reviewer read the bucket, the distribution, the certificate, the headers policy, and the publish role back from AWS and simulated the role's policy. It allows listing the bucket, putting and deleting objects, and invalidating this distribution, and nothing else that was tried.

## Restore drill

Quarterly, and only against staging. Restore the staging database to a new instance from point-in-time recovery. Record the time taken against the 4-hour target. Then delete the restored instance, because it bills by the hour. This drill does not restore production. Reading `SHOW max_connections` belongs to `first-running-task`, not to this drill.
