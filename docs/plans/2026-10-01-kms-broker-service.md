# Plan: KMS broker service

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the AU broker process beside `cloudflared`, on the envelope task role, and register an HTTP Workers VPC service to `127.0.0.1:8080`.

**Architecture:** `@community-hub/kms-broker` owns the fixture and the context check. `apps/kms-broker` is a Node 24 HTTP server, not a Worker. ECS runs that image and `docker.io/cloudflare/cloudflared` by digest in one task. The Workers VPC service is `type = "http"` to loopback through the broker tunnel. Tasks stay off until `enable_kms_broker_tasks` is true.

**Tech Stack:** Node 24, pnpm, Vitest, `@aws-sdk/client-kms`, Terraform `~> 1.11` (CI is 1.11.4), hashicorp/aws `~> 6.0`, cloudflare/cloudflare `~> 5.13`, tflint AWS ruleset `0.48.0`.

**Spec:** `docs/specs/2026-10-01-kms-broker-service.md`

Status: draft

**Branch:** `feat/2026-10-01-kms-broker-service` · one PR · 7 tasks, one commit each

## Global Constraints

- Do not recreate envelope resources. The only edit to `infra/modules/aws-kms-envelope` is three outputs. Its five runs stay: `happy`, `probe_create_grant`, `wrong_region`, `rotation_off`, `log_retention_zero`.
- Do not edit `infra/modules/aws-ecs-tunnel`, `infra/modules/cf-vpc-service`, the Postgres `module "tunnel"` call, or the connector task.
- Do not edit `@community-hub/crypto`. Do not add `@community-hub/kms-broker` to `regionalOnlyPackages`. No `wrangler` config and no `worker.meta.json` on `apps/kms-broker`.
- No AWS SDK in `@community-hub/kms-broker`. SigV4 stays inside the SDK in the app.
- `kms_broker_image` is a whole-string match, lowercase hex, prefix built from `aws_account_id` and `name`. Must-fail tests live in the broker task module. A root test cannot `expect_failures` on a child resource.
- `kms_broker_cloudflared_image` matches `^docker\.io/cloudflare/cloudflared@sha256:[0-9a-f]{64}$`. Pull it from Docker Hub. Do not add a pull-through cache, a Docker Hub credential, `ecr:BatchImportUpstreamImage`, or `ecr:CreateRepository`.
- Pull policy actions, only when the flag is true: `ecr:GetAuthorizationToken` on `*`; `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, and `ecr:BatchGetImage` on the broker repository. No push action on the task role or any execution policy.
- KMS client `maxAttempts` is 1. The server aborts the call after 3000 ms.
- `ENVELOPE_KEY_ARN` must match `^arn:aws:kms:ap-southeast-2:[0-9]{12}:key/.+$` or the process exits non-zero before listen.
- Unknown methods and paths return 404 `{"error":"kms_failed"}` and `cache-control: no-store`. No KMS call.
- `FROM` digest pin and `pnpm install --frozen-lockfile` are a review rule. Do not add a CI checker for them.
- `terraform init -backend=false -lockfile=readonly`. No live `plan`. No apply. No ECR push. No registry login in CI.
- Lock new modules with `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- The last commit updates `docs/roadmap.md`: `kms-broker-service` **done**, next `kms-worker-adapter`, Phase 0 `11 / 14`. Do not insert rows.
- Implementer and reviewer cross Grok and Composer. A second fresh-context review of the final diff is required before merge. This chunk touches encryption and residency.

**Rollback:** Revert the PR. The flag defaults to false, so a revert removes the task and the VPC service from the next plan. The ECR repository is empty until a person pushes. No tenant data.

---

## File map

| Path | Role |
| --- | --- |
| `infra/modules/aws-kms-envelope/outputs.tf` | `tunnel_secret_arn`, `execution_role_name`, `log_group_name` |
| `packages/kms-broker/` | Fixture and context check |
| `apps/kms-broker/` | HTTP server, SDK call, Dockerfile |
| `infra/modules/aws-kms-broker/` | ECR repository, cluster, task, service, pull policy |
| `infra/modules/cf-broker-vpc-service/` | HTTP VPC service to `127.0.0.1:8080` |
| `infra/regions/au/` | Flag, wiring, service-id output |
| `docs/adr/0008-kms-broker-in-the-cell.md` | Sidecar trust and Workers VPC beta |
| `architecture.md` | §12.2: the process exists; the Worker still does not call it |
| `docs/runbooks/apply-staging-au.md` | Build, stamp, push, then the flag |
| `.github/workflows/ci.yml` | Docker build job and two Terraform matrix rows |

