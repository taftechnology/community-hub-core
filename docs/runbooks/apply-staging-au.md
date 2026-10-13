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

## Staging proof run

This section is the operator path for `docs/specs/2026-10-12-staging-proof-run.md`. The human owner runs every apply, every `aws ecs run-task`, and `put-secret-value`. The owner's assistant is read-only: it describes resources, reads CloudTrail and CloudWatch Logs, calls the staging hostnames over HTTP, and runs the signed-out browser pass. An agent does not. Stop after any failed proof, or after a second failure on the same step (AGENTS.md section 12). Then re-park before more attempts. The 48-hour hard stop is measured from apply 1 completion; the owner, not the assistant, runs the re-park at that hard stop even if proofs remain.

Shell variables and placeholders only. Never paste an account id, ARN, hostname, registry host, secret name, key id, task id, IP address or email address into evidence. Say "the api hostname", "the auth hostname", and "the admin origin". Values that come from AWS at run time (a subnet, a security group, a task definition revision, a secret id) are held in shell variables and never recorded. In zsh write `${VAR}:text`, not `$VAR:text`. Do not put an inline `#` comment inside a command string. Single-quoted JSON for `--overrides`. One pasteable command per indented block.

Every one-off this section defines (2a, 2b, 2c, both row-count commands, and the Secrets Manager read in 7a) prints only its fixed success form on success. On any failure it prints exactly the word `fail` to stderr, exits 1, and never prints an error object, a message, a stack, a host, a port, a secret name or an ARN. The image has no shell: every one-off is a `node` invocation.

### Pre-checks (assistant, read-only)

1. Resolve the deploy SHA on `main`: the latest that contains `db-migrate-command`, `fix/2026-10-12-request-error-log`, and `entitlements-plans` (`cd19f0b` or later). Confirm all three are on that SHA.
2. Confirm the `publish` and `admin-publish` jobs for that SHA succeeded. Confirm the ECR scan is `COMPLETE` and `CRITICAL` is 0. Record the image digest only; never the registry host.
3. Confirm the repository variables `ADMIN_API_ORIGIN` and `ADMIN_AUTH_ORIGIN` are set. Record "both origins present" and "no placeholder"; never URLs.
4. Read `packages/db/drizzle/meta/_journal.json` on that SHA. Record the journal tags in order. Those are the expected `applied <tag>` lines for proof 3.

**Stop if:** publish failed, the scan is not `COMPLETE`, or `CRITICAL` is above 0.

### Cost anchor

The owner records the UTC time when apply 1 completes (after the apply returns, not when the plan was shown). The 24-hour target and the 48-hour hard stop are measured from that instant to the start of the re-park apply. At the hard stop the owner re-parks even if proofs remain. The assistant does not act on the hard stop.

### Before each apply

Run the checks under **Before each apply** above: clean tree, `git rev-parse HEAD` equals the SHA named for that apply and that SHA is on origin, both var files passed with the gitignored file last, `terraform init` with `-lockfile=readonly`.

### Apply 1 and apply 2

Profile `${AWS_PROFILE}` (default `ch-admin`). Region `ap-southeast-2`. From `infra/regions/au`.

**Apply 1 (owner)** — Task 2 SHA, no `service_image` in either var file.

1. Run the before-each-apply checks.
2. `terraform init -backend-config=backend/staging.hcl -lockfile=readonly`
3. Plan with both var files. Paste add/change/destroy counts and Terraform resource addresses with action only. Expected: eight `module.rds[0]` creates, nothing else.
4. **Stop** if the plan changes `module.admin_static[0].aws_cloudfront_response_headers_policy.admin` or `module.ingress.aws_apigatewayv2_api.tenant`, or if the counts differ from eight RDS creates. Reconcile state first; the cost window has not started.
5. Apply with the same var files. Record the UTC completion time under **Cost anchor**.
6. Wait until the RDS instance status is `available` (read-only describe; do not record identifiers).

**Apply 2 (owner)** — digest in the gitignored `staging.local.tfvars` only.

