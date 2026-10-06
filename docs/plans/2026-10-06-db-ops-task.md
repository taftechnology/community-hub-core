Spec: docs/specs/2026-10-06-db-ops-task.md

# Database ops task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an ECS command override reach the probe, and add an ops task that bootstraps the database without sending a cleartext password.

**Architecture:** Five commits. The image `CMD` replaces `ENTRYPOINT`. `db-bootstrap.js` runs `bootstrap.sql`, then three `ALTER ROLE` statements that carry a client-side SCRAM-SHA-256 verifier. A separate task definition and execution role exist only when the image is set and the database is on. The runbook names that task. Nothing is applied. The last commit updates the catalogue.

**Tech Stack:** TypeScript, Node 24, Vitest, `@community-hub/db` `createDirectSql`, `runBootstrap`, and `setLoginPasswords`, Docker, Terraform 1.11.4, `terraform test`. No new dependency. No AWS call.

Status: approved (2026-10-06, Abdus)

**Branch:** `feat/2026-10-06-db-ops-task` · one PR · 5 tasks, one commit each

## Global Constraints

- The spec is approved. Do not edit `docs/specs/2026-10-06-db-ops-task.md`. Do not edit `docs/specs/2026-10-06-first-running-task.md` or its branch.
- No migration wave. There is no expand, migrate, or contract step. Bootstrap creates roles and empty schemas only when a later chunk runs the task.
- This chunk does not apply, push an image, or call AWS. `terraform apply` is out of the task gates.
- The service task definition, the service execution role, and the service task role gain nothing. The service execution role does not gain the master secret. Do not set `master_user_secret_kms_key_id`.
- A role password is passed only into the SCRAM verifier. The master password is passed only to `createDirectSql`. No statement text contains a cleartext password. Do not bind the password as a query parameter.
- No password, connection string, secret ARN, real account id, hosted zone id, or key ARN in the repo, the tests, or the runbook. Tests use the marker `planted-password-marker` and account `123456789012`.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Do not mark this plan approved yourself.
- This chunk injects the master password and adds an IAM role that can read it. A second fresh-context review reads the final diff and has not seen the implementation. Leave that line open in the PR. Do not write the second review yourself.
- Every task runs this gate before its commit, with the filter named in that task: `pnpm lint && pnpm typecheck && pnpm test --filter <filter> && pnpm check:boundaries`. Task 3 also runs the Stage 1 Terraform sequence in `infra/regions/au`, `infra/modules/aws-rds`, `infra/modules/aws-ingress`, and `infra/modules/aws-kms-envelope`. Task 5 runs the full CI sequence in §8 of `AGENTS.md` for the packages this branch touches, not a deploy.

**Rollback:** Revert the merge. Nothing is applied. There is no migration and no live secret change. Staging stays parked.

## File map

| File                                                       | Responsibility                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/api/Dockerfile`                                      | `CMD` instead of `ENTRYPOINT`.                                                                    |
| `apps/api/src/image.test.ts`                               | Command override with no `--entrypoint`. The image contains the program and the shipped SQL file. |
| `apps/api/src/db-bootstrap.ts`                             | Connect, call `runBootstrap` and `setLoginPasswords`, print `SHOW max_connections`.               |
| `apps/api/src/db-bootstrap.test.ts`                        | SQL-text must-fail, output must-fail, success, and the failure words.                             |
| `infra/modules/aws-rds/outputs.tf`                         | Master secret ARN output.                                                                         |
| `infra/modules/aws-ingress/outputs.tf`                     | `repository_arn` for the one service repository.                                                  |
| `infra/regions/au/main.tf`                                 | Ops task definition, task role with no policies, execution role.                                  |
| `infra/regions/au/tests/cell.tftest.hcl`                   | Count gates and the ops role's IAM assertions. Root resources only.                               |
| `infra/modules/aws-kms-envelope/tests/envelope.tftest.hcl` | Master secret ARN stays out of `execution_secrets`.                                               |
| `docs/runbooks/apply-staging-au.md`                        | "Change a database role" runs this task.                                                          |
| `docs/roadmap.md`, `AGENTS.md`                             | Catalogue. Last commit only.                                                                      |

---

### Task 1: Let a command override reach the probe

**Files:**

- Modify: `apps/api/Dockerfile`
- Modify: `apps/api/src/image.test.ts`

**Interfaces:**

- Consumes: the existing image test at the `docker run --entrypoint node` call.
- Produces: runtime stage `CMD ["node", "/app/index.js"]` and no `ENTRYPOINT`. `HEALTHCHECK` stays. `docker run <image> node /app/probe.js` with no `--entrypoint` exits 1, stdout `fail\n`, stderr `env\n`.

**Rule this must not break:** a container with no command still starts the server. The existing `startContainer` path in the same test is that proof. Do not put a secret in the image.

- [ ] **Step 1: Change the probe invocation first**

In `apps/api/src/image.test.ts`, replace the probe `docker run` so it does not pass `--entrypoint`. The arguments are `run`, `--rm`, the image name, `node`, `/app/probe.js`. Expected status, stdout, and stderr stay `1`, `fail\n`, and `env\n`.

- [ ] **Step 2: Run it and watch it fail**

Run: `RUN_IMAGE_TESTS=1 pnpm test --filter @community-hub/api -- src/image.test.ts`

Expected: FAIL. The entrypoint is still `node /app/index.js`, so the process is the server plus extra arguments and does not exit with the probe's `env` failure.

- [ ] **Step 3: Replace ENTRYPOINT with CMD**

In `apps/api/Dockerfile`, replace `ENTRYPOINT ["node", "/app/index.js"]` with `CMD ["node", "/app/index.js"]`. Do not edit `HEALTHCHECK`, `USER`, or `VOLUME`.

- [ ] **Step 4: Run the image test again**

Run the same command. Expected: the probe assertion passes, and the containers started with no command still become healthy.

- [ ] **Step 5: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/api && pnpm check:boundaries`

