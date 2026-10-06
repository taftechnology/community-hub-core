Spec: docs/specs/2026-10-06-first-running-task.md

# First running task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unpark staging long enough to record a running task, the ops bootstrap, and the nine proofs, then park it again.

**Architecture:** Seven agent commits. Tests pin the plan gates that already exist on `main`. One commit turns the database and the desired count on. The human builds, pushes, applies, and runs tasks. Two commits record evidence. One commit parks the flags. One commit records the empty plan. The last commit updates the catalogue. Nothing in an agent task calls AWS.

**Tech Stack:** Terraform 1.11.4, `terraform test`, the existing `apps/api` image. No new dependency. No AWS call by the agent.

Status: draft

**Branch:** `feat/2026-10-06-first-running-task` · one PR · 7 agent commits

## Global Constraints

- The spec is approved. Do not edit `docs/specs/2026-10-06-first-running-task.md`. Do not edit `docs/specs/2026-10-06-db-ops-task.md`.
- The agent does not run `terraform apply`, `docker push`, `docker build` of the proof image, `aws`, or any command in a **Human** section. Those sections are for the human. Placeholders (`<account-id>`, `<digest>`, `<staging-public-subnet-id>`, `<task-security-group-id>`, `<vpc-link-security-group-id>`, `<service-task-private-ipv4>`) stay placeholders in git.
- `service_image` is never committed. Tests keep account `123456789012`. The committed staging file never gains a `service_image` line and never sets `enable_kms_endpoint`.
- No real account id, hosted zone id, alarm email, key ARN, secret ARN, password, task address, or VPC endpoint id in the plan, the tests, or the runbook evidence.
- From Task 2 on: no rebase, no amend, and no force-push. If `origin/main` moves, bring it in with a merge commit. The pull request merges with a merge commit, never a squash. The PR body says this departs from AGENTS.md §5 because a rebase would replace the SHAs the runbook records.
- This chunk does not add the ops task, the bootstrap program, the `CMD` change, an image-publish role, a NAT gateway, a load balancer, a second interface endpoint, or a budget change. `failure_threshold` stays.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Do not mark this plan approved yourself.
- Second fresh-context review is required. This chunk unparks the database, starts the task, runs the ops task, and runs the probe against KMS. Leave that line open in the PR. Do not write the second review.
- Agent tasks run `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/api && pnpm check:boundaries` before the commit, plus the Terraform sequence named in that task.

**Rollback:** The re-park commit is the rollback. If a proof fails before that commit exists, the human still applies the parked flags. Exact steps are under **Rollback** below. The agent does not run them.

**Cost:** Already approved in the spec. Running month while proofs are in progress and the endpoint is off: USD 40.50. Lasting parked month after the re-park: USD 6.30. The one-zone KMS endpoint is about USD 9.49 a month for the hours it exists and is not part of either total. The budget stays USD 50. No new hourly or monthly resource type.

## File map

| File                                     | Responsibility                                                      |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `infra/regions/au/tests/cell.tftest.hcl` | Unpark, image-null, re-park, and endpoint-off asserts.              |
| `infra/regions/au/env/staging.tfvars`    | Unpark, then re-park. No `service_image`. No `enable_kms_endpoint`. |
| `docs/runbooks/apply-staging-au.md`      | Redacted evidence. Historical sections stay.                        |
| `docs/roadmap.md`, `AGENTS.md`           | Catalogue. Last commit only.                                        |

---

### Task 1: Pin the plan gates

**Files:**

- Modify: `infra/regions/au/tests/cell.tftest.hcl`

**Interfaces:**

- Consumes: the cell runs already on `main`. `module.ingress.ecs_service_desired_count` is `var.desired_count` when the image is set and `0` when it is null. `aws_ecs_task_definition.db_ops` exists only when the image is set and `enable_database` is true.
- Produces: the spec's plan asserts. No module code changes.