1. Set `service_image` to the digest URI from the pre-check (`<registry>/ch-staging/service@sha256:<digest>`). The registry host stays only in that gitignored file.
2. Plan and apply. Expected: exactly ten new ECS-related resources (cluster, capacity providers, service task definition, service, ECR pull policy, task API ingress rule, ops task definition, ops execution role, ops task role, ops execution policy). **Stop** if the plan shows anything else.
3. Wait until the ECS service is stable and the VPC link name `ch-staging-link` is `AVAILABLE`.

### Retrospective record (CSP and CORS, 2026-10-12)

The owner applied the admin content-security-policy change and the gateway CORS change to staging on 2026-10-12 before those commits merged. The applied commit SHA is confirmed by the owner when evidence is written (believed `836a3f9` in the spec; the owner fills the actual SHA in the evidence commit). Plan for that apply: 0 add, 2 change, 0 destroy. Record counts and addresses with action only; no ARNs.

### One-off network

Hold these in the shell. Never record their values.

| Variable                     | Meaning                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `${AWS_PROFILE}`             | Apply and one-off profile (default `ch-admin`)                                                         |
| `${CLUSTER}`                 | ECS cluster name for staging (`ch-staging`)                                                            |
| `${SERVICE_TASK_DEFINITION}` | Service task definition family (`ch-staging`, from `aws_ecs_task_definition.this` family = `var.name`) |
| `${OPS_TASK_DEFINITION}`     | Ops task definition family (`ch-staging-db-ops`)                                                       |
| `${SUBNET}`                  | Staging public subnet id (from Terraform / describe; never recorded)                                   |
| `${TASK_SECURITY_GROUP}`     | Task security group id (from Terraform / describe; never recorded)                                     |
| `${LOG_GROUP}`               | Service log group `/community-hub/ch-staging/service` (streams use prefixes `service` and `db-ops`)    |

Same network pattern as **Apply product migrations**: task security group, staging public subnet, public address. Command override only; do not set `entryPoint`. Service container name is `service`. Ops container name is `db-ops`. After each one-off, wait stopped, describe the exit code, and read the log stream the same way the migrate section does (`service/service/<task-id>` or `db-ops/db-ops/<task-id>`). Do not paste a stopped reason that names a registry or a secret.

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
      --query 'tasks[0].taskArn' --output text)

**2b — uid and gid (service).** Expected: stdout exactly `1000 1000`, stderr empty, exit 0.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${SERVICE_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"service","command":["node","--input-type=module","-e","try{console.log(String(process.getuid())+'\'' '\''+String(process.getgid()));}catch{console.error('\''fail'\'');process.exit(1);}"]}]}' \
      --query 'tasks[0].taskArn' --output text)

**2c — read-only root (service).** Tries to write under `/app` and exits 0 only if the write is refused. Expected: exit 0, stderr empty.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${SERVICE_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"service","command":["node","--input-type=module","-e","import{writeFileSync}from'\''node:fs'\'';try{writeFileSync('\''/app/proof-write'\'','\''ok'\'');console.error('\''fail'\'');process.exit(1);}catch{/* write refused */}"]}]}' \
      --query 'tasks[0].taskArn' --output text)

**2d — bootstrap (ops).** After 2a–2c. Command `["node","/app/db-bootstrap.js"]`. Expected: exit 0, stdout exactly one integer and one newline, stderr empty. A non-integer or a non-zero exit stops the run.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${OPS_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"db-ops","command":["node","/app/db-bootstrap.js"]}]}' \
      --query 'tasks[0].taskArn' --output text)

**2e — probe (service).** After 2d succeeds. Command `["node","/app/probe.js"]`. Expected: stdout `pass`, stderr empty, exit 0.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${SERVICE_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"service","command":["node","/app/probe.js"]}]}' \
      --query 'tasks[0].taskArn' --output text)

**Stop if:** proof 1 (service healthy) or any of 2a–2e fails — go to re-park.

### Proof 3

Run **Apply product migrations** twice (same network as 2d). First run: one `applied <tag>` per journal entry from the pre-check, then `done applied=<n> total=<m>`. Second run: stdout exactly `done applied=0 total=<m>`, no `applied` lines. Exit 0 and stderr empty both times.

**Stop if:** exit 1.

### Row counts (counts only)