The image test is skipped unless `RUN_IMAGE_TESTS=1`. Step 4 is the proof for this task. The gate still has to pass.

```bash
git add apps/api/Dockerfile apps/api/src/image.test.ts
git commit -m "$(cat <<'EOF'
fix(api): let an ECS command override reach the probe

The image CMD is the server. A command replaces it, which ECS can do.
An entrypoint would start the server and never exit.

EOF
)"
```

---

### Task 2: Bootstrap program, SQL-text test first

`@community-hub/db` already exports `runBootstrap(sql)` and `setLoginPasswords(sql, passwords)` from `packages/db/src/bootstrap.ts`. `runBootstrap` reads `sql/bootstrap.sql`, then `constrainRoleAttributes` and `assertRoleAttributes`. It fails closed on `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB`, and `migrator` `LOGIN`, and it already omits the superuser clauses when the master is `rds_superuser`. `setLoginPasswords` sends `ALTER ROLE <role> PASSWORD '<SCRAM verifier>'` through `scram.ts`, after the `VERIFIER_SAFE` check. `packages/db/test/global-setup.ts` proves those verifiers by logging in as `app` through PgBouncer on every CI run. This task does not reimplement that, and it does not open the compose Postgres. Roles are cluster-wide, and Turbo runs packages in parallel, so an `apps/api` test that changed `app`'s password would race the `@community-hub/db` suite.

**Files:**

- Create: `apps/api/src/db-bootstrap.test.ts`
- Create: `apps/api/src/db-bootstrap.ts`
- Modify: `apps/api/src/image.test.ts`

**Interfaces:**

- Consumes: `createDirectSql`, `runBootstrap`, and `setLoginPasswords` from `@community-hub/db`. `IMAGE_CERT_PATH` from `./env.js`. The SQL file ships in the db package `files` list, so `runBootstrap` reads `node_modules/@community-hub/db/sql/bootstrap.sql` inside the image.
- Produces: `runDbBootstrap(deps)` exported for tests, and `node /app/db-bootstrap.js` as the compiled entry. Stdout on success is one integer and a newline. Stderr on failure is `env`, `bootstrap`, `alter_role`, or `max_connections`, plus one newline. Exit 0 or 1.

**Rule this must not break:** no cleartext password in any statement, stdout, or stderr. The production path uses `createDirectSql` with verify-full. Do not implement SCRAM. Do not read `bootstrap.sql` in this program. Do not print the verifiers `setLoginPasswords` returns. No new dependency. No Secrets Manager call. No secret ARN in the program. No Dockerfile copy of the SQL file. No Vitest alias.

Do not add `db-bootstrap.ts` until Step 2 has failed.

- [ ] **Step 1: Write the SQL-text must-fail test**

Add `apps/api/src/db-bootstrap.test.ts` only. Do not add `db-bootstrap.ts` in this step.

The test plants `planted-password-marker` as each role password and as the master password. It injects a connect function. The returned fake `Sql` records the full text of every `unsafe()` call and every tagged-template query. Assert all of these:

