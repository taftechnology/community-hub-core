# Plan: Envelope wrapping key and AU KMS path

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the AU envelope wrapping key, its apply-time action guard, the KMS interface endpoint, and a separate broker tunnel, with offline tests and no broker process yet.

**Architecture:** The envelope key's only cryptographic principal is an IAM task role that no task assumes in this plan. Every cryptographic statement requires `aws:SourceVpce` of a KMS interface endpoint in the public subnet. The broker tunnel, token, and secret are distinct from the Postgres tunnel. The Worker, the container, and the ECS task are a following spec.

**Tech Stack:** Terraform `~> 1.11`, hashicorp/aws `~> 6.0`, cloudflare/cloudflare `~> 5.13`, tflint AWS ruleset `0.48.0`, the existing `terraform-invariants` checker.

**Spec:** `docs/specs/2026-09-30-terraform-envelope-kms.md`

Status: approved (2026-10-01, Abdus Salam)

**Branch:** `feat/2026-09-30-terraform-envelope-kms` · one PR · 7 tasks, one commit each

## Global Constraints

- This plan is the infrastructure seam only. No `apps/kms-broker`, no `@community-hub/kms-broker`, no Dockerfile, no `docker build`, no ECR repository, no ECS task or service, no Workers VPC service, no `enable_kms_broker_tasks`.
- Do not edit `infra/modules/aws-ecs-tunnel` or the Postgres `module "tunnel"` call. The connector task role stays absent.
- Do not edit `@community-hub/crypto`.
- `terraform init -backend=false -lockfile=readonly`. No live `plan`. No apply. No AWS or Cloudflare credentials.
- Lock new modules with `terraform providers lock -platform=linux_amd64 -platform=darwin_arm64`.
- Assert configured values and `jsonencode` documents. Do not assert provider-computed attributes unless `mock_resource` makes them a known string.
- Key policy is `jsonencode` of a local. No `data.aws_iam_policy_document`.
- The precondition reads the statement local, not the encoded string. It does not read the endpoint id.
- `policy_probe_action` defaults to null. Neither tfvars file sets it. There is no variable that disables the precondition.
- Storage key policy is the single account-root `kms:*` statement. Do not narrow it. If a live apply shows any other statement, stop and report.
- `bypass_policy_lockout_safety_check = false` is set on the envelope key.
- Broker tunnel secret uses the AWS-managed Secrets Manager key. No `kms_key_id`.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- The last commit updates `docs/roadmap.md`: `terraform-envelope-kms` **done**, next `kms-broker-service`, Phase 0 `10 / 14`. Insert `kms-broker-service`, then `kms-worker-adapter`, then `kms-mrk-replica` after the done row and before `api-au-hostname`.

**Size:** Envelope module, tunnel module, storage-policy edit, root wiring, checker, ADR, and runbook are about 900 lines excluding lockfiles and fixtures. The broker server, image, and task definition are `docs/specs/2026-10-01-kms-broker-service.md`, a separate spec, plan, and branch. This plan implements only `docs/specs/2026-09-30-terraform-envelope-kms.md`.

**Rollback:** Revert the PR. Nothing in this plan is applied. No data to restore.

---

## File map

| Path | Role |
| --- | --- |
| `tooling/checks/terraform-invariants/` | `prevent_destroy` on `aws_kms_key.envelope` |
| `infra/modules/aws-kms-envelope/` | Key, policy, guard, endpoint, broker security group, task role, tunnel secret, execution role |
| `infra/modules/aws-kms-storage/` | Explicit default key policy |
| `infra/modules/cf-broker-tunnel/` | Second tunnel and its ingress |
| `infra/regions/au/` | Wire the modules. Postgres tunnel unchanged |
| `docs/adr/0008-kms-broker-in-the-cell.md` | Decision record |
| `architecture.md` | Diagram and §12.2 / §22 |
| `docs/runbooks/apply-staging-au.md` | Key, endpoint, tunnel. No image push |
| `.github/workflows/ci.yml` | Matrix entries for the two new modules |

---

## Tasks

Each task is one commit. The tree stays green after each commit.

### T1 — Envelope key must set prevent_destroy

**Commit:** `feat(tooling): require prevent_destroy on the envelope KMS key`

**Files:**

- Modify: `tooling/checks/terraform-invariants/check.ts`
- Modify: `tooling/checks/terraform-invariants/selftest.ts`
- Create: `tooling/checks/terraform-invariants/fixtures/missing-envelope-prevent-destroy/infra/modules/aws-kms-envelope/main.tf`

**Interfaces:**

- Consumes: `check(root?: string)` and `findResources` already in `check.ts`
- Produces: a violation when a file under `infra/modules/aws-kms-envelope/` contains `aws_kms_key` `envelope` whose body lacks `prevent_destroy = true`. No other `aws_kms_key` is affected. A tree with no envelope key stays valid.

