# Plan: Terraform AU cell foundations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land declarative `staging-au` Terraform (bootstrap, global zone, AU cell) that CI `fmt`/`validate`/`tflint`/`test`s offline — including **module** tests — never applies, and does not block `packages-db`.

**Architecture:** One cell = one Terraform root (`infra/regions/au/`). Account-level zone lives in `infra/global/`. State bucket lives in `infra/bootstrap/` (local state, then migrated). Wrangler owns Worker routes; Terraform owns AWS, Tunnel, Hyperdrive, Workers VPC, and Regional Services settings.

**Tech Stack:** Terraform `~> 1.11`, hashicorp/aws `~> 6.0`, cloudflare/cloudflare `~> 5.13`, tflint with pinned AWS ruleset, Vitest checker for HCL invariants `terraform test` cannot see.

**Spec:** `docs/specs/2026-09-18-terraform-au-cell.md` (approved 2026-09-18, Abdus Salam)

Status: approved (2026-09-18, Abdus Salam)

**Branch:** `feat/2026-09-18-terraform-au-cell` · one PR · 8 tasks, one commit each

## Global Constraints

- `terraform init -backend=false -lockfile=readonly` in CI. Never plain `init`.
- CI matrix: every root **and every module**. A module `tests/` directory that is not in the matrix does not run.
- No live `plan` job. No apply. No AWS/Cloudflare credentials for Terraform.
- Lockfile: `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`.
- Assert **configured** values only (arguments, `jsonencode` policies, AWS v6 per-resource `region`). Never provider-computed attributes under `mock_provider`.
- `environment` is `staging` or `prod`. Prod-only rules key off it.
- Staging `zone_name` rejected by **`cf-zone` variable validation** (normalise case and trailing dot; reject apex and subdomains of `communityhub.one`).
- `enable_hyperdrive` default `false`; password `sensitive`, `default = null`, required only when the flag is true.
- Staging TLS `disabled`; `environment = "prod"` requires `verify_full`.
- Keep Workers VPC. Do not add Access + service-token origin.
- Connector SG: `ingress = []` explicitly. No `aws_vpc_security_group_ingress_rule` targeting it.
- Execution role holds secret + logs; task role empty or absent.
- No D1, KV, S3 app buckets, Worker routes, `auth.au`, `webhooks.au`, empty `ca`/`eu`/`us` roots.
- `packages-db` is documentation only in this PR.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.

---

## Tooling decisions this plan makes

| Choice              | Decision                                                                  | Why                                                                                 |
| ------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Terraform           | **`~> 1.11`**, CI pin `1.11.x` current patch                              | S3-native `use_lockfile = true`. Cross-variable validation already exists.          |
| AWS provider        | **hashicorp/aws `~> 6.0`**                                                | Per-resource `region` is a configured argument, assertable under mocks.             |
| Cloudflare provider | **`~> 5.13`** (not `>=`)                                                  | Workers VPC in 5.13; `>=` would allow a 6.x on `init -upgrade`.                     |
| Policies            | **`jsonencode({...})` in HCL**, not `data.aws_iam_policy_document`        | Plan-time known value; mocks do not invent `.json`.                                 |
| tflint AWS ruleset  | Exact semver in `.tflint.hcl`                                             | Spec: `--init` must not float. CI: `GITHUB_TOKEN` for GitHub API.                   |
| `cloudflared` image | Digest-pinned; runbook prefers ECR pull-through                           | Anonymous Docker Hub pulls from Fargate fail.                                       |
| RDS CA              | `rds-ca-rsa2048-g1` unless superseded in ap-southeast-2                   | Pin; do not leave default implicit.                                                 |
| RDS engine          | Variable, latest PostgreSQL in ap-southeast-2 (17 or 18)                  | `uuidv7()` is `packages-db`.                                                        |
| Staging instance    | `db.t4g.medium`, Multi-AZ off; deletion protection / backup retention off | `environment = "prod"` flips those.                                                 |
| Checker             | `tooling/checks/terraform-invariants/`                                    | Backend, `prevent_destroy`, connector ingress-rule resources, comment-stripped HCL. |