**Rule this must not break:** root tests reference root resources and module outputs only. Do not assert `module.ingress.aws_ecs_service` or any other child resource. Do not edit `infra/modules/aws-ingress/tests/ingress.tftest.hcl`. That file already asserts `assign_public_ip == true`. Production with the database off, and a digest with the database off, keep `expect_failures`.

The behaviour under test is already on `main`. Write the asserts first. A passing test is the expected result. If an assert fails, stop and report. Do not change a module to force it green.

- [ ] **Step 1: Write the asserts**

In `cell.tftest.hcl`, add run `staging_unpark`. `command = plan`. Staging variables as in `staging_image_set`, with `enable_database = true`, `desired_count = 1`, and the same synthetic digest (`123456789012`, `sha256:0123…abcdef`). Do not set `enable_kms_endpoint`. Assert all of:

- `length(module.rds) == 1`
- `module.ingress.ecs_service_desired_count == 1`
- `length(module.ingress.task_subnet_ids) == 1`
- `length(aws_ecs_task_definition.db_ops) == 1`
- `module.envelope.endpoint_id == null`

Add run `staging_image_null`. Same staging variables, `enable_database = true`, `desired_count = 1`, and no `service_image`. Assert:

- `length(module.rds) == 1`
- `module.ingress.ecs_service_desired_count == 0`
- `length(aws_ecs_task_definition.db_ops) == 0`
- `length(aws_iam_role.db_ops_execution) == 0`

On `database_off`, set `desired_count = 0` in the variables and assert `module.ingress.ecs_service_desired_count == 0`. Keep the existing asserts that the RDS module is absent, the ops task is absent, and the topic, subscription, hostname alarm, and budget remain.

Add one file assert, on `staging_happy` or `database_off`: `env/staging.tfvars` does not contain `service_image` and does not contain `enable_kms_endpoint`.

Do not edit `prod_database_off_fails` or `image_without_database_fails`. Do not edit `staging_endpoint_on`. That run already plans the endpoint when the flag is true.

- [ ] **Step 2: Run the test**

Run: `terraform -chdir=infra/regions/au test`

Expected: PASS, including `staging_unpark`, `staging_image_null`, `database_off`, `prod_database_off_fails`, `image_without_database_fails`, and `staging_endpoint_on`. The two `expect_failures` runs pass by failing the plan.

- [ ] **Step 3: Gate and commit**

In `infra/regions/au`: `terraform init -backend=false -lockfile=readonly`, `terraform fmt -check`, `terraform validate`, `tflint --init`, `tflint`, `terraform test`.

Run: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/api && pnpm check:boundaries`

```bash
git add infra/regions/au/tests/cell.tftest.hcl
git commit -m "$(cat <<'EOF'
test(infra): lock the unpark plan gates

A set image plans the service and the ops task. An unset image
plans neither. Re-park values plan no database and no service.

EOF
)"
```

Push. No rebase, no force-push.

---

### Task 2: Unpark commit

**Files:**

- Modify: `infra/regions/au/env/staging.tfvars`

**Interfaces:**

- Consumes: `enable_database = false` and `desired_count = 0`.
- Produces: `enable_database = true` and `desired_count = 1`. `enable_budgets` stays true. No `service_image` line. No `enable_kms_endpoint` line. Deletion protection stays false. Backup retention stays 0.

**Rule this must not break:** the Task 1 file assert. This commit is the SHA the human applies first. After this commit lands on the remote, nobody rebases, amends, or force-pushes this branch.

- [ ] **Step 1: Change the two flags**

Set `enable_database = true` and `desired_count = 1`. Run `terraform fmt infra/regions/au/env/staging.tfvars`.

- [ ] **Step 2: Gate and commit**

`terraform -chdir=infra/regions/au test` still passes. `staging_unpark` does not read the tfvars flags except the file assert from Task 1, which must still pass.

Run the same pnpm gate as Task 1.

```bash
git add infra/regions/au/env/staging.tfvars
git commit -m "$(cat <<'EOF'
feat(infra): unpark staging for the first running task