- [ ] **Step 1: Write the failing fixture and register it**

`selftest.ts` gains `"missing-envelope-prevent-destroy"` in `mustFail`.

Fixture `main.tf`:

```hcl
resource "aws_kms_key" "envelope" {
  region              = "ap-southeast-2"
  enable_key_rotation = true
}
```

- [ ] **Step 2: Run the checker test and confirm RED**

Run: `pnpm --filter @community-hub/check-terraform-invariants test`

Expected: FAIL. The new fixture is `ok: true` because the checker does not look at that module yet.

- [ ] **Step 3: Implement the check**

In `check.ts`, add `validateEnvelopeKeyFile`. From the existing `allTf` loop, when `isUnder(filePath, resolvedRoot, path.join(INFRA_DIR, "modules", "aws-kms-envelope"))`, scan resources. If `type === "aws_kms_key"` and `name === "envelope"` and the body does not match `/prevent_destroy\s*=\s*true\b/`, push a violation whose message is `envelope KMS key must set lifecycle.prevent_destroy = true`.

Do not require `prevent_destroy` on `aws_kms_key.storage` or `aws_kms_key.state`.

- [ ] **Step 4: Confirm GREEN**

Run: `pnpm --filter @community-hub/check-terraform-invariants test` and `pnpm check:boundaries`

Expected: the new fixture fails the check (`ok: false`). `valid` still passes. The real tree passes, because `infra/modules/aws-kms-envelope/` does not exist yet.

- [ ] **Step 5: Commit** the checker, the fixture, and `selftest.ts` only.

```
feat(tooling): require prevent_destroy on the envelope KMS key

terraform test cannot see lifecycle. A must-fail fixture keeps the
wrapping key from being destroyed with the cell.

Refs: docs/plans/2026-10-01-terraform-envelope-kms.md task 1
```

---

### T2 — Envelope key, guard, endpoint, and task role

**Commit:** `feat(infra): add the AU envelope key and KMS endpoint`

**Files:**

- Create: `infra/modules/aws-kms-envelope/{versions.tf,main.tf,variables.tf,outputs.tf,.tflint.hcl,.terraform.lock.hcl,tests/envelope.tftest.hcl}`
- Copy `versions.tf` from `infra/modules/aws-kms-storage/versions.tf` and `.tflint.hcl` from `infra/modules/aws-kms-storage/.tflint.hcl`.

**Interfaces:**

- Consumes: `aws_region`, `aws_account_id`, `name`, `vpc_id`, `public_subnet_id`, `broker_tunnel_token` (sensitive)
- Produces:
  - `key_arn`, `key_id`, `alias_name`
  - `task_role_arn`, `task_role_name` (`${name}-kms-broker-task`)
  - `broker_security_group_id`, `endpoint_id`
  - `execution_role_arn`, `tunnel_secret_name`

The module does not create an ECS service, a task definition, or an ECR repository.

- [ ] **Step 1: Write `tests/envelope.tftest.hcl` — RED**

`mock_provider "aws"` with:

```hcl
mock_resource "aws_vpc_endpoint" {
  defaults = {
    id = "vpce-mock"
  }
}
```

`run "happy"` plans with `aws_region = "ap-southeast-2"`, `aws_account_id = "123456789012"`, `name = "ch-staging"`, `vpc_id = "vpc-mock"`, `public_subnet_id = "subnet-mock"`, `broker_tunnel_token = "token-mock"`, `policy_probe_action = null`.

Assert:

- `aws_kms_key.envelope.region == "ap-southeast-2"`
- `enable_key_rotation == true`
- `deletion_window_in_days == 30`
- `bypass_policy_lockout_safety_check == false`
- `aws_kms_alias.envelope.name == "alias/ch-staging-envelope"`
- `aws_vpc_endpoint.kms.service_name == "com.amazonaws.ap-southeast-2.kms"`
- `aws_vpc_endpoint.kms.vpc_endpoint_type == "Interface"`
- `aws_vpc_endpoint.kms.private_dns_enabled == true`
- `aws_security_group.broker.ingress` is empty
- endpoint ingress is TCP 443, its `cidr_blocks` is empty, and `ingress[0].security_groups` equals `[aws_security_group.broker.id]`. Also assert `file("${path.module}/main.tf")` contains `security_groups = [aws_security_group.broker.id]`, because a shared mock security-group id would make the planned list match even if the source referenced the wrong group
- `file("${path.module}/main.tf")` contains `depends_on = [aws_iam_role.task]` on `aws_kms_key.envelope`
- `jsondecode(aws_kms_key.envelope.policy).Statement` has length 5 and `Sid` values `Admin`, `GenerateDataKeyOrg`, `GenerateDataKeyIdentity`, `DecryptOrg`, `DecryptIdentity` in that order
- admin `Action` equals the 16-name list in the spec, including `kms:PutKeyPolicy`, and does not include `kms:CreateGrant`, `kms:Encrypt`, `kms:Decrypt`, or `kms:GenerateDataKey`
- each cryptographic statement's `Action` is a one-element list: `kms:GenerateDataKey` or `kms:Decrypt` matching its `Sid`
- each cryptographic statement's `Condition` includes `aws:SourceVpce = "vpce-mock"`, `ForAllValues:StringEquals` on `kms:EncryptionContextKeys`, and `Null` entries `"false"` for required keys and `"true"` for the forbidden scope key (`region` on org, `org_id` on identity)
- the policy string does not contain `kms:CreateGrant`, `kms:Encrypt`, `kms:ReEncrypt`, `kms:GenerateDataKeyWithoutPlaintext`, or `kms:GenerateDataKeyPair`
- `aws_iam_role.task.name == "ch-staging-kms-broker-task"`
- `file("${path.module}/main.tf")` does not contain `aws_iam_role_policy`
- execution role policy contains `kms-broker-tunnel-token` and `secretsmanager:GetSecretValue`, and does not contain `kms:`
- `aws_secretsmanager_secret.broker_tunnel.kms_key_id` is null
- no resource address in the plan is `aws_ecs_service` or `aws_lb` (do not declare them; the test file does not reference them)

`run "probe_create_grant"` sets `policy_probe_action = "kms:CreateGrant"` and:

```hcl
expect_failures = [terraform_data.envelope_key_policy]
```

`run "wrong_region"`, `run "rotation_off"`, and `run "log_retention_zero"` use `expect_failures` on `var.aws_region`, `var.enable_key_rotation`, and `var.log_retention_days`.

- [ ] **Step 2: Run the test and confirm RED**

From `infra/modules/aws-kms-envelope`:

```
terraform init -backend=false
terraform test
```

Expected: FAIL because the module files do not exist yet. After the files exist, a wrong guard must fail `probe_create_grant` rather than pass it.

- [ ] **Step 3: Implement the module**

`variables.tf` includes `aws_region` validated to `ap-southeast-2`, `aws_account_id`, `name`, `vpc_id`, `public_subnet_id`, `broker_tunnel_token` (`sensitive = true`), `enable_key_rotation` default `true` with validation that it is true, `log_retention_days` default `14` with validation `> 0`, and:

```hcl
variable "policy_probe_action" {
  type        = string
  default     = null
  description = "Test-only action appended to the admin statement. Any non-null value fails the plan."
}
```

`main.tf` locals:

```hcl
locals {
  admin_actions = [
    "kms:DescribeKey",
    "kms:GetKeyPolicy",
    "kms:GetKeyRotationStatus",
    "kms:ListResourceTags",
    "kms:PutKeyPolicy",
    "kms:CreateAlias",
    "kms:DeleteAlias",
    "kms:EnableKey",
    "kms:DisableKey",
    "kms:EnableKeyRotation",
    "kms:DisableKeyRotation",
    "kms:UpdateKeyDescription",
    "kms:TagResource",
    "kms:UntagResource",
    "kms:ScheduleKeyDeletion",
    "kms:CancelKeyDeletion",
  ]

  expected_sids = [
    "Admin",
    "GenerateDataKeyOrg",
    "GenerateDataKeyIdentity",
    "DecryptOrg",
    "DecryptIdentity",
  ]

  task_role_arn = "arn:aws:iam::${var.aws_account_id}:role/${var.name}-kms-broker-task"
  root_arn      = "arn:aws:iam::${var.aws_account_id}:root"

  admin_action_list = var.policy_probe_action == null ? local.admin_actions : concat(local.admin_actions, [var.policy_probe_action])

  policy_statements = [
    {
      Sid       = "Admin"
      Effect    = "Allow"
      Principal = { AWS = local.root_arn }
      Action    = local.admin_action_list
      Resource  = "*"
    },
    {
      Sid       = "GenerateDataKeyOrg"
      Effect    = "Allow"
      Principal = { AWS = local.task_role_arn }
      Action    = ["kms:GenerateDataKey"]
      Resource  = "*"
      Condition = {
        StringEquals = {
          "aws:SourceVpce"                 = aws_vpc_endpoint.kms.id
          "kms:EncryptionContext:key_kind" = "org"
        }
        "ForAllValues:StringEquals" = {
          "kms:EncryptionContextKeys" = ["key_kind", "org_id", "key_version"]
        }
        Null = {
          "kms:EncryptionContext:key_kind"    = "false"
          "kms:EncryptionContext:org_id"      = "false"
          "kms:EncryptionContext:key_version" = "false"
          "kms:EncryptionContext:region"      = "true"
        }
      }
    },
    {
      Sid       = "GenerateDataKeyIdentity"
      Effect    = "Allow"
      Principal = { AWS = local.task_role_arn }
      Action    = ["kms:GenerateDataKey"]
      Resource  = "*"
      Condition = {
        StringEquals = {
          "aws:SourceVpce"                 = aws_vpc_endpoint.kms.id
          "kms:EncryptionContext:key_kind" = "identity"
        }
        "ForAllValues:StringEquals" = {
          "kms:EncryptionContextKeys" = ["key_kind", "region", "key_version"]
        }
        Null = {
          "kms:EncryptionContext:key_kind"    = "false"
          "kms:EncryptionContext:region"      = "false"
          "kms:EncryptionContext:key_version" = "false"
          "kms:EncryptionContext:org_id"      = "true"
        }
      }
    },
    {
      Sid       = "DecryptOrg"
      Effect    = "Allow"
      Principal = { AWS = local.task_role_arn }
      Action    = ["kms:Decrypt"]
      Resource  = "*"
      Condition = {
        StringEquals = {
          "aws:SourceVpce"                 = aws_vpc_endpoint.kms.id
          "kms:EncryptionContext:key_kind" = "org"
        }
        "ForAllValues:StringEquals" = {
          "kms:EncryptionContextKeys" = ["key_kind", "org_id", "key_version"]
        }
        Null = {
          "kms:EncryptionContext:key_kind"    = "false"
          "kms:EncryptionContext:org_id"      = "false"
          "kms:EncryptionContext:key_version" = "false"
          "kms:EncryptionContext:region"      = "true"
        }
      }
    },
    {
      Sid       = "DecryptIdentity"
      Effect    = "Allow"
      Principal = { AWS = local.task_role_arn }
      Action    = ["kms:Decrypt"]
      Resource  = "*"
      Condition = {
        StringEquals = {
          "aws:SourceVpce"                 = aws_vpc_endpoint.kms.id
          "kms:EncryptionContext:key_kind" = "identity"
        }
        "ForAllValues:StringEquals" = {
          "kms:EncryptionContextKeys" = ["key_kind", "region", "key_version"]
        }
        Null = {
          "kms:EncryptionContext:key_kind"    = "false"
          "kms:EncryptionContext:region"      = "false"
          "kms:EncryptionContext:key_version" = "false"
          "kms:EncryptionContext:org_id"      = "true"
        }
      }
    },
  ]
}

resource "terraform_data" "envelope_key_policy" {
  lifecycle {
    precondition {
      condition = (
        var.policy_probe_action == null &&
        length(local.policy_statements) == 5 &&
        [for statement in local.policy_statements : statement.Sid] == local.expected_sids &&
        local.policy_statements[0].Action == local.admin_actions &&
        local.policy_statements[1].Action == ["kms:GenerateDataKey"] &&
        local.policy_statements[2].Action == ["kms:GenerateDataKey"] &&
        local.policy_statements[3].Action == ["kms:Decrypt"] &&
        local.policy_statements[4].Action == ["kms:Decrypt"]
      )
      error_message = "envelope key policy must be exactly five statements with the allowed actions."
    }
  }
}
```

`var.policy_probe_action == null` is required so a duplicate of an allowed action still fails: list equality would also fail for a duplicate, and the null check fails even before the lists are compared. Keep both. The precondition does not mention `aws_vpc_endpoint.kms.id`.

`aws_kms_key.envelope` uses `policy = jsonencode({ Version = "2012-10-17", Statement = local.policy_statements })`, `deletion_window_in_days = 30`, `bypass_policy_lockout_safety_check = false`, rotation from the variable, region from the variable, `lifecycle { prevent_destroy = true }`, and `depends_on = [aws_iam_role.task]`. Keep the string ARN. The `depends_on` is the apply order. KMS rejects a principal that does not exist, and the AWS provider's IAM retry does not cover a role that has not been created at all.

Alias name `alias/${var.name}-envelope`.

`aws_iam_role.task` name `${var.name}-kms-broker-task`, trust `ecs-tasks.amazonaws.com` only. No `aws_iam_role_policy` and no policy attachment.

`aws_security_group.broker`: `ingress = []`, egress TCP 443 and TCP 7844 to `0.0.0.0/0`, same shape as `aws_security_group.connector` in `infra/modules/aws-network/main.tf`. Description: broker task, no inbound.

`aws_security_group.endpoint`: ingress TCP 443 from `aws_security_group.broker.id` only (`cidr_blocks = []`). Egress empty.