**Rollback:** revert the PR. Nothing is applied. No data to restore.

---

## File map

| Path                                                      | Role                               |
| --------------------------------------------------------- | ---------------------------------- |
| `tooling/checks/terraform-invariants/`                    | Static HCL invariants + fixtures   |
| `infra/bootstrap/`                                        | State bucket + KMS                 |
| `infra/global/`                                           | Dedicated staging zone             |
| `infra/regions/au/`                                       | The cell                           |
| `infra/modules/*`                                         | Shared modules (each has `tests/`) |
| `docs/adr/0002-terraform-roots-follow-failure-domains.md` | Roots + Wrangler line              |
| `docs/adr/0003-staging-tls-verification-exception.md`     | Staging `disabled` / prod blocked  |
| `docs/runbooks/apply-staging-au.md`                       | Later human apply                  |
| `.github/workflows/ci.yml`                                | `terraform` job                    |

**CI matrix directories (T8 — keep in sync when adding a module):**

```
infra/bootstrap
infra/global
infra/regions/au
infra/modules/aws-network
infra/modules/aws-kms-storage
infra/modules/aws-rds
infra/modules/aws-ecs-tunnel
infra/modules/cf-tunnel
infra/modules/cf-vpc-service
infra/modules/cf-hyperdrive
infra/modules/cf-regional-hostname
infra/modules/cf-zone
```

---

## Tasks

Each task is one commit, test-first, independently verifiable, and leaves the tree green.

### T1 — Terraform invariants checker

**Commit:** `feat(tooling): fail CI if Terraform state or connector SG invariants break`

**Files:**

- Create: `tooling/checks/terraform-invariants/{package.json,tsconfig.json,vitest.config.ts,check.ts,selftest.ts}`
- Create: fixtures under `tooling/checks/terraform-invariants/fixtures/`:
  - `valid/` — good backend + bootstrap `prevent_destroy` + connector SG with `ingress = []` and no separate ingress-rule resource
  - `wrong-region/`, `encrypt-false/`, `missing-kms/`, `missing-lockfile/`
  - `commented-region/` — `# region = "ap-southeast-2"` plus `region = "us-east-1"`
  - `missing-prevent-destroy/`
  - `connector-ingress-rule/` — `aws_vpc_security_group_ingress_rule` whose `security_group_id` is the connector group
- Modify: `tooling/checks/run.ts`

**Interfaces:**

- Produces: `check(root?: string): { ok: boolean; notice?: string; violations: { file: string; message: string }[] }`
- Strip `#` and `//` comments before matching (same idea as worker-config JSONC strip). Empty real `infra/` until T2: `ok: true` plus a notice.

**Must-fail coverage:**

| Fixture                   | Fails because                                       |
| ------------------------- | --------------------------------------------------- |
| `wrong-region`            | backend `region` not `ap-southeast-2`               |
| `encrypt-false`           | `encrypt = false`                                   |
| `missing-kms`             | no `kms_key_id`                                     |
| `missing-lockfile`        | no `use_lockfile = true`                            |
| `commented-region`        | only the live `region` counts                       |
| `missing-prevent-destroy` | bootstrap bucket/key lack `prevent_destroy = true`  |
| `connector-ingress-rule`  | separate ingress-rule resource targets connector SG |

- [ ] **Step 1: Write `selftest.ts` — RED**
- [ ] **Step 2: Implement `check.ts`; wire `run.ts`**
- [ ] **Step 3: `pnpm check:boundaries` still 0 on the real tree; every must-fail fixture fails**
- [ ] **Step 4: Commit**

```
feat(tooling): fail CI if Terraform state or connector SG invariants break

terraform test cannot read backend files, lifecycle, or sibling ingress
rule resources. Comment-stripped checks plus must-fail fixtures keep
state in ap-southeast-2 and the connector closed.

Refs: docs/plans/2026-09-18-terraform-au-cell.md task 1
```