This SHA is the first apply. The database comes back and the
desired count is 1. The image stays in the gitignored file.

EOF
)"
```

Push. Record the full SHA in the PR as the unpark SHA. Do not apply.

---

## Human: build, apply, ops task, proofs

The agent stops here. The human runs this section. Paste back only the fields each step names. Do not paste an account id, a hosted zone id, an alarm email, a key ARN, a secret ARN, a password, a registry hostname, a task address, a task ARN, or a VPC endpoint id.

Profile is `ch-admin`. Region is `ap-southeast-2`. Both var files are passed, the gitignored file last. `git status` is clean and `git rev-parse HEAD` is the SHA named for that apply, and that SHA is on `origin`.

### a. Image

Clean checkout of `main` at `d4b22132d69ae02413d257b3bf3df1b6fa162a6f` or a later `main` that contains it. Not the unpark commit. From the repo root:

```bash
git fetch origin
git switch --detach d4b22132d69ae02413d257b3bf3df1b6fa162a6f
docker build --platform linux/arm64 -f apps/api/Dockerfile -t community-hub-api:local .
RUN_IMAGE_TESTS=1 pnpm --filter @community-hub/api exec vitest run --config vitest.config.ts src/image.test.ts
```

The image test must pass on that exact local image. Then:

```bash
aws ecr get-login-password --profile ch-admin --region ap-southeast-2 \
  | docker login --username AWS --password-stdin <account-id>.dkr.ecr.ap-southeast-2.amazonaws.com
docker tag community-hub-api:local <account-id>.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service:run1
docker push <account-id>.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service:run1
```

Copy the `sha256:` digest from the push. Immutable tags and scan-on-push are already on.

```bash
aws ecr wait image-scan-complete --profile ch-admin --region ap-southeast-2 \
  --repository-name ch-staging/service --image-id imageDigest=sha256:<digest>
aws ecr describe-image-scan-findings --profile ch-admin --region ap-southeast-2 \
  --repository-name ch-staging/service --image-id imageDigest=sha256:<digest> \
  --query 'imageScanFindings.findingSeverityCounts' --output json
```

Paste the severity counts. If `CRITICAL` is greater than 0, stop. Do not set `service_image`. Do not apply the task. A later `main` may be used for a rebuilt image; name that SHA. Do not waive a critical finding.

### b. Apply with no image

On the Task 2 SHA, from `infra/regions/au`. `staging.local.tfvars` has no `service_image`.

```bash
terraform init -backend-config=backend/staging.hcl -lockfile=readonly
terraform apply -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
aws rds wait db-instance-available --profile ch-admin --region ap-southeast-2 \
  --db-instance-identifier ch-staging-postgres
```

Paste the apply summary (added, changed, destroyed) and that the wait finished. This apply creates the database. It does not create the cluster, the service task definition, the service, or the ops task definition.

### c. Set the digest and apply again

In `infra/regions/au/env/staging.local.tfvars` only:

```hcl
service_image = "<account-id>.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/service@sha256:<digest>"
```

```bash
terraform apply -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
```

Paste the apply summary. This creates the service at count 1 and the ops task definition. The evidence records the digest, not the registry hostname.

### d. VPC link, then the ops task

```bash
aws apigatewayv2 get-vpc-links --profile ch-admin --region ap-southeast-2 \
  --query 'Items[?Name==`ch-staging-link`].VpcLinkStatus' --output text
```

If the status is `INACTIVE` or `PENDING`, wait and repeat until it is `AVAILABLE`. A failed health check before that is not a task fault. Paste the status word only.

Look up ids by name. Do not commit them.

```bash
aws ec2 describe-subnets --profile ch-admin --region ap-southeast-2 \
  --filters Name=tag:Name,Values=ch-staging-public-ap-southeast-2a \
  --query 'Subnets[0].SubnetId' --output text
aws ec2 describe-security-groups --profile ch-admin --region ap-southeast-2 \
  --filters Name=group-name,Values=ch-staging-task \
  --query 'SecurityGroups[0].GroupId' --output text
