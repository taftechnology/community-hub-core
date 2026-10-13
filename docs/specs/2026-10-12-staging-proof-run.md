# Spec: Staging proof run

Slug: staging-proof-run
Status: draft
Architecture refs: §7.1, §7.3, §23.1, §23.2, ADR 0009. Follows `docs/specs/2026-10-06-first-running-task.md`, which is the model for the unpark, the proofs and the re-park. Depends on `service-image-runtime-base`, `tenancy-implicit-org`, `identity-otp`, `people-households`, `access-roles`, `db-migrate-command` (`docs/specs/2026-10-12-db-migrate-command.md`), the no-spec fix `fix/2026-10-12-request-error-log`, and `entitlements-plans` (`docs/specs/2026-10-12-entitlements-plans.md`). All three of those later merges are on `main` at `cd19f0b` (pull requests 49, 48 and 47). The image is the latest `main` SHA that contains all three (`cd19f0b` or later).

## Problem

Staging is parked: `enable_database` is false, `desired_count` is 0 and `service_image` is null (`infra/regions/au/env/staging.tfvars`). The last time a task ran was `first-running-task`, on 2026-10-06. Since then these merged and have never run on Fargate or against RDS:

- The runtime image. It is now `gcr.io/distroless/nodejs24-debian13` with no shell, an empty `ENTRYPOINT`, and user `node` added to `/etc/passwd` by the Dockerfile (`apps/api/Dockerfile`, `service-image-runtime-base`). The Dockerfile also builds `@community-hub/entitlements-eval` and `@community-hub/entitlements` into the image. The roadmap open item says the next unpark re-runs the health check, the `/tmp` write one-off and the ops task.
- Product migrations `0000` to `0009` (`packages/db/drizzle`): the schemas, the outbox and audit tables, the platform directory, the identity tables, the people tables, the org-scoped uniques, the access tables, the custom-role permission check widen (`0008`), and the entitlements platform tables (`0009`). The journal has ten entries. The `db-migrate` ops command (`/app/db-migrate.js` from `db-migrate-command`) is what applies them in this run. It has not been run on staging.
- The sign-in routes (`apps/api/src/auth-routes.ts`), the role routes (`apps/api/src/access-routes.ts`), and the entitlement routes (`apps/api/src/entitlement-routes.ts`).
- The Module Toggles page in the admin shell (`apps/admin/src/module-toggles.tsx`), linked from Settings after Users & Roles.
- The pooled checkout and the `28P01` password re-read (`apps/api/src/checkout.ts`, `apps/api/src/secrets.ts`). Neither has called Secrets Manager at runtime.
- The preflight answer in the gate (`apps/api/src/gate.ts`) and the gateway CORS configuration (`infra/modules/aws-ingress/main.tf`, `cors_configuration`).
- The admin content-security policy `connect-src` change (`infra/modules/aws-admin-static/main.tf`). Commits `70988a1` and `6c02cb2` post-date the last apply the runbook records, `8a68085`. The owner applied both the policy change and the gateway CORS change to staging on 2026-10-12 from the `access-roles` branch before it merged (the plan showed 0 to add, 2 to change, 0 to destroy), and the owner's assistant read both back. The runbook has no record of that apply. This chunk adds one.

Tests for these run on Docker Postgres and a fake KMS port. Nothing has shown that they work on the real topology.

## Scope

**In**