`aws_vpc_endpoint.kms`: interface, service `com.amazonaws.ap-southeast-2.kms`, `subnet_ids = [var.public_subnet_id]`, `private_dns_enabled = true`, security group `aws_security_group.endpoint.id`.

Secret name `${var.name}/kms-broker-tunnel-token`, no `kms_key_id`. Secret version `secret_string = var.broker_tunnel_token`.

Execution role name `${var.name}-kms-broker-execution`. Its inline policy, via `jsonencode`, allows `secretsmanager:GetSecretValue` on that secret's ARN (with the `*` suffix the connector uses) and `logs:CreateLogStream` plus `logs:PutLogEvents` on `/community-hub/${var.name}/kms-broker`. It does not contain a `kms:` action.

Log group `/community-hub/${var.name}/kms-broker` with `retention_in_days = var.log_retention_days`. The log group exists so the execution policy's ARN is real. No task definition uses it in this plan.

- [ ] **Step 4: Confirm GREEN**

From `infra/modules/aws-kms-envelope`:

```
terraform init -backend=false
terraform providers lock -platform=linux_amd64 -platform=darwin_arm64
terraform fmt -check
terraform validate
tflint --init
tflint
terraform test
```

Expected: `happy` passes, `probe_create_grant` fails on `terraform_data.envelope_key_policy`, region and rotation and log-retention runs fail validation. Commit `.terraform.lock.hcl`.

- [ ] **Step 5: Commit** the module only.

```
feat(infra): add the AU envelope key and KMS endpoint

The wrapping key allows GenerateDataKey and Decrypt only to the broker
task role, and only through the cell's KMS endpoint. A sixth statement
or an extra admin action fails the plan.

Refs: docs/plans/2026-10-01-terraform-envelope-kms.md task 2
```

---

### T3 — Make the storage key policy explicit

**Commit:** `feat(infra): record the storage KMS key's default policy`

**Files:**

- Modify: `infra/modules/aws-kms-storage/{main.tf,variables.tf,tests/kms.tftest.hcl}`
- Modify: `infra/regions/au/main.tf` to pass `aws_account_id = var.aws_account_id` into `module "kms"`

**Interfaces:**

- Consumes: new required variable `aws_account_id` on `aws-kms-storage`
- Produces: `aws_kms_key.storage.policy` is `jsonencode` of one statement, `Sid` `EnableIAMUserPermissions`, principal `arn:aws:iam::${aws_account_id}:root`, action `kms:*`, resource `*`

Do not add `prevent_destroy`. Do not remove rotation or the alias. Do not grant `kms-broker-task`.

- [ ] **Step 1: Extend `tests/kms.tftest.hcl`**

Add `aws_account_id = "123456789012"` to every run. On `staging_happy`, assert the decoded policy has one statement, action `kms:*`, principal the root ARN, and the policy string does not contain `kms-broker-task`.

- [ ] **Step 2: Run `terraform test` in `infra/modules/aws-kms-storage` and confirm RED** because `aws_account_id` is not a variable yet.

- [ ] **Step 3: Add the variable and the `policy` argument.** Pass `aws_account_id` from `infra/regions/au/main.tf`.

- [ ] **Step 4: `terraform test` in the storage module and in `infra/regions/au` passes.**

- [ ] **Step 5: Commit**

```
feat(infra): record the storage KMS key's default policy

The default account-root statement is now in config so tests can see it.
It is not narrowed, and it does not name the envelope task role.

Refs: docs/plans/2026-10-01-terraform-envelope-kms.md task 3
```

---

### T4 — Broker tunnel

**Commit:** `feat(infra): add a Cloudflare tunnel for the KMS broker`

**Files:**

- Create: `infra/modules/cf-broker-tunnel/{versions.tf,main.tf,variables.tf,outputs.tf,.tflint.hcl,.terraform.lock.hcl,tests/tunnel.tftest.hcl}`
- Copy `versions.tf` and `.tflint.hcl` from `infra/modules/cf-tunnel/`.

**Interfaces:**

- Consumes: `account_id`, `name`
- Produces: `tunnel_id`, `tunnel_name`, `tunnel_token` (`sensitive = true`)

Do not add an ingress argument to `infra/modules/cf-tunnel`. The Postgres tunnel module stays a tunnel plus a token data source.

- [ ] **Step 1: Write `tests/tunnel.tftest.hcl`**

`mock_provider "cloudflare"` with the same tunnel id and token defaults `infra/regions/au/tests/cell.tftest.hcl` uses.

`run "happy"` asserts:

- `cloudflare_zero_trust_tunnel_cloudflared.this.name == var.name`
- the config resource's origin services are `http://127.0.0.1:8080` and `http_status:404`, in that order, and no service contains an RDS hostname or the string `postgres`
- `tunnel_token` output is sensitive (assert the output exists; do not print it)

