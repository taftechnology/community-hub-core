Spec: docs/specs/2026-10-07-kms-mrk-replica.md

# KMS multi-Region replica Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The staging account holds a Melbourne replica of the envelope key, and the primary policy allows that replication only.

**Architecture:** Four agent commits. One commit adds the sixth primary statement, the replica, and the alias, with plan-time tests. One commit adds the region allow-list and the replica `prevent_destroy` check. The human enables the Region and applies. One commit records that apply. The last commit updates the catalogue. Nothing in an agent task calls AWS.

**Tech Stack:** Terraform 1.11.4, AWS provider 6.67.0, `terraform test` with the existing `override_during = plan` mock. No new dependency.

Status: draft

**Branch:** `feat/2026-10-07-kms-mrk-replica` · one PR · 4 agent commits

## Global Constraints

- The spec is approved. Do not edit `docs/specs/2026-10-07-kms-mrk-replica.md`.
- The agent does not run `terraform apply`, `aws`, or any command in the **Human** section. The agent does not enable `ap-southeast-4`.
- Staging stays parked. Do not change `enable_database`, `desired_count`, or add `service_image` or `enable_kms_endpoint`. Do not edit `env/staging.tfvars` or `env/prod.tfvars`.
- Do not edit `aws_kms_key.envelope` except to add the sixth policy statement. `region`, `multi_region`, `enable_key_rotation`, `deletion_window_in_days`, `prevent_destroy`, the description, and the tags stay as they are. `kms:ReplicateKey` is not added to `local.admin_actions`.
- The replica does not set `enable_key_rotation`. Provider 6.67.0 has no such argument on `aws_kms_replica_key`. Do not assert the computed attribute `key_rotation_enabled`.
- No file under `apps/` or `packages/` changes. No Melbourne VPC, task, database, log group, bucket, secret, or interface endpoint. `architecture.md` is not edited. No ADR.
- Tests use account `123456789012`. Do not write a key id, a key ARN, or an account id into the runbook.
- `terraform_data.envelope_key_policy` has no input and no trigger. Changing its precondition does not put it in the apply change set. If a live plan shows it, stop.
- Any rebase onto `origin/main` happens before the human applies. From the applied commit on: no rebase, no amend, and no force-push. If `origin/main` moves after that, bring it in with a merge commit. The pull request merges with a merge commit, never a squash, and the PR body says so.
- The pull request is not merged until the second fresh-context review line is closed. This chunk replicates the key that wraps personal data. Leave that line open. Do not write the second review. The agent does not merge.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Do not mark this plan approved yourself.
- Prettier formats Markdown, TypeScript, and YAML. It has no parser for `.tf` or `.tftest.hcl` and exits 2, so those files are not passed to it. Terraform files use `terraform fmt -recursive`. A non-recursive `terraform fmt -check` misses `tests/`. Run the matching formatter on the files in the commit before every commit, then the gate. The plan file is formatted before its own commit. A code fence inside a list item is indented so Prettier does not join the list.

**Rollback:** A later commit removes `aws_kms_replica_key.envelope` and `aws_kms_alias.envelope_replica`, including their `prevent_destroy` blocks, and the human applies it. That plan destroys only those two. The primary stays, and the sixth statement stays. Removing the sixth statement is a separate policy change. Replica deletion uses the 30-day window and does not delete the primary. The agent does not run the apply.

**Cost:** The replica is USD 1 a month. The staging budget stays USD 50. No NAT gateway, no load balancer, and no interface endpoint. Enabling the Region has no monthly charge.

## File map

| File                                                       | Responsibility                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `infra/modules/aws-kms-envelope/main.tf`                   | Sixth statement, replica key, replica alias.                           |
| `infra/modules/aws-kms-envelope/tests/envelope.tftest.hcl` | Plan-time asserts and the mock defaults below.                         |
| `infra/regions/au/tests/cell.tftest.hcl`                   | Statement count 6, the three Sid filters, and the sixth Sid. No mocks. |
| `tooling/checks/terraform-invariants/check.ts`             | Region allow-list, and `prevent_destroy` on the replica.               |
| `tooling/checks/terraform-invariants/selftest.ts`          | New must-fail names, and one must-pass replica fixture.                |
| `tooling/checks/terraform-invariants/fixtures/`            | Existing `region = "ap-southeast-2"` literals become `var.aws_region`. |
| `docs/runbooks/apply-staging-au.md`                        | Apply record. No key id and no key ARN.                                |
| `docs/roadmap.md`, `AGENTS.md`                             | Catalogue and the repository-state sentence.                           |