- The planted marker appears in no statement text.
- Three `ALTER ROLE` statements, for `app`, `identity`, and `platform`, carry a value starting with `SCRAM-SHA-256$`.
- The marker is also absent from stdout and stderr when the driver throws an error whose message is the marker.

Also cover, in this same file, before any implementation: success stdout is the `SHOW max_connections` integer plus one newline and stderr is empty; a second call exits 0 again; missing environment yields stdout empty, stderr `env\n`, exit 1; a `runBootstrap` failure yields `bootstrap`, a `setLoginPasswords` failure yields `alter_role`, and a `SHOW` failure yields `max_connections`, each with empty stdout. Connect is called with the master password, the host, the port, the database, user `postgres`, and the CA pem. The role passwords are not on that object.

The fake answers the attribute queries `runBootstrap` issues so both library calls run to completion. It does not replace them.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm test --filter @community-hub/api -- src/db-bootstrap.test.ts`

Expected: FAIL because `./db-bootstrap.js` does not exist. This is the RED. Do not commit.

- [ ] **Step 3: Call the existing functions**

Add `apps/api/src/db-bootstrap.ts`.

Read `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER` (`postgres` in the task), `PGPASSWORD_MASTER`, `PGPASSWORD_APP`, `PGPASSWORD_IDENTITY`, and `PGPASSWORD_PLATFORM` from the environment. A missing or empty value is the `env` failure.

Connect with `createDirectSql` the way the probe does: host, port, database, user, master password, and the image CA pem. Omit `servername` so a hostname is the server name. `rds.force_ssl` is 1. That factory is verify-full. Tests inject `deps.connect`.

Call `runBootstrap(sql)`, then `setLoginPasswords(sql, { app, identity, platform })`. Discard the returned verifiers. Do not print them. Then run `SHOW max_connections` and print that integer as the only stdout line.

A thrown driver error is not written. Map a `runBootstrap` failure to `bootstrap`, a `setLoginPasswords` failure to `alter_role`, and a `SHOW` failure to `max_connections`.

- [ ] **Step 4: Run the test and watch it pass**

Run the same test command. Expected: PASS, including both must-fail assertions.

- [ ] **Step 5: Assert the shipped SQL file is in the image**

Do not copy `bootstrap.sql` in the Dockerfile. `runBootstrap` reads it from `node_modules/@community-hub/db/sql/bootstrap.sql`, and the db package `files` list already ships `sql`. The existing `dist` copy places `db-bootstrap.js` at `/app/db-bootstrap.js`.

With `RUN_IMAGE_TESTS=1`, `docker run --rm <image> node --input-type=module -e` exits 0 only when both `/app/db-bootstrap.js` and `/app/node_modules/@community-hub/db/sql/bootstrap.sql` exist. Add that assertion to `image.test.ts`.

- [ ] **Step 6: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/api && pnpm check:boundaries`

```bash
git add apps/api/src/db-bootstrap.ts apps/api/src/db-bootstrap.test.ts apps/api/src/image.test.ts
git commit -m "$(cat <<'EOF'
feat(api): bootstrap roles with the existing verifier

The program calls runBootstrap and setLoginPasswords. It does not
send a cleartext password or print the verifier.

EOF
)"
```

---

### Task 3: Ops task definition and its execution role

**Files:**

- Modify: `infra/modules/aws-rds/outputs.tf`
- Modify: `infra/modules/aws-ingress/outputs.tf`
- Modify: `infra/regions/au/main.tf`
- Modify: `infra/regions/au/tests/cell.tftest.hcl`
- Modify: `infra/modules/aws-kms-envelope/tests/envelope.tftest.hcl`
- Modify: `infra/modules/aws-rds/tests/rds.tftest.hcl` only if the new output breaks that suite's mock

**Interfaces:**

- Consumes: `module.rds[0]` when `enable_database` is true. `module.db_secrets` secret ARNs and `key_arn`. `module.envelope.log_group_name`. `module.ingress.repository_arn`. `var.service_image`.
- Produces: `aws_ecs_task_definition.db_ops`, `aws_iam_role.db_ops_execution`, `aws_iam_role.db_ops_task`, and `aws_iam_role_policy.db_ops_execution`, each with count 1 only when `service_image` is set and `enable_database` is true. RDS output `master_user_secret_arn` is `aws_db_instance.this.master_user_secret[0].secret_arn`. Ingress output `repository_arn` is `aws_ecr_repository.service.arn`. The AU root does not output either ARN. `cell.tftest.hcl` references root resources and module outputs only.