Use the `config` / `ingress_rule` blocks from the locked `cloudflare` provider `~> 5.13`. If that provider cannot express those two services, stop and report. Do not invent a public hostname.

- [ ] **Step 2: `terraform init -backend=false && terraform test` fails** because the module does not exist.

- [ ] **Step 3: Implement.** Tunnel resource matches `infra/modules/cf-tunnel/main.tf` (`config_src = "cloudflare"`). Add `cloudflare_zero_trust_tunnel_cloudflared_config` with the two ingress rules. Outputs: `tunnel_id`, `tunnel_name = var.name`, `tunnel_token` from the token data source, `sensitive = true`.

- [ ] **Step 4: `terraform fmt -check`, `validate`, `tflint`, `terraform test` pass.** Commit the lockfile.

- [ ] **Step 5: Commit**

```
feat(infra): add a Cloudflare tunnel for the KMS broker

The broker tunnel's only origin is loopback port 8080. It does not share
the Postgres tunnel or its token.

Refs: docs/plans/2026-10-01-terraform-envelope-kms.md task 4
```

---

### T5 — Wire the AU root

**Commit:** `feat(infra): wire the envelope key and broker tunnel into the AU cell`

**Files:**

- Modify: `infra/regions/au/{main.tf,variables.tf,outputs.tf,tests/cell.tftest.hcl}`
- Modify: `.github/workflows/ci.yml` matrix, adding `infra/modules/aws-kms-envelope` and `infra/modules/cf-broker-tunnel`

**Interfaces:**

- Consumes: `module.network.vpc_id`, `module.network.public_subnet_id`, `module.kms` (storage), `var.aws_account_id`, `var.cloudflare_account_id`, `local.name`
- Produces:
  - `output "envelope_key_arn"`
  - `output "kms_endpoint_id"`
  - `output "broker_tunnel_id"`
  - `output "broker_tunnel_token"` with `sensitive = true`
  - `variable "policy_probe_action"` type `string`, default `null`, passed into the envelope module

`module "tunnel"` is unchanged. No `enable_kms_broker_tasks`. No ECS module call.

- [ ] **Step 1: Extend `tests/cell.tftest.hcl`**

On `staging_happy`, assert:

- `module.broker_tunnel.tunnel_name == "ch-staging-au-kms"`
- `module.tunnel` is still present and the broker module's name output is not equal to `"${local.name}-au"` (the Postgres tunnel name). Compare outputs, not mock ids: both tunnels share one mock id, so an id inequality tests the mock.
- secret name from the envelope module is `ch-staging/kms-broker-tunnel-token`
- storage key policy does not contain `kms-broker-task`
- envelope key policy contains `role/ch-staging-kms-broker-task` and contains `vpce-` only as a mock id, and contains `kms:GenerateDataKey`
- connector execution policy does not contain `kms-broker-tunnel-token`
- broker execution policy does not contain `/cloudflare-tunnel-token` and does not contain `kms:`
- `file("${path.module}/env/staging.tfvars")` and `env/prod.tfvars` do not contain `policy_probe_action`
- `module.vpc_service` still uses `module.tunnel.tunnel_id`, not `module.broker_tunnel.tunnel_id`

Add `run "probe_fails"` copying `staging_happy`'s variables plus `policy_probe_action = "kms:CreateGrant"` and `expect_failures = [module.envelope.terraform_data.envelope_key_policy]`.

- [ ] **Step 2: `terraform test` in `infra/regions/au` fails** on the missing module.

- [ ] **Step 3: Wire `main.tf`**

```hcl
module "broker_tunnel" {
  source = "../../modules/cf-broker-tunnel"

  account_id = var.cloudflare_account_id
  name       = "${local.name}-au-kms"
}

module "envelope" {
  source = "../../modules/aws-kms-envelope"

  aws_region           = var.aws_region
  aws_account_id       = var.aws_account_id
  name                 = local.name
  vpc_id               = module.network.vpc_id
  public_subnet_id     = module.network.public_subnet_id
  broker_tunnel_token  = module.broker_tunnel.tunnel_token
  policy_probe_action  = var.policy_probe_action
}
```

Pass `aws_account_id` into `module "kms"` if T3 has not already been merged into this branch's `main.tf`. Do not pass `policy_probe_action` from either tfvars file.

Add the two directories to the `terraform` job matrix in `.github/workflows/ci.yml`. A module that is not in the matrix does not run in CI.

- [ ] **Step 4: `terraform test` in `infra/regions/au` passes**, including `probe_fails`.

- [ ] **Step 5: Commit** the root, the test, and `ci.yml`.