## Mock defaults

`envelope.tftest.hcl` already sets `mock_provider "aws" { override_during = plan }`. Add these blocks inside that provider. They stay in the module test file only. Do not copy them into `infra/regions/au/tests/cell.tftest.hcl`. The cell runs pass without them. A shared `aws_kms_key` default gives the storage, secrets, and envelope keys the same ARN, and the cell asserts tell those keys apart.

Defaults fill computed attributes only. Do not default `region`, `policy`, `name`, `target_key_id`, `primary_key_arn`, `deletion_window_in_days`, `bypass_policy_lockout_safety_check`, or `tags`. A default on any of those would hide a wrong value under `override_during = plan`.

```hcl
mock_resource "aws_kms_key" {
  defaults = {
    arn    = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-envelope"
    key_id = "mock-envelope"
  }
}

mock_resource "aws_kms_replica_key" {
  defaults = {
    arn    = "arn:aws:kms:ap-southeast-4:123456789012:key/mock-envelope-replica"
    key_id = "mock-envelope-replica"
  }
}

mock_resource "aws_kms_alias" {
  defaults = {
    arn            = "arn:aws:kms:ap-southeast-2:123456789012:alias/mock-envelope"
    target_key_arn = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-envelope"
  }
}
```

New asserts read configuration, plus `aws_kms_key.envelope.arn` and `aws_kms_replica_key.envelope.key_id`. They do not read `key_rotation_enabled`, `key_spec`, `key_usage`, `tags_all`, alias `arn`, or alias `target_key_arn`.

Policy `Action` is compared with `toset`. A one-element action can arrive as a string under the plan mock. Use `try(toset(statement.Action), toset([statement.Action]))`. Tags stay a map. Compare `tags["environment"]` and `tags["project"]`. Do not wrap a map in `toset`.

---

### Task 1: Replica and the sixth statement

**Files:**

- Modify: `infra/modules/aws-kms-envelope/main.tf`
- Modify: `infra/modules/aws-kms-envelope/tests/envelope.tftest.hcl`
- Modify: `infra/regions/au/tests/cell.tftest.hcl`

**Interfaces:**

- Produces: `local.expected_sids` ends with `ReplicateToMelbourne`. `local.policy_statements` has six objects. The sixth is Sid `ReplicateToMelbourne`, Effect `Allow`, Principal `local.root_arn`, Action `["kms:ReplicateKey"]`, Resource `"*"`, Condition `StringEquals` `kms:ReplicaRegion` = `"ap-southeast-4"` and no other key. `terraform_data.envelope_key_policy` requires `length == 6` and that sixth action. Its error message says six statements.
- Produces: `local.replica_policy_statements` is one object, Sid `Admin`, Principal `local.root_arn`, Action `local.admin_actions`, Resource `"*"`. It does not merge `local.source_vpce`.
- Produces: `aws_kms_replica_key.envelope` with `region = "ap-southeast-4"`, `primary_key_arn = aws_kms_key.envelope.arn`, `deletion_window_in_days = 30`, `bypass_policy_lockout_safety_check = false`, the replica policy, tags `environment` and `project`, and `prevent_destroy`. Provider 6.67.0 gives `aws_kms_alias` neither `tags` nor `deletion_window_in_days`. `aws_kms_alias.envelope_replica` sets `region = "ap-southeast-4"`, `name = "alias/${var.name}-envelope"`, `target_key_id = aws_kms_replica_key.envelope.key_id`, and `prevent_destroy`. The Sydney alias is unchanged.

**Rule this must not break:** the primary key is updated in place and is never replaced. The four cryptographic statements stay bound to `aws:SourceVpce` only when `enable_kms_endpoint` is true. `ReplicateToMelbourne` is not added to that filter. The replica policy does not grant `kms:Decrypt` or `kms:GenerateDataKey` and does not name the task role.

- [ ] **Step 1: Write the failing asserts**

On run `happy`, change the length assert from 5 to 6 and append `ReplicateToMelbourne` to the Sid list. Add asserts:

- `toset` of `Statement[0].Action` equals the existing 16 names and does not contain `kms:ReplicateKey`.
- Statement index 5 has Sid `ReplicateToMelbourne`, principal `arn:aws:iam::123456789012:root`, resource `"*"`, and `try(toset(action), toset([action]))` equals `toset(["kms:ReplicateKey"])`.
- `keys(statement.Condition.StringEquals) == ["kms:ReplicaRegion"]`, the value is `"ap-southeast-4"`, and `keys(statement.Condition) == ["StringEquals"]`. `keys` returns a list, so it is not compared with `toset`.
- `aws_kms_replica_key.envelope.region` is `"ap-southeast-4"`.
- `aws_kms_replica_key.envelope.primary_key_arn` equals `aws_kms_key.envelope.arn` and equals `arn:aws:kms:ap-southeast-2:123456789012:key/mock-envelope`.
- `deletion_window_in_days` is 30 and `bypass_policy_lockout_safety_check` is false.
- Replica tags are `environment=staging` and `project=community-hub`.
- The replica policy has one statement, Sid `Admin`. Its action `toset` equals the 16 admin names. The policy string does not contain `kms:Decrypt`, `kms:GenerateDataKey`, or `arn:aws:iam::123456789012:role/ch-staging-task`.
- `aws_kms_alias.envelope_replica.region` is `"ap-southeast-4"`, the name is `alias/ch-staging-envelope`, and `target_key_id` equals `aws_kms_replica_key.envelope.key_id` and equals `mock-envelope-replica`.
- `aws_kms_alias.envelope.name` is still `alias/ch-staging-envelope` and its region is still `ap-southeast-2`.

On run `endpoint_on`, keep the SourceVpce filter on the four cryptographic Sids. Add an assert that `ReplicateToMelbourne` has no `aws:SourceVpce`, and that the replica policy has no `aws:SourceVpce`.

Do not assert `prevent_destroy`. Terraform test cannot see it.

Add the three mock blocks from Mock defaults to `envelope.tftest.hcl` only.

In `infra/regions/au/tests/cell.tftest.hcl`, on `staging_happy`, change the envelope policy length from 5 to 6. Change the two filters in that assert, and the filter on `staging_endpoint_on`, from `statement.Sid != "Admin"` to `contains(["GenerateDataKeyOrg", "GenerateDataKeyIdentity", "DecryptOrg", "DecryptIdentity"], statement.Sid)`. Those are the filters at lines 135, 140, and 238. The filtered length stays 4. Add an assert that statement index 5 has Sid `ReplicateToMelbourne`. Do not add mock blocks to this file.

Run `terraform test` in `infra/modules/aws-kms-envelope`. Expected: the new resources are missing and the test fails.

- [ ] **Step 2: Add the statement, the replica, and the alias**

- [ ] **Step 3: Gate and commit**

```bash
terraform -chdir=infra/modules/aws-kms-envelope fmt -check -recursive
terraform -chdir=infra/modules/aws-kms-envelope init -backend=false -lockfile=readonly
terraform -chdir=infra/modules/aws-kms-envelope validate
terraform -chdir=infra/modules/aws-kms-envelope test
terraform -chdir=infra/regions/au fmt -check -recursive
terraform -chdir=infra/regions/au init -backend=false -lockfile=readonly
terraform -chdir=infra/regions/au validate
terraform -chdir=infra/regions/au test
pnpm lint && pnpm typecheck && pnpm test && pnpm check:boundaries
git add infra/modules/aws-kms-envelope/main.tf infra/modules/aws-kms-envelope/tests/envelope.tftest.hcl infra/regions/au/tests/cell.tftest.hcl
git commit -m "$(cat <<'EOF'
feat(kms): replicate the envelope key to Melbourne

The primary policy allows ReplicateKey only into ap-southeast-4.
The replica policy is the admin statement.

EOF
)"
```

---

### Task 2: Region allow-list and replica prevent_destroy

**Files:**

- Modify: `tooling/checks/terraform-invariants/check.ts`
- Modify: `tooling/checks/terraform-invariants/selftest.ts`
- Modify: existing `*.tf` fixtures that set `region = "ap-southeast-2"` on a resource
- Create: the fixtures named below

**Interfaces:**

- Produces: every `region` argument on a `resource` or `provider` block under `infra/**/*.tf` is exactly `var.aws_region`, or the literal `"ap-southeast-4"` on `aws_kms_replica_key.envelope` and `aws_kms_alias.envelope_replica` in `infra/modules/aws-kms-envelope`. Anything else fails, including another variable, a local, or an expression. Compare the trimmed right-hand side. `awslogs-region` and the module argument `aws_region` are different arguments and stay out of the rule. Backend `.hcl` files are not resource or provider blocks.
- Produces: `validateEnvelopeKeyFile` also requires `prevent_destroy = true` on `aws_kms_replica_key.envelope`.