```

Run the ops task. Command override only. No `entryPoint`.

```bash
aws ecs run-task --profile ch-admin --region ap-southeast-2 \
  --cluster ch-staging \
  --task-definition ch-staging-db-ops \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[<staging-public-subnet-id>],securityGroups=[<task-security-group-id>],assignPublicIp=ENABLED}' \
  --overrides '{"containerOverrides":[{"name":"db-ops","command":["node","/app/db-bootstrap.js"]}]}'
```

Wait until the task stops. Read the exit code locally. Read stdout from log group `/community-hub/ch-staging/service`, stream prefix `db-ops`. Paste the exit code and the stdout line. Exit must be 0 and stdout must be one integer and nothing else, before any later proof. Do not paste the task ARN.

### e. Proofs

Do not start until step d exited 0. Record proofs 1–8 against the step c apply SHA. Proof 5 is the integer from step d, not a second ops run. Proof 9 names its own applies.

1. Health and Cloud Map.

```bash
curl -sS -D - -o /dev/null https://au.api.communityhub-staging.net/health
```

Look up the Cloud Map service by namespace `ch-staging.local` and name `service`, then list instances. Paste the HTTP status and "one healthy instance". Do not paste an instance id or an address. The earlier empty-map result was 500, not 503.

2. Security groups. Compare live rules for `ch-staging-task`, `ch-staging-rds`, and `ch-staging-vpc-link` with the parked set in the runbook, plus inbound TCP 8080 on `ch-staging-task` from `ch-staging-vpc-link`. Paste "match" or the extra rule. No other new rule.

3. `/tmp` write. Same cluster, task definition `ch-staging`, launch type `FARGATE`, the staging public subnet, the task security group, `assignPublicIp=ENABLED`. Container `service`. Command override only:

```json
["node", "-e", "require('node:fs').writeFileSync('/tmp/probe-write','ok')"]
```

Paste the exit code. `desired_count` stays 1. ECS Exec stays off.

4. Probe. Same network as step 3. Container `service`. Command `["node", "/app/probe.js"]`. No `entryPoint`. Paste stdout, stderr, and the exit code. Expected: stdout `pass`, stderr empty, exit 0. This is the database round trip and the KMS round trip with the endpoint off.

5. Paste the integer from step d again, and nothing else. There is no master session.

6. Rolling deploy of the same task definition.

```bash
aws ecs update-service --profile ch-admin --region ap-southeast-2 \
  --cluster ch-staging --service ch-staging --force-new-deployment
```

From the start of that deployment until the new task is healthy, count HTTP 5xx from `GET /health` on `https://au.api.communityhub-staging.net/health`. No body, no query string, no personal data. Paste the count. A 500 while Cloud Map is empty counts as a 5xx from that cause.

7. Steady traffic: 60 requests over 60 seconds, same URL and the same restrictions.

```bash
for i in $(seq 1 60); do
  curl -sS -o /dev/null -w '%{http_code}\n' https://au.api.communityhub-staging.net/health
  sleep 1
done
```

Paste the 5xx count. That count confirms `keepAliveTimeout` 65000 and `requestTimeout` 30000. Change those two numbers only when the count is not zero and the log shows a timeout. Otherwise leave them. A change is one later commit, and this loop is run again.

8. Hostname alarm. Look up `ch-staging-vpc-link` the same way as the task group. Describe the running service task and take its private IPv4. Do not paste that address.

One-off task, task definition `ch-staging`, container `service`, both security groups, the staging public subnet, `assignPublicIp=ENABLED`. Command override only, so the request has no Host header:

```json
[
  "node",
  "-e",
  "const s=require('node:net').connect(8080,process.env.TARGET); s.on('connect',()=>s.end('GET /health HTTP/1.1\\r\\n\\r\\n'));"
]
```