Proof 5, after the OTP requests and before proof 7b. Owner runs two ops one-offs on family `${OPS_TASK_DEFINITION}`, container `db-ops`, same network as 2d. The ops task already injects `PGHOST`, `PGPORT`, `PGDATABASE`, `PGPASSWORD_IDENTITY`, and `PGPASSWORD_PLATFORM` (`apps/api/src/db-ops-env.ts` and `aws_ecs_task_definition.db_ops`). Login `identity` reads `PGPASSWORD_IDENTITY`. Login `platform` reads `PGPASSWORD_PLATFORM`. CA file is `/app/certs/rds-ap-southeast-2-bundle.pem` (`IMAGE_CERT_PATH` in `apps/api/src/env.ts`). Each command uses `@community-hub/db` `createDirectSql` the same way `apps/api/src/probe.ts` does: omit `servername` because ops `PGHOST` is DNS, not an IP. Output is one line of space-separated integers in the fixed table order only.

**Identity** — tables in order: `identity_keys`, `otp_challenges`, `users`, `sessions`, `passkey_challenges`, `passkey_credentials`. Expected after proof 3 and the proof 5 OTP posts: `1 0 0 0 0 0`.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${OPS_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"db-ops","command":["node","--input-type=module","-e","import{createDirectSql}from'\''@community-hub/db'\'';import{readFileSync}from'\''node:fs'\'';try{const pem=readFileSync('\''/app/certs/rds-ap-southeast-2-bundle.pem'\'','\''utf8'\'');const e=process.env;const sql=createDirectSql({host:e.PGHOST,port:Number(e.PGPORT),database:e.PGDATABASE,user:'\''identity'\'',password:e.PGPASSWORD_IDENTITY,ca:pem});const t=['\''identity_keys'\'','\''otp_challenges'\'','\''users'\'','\''sessions'\'','\''passkey_challenges'\'','\''passkey_credentials'\''];const o=[];for(const n of t){const r=await sql.unsafe('\''select count(*)::int c from identity.'\''+n);o.push(r[0].c);}console.log(o.join('\'' '\''));await sql.end({timeout:1});}catch{console.error('\''fail'\'');process.exit(1);}"]}]}' \
      --query 'tasks[0].taskArn' --output text)

**Platform** — tables in order: `organisations`, `communities`, `plans`, `plan_entitlements`, `add_ons`, `add_on_entitlements`, `organisation_plans`, `organisation_add_ons`, `community_allocations`, `community_toggles`, `entitlement_overrides`, `feature_flags`. Expected on a fresh database: twelve zeros.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${OPS_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"db-ops","command":["node","--input-type=module","-e","import{createDirectSql}from'\''@community-hub/db'\'';import{readFileSync}from'\''node:fs'\'';try{const pem=readFileSync('\''/app/certs/rds-ap-southeast-2-bundle.pem'\'','\''utf8'\'');const e=process.env;const sql=createDirectSql({host:e.PGHOST,port:Number(e.PGPORT),database:e.PGDATABASE,user:'\''platform'\'',password:e.PGPASSWORD_PLATFORM,ca:pem});const t=['\''organisations'\'','\''communities'\'','\''plans'\'','\''plan_entitlements'\'','\''add_ons'\'','\''add_on_entitlements'\'','\''organisation_plans'\'','\''organisation_add_ons'\'','\''community_allocations'\'','\''community_toggles'\'','\''entitlement_overrides'\'','\''feature_flags'\''];const o=[];for(const n of t){const r=await sql.unsafe('\''select count(*)::int c from platform.'\''+n);o.push(r[0].c);}console.log(o.join('\'' '\''));await sql.end({timeout:1});}catch{console.error('\''fail'\'');process.exit(1);}"]}]}' \
      --query 'tasks[0].taskArn' --output text)

### HTTP proofs (assistant)

Shapes only. Never paste hostnames or the synthetic address into evidence.