**Rule this must not break:** the service task definition's secret list, `aws_iam_role_policy.execution_secrets`, and `aws_iam_role_policy.task_secrets` stay as they are. No storage key, no envelope key, and no `kms:Decrypt` for the master secret. The task role has no policies. No apply.

- [ ] **Step 1: Extend the mocks, then write the failing asserts**

In `infra/regions/au/tests/cell.tftest.hcl`, give the `aws_db_instance` mock a `master_user_secret` default whose `secret_arn` is `arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:master`. Do not use a real account id.

Add asserts before the resources exist:

- `staging_happy` (`service_image` unset, database on): `length(aws_ecs_task_definition.db_ops) == 0` and `length(aws_iam_role.db_ops_execution) == 0`.
- `database_off`: the same two lengths are 0.
- `staging_image_set` (image set, `enable_database` default true): the task definition and both roles exist. `prod_image_set` asserts the task definition exists too.

On `staging_image_set`, decode `aws_iam_role_policy.db_ops_execution[0].policy` and assert:

- `secretsmanager:GetSecretValue` resources are exactly the master secret ARN plus `module.db_secrets.app_secret_arn`, `module.db_secrets.identity_secret_arn`, and `module.db_secrets.platform_secret_arn`. No wildcard.
- Exactly one statement has Action `kms:Decrypt`. Its Resource is exactly `module.db_secrets.key_arn`. It is not a list that also contains the storage key, the envelope key, or another key.
- One statement has Action `ecr:GetAuthorizationToken` and Resource `*`.
- One statement has Actions `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, and `ecr:BatchGetImage`, and its Resource is exactly `module.ingress.repository_arn`.
- Log writes are `logs:CreateLogStream` and `logs:PutLogEvents` on the service log group, the same shape as `aws_iam_role_policy.execution` in `infra/modules/aws-kms-envelope/main.tf`.

Also assert on that run:

- `aws_iam_role.db_ops_task[0]` has no `aws_iam_role_policy` and no managed policy. The only new policy resource is `db_ops_execution`, and its role is the execution role.
- The ops container command is `["node", "/app/db-bootstrap.js"]`, the image is `var.service_image`, cpu is `256`, memory is `512`, runtime is `ARM64`, `readonlyRootFilesystem` is true, the user is `node`, and a writable `/tmp` volume exists.
- Environment names are only `PGHOST`, `PGPORT`, `PGDATABASE`, and `PGUSER`. `PGUSER` is `postgres`. No environment value contains `arn:`.
- Secret names are `PGPASSWORD_MASTER`, `PGPASSWORD_APP`, `PGPASSWORD_IDENTITY`, and `PGPASSWORD_PLATFORM`. `PGPASSWORD_MASTER` uses the master secret's `password` JSON key. The other three use the raw secret ARNs. The log stream prefix is `db-ops`.

Do not assert `module.ingress.aws_ecs_task_definition.this[0]` or `module.envelope.aws_iam_role_policy.execution_secrets` from `cell.tftest.hcl`. A root test can read module outputs, not child-module resources.

In `infra/modules/aws-kms-envelope/tests/envelope.tftest.hcl`, assert `aws_iam_role_policy.execution_secrets` does not contain `arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:master`. Its `GetSecretValue` resources stay the three role-secret ARNs that run already supplies.

The existing `aws-ingress` suite stays as it is. `infra/modules/aws-ingress/tests/ingress.tftest.hcl` pins the service secret names at the `PGPASSWORD_APP`, `PGPASSWORD_IDENTITY`, `PGPASSWORD_PLATFORM` list. That suite and the envelope suite must pass unchanged apart from the new envelope assert.

- [ ] **Step 2: Run the test and watch it fail**

Run: `terraform -chdir=infra/regions/au test`

Expected: FAIL. `aws_ecs_task_definition.db_ops` does not exist yet.

- [ ] **Step 3: Add the outputs and the resources**

Add `master_user_secret_arn` to `infra/modules/aws-rds/outputs.tf`.

Add `repository_arn` to `infra/modules/aws-ingress/outputs.tf`, value `aws_ecr_repository.service.arn`. `repository_url` stays.

In `infra/regions/au/main.tf`, create the four resources with count `var.service_image != null && var.enable_database ? 1 : 0`. Family is `${local.name}-db-ops`, distinct from the service family `local.name`. Trust policy is `ecs-tasks.amazonaws.com` on both roles. The image-pull statement's repository resource is `module.ingress.repository_arn`. Container has no port and no Cloud Map registry. Passwords are `secrets` entries, not environment entries. Do not reference `module.rds[0]` unless the count is 1. Do not read `module.ingress.aws_ecr_repository.service.arn`.

If `terraform -chdir=infra/modules/aws-rds test` fails on the new output, add the same synthetic `master_user_secret` mock there. Do not change the `rds.force_ssl` or alarm asserts.

- [ ] **Step 4: Run the tests and watch them pass**

Run `terraform test` in `infra/regions/au`, `infra/modules/aws-rds`, `infra/modules/aws-ingress`, and `infra/modules/aws-kms-envelope`.

Expected: the new asserts pass. The ingress suite passes with its service secret names unchanged. The envelope suite passes with the new absence assert.

- [ ] **Step 5: Gate and commit**

In `infra/regions/au`, `infra/modules/aws-rds`, and `infra/modules/aws-ingress`, run the Stage 1 sequence: `terraform init -backend=false -lockfile=readonly`, `terraform fmt -check`, `terraform validate`, `tflint --init`, and `tflint`. Run the same sequence in `infra/modules/aws-kms-envelope` because this task edits its test.

Run: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/api && pnpm check:boundaries`