Pass `TARGET` as `<service-task-private-ipv4>` in the container environment override. Stop that one-off task after it exits. In log group `/community-hub/ch-staging/service`, confirm `missing_hostname_header`. Then:

```bash
aws cloudwatch describe-alarms --profile ch-admin --region ap-southeast-2 \
  --alarm-names ch-staging-missing-hostname-header \
  --query 'MetricAlarms[0].StateValue' --output text
```

Paste the log reason and the alarm state. Expected: `missing_hostname_header` and `ALARM`. Do not paste the address. Port 8080 is not opened to the internet.

9. Endpoint. This is its own apply. The committed file stays unchanged.

```bash
terraform apply -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars \
  -var enable_kms_endpoint=true
```

Run the probe again with the step 4 command. Paste stdout `pass` and exit 0. Then:

```bash
aws cloudtrail lookup-events --profile ch-admin --region ap-southeast-2 \
  --lookup-attributes AttributeKey=EventName,AttributeValue=GenerateDataKey \
  --max-results 5
```

Confirm the probe event has `vpcEndpointId`. Paste the word `present`. Do not paste the id. Then:

```bash
terraform apply -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars \
  -var enable_kms_endpoint=false
```

Paste both apply summaries. The endpoint and its security group are destroyed. `enable_kms_endpoint` in git is still unset.

---

### Task 3: Record the running-task evidence

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`

**Interfaces:**

- Consumes: the human's paste from steps b, c, d, and proofs 1–8.
- Produces: a new section after "Change a database role". It names the Task 2 SHA for the database apply and the step c SHA if that apply was a later commit. It records the digest, the scan severity counts, the ops exit code, the integer, and proofs 1–8.

**Rule this must not break:** do not edit the historical First apply, Park, or Restore drill evidence. Redact the account id, the hosted zone id, the alarm email, every key ARN, every secret ARN, every password, every task address, and every VPC endpoint id. Do not write a registry hostname or a task ARN.

- [ ] **Step 1: Write the section from the paste**

If the human has not pasted, stop. Do not invent results. The section says the ops task ran `db-bootstrap.js` and a person did not open a master session.

- [ ] **Step 2: Gate and commit**

Run the pnpm gate from Task 1.

```bash
git add docs/runbooks/apply-staging-au.md
git commit -m "$(cat <<'EOF'
docs(runbooks): record the first running task proofs

The ops task printed SHOW max_connections. The evidence names the
apply SHA and leaves every secret and address out.

EOF
)"
```

Push. No rebase, no amend, no force-push.

---

### Task 4: Record the endpoint proof

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`

**Interfaces:**

- Consumes: the human's paste from proof 9, including both apply summaries.
- Produces: a separate section. It names the SHA that was applied with the flag true, then the apply that set the flag false. The evidence says `vpcEndpointId` was present. It does not contain the id.

**Rule this must not break:** the committed tfvars still do not set `enable_kms_endpoint`. Do not fold this into Task 3.

- [ ] **Step 1: Write the section from the paste**

If the human has not pasted proof 9, stop.

- [ ] **Step 2: Gate and commit**

Run the pnpm gate from Task 1.

```bash
git add docs/runbooks/apply-staging-au.md
git commit -m "$(cat <<'EOF'
docs(runbooks): record the KMS endpoint proof

The flag was true for one apply and is false again. The evidence
says the endpoint id was present and does not record it.

EOF
)"
```

Push. No rebase, no amend, no force-push.

---

### Task 5: Re-park commit

**Files:**

- Modify: `infra/regions/au/env/staging.tfvars`

**Interfaces:**

- Consumes: `enable_database = true` and `desired_count = 1`.
- Produces: `enable_database = false` and `desired_count = 0`. `enable_budgets` stays true. Still no `service_image` and no `enable_kms_endpoint`.

**Rule this must not break:** production still refuses `enable_database` false. A digest with the database off still fails. This commit is the rollback SHA.

- [ ] **Step 1: Set the two flags back**

`terraform fmt` the file. `terraform -chdir=infra/regions/au test` passes, including `database_off`, `prod_database_off_fails`, and `image_without_database_fails`.