```
feat(infra): wire the envelope key and broker tunnel into the AU cell

The cell plans a second tunnel and a wrapping key whose task role is
absent from the storage key policy. The Postgres connector is unchanged.

Refs: docs/plans/2026-10-01-terraform-envelope-kms.md task 5
```

---

### T6 — ADR, architecture, runbook

**Commit:** `docs(kms): record the in-cell broker decision`

**Files:**

- Create: `docs/adr/0008-kms-broker-in-the-cell.md`
- Modify: `architecture.md` (§5 diagram, §12.2, §22)
- Modify: `docs/runbooks/apply-staging-au.md`
- Modify: `docs/roadmap.md`

**Interfaces:**

- Consumes: the modules from T5
- Produces: ADR 0008 accepted for this spec. Architecture says the Worker reaches KMS through the broker. The runbook tells the human what this apply creates and what it does not.

- [ ] **Step 1: Write the ADR**

```markdown
# ADR 0008: KMS unwrap goes through an in-cell broker

- Status: accepted
- Date: 2026-10-01
- Spec: `docs/specs/2026-09-30-terraform-envelope-kms.md`
- Amends: the operational shape of D8

## Context

D8 wraps field keys with AWS KMS in the cell's region. §7.3 rule 5 distributes Worker secrets globally, so an IAM access key in a Workers secret would be a worldwide credential that can unwrap every organisation key. IAM Roles Anywhere still puts a long-lived private key in that secret store.

## Decision

The regional Worker calls an in-VPC broker. The broker task role is the only principal that may call `kms:GenerateDataKey` and `kms:Decrypt` on the envelope key. Those calls must arrive through the KMS interface endpoint in the public subnet (`aws:SourceVpce`). The key policy has exactly five statements.

Plaintext roots go from the broker over loopback, then the broker's own tunnel, then Cloudflare's network, to the regional Worker. That is the same path, and the same AU-only argument, as Postgres traffic (`docs/specs/2026-09-18-terraform-au-cell.md`, architecture §7.3).

Zeroing the SDK plaintext buffer is best-effort. The base64 string in the JSON response cannot be wiped, and it lives until garbage collection.

## Consequences

- About US$7–8 per month for one interface endpoint in one availability zone. The cost starts when this infrastructure is applied, before a broker task exists.
- Two broker tasks will share the one public subnet. Loss of that availability zone takes unwrap with it. This ADR does not add a subnet.
- This plan does not deploy the broker process. Until that following spec, nothing assumes the task role.
- The envelope key is single-region. The Melbourne replica is the later row `kms-mrk-replica`.
- An account administrator can `kms:PutKeyPolicy` and grant themselves `Decrypt`. CloudTrail records that change. `bypass_policy_lockout_safety_check` stays false.

## Alternatives rejected

- A long-lived IAM access key as a Workers secret.
- IAM Roles Anywhere. The X.509 private key would still be a Workers secret, and a copy of it can mint a session from outside the VPC.
```

- [ ] **Step 2: Edit `architecture.md`**

In the §5 diagram, add a node `BR[kms-broker<br/>ECS Sydney]` inside the AU subgraph and replace the edge `API --> KMS` with `API --> BR` and `BR --> KMS`. Leave `API --> PG` and `API --> S3`.

In §12.2, after the key-wrapping diagram, add: the regional Worker does not call KMS and does not hold an AWS credential. It will call the in-cell broker over that tunnel. The broker task role calls `GenerateDataKey` and `Decrypt`. See ADR 0008. The broker process is the following spec; this cell already has the key, the endpoint, and the tunnel.

In the §22 KMS row, add that the envelope wrapping key is single-region in `ap-southeast-2`, and the Multi-Region replica in `ap-southeast-4` is the later row `kms-mrk-replica`.

Do not change the D8 table cell except that ADR 0008 amends its operational shape. One clause on the D8 row is enough: "Worker calls an in-cell broker; ADR 0008."

- [ ] **Step 3: Extend the runbook**

After the tunnel-token section, add a "Envelope key and broker tunnel" section:

- The AU apply creates the envelope key (`prevent_destroy`, `depends_on` the task role), the KMS interface endpoint (about US$7–8 per month from this apply), the broker security group, the task role, and the broker tunnel plus its secret.
- If the first apply fails with an invalid principal, the key was created before `aws_iam_role.task`. The module sets `depends_on`. Do not remove it to make a plan look simpler.
- It does not create a broker task, an ECR repository, or a Workers VPC service. Do not push an image from this runbook.
- The broker tunnel token rotates the same way as the connector token, and it is a different secret (`<name>/kms-broker-tunnel-token`). Revoking the connector token does not rotate the broker token.
- If the live storage key's policy is anything other than the single account-root `kms:*` statement, stop. Do not overwrite it.
- Do not apply prod from this runbook.