**Proof 4 — preflight.** `OPTIONS` to `/v1/access/grants/list` on the api hostname and again on the auth hostname. Headers: `Origin` set to the admin origin, `Access-Control-Request-Method: POST`, `Access-Control-Request-Headers: authorization,content-type`. Repeat both with an origin that is not the admin origin. Expected for the admin origin: status 204; CORS headers match `cors_configuration` in `infra/modules/aws-ingress/main.tf` (`access-control-allow-origin` reflects the admin origin, methods include `GET`, `POST` and `OPTIONS`, headers include `authorization` and `content-type`, no `access-control-allow-credentials`). Record status and that the headers match; do not paste origin strings or full header values. Other origin: no `access-control-allow-origin`; record status, do not assert it. Control: the same preflight to the ops hostname `/health` → expect 404 and no `access-control-allow-origin`. Record whether the service log group shows an `OPTIONS` line. The webhooks hostname answer is recorded and not asserted.

**Proof 5 — email OTP.** Two `POST` requests to the auth hostname path `/v1/auth/email-otp/start`, header `content-type: application/json`, body `{"email":"<synthetic>"}`. The synthetic address uses local part `proof` plus eight random hex digits and a domain reserved for tests under RFC 2606; generate it for the run and never write it into the runbook. Then one `POST` with a malformed address. Expected: both valid requests return 503 with an empty body; malformed returns 400 with an empty body. A 500 means stop and record `errorClass` / `errorCode` from the request log at once. A 204 means a mail port other than the boot port is running; stop. CloudTrail (read-only): after the first request, one `GenerateDataKey` and one `Decrypt` (count 1 each), encryption-context key names `key_kind`, `region`, `key_version` only. After the second, one more `Decrypt` and no second `GenerateDataKey`. Service log: `kms` lines with fields `operation` (`generate_data_key` or `decrypt`), `outcome` (`ok`), `key_kind` (`identity`); no `errorClass` on those lines. Then run the row-count one-offs above.

**Proof 6 — refused routes.** All `POST` with `content-type: application/json`. Placeholder slug e.g. `proof-run-no-community`. Where a bearer is required, use 43 random base64url characters.

- 6a. Api hostname `/v1/access/grants/list`, body `{"communitySlug":"<slug>"}`, no `Authorization`. Expected: 401, empty body.
- 6b. Same path and body with `Authorization: Bearer` plus 43 random base64url characters. Expected: 401, empty body (needs proof 3).
- 6c. Same body to the auth hostname. Expected: 404, empty body.
- 6d. Body with an extra key on the api hostname. Expected: 400, empty body.
- 6e. Api hostname `/v1/entitlements/list`, body `{"communitySlug":"<slug>"}`, no `Authorization`. Expected: 401, empty body.
- 6f. Api hostname `/v1/entitlements/toggle`, body `{"communitySlug":"<slug>","key":"people.directory","enabled":true}`, no `Authorization`. Expected: 401. With a bearer of 43 random base64url characters, also 401 (needs proof 3). On the auth hostname, either body returns 404.

### Proof 7a

Assistant tries `iam:SimulatePrincipalPolicy` once for the service task role against `secretsmanager:GetSecretValue` on each of the three database secrets and `kms:Decrypt` on the secrets key. Expected: `allowed` for all four. If the call is refused, the human pastes a table of action and effect per statement from the attached policy, with each resource shown as redacted; the assistant reads that table against the same four actions.