**Rule this must not break:** the 77 `region = var.aws_region` arguments on `main` still pass. The existing backend region check is unchanged.

- [ ] **Step 1: Write the failing fixtures**

In every existing fixture `*.tf`, change a resource or provider `region = "ap-southeast-2"` to `region = var.aws_region`. Do not edit backend `.hcl`.

Add must-fail fixtures. Each is a small `infra/**/*.tf` tree. The self-test asserts the violation message, not only `ok: false`:

- `region-database`: `aws_db_instance` with `region = "ap-southeast-4"`
- `region-bucket`: `aws_s3_bucket` with `region = "ap-southeast-4"`
- `region-log-group`: `aws_cloudwatch_log_group` with `region = "ap-southeast-4"`
- `region-provider`: `provider "aws"` with `region = "ap-southeast-4"`
- `region-us-east-1`: a resource with `region = "us-east-1"`
- `region-other-variable`: a resource with `region = var.other_region`
- `missing-replica-prevent-destroy`: `aws_kms_replica_key.envelope` in the envelope module, `region = "ap-southeast-4"`, no `prevent_destroy`. The message is the replica `prevent_destroy` rule.

Add must-pass fixture `melbourne-replica`: in the envelope module, `aws_kms_key.envelope` with `region = var.aws_region` and `prevent_destroy`, plus the replica and `aws_kms_alias.envelope_replica` with `region = "ap-southeast-4"` and `prevent_destroy` on the replica. A provider in that fixture uses `region = var.aws_region`. The same fixture also contains the forms the rule must ignore: `awslogs-region = "ap-southeast-2"`, `multi_region = true`, a module call with `aws_region = var.aws_region`, and a `backend "s3"` block with a literal region inside a `.tf` file.

Run `pnpm --filter @community-hub/check-terraform-invariants test`. Expected: the new fixtures fail because the check does not know them yet.

- [ ] **Step 2: Implement the allow-list and the replica lifecycle check**

- [ ] **Step 3: Gate and commit**

```bash
pnpm exec prettier --write tooling/checks/terraform-invariants/check.ts tooling/checks/terraform-invariants/selftest.ts
terraform fmt -recursive tooling/checks/terraform-invariants/fixtures
pnpm lint && pnpm typecheck && pnpm test && pnpm check:boundaries
git add tooling/checks/terraform-invariants
git commit -m "$(cat <<'EOF'
feat(checks): allow-list the Terraform region argument

Melbourne is the replica and its alias. Every other region
argument is var.aws_region. The replica keeps prevent_destroy.

EOF
)"
```

This commit is the one the human applies, unless a review fix lands on top and the reviewer accepts that later commit instead. Do not write the SHA into this plan. Report it in chat. Task 3 records the SHA the human actually applied.

---

## Human: enable Melbourne and apply

The agent stops. The reviewer runs the read-only plan below before the apply. The agent does not.

From `docs/runbooks/apply-staging-au.md`, before the apply:

1. git status is clean.
2. git rev-parse HEAD equals the SHA named for this apply, and that SHA is on origin.
3. terraform init uses `-lockfile=readonly`.

Enable the Region on the staging account only. Do not enable it in the production account.

```bash
aws account enable-region --region-name ap-southeast-4 --profile ch-admin
aws account get-region-opt-status --region-name ap-southeast-4 --profile ch-admin
```

The opt-in status reads `ENABLED`. If it reads `ENABLING`, wait and read it again. Do not apply while it is not `ENABLED`.

Then a read-only KMS call in that Region. It creates nothing.

```bash
aws kms list-keys --region ap-southeast-4 --profile ch-admin --max-items 1
```

The command exits 0. Then the reviewer, still before the apply, from `infra/regions/au` on that SHA, profile `ch-admin`, both var files, the gitignored file last:

```bash
terraform init -backend-config=backend/staging.hcl -lockfile=readonly
terraform plan -lock=false -detailed-exitcode -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
```

The reviewer does not apply. Detailed exit code 2 is the expected result, because the plan has changes. Exit 0 or 1 is a stop.

The change set is exactly these three addresses:

| Action | Address                                          |
| ------ | ------------------------------------------------ |
| add    | `module.envelope.aws_kms_replica_key.envelope`   |
| add    | `module.envelope.aws_kms_alias.envelope_replica` |
| change | `module.envelope.aws_kms_key.envelope`           |

That is 2 to add, 1 to change, 0 to destroy. The change is the `policy` attribute, in place. `module.envelope.terraform_data.envelope_key_policy` is not in the change set. It is state-only and this chunk gives it no new input.