```bash
git add infra/modules/aws-rds/outputs.tf infra/modules/aws-ingress/outputs.tf infra/regions/au/main.tf infra/regions/au/tests/cell.tftest.hcl infra/modules/aws-kms-envelope/tests/envelope.tftest.hcl infra/modules/aws-rds/tests/rds.tftest.hcl
git commit -m "$(cat <<'EOF'
feat(infra): add the database ops task definition

Only its execution role can read the master secret. Decrypt is limited
to the role-secrets key, and the service task gains nothing.

EOF
)"
```

If `rds.tftest.hcl` was not modified, leave it out of the commit.

---

### Task 4: Point the runbook at the ops task

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`

**Interfaces:**

- Consumes: the section "Change a database role".
- Produces: that section names the ops task as the way to run bootstrap and `ALTER ROLE`.

**Rule this must not break:** the section records no password, no connection string, and no secret ARN. It does not add a bastion, a public database, NAT, or ECS Exec.

- [ ] **Step 1: Replace the section**

Replace the body of "Change a database role". An operator runs the ops task. A person does not open a master session. The database is on and `service_image` is set, because otherwise the task definition does not exist. The task uses the task security group, the staging public subnet, and a public address. The command is `["node", "/app/db-bootstrap.js"]`. Stdout is only the integer from `SHOW max_connections`. There is no rotation function. The same task is how a later password change is applied.

Leave "Restore drill" as it is. `SHOW max_connections` in that section still belongs to `first-running-task`.

- [ ] **Step 2: Gate and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/api && pnpm check:boundaries`

```bash
git add docs/runbooks/apply-staging-au.md
git commit -m "$(cat <<'EOF'
docs(runbooks): run bootstrap as the ops task

Nothing outside the task security group can reach Postgres. The
runbook no longer tells an operator to open a master session.

EOF
)"
```

---

### Task 5: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Consumes: the Phase 0 table and the snapshot. The repository-state cell in `AGENTS.md`.
- Produces: row `db-ops-task` immediately before `first-running-task`, status **done**, linking `docs/specs/2026-10-06-db-ops-task.md`. Snapshot last shipped `db-ops-task`, next chunk `first-running-task`, Phase 0 `23 rows: 19 done, 1 superseded (api-au-hostname), 3 not started`. The repository-state sentence matches those counts and names `first-running-task` as next. `kms-mrk-replica` stays last.

**Rule this must not break:** do not edit any other sentence in `AGENTS.md`. Prettier may reflow the header table's trailing spaces when that cell changes. Do not mark the plan approved in this commit.

- [ ] **Step 1: Update the two catalogue lines and the new row**

The row says the image command is `CMD`, bootstrap uses a SCRAM verifier, the ops task is not applied, and the spec path.

The sentence under the Phase 0 table that names the next chunk still names `first-running-task`.

- [ ] **Step 2: Gate and commit**

Run: `pnpm exec prettier --write docs/roadmap.md AGENTS.md`

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm check:boundaries`

```bash
git add docs/roadmap.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark the database ops task done

Phase 0 is 23 rows: 19 done, 1 superseded, 3 not started. Next is
the first running task.

EOF
)"
```