---

### T2 — Bootstrap root

**Commit:** `feat(infra): bootstrap Terraform state bucket in ap-southeast-2`

**Files:** `infra/bootstrap/{versions.tf,main.tf,variables.tf,outputs.tf,env/staging.tfvars,env/prod.tfvars,backend/staging.hcl,backend/prod.hcl,.terraform.lock.hcl,.tflint.hcl,tests/bootstrap.tftest.hcl}`

**Do not assert** `aws_s3_bucket.state.region` (computed under mocks). Assert configured `region` (AWS v6 resource argument) and `jsonencode` policy:

```hcl
variable "aws_region" {
  type = string
  validation {
    condition     = var.aws_region == "ap-southeast-2"
    error_message = "bootstrap must stay in ap-southeast-2."
  }
}

resource "aws_s3_bucket" "state" {
  region = var.aws_region
  # ...
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}

run "staging_happy" {
  command = plan
  variables {
    aws_region  = "ap-southeast-2"
    environment = "staging"
  }
  assert {
    condition     = strcontains(aws_s3_bucket_policy.state.policy, "aws:SecureTransport")
    error_message = "bucket policy must deny non-TLS"
  }
}

run "wrong_region_fails" {
  command = plan
  variables {
    aws_region  = "us-east-1"
    environment = "staging"
  }
  expect_failures = [var.aws_region]
}
```

`prevent_destroy` is present in HCL; T1 fixture is the proof, not `terraform test`. Backend files: `region`, `encrypt = true`, `kms_key_id`, `use_lockfile = true`. Load both tfvars. KMS: `enable_key_rotation = true` (configured argument).

`.tflint.hcl`: pin exact AWS plugin version. `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`.

- [ ] **Step 1: Tests first — RED** (`terraform init -backend=false && terraform test`)
- [ ] **Step 2: Implement**
- [ ] **Step 3: Tests GREEN; T1 passes on real backend files**
- [ ] **Step 4: Commit** `feat(infra): bootstrap Terraform state bucket in ap-southeast-2`

---

### T3 — AWS network, storage KMS, RDS modules

**Commit:** `feat(infra): private AU VPC and empty RDS`

**Files:** `infra/modules/aws-network`, `aws-kms-storage`, `aws-rds` each with `tests/*.tftest.hcl`.

Connector security group:

```hcl
resource "aws_security_group" "connector" {
  region = var.aws_region
  vpc_id = aws_vpc.this.id
  ingress = []
  # egress 443, 7844, 5432 to RDS SG — as inline egress or separate egress_rule resources
}
```

**Do not** write a precondition on `aws_security_group.connector` that reads `ingress`. Assert the configured `ingress = []`. Separate `aws_vpc_security_group_ingress_rule` resources are banned by T1, not by this assert.

RDS: `publicly_accessible = false` (configured); `manage_master_user_password = true`; storage encrypted; pinned `ca_cert_identifier`; `rds.force_ssl = 1`. `expect_failures` for public RDS and region validation.

KMS: `enable_key_rotation = true`; `expect_failures` if a test run sets it false.

RDS SG: ingress 5432 only from connector SG (configured argument on the ingress rule attached to **RDS**, not the connector).

- [ ] **Step 1: Module tests RED**
- [ ] **Step 2: Implement (public subnet + IGW, no NAT; no S3)**
- [ ] **Step 3: GREEN**
- [ ] **Step 4: Commit** `feat(infra): private AU VPC and empty RDS`

---

### T4 — Tunnel: Cloudflare resource + ECS connector

**Commit:** `feat(infra): Cloudflare Tunnel connector with least-privilege execution role`

**Files:** `infra/modules/cf-tunnel`, `infra/modules/aws-ecs-tunnel`

**ECS roles (do not conflate):**