---

## Tasks

Each task is one commit. The tree stays green after each commit.

### T1 — Envelope outputs the task can use

**Commit:** `feat(infra): output the broker secret ARN and execution role name`

**Files:**

- Modify: `infra/modules/aws-kms-envelope/outputs.tf`
- Modify: `infra/modules/aws-kms-envelope/tests/envelope.tftest.hcl`

**Interfaces:**

- Consumes: `aws_secretsmanager_secret.broker_tunnel`, `aws_iam_role.execution`, `local.log_group_name`
- Produces: `output.tunnel_secret_arn`, `output.execution_role_name`, `output.log_group_name`. No new resource.

- [ ] **Step 1: Write the failing assertions**

In `run "happy"`, add an override so the secret ARN is known at plan:

```hcl
  override_resource {
    target = aws_secretsmanager_secret.broker_tunnel
    values = {
      arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging/kms-broker-tunnel-token-AbCdEf"
    }
    override_during = plan
  }

  assert {
    condition     = output.tunnel_secret_arn == "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging/kms-broker-tunnel-token-AbCdEf"
    error_message = "tunnel_secret_arn must be the secret's ARN, suffix included"
  }

  assert {
    condition     = output.execution_role_name == "ch-staging-kms-broker-execution"
    error_message = "execution_role_name must be the role name, not the ARN"
  }

  assert {
    condition     = output.log_group_name == "/community-hub/ch-staging/kms-broker"
    error_message = "log_group_name must be the envelope log group"
  }
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
terraform -chdir=infra/modules/aws-kms-envelope init -backend=false -lockfile=readonly
terraform -chdir=infra/modules/aws-kms-envelope test
```

Expected: FAIL because those outputs do not exist.

- [ ] **Step 3: Add the outputs**

```hcl
output "tunnel_secret_arn" {
  description = "Full ARN of the broker tunnel token, including the Secrets Manager suffix."
  value       = aws_secretsmanager_secret.broker_tunnel.arn
}

output "execution_role_name" {
  description = "Name of the broker execution role. aws_iam_role_policy.role takes this, not the ARN."
  value       = aws_iam_role.execution.name
}

output "log_group_name" {
  description = "Broker log group name."
  value       = local.log_group_name
}
```

Do not change `main.tf`.

- [ ] **Step 4: Re-run the five runs**

```bash
terraform -chdir=infra/modules/aws-kms-envelope test
```

Expected: PASS for `happy`, `probe_create_grant`, `wrong_region`, `rotation_off`, `log_retention_zero`.

- [ ] **Step 5: Commit** only the two files above.

### T2 — Protocol fixture and context check

**Commit:** `feat(kms-broker): check the KMS context before any caller`

**Files:**