- [ ] **Step 2: Gate and commit**

Run the pnpm gate from Task 1.

```bash
git add infra/regions/au/env/staging.tfvars
git commit -m "$(cat <<'EOF'
feat(infra): park staging after the first running task

The database flag is false and the desired count is 0. The image
is cleared in the gitignored file, not in this commit.

EOF
)"
```

Push. No rebase, no amend, no force-push.

---

## Human: null the image and apply the re-park

The agent stops. On the Task 5 SHA, in `staging.local.tfvars`, set `service_image = null` or delete the line. From `infra/regions/au`:

```bash
terraform init -backend-config=backend/staging.hcl -lockfile=readonly
terraform apply -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
terraform plan -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
```

Paste the apply summary and that the plan printed `No changes` with exit 0. The database, the service, and the ops task definition are gone. The topic, the subscription, the hostname alarm, and the budget remain. `enable_kms_endpoint` is still false. Do not paste a secret or an address.

---

### Task 6: Record the re-park

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`

**Interfaces:**

- Consumes: the human's paste from the re-park apply and the following plan.
- Produces: proof 10. It names the Task 5 SHA. The plan showed no changes.

**Rule this must not break:** the redaction list. Do not claim the image line was committed.

- [ ] **Step 1: Write proof 10 from the paste**

If the human has not pasted, stop. Update the "Unpark is `first-running-task`" sentence so it no longer tells a later reader to unpark again. Leave the Park evidence section as history.

- [ ] **Step 2: Gate and commit**

Run the pnpm gate from Task 1.

```bash
git add docs/runbooks/apply-staging-au.md
git commit -m "$(cat <<'EOF'
docs(runbooks): record the re-park plan

The apply removed the database and the service. The following
plan showed no changes.

EOF
)"
```

Push. No rebase, no amend, no force-push.

---

### Task 7: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Consumes: the Phase 0 table, the snapshot, and the repository-state cell.
- Produces: `first-running-task` **done**, linking `docs/specs/2026-10-06-first-running-task.md`. Snapshot last shipped `first-running-task`, next chunk `image-publish`. Phase 0 stays `23 rows: 20 done, 1 superseded (api-au-hostname), 2 not started`. The repository-state sentence matches and names `image-publish` as next. `kms-mrk-replica` stays last. The sentence under the Phase 0 table that names the next chunk names `image-publish`.

**Rule this must not break:** do not edit any other sentence in `AGENTS.md`. Prettier may reflow the header table. Do not mark this plan approved in this commit.

- [ ] **Step 1: Update the row, the snapshot, and the repository-state sentence**

The row says the task ran, the proofs were recorded, staging was parked again, and the spec path.

- [ ] **Step 2: Gate and commit**

Run: `pnpm exec prettier --write docs/roadmap.md AGENTS.md`

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm check:boundaries`

```bash
git add docs/roadmap.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark the first running task done

Phase 0 is 23 rows: 20 done, 1 superseded, 2 not started. Next is
image-publish.

EOF
)"
```

Push. Open the PR only after this commit is on the remote. Merge commit, not squash. Second review line stays open.

---

## Rollback

The re-park commit is the rollback. The agent does not run this.

If a proof fails after the image apply and before Task 5:

1. In `staging.local.tfvars`, set `service_image = null` or delete the line.
2. In `env/staging.tfvars`, set `enable_database = false` and `desired_count = 0`. Commit that if it is not already Task 5, and push. No amend if the unpark SHA was applied.
3. From `infra/regions/au`:

```bash
terraform apply -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
terraform plan -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
```

4. Stop. The plan must show no changes. The database, the service, and the ops task definition are gone. If `enable_kms_endpoint` was left true, apply once more with `-var enable_kms_endpoint=false` before the re-park apply.

If the failure is a critical image scan, stop before any task apply. The unpark apply may already have created the database. Park with the steps above and do not set `service_image`.