| Role               | Permissions                                                                                                                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Execution role** | `secretsmanager:GetSecretValue` on **one** secret ARN; `logs:CreateLogStream` / `PutLogEvents` on **one** log-group ARN; `kms:Decrypt` on the customer key **if** the secret is encrypted with it. Policy via `jsonencode`. |
| **Task role**      | Omit, or attach an empty role. `cloudflared` needs no AWS API.                                                                                                                                                              |

Assert execution-role `jsonencode` document contains those ARNs and does not contain `"Action":"*"`. Assert task definition `environment` has no tunnel token; secret uses `valueFrom`. Image contains `sha256:`. `retention_in_days >= 1` (`0` = never expire = fail).

- [ ] **Step 1: Tests RED**
- [ ] **Step 2: Implement.** Pin digest at implement time.
- [ ] **Step 3: GREEN**
- [ ] **Step 4: Commit** `feat(infra): Cloudflare Tunnel connector with least-privilege execution role`

---

### T5 — Zone, VPC service, Hyperdrive, regional hostname modules

**Commit:** `feat(infra): Hyperdrive over Workers VPC with staging TLS exception`

**Files:** `infra/modules/cf-zone`, `cf-vpc-service`, `cf-hyperdrive`, `cf-regional-hostname`

**Zone — enforce in the variable, not a local:**

```hcl
variable "zone_name" {
  type = string
  validation {
    condition = (
      trimsuffix(lower(var.zone_name), ".") != "communityhub.one"
      && !endswith(trimsuffix(lower(var.zone_name), "."), ".communityhub.one")
    )
    error_message = "staging zone must not be communityhub.one or a subdomain of it."
  }
}
```

`expect_failures` for `CommunityHub.one.`, `staging.communityhub.one`.

Hyperdrive: `enable_hyperdrive = false` plans without password; `true` + null password `expect_failures`; caching enabled `expect_failures`; `mtls` + `service_id` `expect_failures`. Origin is VPC `service_id` only.

VPC service: `cert_verification_mode` variable; host = RDS hostname.

Regional hostname: `region_key != "au"` `expect_failures`.

- [ ] **Step 1: Tests RED**
- [ ] **Step 2: Implement**
- [ ] **Step 3: GREEN**
- [ ] **Step 4: Commit** `feat(infra): Hyperdrive over Workers VPC with staging TLS exception`

---

### T6 — Compose `global/` and `regions/au/`

**Commit:** `feat(infra): staging-au cell root and dedicated zone`

**Files:** `infra/global/*`, `infra/regions/au/*`

```hcl
variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "prod"], var.environment)
    error_message = "environment must be staging or prod."
  }
}

variable "cert_verification_mode" {
  type = string
}

check "prod_tls" {
  assert {
    condition     = var.environment != "prod" || var.cert_verification_mode == "verify_full"
    error_message = "prod must use verify_full."
  }
}

check "prod_backup" {
  assert {
    condition     = var.environment != "prod" || (var.deletion_protection && var.backup_retention_days >= 7)
    error_message = "prod must set deletion protection and backup retention."
  }
}
```

Staging tfvars: `environment = "staging"`, `cert_verification_mode = "disabled"`. Prod tfvars: `environment = "prod"`, `verify_full`, deletion protection, backup retention ≥ 7. `expect_failures` when `environment = "prod"` and mode is `disabled`. Load **each** tfvars file.

`terraform test` in the **cell root does not replace module tests**. Module tests still live under `infra/modules/*/tests/` and must remain in the T8 matrix.

- [ ] **Step 1: Root tests RED**
- [ ] **Step 2: Compose modules; flags default false; sensitive outputs marked**
- [ ] **Step 3:** each root: `terraform init -backend=false -lockfile=readonly`, `fmt -check`, `validate`, `tflint`, `test`. T1 green on all backends.
- [ ] **Step 4: Commit** `feat(infra): staging-au cell root and dedicated zone`

---

### T7 — ADRs, architecture, AGENTS, runbook

**Commit:** `docs: record cell Terraform roots and staging TLS exception`