- Create: `packages/kms-broker/package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `eslint.config.js`
- Create: `packages/kms-broker/contract/kms-port-v1.json`
- Create: `packages/kms-broker/src/context.ts`, `packages/kms-broker/src/index.ts`
- Create: `packages/kms-broker/src/context.test.ts`
- Modify: root `tsconfig.json` references if this repo lists project references

**Interfaces:**

- Consumes: the JSON fixture in the spec's Protocol section, including `limits.maxBodyBytes` of `65536`
- Produces: `readContract(): Contract` and `checkContext(context: unknown): KmsContext`. `KmsContext` is `{ key_kind: "org"; org_id: string; key_version: string } | { key_kind: "identity"; region: string; key_version: string }`. `checkContext` throws `ContextRejected` on every rejection. No AWS SDK import. Package name `@community-hub/kms-broker`. Do not add it to `packages/residency/src/catalog.json`.

- [ ] **Step 1: Write failing tests** for empty `{}`, missing `key_version`, both scope keys, neither scope key, an extra key, a bad `key_kind`, a non-object, and the two happy contexts. Assert `readContract().limits.maxBodyBytes === 65536` and the two route paths.

- [ ] **Step 2: Run** `pnpm --filter @community-hub/kms-broker test`. Expected: FAIL.

- [ ] **Step 3: Implement** the allow-list from the spec. Org requires `org_id` and rejects `region`. Identity requires `region` and rejects `org_id`. `key_version` is a string. No extra key.

- [ ] **Step 4: Re-run the filter test.** Expected: PASS.

- [ ] **Step 5: Commit** only `packages/kms-broker/**` and a root reference if one was required.

### T3 — HTTP server

**Commit:** `feat(kms-broker): serve generate and decrypt on loopback`

**Files:**

- Create: `apps/kms-broker/package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`, `eslint.config.js`
- Create: `apps/kms-broker/src/server.ts`, `apps/kms-broker/src/main.ts`, `apps/kms-broker/src/server.test.ts`
- Dependency: `@community-hub/kms-broker` workspace, `@aws-sdk/client-kms`

**Interfaces:**

- Consumes: `readContract`, `checkContext` from `@community-hub/kms-broker`
- Produces: `createServer(deps)` listening only if `start` is called, and `assertEnvelopeKeyArn(value: string): string`. `deps.kms.generateDataKey` and `deps.kms.decrypt` are the fake in tests. `deps.now` is not required. The deadline is 3000 ms inside `createServer`.

`assertEnvelopeKeyArn` accepts only `^arn:aws:kms:ap-southeast-2:[0-9]{12}:key/.+$`. `main.ts` calls it on `process.env.ENVELOPE_KEY_ARN` and `process.exit(1)` before `listen` when it throws.

`createServer` behaviour, all from the spec:

- `POST /v1/generate-data-key` and `POST /v1/decrypt` only. `keyId` must be `envelope`. Map it to the configured ARN. Both SDK calls set `KeyId` to that ARN. `GenerateDataKey` uses `KeySpec: "AES_256"`.
- Context rejections, a body over 65536, non-JSON, and a wrong `content-type` are 400 `{"error":"kms_failed"}` and do not call KMS. Honour `Content-Length` before reading. Stop a chunked body at 65536.
- AWS errors and a plaintext that is not 32 bytes are 502 with that same body. Never copy the SDK message into the body or the log.
- Any other method or path is 404 with that body and `cache-control: no-store`, and does not call KMS.
- `GET /health` is 200, empty, no KMS call.
- Every response sets `cache-control: no-store`.
- One log line per request. Keys are exactly `operation`, `key_kind`, `outcome`. Omit `key_kind` when the body did not parse.
- Race the SDK call against a 3000 ms abort. `maxAttempts` on the real client is 1. A fake that never resolves returns 502 and the test ends.
- After copying bytes out, fill the SDK `Uint8Array` with zeroes. Best-effort.

- [ ] **Step 1: Write the failing tests named in the spec's Broker list**, including 404 for `GET /v1/decrypt`, `PUT /v1/generate-data-key`, and `/anything`; the chunked oversized body; the never-resolving fake (expect 502, and the test's own timeout under 4000 ms); and `assertEnvelopeKeyArn` for missing and for `arn:aws:kms:us-east-1:123456789012:key/abc`.

- [ ] **Step 2: Run** `pnpm --filter @community-hub/kms-broker-app test` (package name `@community-hub/kms-broker-app` so it does not collide with the library). Expected: FAIL.

- [ ] **Step 3: Implement** the server and `main.ts`. The real client is constructed only in `main.ts`:

```ts
new KMSClient({
  region: "ap-southeast-2",
  maxAttempts: 1,
});
```

The 3000 ms deadline wraps the call even when the fake ignores SDK config.

- [ ] **Step 4: Re-run the app tests.** Expected: PASS.

- [ ] **Step 5: Commit** only `apps/kms-broker/**` except the Dockerfile, which is T4.

### T4 — Image build

**Commit:** `build(kms-broker): build the broker image without pushing it`

**Files:**

- Create: `apps/kms-broker/Dockerfile`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: the server from T3 and the repo lockfile
- Produces: a Dockerfile whose `FROM` is `node:24-slim@sha256:` plus 64 lowercase hex characters, install `pnpm install --frozen-lockfile`, and a CI job that builds it. No checker.

- [ ] **Step 1: Resolve the digest and write the Dockerfile**

```bash
docker buildx imagetools inspect node:24-slim --format '{{json .Manifest}}'
```

Use the manifest digest in `FROM`. Install with `pnpm install --frozen-lockfile`. Do not use `npm install`. Copy the workspace files the app needs (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `packages/kms-broker`, `apps/kms-broker`). The image `CMD` is `node` on the built `main.js`.

Review rule, not a test: a tag-only `FROM` fails review.

- [ ] **Step 2: Add the CI job** `broker-image` after `test` and before `terraform`:

```yaml
  broker-image:
    name: broker-image
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: docker build -f apps/kms-broker/Dockerfile --label org.opencontainers.image.revision=${{ github.sha }} .
```

No `docker push`. No registry login. No AWS credentials.

- [ ] **Step 3: Build locally**

```bash
docker build -f apps/kms-broker/Dockerfile --label org.opencontainers.image.revision="$(git rev-parse HEAD)" .
```

Expected: exit 0. Do not push.

- [ ] **Step 4: Commit** the Dockerfile and `ci.yml` only.

### T5 — Repository, task, and pull policy

**Commit:** `feat(infra): add the broker task behind a flag`

**Files:**

- Create: `infra/modules/aws-kms-broker/` (`main.tf`, `variables.tf`, `outputs.tf`, `versions.tf`, `.tflint.hcl`, `.terraform.lock.hcl`, `tests/broker.tftest.hcl`)

**Interfaces:**

- Consumes: `tunnel_secret_arn`, `execution_role_name`, `execution_role_arn`, `log_group_name`, `task_role_arn`, `broker_security_group_id` as variables. This module does not read the envelope module.
- Produces: ECR repository `${var.name}/kms-broker` always. When `var.enable_tasks` is false: no task definition, no service, no pull policy. When true: cluster `${var.name}-kms-broker`, Fargate task `cpu = "512"` `memory = "1024"`, `network_mode = "awsvpc"`, `assign_public_ip = true`, one `public_subnet_id`, `task_role_arn` and `broker_security_group_id` from variables. Both containers `essential = true`. `cloudflared` `dependsOn` the broker with condition `HEALTHY`. Health check command is `node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`. `secrets.valueFrom = var.tunnel_secret_arn`. Logs to `var.log_group_name`. Pull policy `role = var.execution_role_name`. No load balancer.

Image validations, whole string:

```hcl
variable "kms_broker_image" {
  type    = string
  default = null

  validation {
    condition = (
      var.kms_broker_image == null ||
      can(regex(
        "^${var.aws_account_id}\\.dkr\\.ecr\\.ap-southeast-2\\.amazonaws\\.com/${var.name}/kms-broker@sha256:[0-9a-f]{64}$",
        var.kms_broker_image
      ))
    )
    error_message = "kms_broker_image must be this cell's ECR repository digest, lowercase hex, or null."
  }
}
```

Require non-null inside a `lifecycle` precondition on the task definition when `enable_tasks` is true, so a null image cannot slip through the `||` above while the task exists.

```hcl
variable "kms_broker_cloudflared_image" {
  type    = string
  default = "docker.io/cloudflare/cloudflared@sha256:b7a6db450ae2e2f773d4fbe9ffb48e7b5fc451e17329daab1b4dda5a2487e2cc"

  validation {
    condition     = can(regex("^docker\\.io/cloudflare/cloudflared@sha256:[0-9a-f]{64}$", var.kms_broker_cloudflared_image))
    error_message = "cloudflared image must be docker.io/cloudflare/cloudflared pinned by digest."
  }
}
```

That default is the connector's current default digest. If the connector default has moved, copy the connector's current default and do not edit the connector.

Repository: `image_tag_mutability = "IMMUTABLE"`, `scan_on_push = true`. No repository policy. Pull policy statements are exactly the four actions in Global Constraints. Push actions `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload` appear in neither policy.

- [ ] **Step 1: Write `tests/broker.tftest.hcl`**

`run "flag_off"`: repository present, `image_tag_mutability` is `IMMUTABLE`, scan on push is true, no `aws_ecs_task_definition`, no `aws_ecs_service`, no `aws_iam_role_policy`.

`run "flag_on"`: image `123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/ch-staging/kms-broker@sha256:` plus 64 lowercase hex `a`s. Assert `desired_count` 2, both `essential`, the dependsOn condition, the health-check command, `secrets.valueFrom` equals the variable ARN, log group equals the variable, pull-policy actions are the four named, and the policy text does not contain the four push actions.

`run "foreign_broker_image"` with `expect_failures = [var.kms_broker_image]`: a `public.ecr.aws` digest, a `us-east-1` ECR digest, a tag, uppercase hex, and a trailing suffix. Split these into one run each if Terraform 1.11 only reports one variable failure per run.

`run "foreign_cloudflared"` with `expect_failures = [var.kms_broker_cloudflared_image]`: `docker.io/anyone/cloudflared@sha256:` plus 64 hex `b`s.

- [ ] **Step 2: Run** `terraform -chdir=infra/modules/aws-kms-broker test`. Expected: FAIL.

- [ ] **Step 3: Implement** the module. `count` the task, service, and pull policy on `var.enable_tasks`. The repository has no count.

- [ ] **Step 4: Re-run the module test.** Expected: PASS.

- [ ] **Step 5: Commit** only `infra/modules/aws-kms-broker/**`.

### T6 — Workers VPC service and the AU root

**Commit:** `feat(infra): attach the broker HTTP service to the broker tunnel`

**Files:**

- Create: `infra/modules/cf-broker-vpc-service/` (resource from the spec, `versions.tf`, `.tflint.hcl`, lock file, `tests/service.tftest.hcl`)
- Modify: `infra/regions/au/main.tf`, `variables.tf`, `outputs.tf`, `tests/cell.tftest.hcl`
- Modify: `.github/workflows/ci.yml` matrix, add `infra/modules/aws-kms-broker` and `infra/modules/cf-broker-vpc-service`

**Interfaces:**

- Consumes: `module.broker_tunnel.tunnel_id`, `module.envelope.task_role_arn`, `module.envelope.execution_role_arn`, `module.envelope.execution_role_name`, `module.envelope.tunnel_secret_arn`, `module.envelope.log_group_name`, `module.envelope.broker_security_group_id`, `module.network.public_subnet_id`
- Produces: `output.broker_vpc_service_id`, null when `var.enable_kms_broker_tasks` is false. The Postgres `module.vpc_service` call is unchanged.

VPC resource, no `https_port`, no `tls_settings`:

```hcl
resource "cloudflare_connectivity_directory_service" "broker" {
  account_id = var.account_id
  name       = "${var.name}-kms-broker"
  type       = "http"
  http_port  = 8080

  host = {
    ipv4 = "127.0.0.1"
    network = {
      tunnel_id = var.tunnel_id
    }
  }
}
```

`variable "enable_kms_broker_tasks"` on the AU root, default `false`. Pass `enable_tasks = var.enable_kms_broker_tasks` into `aws-kms-broker`. Create `cf-broker-vpc-service` only when the flag is true (`count`).

Cell tests, mocked providers, `command = plan`:

- Flag false: no broker task definition, no broker ECS service, no broker VPC service, no pull policy. `output.broker_vpc_service_id` is null. The ECR repository is in the plan. `kms_broker_image` is not required.
- Flag true: service `type` `http`, `http_port` 8080, `https_port` null, `tls_settings` null, `host.ipv4` `127.0.0.1`, no hostname, `host.network.tunnel_id` equals `module.broker_tunnel.tunnel_id` and not `module.tunnel.tunnel_id`.
- Do not `expect_failures` on `module.broker`. Image failures stay in T5.

- [ ] **Step 1: Write the module test and the two cell runs.** Expected: FAIL.

- [ ] **Step 2: Implement.** Do not edit `cf-vpc-service` or `aws-ecs-tunnel`.

- [ ] **Step 3: Run**

```bash
terraform -chdir=infra/modules/cf-broker-vpc-service test
terraform -chdir=infra/modules/aws-kms-broker test
terraform -chdir=infra/regions/au test
```

Expected: PASS.

- [ ] **Step 4: Commit** those files and the matrix rows.

### T7 — ADR, runbook, roadmap, and full CI

**Commit:** `docs(kms): record the broker service and mark the chunk done`

**Files:**

- Modify: `docs/adr/0008-kms-broker-in-the-cell.md` consequences
- Modify: `architecture.md` §12.2 paragraph that currently says the broker process is the following spec
- Modify: `docs/runbooks/apply-staging-au.md` envelope section
- Modify: `docs/roadmap.md`

**Interfaces:**

- Consumes: the behaviour shipped in T1–T6
- Produces: the docs the spec's Out-of-band section names. Roadmap snapshot: last shipped `kms-broker-service`, next `kms-worker-adapter`, Phase 0 `11 / 14`.

ADR consequences to add, in that file's existing list:

- Both containers in the broker task receive the task role credentials. `cloudflared` is trusted code inside the D8 boundary. Its image is `docker.io/cloudflare/cloudflared` pinned by digest. An unpinned tag or a foreign repository is not acceptable. An ECR pull-through cache is later work.
- Workers VPC is in beta. Features and APIs may change before general availability. The unwrap path uses an HTTP service to `127.0.0.1:8080`. If the first apply rejects that shape, stop and report.

Replace the §12.2 sentence that ends "The broker process is the following spec; this cell already has the key, the endpoint, and the tunnel." with: the cell runs the broker task when `enable_kms_broker_tasks` is true. The regional Worker still does not call it. That call is `kms-worker-adapter`.

Runbook, replacing "It does not create a broker task, an ECR repository, or a Workers VPC service. Do not push an image from this runbook.":

The flag-off apply creates the ECR repository `${name}/kms-broker` and no task. From a clean checkout of the merged commit, build `apps/kms-broker` with `org.opencontainers.image.revision` set to that SHA, push to that repository, set `kms_broker_image` to the `@sha256:` digest, then apply with `enable_kms_broker_tasks = true`. `cloudflared` stays on the Docker Hub digest. The first live proof is a `fetch()` through the VPC service to `127.0.0.1:8080`, not the tunnel's catch-all ingress. If that apply rejects the loopback service, stop and report. Do not apply prod from this runbook.

- [ ] **Step 1: Edit the four docs.**

- [ ] **Step 2: Run full CI in workflow order.** This is the gate, not a subset.

```bash
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm typecheck
pnpm check:boundaries
pnpm audit --audit-level=high
pnpm test
```

Then, for every directory in the `terraform` matrix plus `infra/modules/aws-kms-broker` and `infra/modules/cf-broker-vpc-service`:

```bash
terraform init -backend=false -lockfile=readonly
terraform fmt -check
terraform validate
tflint --init
tflint
terraform test
```

Then:

```bash
pnpm --filter @community-hub/gateway... --filter @community-hub/api... build
docker build -f apps/kms-broker/Dockerfile --label org.opencontainers.image.revision="$(git rev-parse HEAD)" .
```

`gitleaks` is the CI secret-scanning job. If the binary is not installed locally, say so in the task report. Do not skip a command that is installed.

- [ ] **Step 3: Commit** the four docs. The roadmap change is in this commit.

---

## Spec coverage

| Spec requirement | Task |
| --- | --- |
| Three envelope outputs, five runs still pass | T1 |
| Fixture, context check, no AWS SDK, not in `regionalOnlyPackages` | T2 |
| HTTP behaviour, 404, body limit, timeout, startup ARN, logs | T3 |
| Dockerfile review rule, CI build, no push | T4 |
| ECR, task, validations, pull policy, flag off | T5 |
| HTTP VPC service, AU root, cell tests | T6 |
| ADR, architecture, runbook, roadmap `11 / 14` | T7 |
| Checker for `vpc_networks` / `cf1:network` | Out. `kms-worker-adapter` |
| Pull-through cache | Out. Later work |