Then the owner runs a one-off of the **service** task definition (task role, not the execution role). The service container already has `IDENTITY_SECRET_ARN` in its environment (`infra/modules/aws-ingress/main.tf`). Confirm the name with `describe-task-definition` if needed; never record the value. The command calls `GetSecretValue` with `VersionStage` `AWSCURRENT` via `@aws-sdk/client-secrets-manager` and prints `pass` only when a non-empty string comes back. On any failure: stdout empty, stderr exactly `fail`, exit 1.

    TASK_ARN=$(aws ecs run-task \
      --profile ${AWS_PROFILE} \
      --cluster ${CLUSTER} \
      --task-definition ${SERVICE_TASK_DEFINITION} \
      --launch-type FARGATE \
      --network-configuration "awsvpcConfiguration={subnets=[${SUBNET}],securityGroups=[${TASK_SECURITY_GROUP}],assignPublicIp=ENABLED}" \
      --overrides '{"containerOverrides":[{"name":"service","command":["node","--input-type=module","-e","import{GetSecretValueCommand,SecretsManagerClient}from'\''@aws-sdk/client-secrets-manager'\'';try{const id=process.env.IDENTITY_SECRET_ARN;if(!id)throw 0;const r=await new SecretsManagerClient({}).send(new GetSecretValueCommand({SecretId:id,VersionStage:'\''AWSCURRENT'\''}));if(typeof r.SecretString!=='\''string'\''||r.SecretString.length===0)throw 0;console.log('\''pass'\'');}catch{console.error('\''fail'\'');process.exit(1);}"]}]}' \
      --query 'tasks[0].taskArn' --output text)

**Stop if:** non-zero exit or denied simulate with no matching redacted policy table.

### Proof 7b

Order: after proofs 5 and 6b and 6f and the row-count one-offs. The rotation must never display a secret.

1. Owner forces a new deployment of the service and waits until it is stable, so the pool is empty and start-time environment holds the current password.
2. Owner generates a new random value and puts it on the identity secret in one pipeline, with nothing echoed and nothing left in shell history beyond the pipeline itself. Hold the secret id in `${IDENTITY_SECRET_ID}` from a read-only describe (never recorded):

   openssl rand -base64 48 | tr -d '\n' | aws secretsmanager put-secret-value \
   --profile ${AWS_PROFILE} \
      --secret-id ${IDENTITY_SECRET_ID} \
   --secret-string file:///dev/stdin

3. Owner re-runs proof 2d (`node /app/db-bootstrap.js`). That one-off reads the secrets at task start and runs `ALTER ROLE` so the database role passwords match the secrets (`setLoginPasswords` in the bootstrap path). **If this step fails:** the secret holds a value the role does not; the running service still works on its old start-time password. Re-run 2d, or re-park. Do not print the secret. Do not leave the mismatch for a later day without re-parking.
4. Assistant repeats one proof 5 `POST /v1/auth/email-otp/start`. Expected: 503, not 500. CloudTrail (read-only, may lag ~15 minutes): event name `GetSecretValue`, count 2, by the task role for the identity secret in that window.

**Stop if:** OTP is not 503.

### Proof 8–9

**Proof 8 (assistant).** Admin origin `GET /`: expect 200 and one `h1` named Dashboard. For `content-security-policy`, record "both origins present" in `connect-src` and "no other origin"; do not paste the header. Confirm other directives still match `local.content_security_policy` in `infra/modules/aws-admin-static/main.tf` without pasting values. Fetch the page's script asset and record "both origins present" and "no other origin" in the bundle. Browser pass (signed out): open `/`, follow Users & Roles, Module Toggles, Sign in; enter the synthetic address; press Send code. Direct loads of `/sign-in`, `/settings/users` and `/settings/modules` return 403 from CloudFront (no `custom_error_response`); start at `/`. Expected while signed out: each Settings page shows the heading and `Sign in required`. After Send code: page shows `Sign-in failed`; record that one preflight returned 204 and one `POST` returned 503 (status only). Record CloudFront 403 on deep links as a finding only; do not fix here.

**Proof 9 (assistant).** Read-only `filter-log-events` on the service log group (`/community-hub/ch-staging/service`, stream prefixes `service` and `db-ops`) and the tenant API access log group (`/community-hub/ch-staging/api-access`) over the whole window. Searches expected to return zero events unless a hit is only inside `errorClass` or `errorCode` on a `request` or `kms` line: the string `proof` followed by hex; the `@` character; the word `Bearer`; any run of eight digits outside a `requestId` or `gatewayRequestId` value; the synthetic address's local part; the community slug placeholder; the strings `identity.`, `password` and `secret`. Request log fields (`packages/kernel` via `apps/api/src/gate.ts`): message `request`, plus `method`, `path` (route pattern), `status`, `duration`, `requestId`, optional `gatewayRequestId`, and on a thrown 500 also `errorClass` and optional `errorCode`. KMS log fields (`apps/api/src/kms/aws-kms-adapter.ts`): message `kms`, plus `operation`, `outcome`, optional `key_kind`, and `errorClass` when outcome is `failed`. Never paste `hostname` from gate not-found lines. If any proof produced a 500, record `status`, `path`, `errorClass` and `errorCode` at once; if none did, say so.

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