Stop if any other address appears, if any other attribute of `aws_kms_key.envelope` changes, or if that key is replaced. A line that says the key must be replaced, or that it forces replacement, is a stop.

The human then applies:

```bash
terraform apply -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
```

If the apply returns `AccessDenied` on `ReplicateKey` right after the policy update, run the apply again. Do not change the policy. That retry shows 2 to add, 0 to change, 0 to destroy, and that is expected: the policy change is already in state, and the two resources are still to add. The stop rule for a first apply does not apply to this retry.

Then:

```bash
terraform plan -detailed-exitcode -var-file=env/staging.tfvars -var-file=env/staging.local.tfvars
```

The following plan shows no changes. Detailed exit code 0. Paste the SHA and the three addresses. A first apply that succeeds is `2 added, 1 changed, 0 destroyed`. A retry after `AccessDenied` on `ReplicateKey` is recorded as both applies: the failed one, then `2 added, 0 changed, 0 destroyed`. Read the replica back far enough to say its Region is `ap-southeast-4` and that it is a replica of the envelope key. Do not paste a key id or a key ARN.

From this applied commit on: no rebase, no amend, and no force-push.

---

### Task 3: Runbook

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`

**Interfaces:**

- Consumes: the human's paste, and the applied SHA reported in chat.
- Produces: a section after Image publish role. It records that SHA, profile `ch-admin`, and the addresses. A first apply that succeeds is 2 added, 1 changed, 0 destroyed. The change is the policy on `module.envelope.aws_kms_key.envelope`, in place. If that apply fails at `ReplicateKey` after the policy update, the section records both applies: the failed one, and the retry that is 2 added, 0 changed, 0 destroyed. The key was not replaced. `terraform_data.envelope_key_policy` was not in the change set. The following plan showed no changes. The replica's Region is `ap-southeast-4`. No key id and no key ARN. A rollback that removes the two resources destroys only those two. The production apply runbook, which this chunk does not write, enables `ap-southeast-4` in the production account before the first production apply.

**Rule this must not break:** if the human has not pasted, stop. Do not invent an apply.

- [ ] **Step 1: Write the section from the paste**

- [ ] **Step 2: Gate and commit**

```bash
pnpm exec prettier --write docs/runbooks/apply-staging-au.md
pnpm lint && pnpm typecheck && pnpm test && pnpm check:boundaries
git add docs/runbooks/apply-staging-au.md
git commit -m "$(cat <<'EOF'
docs(runbooks): record the Melbourne key replica

The apply added the replica and its alias, and updated the
envelope key policy in place.

EOF
)"
```

---

### Task 4: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Produces: `kms-mrk-replica` is **done** and links `docs/specs/2026-10-07-kms-mrk-replica.md`. The snapshot reads: Phase `1 — Core platform`; last shipped `kms-mrk-replica`; next chunk `admin-shell`; Phase 0 `23 rows: 22 done, 1 superseded (api-au-hostname), 0 not started`; Later phases `not started`. The sentence under the Phase 0 table names `admin-shell`. The Next spec section names `admin-shell`. The repository-state sentence matches that Phase 0 count and says next is `admin-shell`.

**Rule this must not break:** do not edit any other AGENTS.md sentence. Prettier may reflow the header table. Do not edit `architecture.md`. Do not mark this plan approved. Do not rebase, amend, or force-push.

- [ ] **Step 1: Update the row, the snapshot, and the repository-state sentence**

- [ ] **Step 2: Gate and commit**

```bash
pnpm exec prettier --write docs/roadmap.md AGENTS.md
pnpm lint && pnpm typecheck && pnpm test && pnpm check:boundaries
git add docs/roadmap.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark the Melbourne key replica done

Phase 0 has nothing left to start. Next is admin-shell.

EOF
)"
```

Push with a normal push. Open the PR only after this commit is on the remote. The PR body says the pull request merges with a merge commit, never a squash, and that it is not merged until the second fresh-context review line is closed. That line stays open. The agent does not write it and does not merge.

---

## Rollback

The agent does not apply.

1. A later commit deletes `aws_kms_replica_key.envelope` and `aws_kms_alias.envelope_replica`, including `prevent_destroy`. It does not edit `aws_kms_key.envelope`.
2. The human applies that commit. The plan shows those two addresses destroyed and nothing else. If it shows anything else, or if the primary is replaced, answer no and stop.
3. The sixth statement remains until a separate change. Replica deletion waits 30 days and does not delete the primary.