- [ ] **Step 4: Update `docs/roadmap.md`**

Snapshot: last shipped `terraform-envelope-kms`, next `kms-broker-service`, Phase 0 `10 / 14` done.

Row `terraform-envelope-kms` → **done**. Text: wrapping key, key policy, KMS endpoint, broker tunnel. Spec `2026-09-30-terraform-envelope-kms`.

Insert `kms-broker-service` and `kms-worker-adapter` between the done envelope row and the existing `api-au-hostname` row. Insert `kms-mrk-replica` after `api-au-hostname`. Resulting order:

| not started | `kms-broker-service` | Broker process, image, ECS task, Workers VPC service on the broker tunnel. Spec `2026-10-01-kms-broker-service`. |
| not started | `kms-worker-adapter` | Worker `KmsPort` against `kms-port-v1.json`. VPC binding only on `apps/api`. |
| not started | `api-au-hostname` | Unchanged. Already in the table. |
| not started | `kms-mrk-replica` | Multi-Region replica of the envelope key in `ap-southeast-4`. |

The next-spec paragraph names `kms-broker-service`.

Phase 0 was 11 rows with 9 done. This commit finishes one row and adds three. That is 14 rows, 10 done.

- [ ] **Step 5: Commit** docs and the roadmap together. This is the last commit on the branch.

```
docs(kms): record the in-cell broker decision

ADR 0008 names the task role and the VPC endpoint as the unwrap path.
The runbook applies the key and the tunnel and does not deploy a broker.

Refs: docs/plans/2026-10-01-terraform-envelope-kms.md task 6
```

---

### T7 — Full CI, in workflow order

**Commit:** only if a previous task left CI red and this task fixes it. If T1–T6 already leave CI green, this task is the verification gate and has no commit of its own. Do not create an empty commit.

**Files:** none new if T5 already updated `ci.yml`.

- [ ] **Step 1: Run the `static` job commands**

```
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm typecheck
pnpm check:boundaries
```

Secret scanning and `pnpm audit --audit-level=high` need the tools the workflow uses. If gitleaks is not installed locally, say so in the task report and do not skip the pnpm commands above.

- [ ] **Step 2: Run the `test` job**

`pnpm test`. The db package starts Postgres through its compose file. If Docker is not running, start it and rerun. Do not skip the db tests.

- [ ] **Step 3: Run the `terraform` job body for every matrix directory**, including the two new ones

For each directory in the `ci.yml` matrix:

```
terraform init -backend=false -lockfile=readonly
terraform fmt -check
terraform validate
tflint --init
tflint
terraform test
```

Expected: exit 0 for every directory. `probe_create_grant` and `probe_fails` are expected failures inside `terraform test`, and the test command itself exits 0.

- [ ] **Step 4: Run the `build-preview` dry-runs**

`pnpm exec wrangler deploy --dry-run` in `apps/gateway` and in `apps/api`, with the no-`zod` check the workflow already runs. This plan does not add a `docker build`.

- [ ] **Step 5: Confirm `docs/roadmap.md` in `git status` shows the T6 commit already on the branch**, with `terraform-envelope-kms` done and next chunk `kms-broker-service`. T7 does not edit it again.

---

## Spec coverage

| Spec item | Task |
| --- | --- |
| Envelope key, alias, rotation, deletion window, lockout check, `prevent_destroy` | T1, T2 |
| Five statements, exact admin actions, four single-action crypto statements, `Null`, `ForAllValues:StringEquals`, `aws:SourceVpce` | T2 |
| Precondition, not a `check` block; probe cannot apply; sixth statement fails the plan | T2, T5 |
| Interface endpoint, private DNS, public subnet, endpoint SG admits 443 only from the broker SG | T2 |
| Task role with no identity policy; execution role has no `kms:` | T2 |
| Broker secret, AWS-managed key, distinct name | T2, T5 |
| Storage policy explicit and not narrowed; task role absent from it | T3, T5 |
| Second tunnel, loopback origin, catch-all 404, distinct from Postgres | T4, T5 |
| `depends_on` the task role; string ARN kept; test reads the source | T2 |
| Endpoint ingress source is the broker security group | T2 |
| ADR 0008, architecture §5 §12.2 §22, runbook, roadmap `10 / 14` | T6 |
| Broker process, image, CI `docker build`, ECS task, Workers VPC service | `docs/specs/2026-10-01-kms-broker-service.md`. Not this plan. |

## Placeholder scan

No task tells the implementer to add validation or error handling without the condition. The Cloudflare config block is the one provider-schema uncertainty: T4 says stop and report if `~> 5.13` cannot express the two services.