**Files:** ADR 0002, ADR 0003, `docs/runbooks/apply-staging-au.md`, `architecture.md` §8.1 / §23.2 / §23.3, `AGENTS.md` §10. Do **not** mark the roadmap row Done.

**Runbook must include:** apply order; `prevent_destroy` warning; bootstrap `migrate-state`; Tunnel token rotation; unexpected-connector alert; feature flags; never apply prod; **ECR pull-through cache** for digest-pinned `cloudflared` (Docker Hub anonymous limits on Fargate).

**AGENTS §10:** offline Terraform on roots **and modules**; invariants checker; live `plan` omitted; present+fail-closed or absent.

- [ ] **Step 1: Write the docs**
- [ ] **Step 2: Commit** `docs: record cell Terraform roots and staging TLS exception`

---

### T8 — CI job and full local gate

**Commit:** `ci: offline Terraform fmt, validate, tflint and test`

**Files:** `.github/workflows/ci.yml`

```yaml
terraform:
  name: terraform
  runs-on: ubuntu-latest
  strategy:
    fail-fast: false
    matrix:
      dir:
        - infra/bootstrap
        - infra/global
        - infra/regions/au
        - infra/modules/aws-network
        - infra/modules/aws-kms-storage
        - infra/modules/aws-rds
        - infra/modules/aws-ecs-tunnel
        - infra/modules/cf-tunnel
        - infra/modules/cf-vpc-service
        - infra/modules/cf-hyperdrive
        - infra/modules/cf-regional-hostname
        - infra/modules/cf-zone
  steps:
    - uses: actions/checkout@v4
    - uses: hashicorp/setup-terraform@v3
      with:
        terraform_version: 1.11.4
    - uses: terraform-linters/setup-tflint@v4
    - name: Terraform checks
      working-directory: ${{ matrix.dir }}
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      run: |
        terraform init -backend=false -lockfile=readonly
        terraform fmt -check
        terraform validate
        tflint --init
        tflint
        terraform test
```

Missing Terraform / failed `init` **fails the job**. No `plan`. No cloud provider secrets. `static` still runs `pnpm check:boundaries` (T1). Pin `1.11.4` or the current 1.11 patch at implement time — must be `~> 1.11`.

- [ ] **Step 1: Add the job**
- [ ] **Step 2: Full local gate**

```
pnpm format
pnpm lint
pnpm typecheck
pnpm check:boundaries
pnpm test
# every matrix dir:
terraform init -backend=false -lockfile=readonly
terraform fmt -check && terraform validate && tflint && terraform test
pnpm exec wrangler deploy --dry-run   # apps/gateway
```

Expected: all exit 0. No AWS/Cloudflare credentials used.

- [ ] **Step 3: Commit** `ci: offline Terraform fmt, validate, tflint and test`

**Must not break:** gateway preview still fail-closed on missing Cloudflare secrets.

---

## Self-review (plan vs spec)

| Spec requirement                                                                         | Task         |
| ---------------------------------------------------------------------------------------- | ------------ |
| Three roots + modules; no unused S3 module                                               | T2–T6        |
| Invariants checker: backend, lockfile, comments, prevent_destroy, connector ingress-rule | T1           |
| Bootstrap jsonencode deny-TLS; region validation; prevent_destroy via T1                 | T2           |
| Connector `ingress = []`; RDS private; storage KMS                                       | T3           |
| Execution role vs empty task role; digest; retention ≥ 1                                 | T4           |
| Workers VPC; Hyperdrive flags; **cf-zone variable validation**; RS `au`                  | T5           |
| `environment`; prod `verify_full` / backup checks; all tfvars                            | T6           |
| ADR 0002/0003, architecture, AGENTS, runbook + ECR line                                  | T7           |
| Matrix includes **modules**; `-lockfile=readonly`; `GITHUB_TOKEN` for tflint             | T8           |
| `packages-db` / PgBouncer                                                                | T7 docs only |
| Never applied                                                                            | T7–T8        |

No live apply, no Access origin, no Worker routes, no computed-attribute asserts under mocks.