- Unpark staging for a stated short window: `enable_database = true` and `desired_count = 1` in `infra/regions/au/env/staging.tfvars`, then `service_image` in the gitignored `staging.local.tfvars` only. See [Cost](#cost) for the window.
- The image comes from the latest `main` SHA that contains `db-migrate-command`, `fix/2026-10-12-request-error-log` and `entitlements-plans` (`cd19f0b` or later), published by the `publish` job in `.github/workflows/ci.yml`. Nobody builds or pushes by hand.
- Product migrations applied to the new database by the `db-migrate` ops command. The human runs it as the runbook section "Apply product migrations" describes. `db-bootstrap` runs first (proof 2d), then `db-migrate`.
- The proofs below, recorded in `docs/runbooks/apply-staging-au.md`.
- A retrospective runbook record of the 2026-10-12 apply of the admin content-security-policy change and the gateway CORS change. The applied commit is believed to be `836a3f9`, and the owner confirms it when the record is written.
- Re-park in the same chunk, before its pull request merges. The runbook records both applies and the commit each applied.
- The catalogue commit, as [Catalogue](#catalogue) says.

**Out**

- Any new feature, route, table or column. This chunk has no code change. The migration command is already on `main`.
- A mail vendor. The boot mail port still rejects, so no code is sent.
- Creating a first owner. `bootstrapOwner` has no HTTP route and this run adds none.
- A signed-in session. Without a mail vendor and without an owner there is no token, so no role or entitlement route returns 200 or 403 for a signed-in user in this run. A signed-in proof waits for a mail vendor and a first owner.
- Load testing, a restore drill, the KMS interface endpoint, ECS Exec, a NAT gateway, a load balancer.
- A change to the budget, the Cloud Map `failure_threshold`, or Fargate Spot.
- Production. The runbook does not apply `environment = "prod"`.
- Fixing anything the run finds, including the CloudFront 403 on a reload of a deep link. A finding is recorded and becomes its own chunk.

## Behaviour

### Who does what

The human applies. The human runs every `terraform apply`, every `aws ecs run-task`, and `aws secretsmanager put-secret-value` for proof 7b. An agent does not run an apply, an `aws` command, or a `docker push`.

The owner's assistant has read-only AWS access. It reads ECS, ECR, CloudTrail `lookup-events`, CloudWatch Logs `filter-log-events`, RDS and EC2 descriptions, and it makes HTTP requests and runs a browser. It writes no repo file and applies nothing. `iam:SimulatePrincipalPolicy` is untested. The assistant tries it once in proof 7a, and if it is refused, proof 7a falls back to the human's paste of the task role's attached policy.

Every apply uses the `ch-admin` profile. Both var files are passed, the gitignored file last. `git status` is clean and `git rev-parse HEAD` is the SHA named for that apply, and that SHA is on `origin`. After the first apply on this branch there is no rebase, no amend and no force-push. `origin/main` comes in by merge commit, and the pull request merges with a merge commit. The pull request body says this departs from AGENTS.md section 5.

### What the code says today

These four facts come from reading the repository at `cd19f0b`. They are not live observations.

1. **Migrations.** The ops task runs `node /app/db-bootstrap.js` by default (`infra/regions/au/main.tf`, `aws_ecs_task_definition.db_ops`). That program calls `runBootstrap` and `setLoginPasswords` and prints `SHOW max_connections` (`apps/api/src/db-bootstrap.ts`). `bootstrap.sql` creates four roles and the `migrator` schema only (`packages/db/sql/bootstrap.sql`). The image also ships `/app/db-migrate.js` (`apps/api/src/db-migrate.ts`). It connects as the master, refuses with `not_bootstrapped` when bootstrap has not run, then calls `applyProductMigrations`. On success it prints one `applied <tag>` line per newly applied journal tag, then `done applied=<n> total=<m>`, and exits 0. On failure stdout is empty, stderr is a stage word (`env`, `connect`, `not_bootstrapped`, or `migrate`) with an optional five-character SQLSTATE, and the exit code is 1. A task that never starts has no log stream; the describe step prints exit `None` and a stopped reason. The failing migration is not named. The runbook section "Apply product migrations" names the command override, the describe and log commands, the results table, and the waiting rule. CI Stage 4 (merge, then migrate, then deploy) is still omitted in AGENTS.md section 10. Without migrations the `identity`, `platform` and `app` product tables do not exist, and every route that opens a connection returns 500.
2. **Secrets and KMS permission.** The running task's role has two statements in `aws_iam_role_policy.task_secrets` (`infra/modules/aws-kms-envelope/main.tf`): `Allow` `secretsmanager:GetSecretValue` on `var.db_secret_arns`, which `infra/regions/au/main.tf` sets to the app, identity and platform secrets; and `Allow` `kms:Decrypt` on `var.db_secrets_key_arn`, which is `module.db_secrets.key_arn`, the `kms_key_id` of all three secrets (`infra/modules/aws-db-secrets/main.tf`). Neither statement has a `Condition`, so both `AWSCURRENT` and `AWSPREVIOUS` are allowed. The secrets key policy, statement `SecretsManagerUse`, lets the account root principal (and so IAM policy) call `kms:Decrypt` and `kms:GenerateDataKey` through Secrets Manager when `kms:EncryptionContext:SecretARN` matches the three secret names. The execution role has the same two statements (`execution_secrets`) for the `secrets` entries injected at task start. The envelope key policy names the task role for `GenerateDataKey` and `Decrypt` in the `org` and `identity` contexts, and the identity context in `modules/core/identity/infrastructure/identity-key.ts` (`key_kind`, `region`, `key_version`) matches the policy's key list. This is the policy as written in code. The live attached policy has not been read.
3. **Network path.** The service task runs in the staging public subnet with `assign_public_ip = true` (`aws_ecs_service.this`, `infra/modules/aws-ingress/main.tf`; `task_subnet_ids` in `infra/regions/au/main.tf`). The public subnet routes `0.0.0.0/0` to an internet gateway (`infra/modules/aws-network/main.tf`, `gateway_id = aws_internet_gateway.this.id`). The task security group allows egress TCP 443 to `0.0.0.0/0`, described as "HTTPS to public AWS APIs" (`task_https`), and TCP 5432 to the RDS group. There is no NAT gateway. The only `aws_vpc_endpoint` in the repository is the optional KMS one (`infra/modules/aws-kms-envelope/main.tf`, `count = var.enable_kms_endpoint ? 1 : 0`), and `staging.tfvars` does not set it. So Secrets Manager and KMS calls leave through the internet gateway over the task's public address to the public regional endpoints. The KMS call with the endpoint off passed on 2026-10-06 (runbook, "First running task", proof 4). A Secrets Manager call from application code has no recorded run. Task start already reads the three secrets for the `secrets` entries through the execution role, and that worked on 2026-10-06.
4. **Image, request logs and KMS logs.** `publish` runs on every push to `main` (`.github/workflows/ci.yml`, job `publish`). It pushes the image to the repository `ch-staging/service` tagged with the full commit SHA, waits for the ECR scan, and writes `Digest: sha256:...` and the severity counts to the job summary. The gate fails when the scan is not `COMPLETE` or `CRITICAL` is above 0. `service_image` is `<registry>/ch-staging/service@sha256:<digest>`. The registry host contains the account id, so the value goes only in the gitignored file. The digest can be read again, read-only, with `aws ecr describe-images` for the tag. The pre-check confirms the publish job for the deployed SHA passed before apply 1. `admin-publish` publishes the admin shell for the same SHA. A thrown handler error becomes an empty 500; the request log line (`message` `request`) carries `method`, `path` (the route pattern), `status`, `duration`, `requestId`, optional `gatewayRequestId`, and on that throw also `errorClass` and optional `errorCode` (`packages/kernel/src/request-handler.ts`, `packages/observability/src/logger.ts`). No message text, stack or personal data is logged. Each KMS port call writes a `kms` line with `operation` (`generate_data_key` or `decrypt`), `outcome` (`ok`, `rejected`, `failed` or `timeout`), optional `key_kind` (`org` or `identity`), and `errorClass` when the outcome is `failed` (`apps/api/src/kms/aws-kms-adapter.ts`, wired through the real logger in `apps/api/src/index.ts`). The pooled checkout's `log` argument is still a no-op at boot.

### Order

1. **Pre-checks (owner's assistant, read-only).** Name the `main` SHA to deploy: the latest that contains `db-migrate-command`, `fix/2026-10-12-request-error-log` and `entitlements-plans` (`cd19f0b` or later). Confirm all three are on `main`. Before apply 1, confirm the `publish` job for that SHA succeeded, the ECR scan is `COMPLETE`, and `CRITICAL` is 0. Record the digest, not the registry host. Confirm the `admin-publish` job for that SHA succeeded. The repository variables `ADMIN_API_ORIGIN` and `ADMIN_AUTH_ORIGIN` are set to the real origins, and the admin bundle published from `8fc42c0` held both and no placeholder (checked by the owner's assistant on 2026-10-12). Proof 8b checks the bundle again for the deployed SHA.
2. **Unpark commit.** One commit sets `enable_database = true` and `desired_count = 1`. `staging.tfvars` gains no `service_image` line. It is pushed before the first apply.
3. **Apply 1, no image.** Creates the database and its subnet group, parameter group and four alarms, and the RDS-managed master secret. The human pastes the plan summary and resource addresses. Expected: the eight `module.rds[0]` resources from 2026-10-06, and no change to `module.admin_static[0].aws_cloudfront_response_headers_policy.admin` or `module.ingress.aws_apigatewayv2_api.tenant`, because the owner applied both on 2026-10-12. A planned change to either, or anything else, is a stop. The human waits for the instance to be `available`.
4. **Apply 2, with the image.** `service_image` goes in `staging.local.tfvars` only. Creates the ECS cluster, capacity providers, the service task definition, the service, the ECR pull policy, the task API ingress rule, the ops task definition, the ops execution role, the ops task role and the ops execution policy: the ten from 2026-10-06. Anything else is a stop. The human waits for the service to be stable and the VPC link `ch-staging-link` to be `AVAILABLE`.
5. **Ops task, then migrations, then the proofs in order.** Proofs 1 and 2 first, because they show the image runs. Proof 2d (`db-bootstrap`) before proof 3 (`db-migrate`), because migrate refuses without bootstrap. Proof 3 before proofs 5, 6b, 6f and 7b, because those open a database connection and need the schemas. Proofs 4, 6a, 6c, 6d, 6e and 7a do not. The proof 5 row-count one-offs run before proof 7b, because the rotation changes the identity password. Proofs 8 and 9 follow proof 7b, so the log search covers the whole window.
6. **Re-park.** One commit sets `enable_database = false` and `desired_count = 0`. `service_image` is removed from the gitignored file. Apply. Then a plan with no changes. See proof 10.

If any proof fails, stop the proofs, run the re-park, and report. After two failed attempts at one step, stop and report what was learned instead of a third attempt (AGENTS.md section 12).

### Proofs

The human pastes only the fields each proof names. The record redacts the account id, the hosted zone id, the alarm email, every key ARN, every secret ARN, every password, every task address, every task ARN, the registry host, and the three hostnames (the record uses "the api hostname", "the auth hostname", "the admin origin"). No proof sends a real person's data. Requests carry no personal data, and the only address used is the synthetic one in proof 5.

**1. The service task starts on the distroless image and is healthy.**
Run by: the human applies; the assistant reads.
Run: after apply 2, `ecs describe-services` for the service, `ecs list-tasks` with `desiredStatus=STOPPED`, and `GET /health` on the api hostname five times.
Expected: `runningCount` 1, `pendingCount` 0, the task `lastStatus` `RUNNING` with health `HEALTHY`, no stopped task for the service, one healthy Cloud Map instance, and five responses of 200. The image digest in the task equals the digest from the pre-check.
Proves: the Fargate agent can resolve `user = "node"` against the Dockerfile's `/etc/passwd`, `node` resolves through the image `PATH` with an empty entrypoint, `/tmp` mounts, the container health command runs without a shell, and the three role passwords inject from Secrets Manager through the execution role. A user lookup failure shows as a stopped task with a container-init stop reason.

**2. The one-offs from the roadmap open item, and the probe.**
Run by: the human runs each `aws ecs run-task` with the task security group, the staging public subnet and a public address, command override only, no `entryPoint`; the assistant reads exit codes and the log stream.
Runs:

- 2a. Service task definition, container `service`, command that writes one file under `/tmp` and exits 0. Expected: exit 0. The service stays at 1 of 1.
- 2b. Same task definition, command that prints the numeric uid and gid and exits 0. Expected: stdout `1000 1000`.
- 2c. Same task definition, command that tries to write a file under `/app` and exits 0 only if the write is refused. Expected: exit 0. This shows the read-only root is in force.
- 2d. The ops task definition, container `db-ops`, command `["node", "/app/db-bootstrap.js"]`. Expected: exit 0, stdout exactly one integer and one newline, stderr empty. On 2026-10-06 the integer was 79 on the same instance class. A different integer is recorded and queried. A non-integer or a non-zero exit stops the run.
- 2e. Service task definition, command `["node", "/app/probe.js"]`, after 2d. Expected: stdout `pass`, stderr empty, exit 0.
  Proves: the `/tmp` volume takes its owner and mode from the image directory on Fargate; the user is `node`; the ops path works on the new image; bootstrap works against a fresh RDS instance; the three logins authenticate; and KMS `GenerateDataKey` and `Decrypt` work with the endpoint off.

**3. Product migrations applied.**
Run by: the human runs the ops task as the runbook section "Apply product migrations" describes (command `["node", "/app/db-migrate.js"]`, same network as 2d). The assistant reads the exit code and the log stream. Do not restate the runbook's shell here.
Order: after proof 2d. A first run without bootstrap would exit 1 with `not_bootstrapped` and apply nothing.
Expected, first run: exit 0, stderr empty, one `applied <tag>` line per journal tag in the image, then `done applied=<n> total=<m>`, where `<m>` is the journal length in that image. At `cd19f0b` that is ten tags, `0000_schemas` through `0009_flippant_bedlam`. The pre-check reads the journal on the deployed SHA so the expected tags match the image, not a hard-coded count from this spec. A second run, same command: exit 0, stderr empty, stdout exactly `done applied=0 total=<m>` (no `applied` lines). That second run costs seconds and proves the re-run is safe on RDS.
On failure: exit 1, stdout empty, stderr a stage word (`env`, `connect`, `not_bootstrapped`, or `migrate`) with an optional five-character SQLSTATE. The failing migration is not named. A task that never starts has no log stream; the describe step prints exit `None` and a stopped reason (do not copy a reason that names a registry or a secret into the evidence).
Proves: every migration in the image's journal, including the hand-added `FORCE ROW LEVEL SECURITY` and `REVOKE` statements and the two entitlements migrations, applies on RDS PostgreSQL 17 as the master with `SET ROLE migrator`. They have only ever run on Docker Postgres. Proof 5 then shows the identity and platform tables exist.

**4. Browser preflight.**
Run by: the assistant, by HTTP request.
Run: `OPTIONS` to a real route path on the api hostname, and again to a real route path on the auth hostname, with `Origin` set to the admin origin, `Access-Control-Request-Method: POST` and `Access-Control-Request-Headers: authorization,content-type`. Repeat both with `Origin` set to an origin that is not the admin origin.
Expected, admin origin: status 204 on both, `access-control-allow-origin` equal to the admin origin, `access-control-allow-methods` listing `GET`, `POST` and `OPTIONS`, `access-control-allow-headers` listing `authorization` and `content-type`, and no `access-control-allow-credentials`. These are the values in `cors_configuration`.
Expected, other origin: no `access-control-allow-origin` header on either. The status is recorded and not asserted.
Also recorded: whether the service log group shows an `OPTIONS` line for these requests. A line means the service answered (`gate.ts` returns 204 with no CORS headers) and the gateway added the headers. No line means the gateway answered.
Control: the same preflight to the ops hostname. Expected: status 404 and no `access-control-allow-origin`. The ops API has no CORS configuration, and `gate.ts` keeps preflight off that hostname. The same request to the webhooks hostname is recorded and not asserted, because it shares the tenant API and so shares its CORS configuration.
Proves: the browser's first request in the admin sign-in flow is allowed from the admin origin and from no other origin.

**5. `POST /v1/auth/email-otp/start` reaches the database and KMS.**
Run by: the assistant, by HTTP request. The human is not needed.
Run: two `POST` requests to the auth hostname, `content-type: application/json`, body `{"email": "<synthetic>"}`. The synthetic address has the local part `proof` plus eight random hex digits and a domain reserved for tests under RFC 2606. It is generated for the run and never written into the runbook. Then one `POST` with a malformed address as a control.
Expected: both valid requests return 503 with an empty body. The malformed request returns 400 with an empty body. A 500 means the database, a migration, a password or KMS failed; when that happens the request log line carries `errorClass` and optional `errorCode`, and the owner's assistant records them at once. A 204 means a mail port other than the boot port is running, and the run stops.
Why 503 proves the path: `startEmailOtp` calls `bidxKey`, which calls `ensureIdentityKey` and unwraps the identity root through KMS, then inserts a challenge row in a transaction, and only then calls `mail.send`. The boot port rejects with `email_unavailable`, the route maps that to 503, and the function deletes the challenge row first (`modules/core/identity/infrastructure/email-otp.ts`). So 503 can only happen after a successful identity-login query, a KMS call and an insert.
Rows that should remain: one row in `identity.identity_keys` (region `au`), created by the first request. Rows that should not: none in `identity.otp_challenges`, none in `identity.users`, none in `identity.sessions`, none in `identity.passkey_challenges` or `identity.passkey_credentials`. No row holds the address, because the address is stored only as ciphertext on `users` and as a blind index on `otp_challenges`, and neither is written.
Checks, with no personal data printed:

- CloudTrail, read-only: after the first request, one `GenerateDataKey` and one `Decrypt` with encryption context `key_kind` `identity`, `region` `au`, `key_version` `1`, from the task role. After the second request, one more `Decrypt` and no second `GenerateDataKey`. These events carry no address.
- Service log, read-only: after the first request, two `kms` lines with `key_kind` `identity` and `outcome` `ok` — one `operation` `generate_data_key`, then one `decrypt`. After the second request, one more `kms` line with `operation` `decrypt`, `key_kind` `identity`, `outcome` `ok`. No `errorClass` on those lines.
- Row counts: two read-only one-offs of the ops task definition with a command override that runs `select count(*)` and prints integers only. The script selects no column value. It is an inline `node -e` command in the runbook, not a repository file.
  - As the `identity` login, the six identity tables in the order `identity_keys`, `otp_challenges`, `users`, `sessions`, `passkey_challenges`, `passkey_credentials`. Expected `1 0 0 0 0 0`. The `identity` login has table privileges in `identity` only (`0000_schemas.sql` default privileges).
  - As the `platform` login, `platform.organisations`, `platform.communities`, and the ten tables created in `0009_flippant_bedlam` (`plans`, `plan_entitlements`, `add_ons`, `add_on_entitlements`, `organisation_plans`, `organisation_add_ons`, `community_allocations`, `community_toggles`, `entitlement_overrides`, `feature_flags`). Expected twelve zeros. The `platform` login has table privileges in `platform` only. The `identity` login cannot read those tables; the `app` login cannot read `identity` or `platform` tables.

**6. Role and entitlement routes without a token return the documented refusal.**
Run by: the assistant, by HTTP request.
Run, all `POST` with `content-type: application/json` and a valid body for the path:

- 6a. `/v1/access/grants/list` on the api hostname, body `{"communitySlug": "<slug>"}`, no `Authorization` header. Expected: 401, empty body. This path opens no connection (`bearer()` returns before `readSession` in `access-routes.ts`).
- 6b. The same path and body with `Authorization: Bearer` followed by 43 random base64url characters. Expected: 401, empty body. This path checks out the `identity` pool and reads `identity.sessions`, so it needs proof 3.
- 6c. The same body to the auth hostname. Expected: 404, empty body (`foreignHost`).
- 6d. A body with an extra key on the api hostname. Expected: 400, empty body, before the token is read.
- 6e. `/v1/entitlements/list` on the api hostname, body `{"communitySlug": "<slug>"}`, no `Authorization` header. Expected: 401, empty body. Same order as the access list route: host check, body parse, then bearer (`entitlement-routes.ts`).
- 6f. `/v1/entitlements/toggle` on the api hostname, body `{"communitySlug": "<slug>", "key": "people.directory", "enabled": true}`, no `Authorization` header. Expected: 401, empty body. With a bearer of 43 random base64url characters, also 401 after an identity session read (needs proof 3). On the auth hostname, either body returns 404.
  The slug is a placeholder string that matches no community. No community exists, because no one runs `createImplicitOrganisation`. No entitlement key is allocated, so a signed-in call would not reach a 200 in this run either.
  Proves: the routes are reachable through the gateway, the hostname gate separates the api and auth hostnames, and an unknown or missing token is refused. A 403 or a 200 needs a session and a community, and is out of this run (Decisions, 10).

**7. The task role can read the database secrets at runtime.**
Run by: the human runs the one-offs; the assistant reads.

- **7a. Read-only proof.**
  - The assistant tries `iam:SimulatePrincipalPolicy` once for the task role against `secretsmanager:GetSecretValue` on each of the three secrets, and `kms:Decrypt` on the secrets key. Expected: `allowed` for all four. If the call is refused, the human pastes the task role's attached policy statements instead, with ARNs redacted, and the assistant reads them against the same four actions.
  - The human runs a one-off of the service task definition (task role, not the execution role) with a command override that calls `GetSecretValue` for the identity secret with `VersionStage` `AWSCURRENT` and prints `pass` if a non-empty string came back. It prints nothing else and never prints the value. It is an inline `node -e` command using `@aws-sdk/client-secrets-manager`, which the image ships. Expected: stdout `pass`, stderr empty, exit 0.
  - Risk: none to any live credential. It reads one secret. It does not exercise `AWSPREVIOUS`, which does not exist on a never-rotated secret (the secrets have one version, written once by `aws_secretsmanager_secret_version`). It does not exercise the `28P01` branch.
  - Proves: the task role's credentials, the public network path to Secrets Manager, and the Secrets Manager use of the secrets key all work at runtime.
- **7b. Real rotation.**
  - Order: after proofs 5 and 6b and 6f and the row-count one-offs, which have opened `identity` connections. The human first forces a new deployment of the service so its pool is empty and its start-time environment holds the current value, and waits for the service to be stable. Only then is the new value put.
  - Before the put: proof 5's OTP path does not call Secrets Manager; passwords come from the task start-time environment. CloudTrail in that earlier window shows no task-role `GetSecretValue` for the identity secret from those requests.
  - The human generates a new random value and puts it on the identity secret with `put-secret-value`, so `AWSCURRENT` is the new value and `AWSPREVIOUS` is the old one, without printing the value. The human re-runs the ops task (2d), which reads the secrets when it starts and runs `ALTER ROLE` to the new value. The running service still holds the old value from its start-time environment.
  - Then the assistant repeats the proof 5 request. Expected: 503 and not 500. What the service does (`apps/api/src/checkout.ts`): the first connection fails with `28P01`; `readPassword` calls `GetSecretValue` for `AWSCURRENT`, then for `AWSPREVIOUS`; because `AWSCURRENT` differs from the password in use it returns the new value; checkout opens a replacement pool and the query succeeds. CloudTrail, read-only, shows two `GetSecretValue` events by the task role for the identity secret in that window, one for each version stage. CloudTrail event history can lag by about 15 minutes. When a database password is refused and the secret has no previous version, and `AWSCURRENT` still equals the password already in use, checkout rethrows the original database error instead of the missing-version error; that case is not this proof's path, because the put creates `AWSPREVIOUS`.
  - Risks: this changes a real staging secret. The secret is synthetic and staging only, and Terraform does not track the value (`secret_string_wo_version` stays 1), so a later apply does not revert it. If the ops task fails after `put-secret-value`, the secret holds a value the role does not. The running service keeps working on its old value. The human re-runs the ops task or re-parks. The re-park destroys the database, and the next unpark's ops task sets the roles to whatever the secrets hold. The value must not be printed or pasted. A shell history that holds it is a leak, so the human generates and sends it in one pipeline.
  - Proves: the pooled checkout re-reads and recovers on a password change, which is the open item recorded in `identity-otp`.

**8. The published admin page loads and its policy allows the two origins.**
Run by: the assistant, by HTTP request, and the browser pass (8c) by the assistant in a browser. Nothing is signed in.

- 8a. `GET` the admin origin at `/`. Expected: 200, one `h1` named Dashboard. The response header `content-security-policy` has `connect-src 'self'` followed by exactly the api origin and the auth origin, and every other directive equals `local.content_security_policy` in `infra/modules/aws-admin-static/main.tf`. The other response headers are unchanged from the 2026-10-07 record.
- 8b. Fetch the page's script asset and search it for the api origin and the auth origin. Expected: both strings present. This shows `admin-publish` used the repository variables.
- 8c. Browser pass. Open the admin origin at `/`, follow the Users & Roles link, follow the Module Toggles link, follow the Sign in link, enter the synthetic address, press Send code. Direct loads of `/sign-in`, `/settings/users` and `/settings/modules` return 403 from CloudFront because the distribution has no error rewrite for client routes (`infra/modules/aws-admin-static/main.tf` has no `custom_error_response`; the runbook recorded 403 for an unknown path), so the pass starts at `/`. Expected while signed out: Users & Roles and Module Toggles each show the heading and `Sign in required` with a Sign in link; no list and no Load form run without a token. After Sign in and Send code: the page shows `Sign-in failed`; the network panel shows one `OPTIONS` that returns 204 with the CORS headers and one `POST` that returns 503; the console has no content-security-policy violation; the address and the code appear in no stored value except the input.
  Proves: the browser loads the shell, reaches both Settings pages signed out, is allowed to call the two origins, and the preflight and the real request both succeed from the admin origin end to end.

**9. The logs hold no personal data.**
Run by: the assistant, read-only `filter-log-events`.
Groups: the service log group (`/community-hub/ch-staging/service`, streams with prefixes `service` and `db-ops`) and the tenant API access log group (`/community-hub/ch-staging/api-access`), over the whole window.
Searches, each expected to return zero events unless a hit is only inside the named exception fields below:

- the string `proof` followed by hex
- the `@` character
- the word `Bearer`
- any run of eight digits outside a `requestId` or `gatewayRequestId` value (a hit inside those two fields is read by eye, because a UUID segment can be all digits)
- the synthetic address's local part
- the community slug placeholder
- the strings `identity.`, `password` and `secret`

A search for UUID text is not used, because `requestId` is a UUID by design.
How a hit inside `errorClass` or `errorCode` is treated: a hit for `password` or `secret` (or any other search string) that sits only inside those two fields on a `request` or `kms` line is read by eye and is not a personal-data finding. A hit in any other field, or in the log message, fails the proof. A SQLSTATE such as `28P01` may appear in `errorCode` on a 500; that is expected evidence, not a personal-data hit.
Also: the distinct values of `path` in the service log are only the fixed route patterns and `unmatched`. A path with an id in it would show here. The service logs a `request` line with `method`, `path` (the route pattern), `status`, `duration` and ids only, and for a thrown error that becomes 500 also `errorClass` and optional `errorCode`. It logs a `kms` line per KMS call with `operation`, `outcome`, optional `key_kind`, and `errorClass` only when the outcome is `failed`. The access log format has no path and no query (`access_log_format` in `infra/modules/aws-ingress/main.tf`). The route modules' own `log` callbacks are still no-ops at boot; the lines above come from the gate and the KMS adapter.
When any proof produces a 500, the owner's assistant reads that request's log line at once and records `errorClass` and `errorCode` as evidence, alongside the one-offs and CloudTrail. If no 500 occurs in the run, the runbook says so. Nobody provokes one.
Proves: rule 5 (no personal data in logs) holds on the real runtime for these routes.

**10. Re-park.**
Run by: the human applies; the assistant reads.
Expected: the re-park plan destroys exactly the eighteen resources recorded for 2026-10-06 (ten from apply 2, eight under `module.rds[0]`) and creates, updates or replaces nothing. The apply completes. A following plan shows no changes, detailed exit code 0. Live, read-only: RDS instances 0, ECS services in `ch-staging` 0, KMS interface endpoints 0. The topic, the subscription, the hostname alarm and the budget remain. The secrets, the keys, the admin shell, the ECR repository, the image publish role and the Melbourne replica key remain.
Proves: the unpark is fully reversible with the committed values.

## Data

No new table and no new column. The run creates the contents of a fresh database and destroys them at re-park:

- Migrations create the tables listed in `packages/db/drizzle/0001` to `0009`, with their classifications in the specs that added them. This run adds no column. At `cd19f0b` that includes the platform entitlements tables from `0009`.
- Proof 5 leaves one `identity.identity_keys` row (`internal`, a KMS blob, not a personal field) until the database is destroyed.
- No `platform.communities` or `platform.organisations` row, no entitlements platform row, no person, no household, no user and no session is created.
- The synthetic address is never stored: the boot mail port rejects and the challenge row is deleted.

## Rules touched

- Residency (§1 rule 1). The task, the database, the logs and the keys stay in `ap-southeast-2`. The synthetic address goes to the regional service only and no other host. No mail leaves the process.
- Tenancy (§1 rule 2). The run applies migrations that carry `FORCE ROW LEVEL SECURITY` for the first time on RDS. It opens no `app` row.
- Encryption (§1 rule 3). No ciphertext column is filtered.
- Children (§1 rule 4). No person exists. No minor field is touched.
- Rule 5 (§1: no personal data in URLs, logs, traces). Proof 9 checks it. The proof requests carry no personal data in paths or query strings.
- Rule 7 (§1: no production data outside production). Every value is synthetic. Nothing is copied from production.
- Rule 8 (§1: secrets). No password, secret ARN, key ARN, registry host, hostname, account id or address enters the repo, the runbook or a prompt. The rotation value (7b) is generated and sent in one pipeline and never printed.
- Cost rules (AGENTS.md section 6, "Cost"). This spec names why staging is unparked, the extra monthly cost, and how long it stays up. The same chunk re-parks before its pull request merges. The runbook records both applies. The human runs both.
- Entitlements, permissions, consent, retention, safeguarding: none changed by this chunk. The run exercises the entitlement routes without a session only.

## Contracts

| Contract              | Value                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enable_database`     | True from the unpark commit, false in the re-park commit. Production still refuses false.                                                                           |
| `desired_count`       | 1 from the unpark commit, 0 in the re-park commit.                                                                                                                  |
| `service_image`       | Gitignored `infra/regions/au/env/staging.local.tfvars` only. Digest URI during the run, removed at re-park. Never committed.                                        |
| `enable_kms_endpoint` | Stays false. The committed file never sets it.                                                                                                                      |
| `enable_budgets`      | Stays true. Limit stays USD 50. Filter stays `user:environment$staging`.                                                                                            |
| Image                 | Published by `publish` for the named `main` SHA (`cd19f0b` or later). Scan `COMPLETE`, `CRITICAL` 0. Identified by digest. `admin-publish` passed for the same SHA. |
| Ops task              | Existing definition `ch-staging-db-ops`. Command override only. Runbook section "Apply product migrations" is the migrate contract.                                 |
| Dependency            | `db-migrate-command`, `fix/2026-10-12-request-error-log` and `entitlements-plans` are on `main` at `cd19f0b` and in the deployed image.                             |
| Routes                | No route, event, permission or collection is added or changed by this chunk.                                                                                        |
| Terraform tests       | None added. `staging_unpark` and `staging_image_null` in `infra/regions/au/tests/cell.tftest.hcl` already pin both plan shapes.                                     |

## Cost

Method and figures are those of `first-running-task` and `staging-base`: list prices read on 2026-10-03 and 2026-10-05, a 730-hour month. Nothing merged since those specs (`db-migrate-command`, the request error log fix, or `entitlements-plans`) adds an hourly or monthly resource; there was no Terraform change in those merges. The unpark adds these lines to the parked cell:

| Line                                         | Monthly USD | Method                                |
| -------------------------------------------- | ----------: | ------------------------------------- |
| Database instance, `db.t4g.micro`, single AZ |       18.25 | USD 0.025 an hour                     |
| 20 GB storage                                |        2.76 | USD 0.138 per GB-month                |
| RDS-managed master secret                    |        0.40 | per secret                            |
| Four RDS alarms                              |        0.40 | USD 0.10 each                         |
| Service task, 0.25 vCPU, 0.5 GB, ARM         |        8.64 | the approved cap (Spot is not higher) |
| Public IPv4 on the task                      |        3.65 | USD 0.005 an hour                     |
| Cloud Map registration                       |        0.10 | one registration                      |
| **Added by the unpark**                      |   **34.20** | **USD 0.0468 an hour**                |

The running month is the parked cell plus this. `first-running-task` approved USD 6.30 + 34.20 = USD 40.50. With the parked figure below it is about USD 41.50 plus images. The unpark runs for hours, not a month.

- **Stated maximum:** 24 hours target from the end of apply 1 to the start of the re-park apply, and 48 hours as a hard stop. At USD 0.0468 an hour that is about USD 1.12 for 24 hours and USD 2.25 for 48. The owner accepted it on 2026-10-12.
- **One-off tasks** (2a to 2e, 3 including the second migrate, 5, 7a, 7b) are billed per second and stay outside the totals. At the task line above, a minute costs about USD 0.0002.
- **Per-use lines** (KMS requests at USD 0.03 per 10,000, Secrets Manager calls, API requests, log ingestion, CloudFront) are billed by use, are well under USD 1 for this run, and stay outside the totals, as in `first-running-task`. A Secrets Manager API-call price is not stated in the repository: figure not found in the repository. The call count for this run is a few dozen.
- **Returns to:** the parked month, about USD 7.30 a month, plus under USD 1 for stored images. That is USD 6.30 from the runbook's 2026-10-06 re-park plus USD 1 for the Melbourne replica key (`docs/specs/2026-10-07-kms-mrk-replica.md`), and the image figure is from `docs/specs/2026-10-06-image-publish.md`. The admin shell is inside the CloudFront and S3 free tiers (`docs/specs/2026-10-07-admin-shell.md`). These figures come from the specs, not from a bill.
- The USD 40 budget alert cannot be reached by this window alone. A run left on for a month would reach it.
- No NAT gateway, no load balancer, no second interface endpoint, no KMS endpoint.

## Risks

| Risk                                                                                                                                        | Mitigation                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The distroless image has never run on Fargate. The task may fail to start (user lookup, `PATH`, `/tmp` ownership).                          | Proofs 1 and 2 come first and nothing else runs until they pass. A failure is a stop, then the re-park.                                                                                                            |
| Migrations `0000` to `0009` have never run on RDS. They may fail on a privilege difference between the Docker superuser and the RDS master. | Proof 3 comes before any route proof. A failure is a stop, then the re-park. The command reports a stage word and optional SQLSTATE only; it does not name the failing migration. The fix is its own chunk.        |
| The database is created fresh, so there is nothing to lose. The re-park destroys it.                                                        | This is intended. `skip_final_snapshot` is true outside prod and backup retention is 0 (`infra/modules/aws-rds/main.tf`), so no snapshot or backup is left. Staging data is synthetic and one `identity_keys` row. |
| A failed proof.                                                                                                                             | Stop the proofs. Run the re-park. Report the exact output. Do not retry the same step a third time. A finding is recorded in the runbook and becomes its own chunk. The re-park is not waived.                     |
| Cost overrun if the window is exceeded.                                                                                                     | 24 hours target, 48 hours hard stop. The human re-parks at the stop even if proofs remain. A month left up costs about USD 41.50 plus images and would reach the USD 40 alert.                                     |
| A committed `service_image` would put the account id in git.                                                                                | The variable stays in the gitignored file. A pre-commit `git diff` on `staging.tfvars` is part of each apply check.                                                                                                |
| The re-park is forgotten.                                                                                                                   | The last Terraform commit and the empty `service_image` are both required, and the following plan must show no changes. The pull request does not open without the runbook record of the re-park.                  |
| The rotation proof leaves the secret and the role out of step.                                                                              | 7b re-runs the ops task straight after `put-secret-value`. The next unpark's ops task re-syncs the roles to the secrets.                                                                                           |
| A 500 used to give no cause in the request log.                                                                                             | The request line for a thrown 500 now carries `errorClass` and optional `errorCode`. The one-offs and CloudTrail still identify the failing leg. No log change is made in this chunk.                              |
| The API Gateway CORS configuration is shared by the api, auth and webhooks hostnames.                                                       | Proof 4 records the webhooks answer. If it allows the admin origin, that is recorded as a finding, not fixed here.                                                                                                 |
| A reload on `/sign-in`, `/settings/users` or `/settings/modules` returns 403 from CloudFront.                                               | Recorded in proof 8c as a finding only. The fix is its own chunk.                                                                                                                                                  |

## Out-of-band

- Legal: none. New subprocessor: none. No ADR. `architecture.md` is not edited.
- The second fresh-context review is required. This chunk unparks the database, runs the task and exercises authentication, encryption and residency paths on real infrastructure. The owner's assistant starts that review when the pull request opens, and the pull request does not merge until the review line is closed. The review that writes this spec does not count.
- The human builds nothing and pushes nothing. The human applies twice to unpark, once or twice to re-park, and runs the one-offs. An agent does not run an apply or an `aws` command.
- No password, alarm email, account id, hosted zone id, key ARN, secret ARN, registry host, hostname, task address, task ARN or address of a person in this spec, the plan, the runbook evidence or the logs.

## Decisions (owner, 2026-10-12)

1. Migrations: a separate chunk, `db-migrate-command`, adds the `db-migrate` ops command and merges to `main` first. This spec depends on it and has no code change.
2. Window: 24 hours target, 48 hours hard stop.
3. Rotation: the real rotation proof (7b) runs, as well as the read-only one (7a).
4. Image: the latest `main` SHA that contains `db-migrate-command` and the `fix/2026-10-12-request-error-log` merge. Before apply 1 the owner's assistant confirms its `publish` job passed with the scan `COMPLETE` and zero `CRITICAL`. (`8fc42c0` passed with zero findings on 2026-10-12 but will be superseded.)
5. Earlier infra changes: the owner applied the admin content-security-policy and gateway CORS changes on 2026-10-12. This chunk adds a retrospective runbook record, and apply 1 is expected to show no change for them.
6. Admin origins: both repository variables are set to the real origins, and the bundle published from `8fc42c0` holds both and no placeholder.
7. Row counts: the read-only row-count one-off is allowed, with counts-only output.
8. Parked figure: about USD 7.30 a month plus under USD 1 for stored images, from the specs and not from a bill.
9. Catalogue: the last commit adds the Phase 0 row, replaces the Fargate open item, and keeps the next chunk.
10. No role route returns 200 or 403 in this run. A signed-in proof waits for a mail vendor and a first owner.
11. The second fresh-context review is required.
12. The owner's assistant runs the browser pass (8c). Nothing is signed in.
13. The assistant can read CloudWatch Logs and look up CloudTrail events. It tries `iam:SimulatePrincipalPolicy` once, and if it is refused, proof 7a falls back to the human's paste.
14. The CloudFront 403 on a reload of a deep link is recorded as a finding only. The fix is its own chunk.
15. A failed migration run does not name the failing statement: `db-migrate` reports a stage word and a five-character SQLSTATE only, and the owner accepted the SQLSTATE as the only evidence.
16. The missing error text in the service log is fixed before the run: `fix/2026-10-12-request-error-log` merges to `main` before the proof-run image is built.

## Rollback

The re-park commit is the rollback. If a proof fails before the re-park commit exists, the human sets `service_image` to null in the gitignored file, commits `enable_database = false` and `desired_count = 0`, and applies as in proof 10. If the failure is in apply 1 or apply 2, the same steps apply, and they apply the partial state. After the first apply there is no amend and no rebase. A failed unpark commit is followed by a new commit.

## Catalogue

The last commit on the branch updates `docs/roadmap.md` and the repository-state line in `AGENTS.md`. It adds one Phase 0 row, `staging-proof-run`, marked done, with this spec's link. It sets the roadmap snapshot's last shipped chunk to this one and sets the next chunk to whatever follows this row on `main` at that time (`stripe-billing` at `cd19f0b`). The commit raises the Phase 0 row count and the done count by one each from the figures on `main` at that time, keeps the superseded and not-started counts as `main` has them, and makes the roadmap snapshot and the `AGENTS.md` line agree. At `cd19f0b` both read 25 rows, 24 done, 1 superseded, 0 not started. The commit also replaces the open-item sentence "This image has not run on Fargate" with what the run showed, and records any finding as an open item. The catalogue edits are the only repo change besides the two `staging.tfvars` commits and the runbook evidence.
