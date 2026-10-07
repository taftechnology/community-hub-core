# Spec: KMS multi-Region replica

Slug: kms-mrk-replica
Status: approved (2026-10-07, Abdus)
Architecture refs: §7.3, §22, ADR 0009. Implements the `kms-mrk-replica` row. Depends on `foundations`, which set `multi_region = true` on the envelope key and is on `main`. Staging stays parked.

## Problem

The envelope key is a multi-Region primary in `ap-southeast-2`, and nothing has created its replica. The wrapping key exists in one Region. `ap-southeast-4` is opt-in and is not enabled. This row is that replica. It is not a copy of the database, the logs, or a restricted file.

## Scope

**In**

- `aws_kms_replica_key.envelope` in the envelope module. Its region is the literal `ap-southeast-4`. `primary_key_arn` is `aws_kms_key.envelope.arn`. `multi_region` stays true. Rotation stays on the primary. The replica resource does not set `enable_key_rotation`.
- The primary resource `aws_kms_key.envelope` is edited. Its policy is updated in place. The key is never replaced. `region`, `multi_region`, `enable_key_rotation`, `deletion_window_in_days`, and `prevent_destroy` stay as they are.
- A sixth statement on the primary, after the five that exist today. Sid `ReplicateToMelbourne`, Effect `Allow`, Principal the account root, Action `kms:ReplicateKey` only, Resource `*`, Condition `StringEquals` `kms:ReplicaRegion` = `ap-southeast-4`. `kms:ReplicateKey` is not added to `Admin`. The `Admin` action list stays the 16 actions it has now.
- `terraform_data.envelope_key_policy` requires six statements. `expected_sids` gains `ReplicateToMelbourne` last. The precondition checks that the sixth statement's action is `kms:ReplicateKey` only.
- `aws_kms_alias.envelope_replica` in `ap-southeast-4`, name `alias/${var.name}-envelope`, targeting the replica. The Sydney alias `aws_kms_alias.envelope` stays where it is.
- Both new resources set `deletion_window_in_days` to 30 where the resource has that argument, `bypass_policy_lockout_safety_check` false on the replica key, `prevent_destroy`, and the tags `environment` and `project`.
- The replica key policy is the `Admin` statement only: account root, the same 16 `Admin` actions, Resource `*`. It has no `GenerateDataKey` statement, no `Decrypt` statement, and no task-role principal.
- The cell provider stays `var.aws_region`, which must remain `ap-southeast-2`. The replica uses the resource `region` argument. There is no provider block whose region is `ap-southeast-4`.
- The region check is an allow-list. Every `region` argument on a resource or a provider under `infra/**/*.tf` must be exactly `var.aws_region`, or the literal `"ap-southeast-4"` on `aws_kms_replica_key.envelope` and `aws_kms_alias.envelope_replica` in the envelope module. Anything else fails, including another variable, a local, or an expression. All 77 `region` arguments on `main` are already `var.aws_region`. `awslogs-region` and the module argument `aws_region` are different arguments and stay out of the rule. Backend `.hcl` files are not resource or provider blocks. Must-fail fixtures: a database instance, an S3 bucket, and a log group with `region = "ap-southeast-4"`; a provider block with that region; one resource whose literal region is outside Australia (`us-east-1`); and one resource with `region = var.other_region`.
- The terraform-invariants envelope rule that requires `prevent_destroy` on `aws_kms_key.envelope` also requires it on `aws_kms_replica_key.envelope`. A must-fail fixture is the replica without that lifecycle.
- The human enables `ap-southeast-4` on the staging account, then applies. The agent does not call AWS and does not enable the Region.
- The catalogue commit marks this row done. Phase 0 becomes 23 rows: 22 done, 1 superseded (`api-au-hostname`), 0 not started. Next is `admin-shell`.
- A runbook section after Image publish role. It records the apply SHA, 2 added, 1 changed, 0 destroyed, and the empty following plan. The change is the policy on `aws_kms_key.envelope`. It does not record a key id or a key ARN.

**Out**

- Unparking staging. `enable_database` stays false. `desired_count` stays 0. `service_image` stays unset. `enable_kms_endpoint` stays unset in the committed staging file.
- Production. The resources are in the shared module, so a later production apply creates that account's replica. This chunk does not apply production and does not enable `ap-southeast-4` in the production account. It does not write the production apply runbook.
- A Melbourne VPC, subnet, security group, interface endpoint, task, database, log group, bucket, or secret. The service keeps calling KMS in `ap-southeast-2`. No file under `apps/` or `packages/` changes.
- Replicating the storage key, the secrets key, or the state key.
- An ADR, and any edit to `architecture.md`. §7.3 and §22 already name this replica.
- A NAT gateway, a load balancer, or an interface endpoint.
- A flag that leaves the replica out of staging. The two resources are unconditional.

## Behaviour

The human enables `ap-southeast-4` on the staging account. Before the apply, the opt-in status of `ap-southeast-4` reads `ENABLED`, and a read-only KMS call in `ap-southeast-4` succeeds with the `ch-admin` profile. The agent does not run those commands. Enabling the production account's Region is not part of this chunk.

The human then applies the AU cell from the commit this spec's plan names, profile `ch-admin`, both var files, the gitignored file last. The agent does not apply.

The plan adds `aws_kms_replica_key.envelope` and `aws_kms_alias.envelope_replica`, and changes the policy on `aws_kms_key.envelope` in place. That is 2 to add, 1 to change, 0 to destroy. The key is not replaced. The database, the cluster, and the service stay absent. If the plan shows anything else, including a replacement of `aws_kms_key.envelope`, the human answers no and stops.

If that apply returns `AccessDenied` on `ReplicateKey` right after the policy update, the human runs the apply again. The policy is not changed to get past that error.

A following plan shows no changes. The human reads the replica back: its Region is `ap-southeast-4`, and it is a replica of the envelope key. The runbook records the SHA, the 2 added, the 1 changed, and those two facts. It does not record the key id or the key ARN.

AGENTS.md §8 says a chunk's behaviour is verified on the staging hostname. That check does not apply. Nothing in this chunk serves traffic. The apply and the empty following plan are the proof.

The application keeps the Sydney key. A Sydney task is not retargeted at Melbourne.

## Data

No new table and no new column. The replica is key material. It is not a copy of ciphertext, a backup, a log, or a restricted file. Personal data stays in `ap-southeast-2`.

## Rules touched

Residency. `ap-southeast-4` is in Australia. The only new resources there are the envelope replica and its alias. Every `region` argument on a resource or a provider under `infra/**/*.tf` is exactly `var.aws_region`, or the literal `"ap-southeast-4"` on those two resources in the envelope module. Another variable, a local, or an expression fails.

Encryption. The primary stays a multi-Region key in `ap-southeast-2` with `prevent_destroy`. Its policy is updated in place: the sixth statement allows the account root to call `kms:ReplicateKey` only when `kms:ReplicaRegion` is `ap-southeast-4`. The key is never replaced. Rotation is not set on the replica. The replica policy is the `Admin` statement only. It does not grant `kms:GenerateDataKey` or `kms:Decrypt`, and it does not name the task role. When `enable_kms_endpoint` is true, the primary's use statements stay bound to `aws:SourceVpce`.

Tenancy and children. No query and no new column.

## Contracts

| Contract       | Value                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary        | Edited in place. Region `ap-southeast-2`. `multi_region` true. The policy gains `ReplicateToMelbourne`. The key is never replaced.                                |
| Replica        | `aws_kms_replica_key.envelope`. Region `ap-southeast-4`. `primary_key_arn` is the envelope ARN.                                                                   |
| Alias          | `alias/${name}-envelope` in `ap-southeast-4` only. The Sydney alias is unchanged.                                                                                 |
| Primary policy | Six statements. `Admin` stays the existing 16 actions and does not include `kms:ReplicateKey`. The sixth action is `kms:ReplicateKey` only, for `ap-southeast-4`. |
| Replica policy | One statement, Sid `Admin`, account root, the same 16 actions. No `kms:Decrypt`, no `kms:GenerateDataKey`, no task role.                                          |
| Staging flags  | `enable_database` false, `desired_count` 0, no `service_image`, no `enable_kms_endpoint`.                                                                         |
| Apply          | 2 to add, 1 to change, 0 to destroy. The change is the policy on `aws_kms_key.envelope`. A replacement of that key is a no.                                       |

## Cost

The replica is one customer managed key. [KMS pricing](https://aws.amazon.com/kms/pricing/) charges USD 1 a month for that key. ADR 0009 already prices five keys once this replica exists: USD 5 a month before the first rotation, then USD 10, then USD 15. Rotation stays configured on the primary. This chunk adds no second rotation setting.

Enabling the Region has no monthly charge of its own. The staging budget stays USD 50. The parked month gains this USD 1. No NAT gateway, no load balancer, and no interface endpoint.

## Risks

Updating `aws_kms_key.envelope` can replace a key that AWS will not convert back. This chunk changes the policy in place and changes no other argument on that resource. The apply is a no if the plan replaces the key.

A replica policy that copies `GenerateDataKey` or `Decrypt` without `aws:SourceVpce` would let the task role decrypt from anywhere, including when the primary binds those actions to the Sydney endpoint. The replica policy is the `Admin` statement only.

`prevent_destroy` on the replica means a rollback is a later commit that removes the two resources, then a human apply. That plan must destroy only those two. The primary stays. Replica deletion uses the 30-day window and does not delete the primary. Removing the sixth statement is a separate policy change and is not part of that rollback.

An apply before the Region is enabled fails. The fix is to wait until the opt-in status reads `ENABLED` and a read-only KMS call in `ap-southeast-4` succeeds, not to put the replica in another Region. An `AccessDenied` on `ReplicateKey` immediately after the policy update is a retry of the same apply. The policy is not widened to clear it.

The two resources are unconditional, so a first production apply before `ap-southeast-4` is enabled in that account fails partway. Owner: the production apply runbook. This chunk does not write that runbook and does not apply production.

A `region` argument that is not exactly `var.aws_region`, and is not the literal `"ap-southeast-4"` on the replica and its alias, fails the check. That includes another variable, a local, or an expression. The must-fail fixtures cover a database, a bucket, a log group, a provider, `us-east-1`, and `region = var.other_region`.

## Out-of-band

- The second fresh-context review. This chunk replicates the key that wraps personal data. The review that writes this spec does not count.
- The human enables `ap-southeast-4` on the staging account, confirms the opt-in status and the read-only KMS call, then applies. The agent does none of those.
- No key id, key ARN, or account id in this spec, the plan, the tests, or the runbook. Tests use account `123456789012`.

## Tests

Terraform tests are mocked plans. They use account `123456789012`.

- The primary key's region is `ap-southeast-2` and `multi_region` is true.
- The primary policy has six statements, in order: `Admin`, `GenerateDataKeyOrg`, `GenerateDataKeyIdentity`, `DecryptOrg`, `DecryptIdentity`, `ReplicateToMelbourne`. `Admin` does not contain `kms:ReplicateKey`. `ReplicateToMelbourne` has action `kms:ReplicateKey` only, principal the account root, resource `*`, and `StringEquals` `kms:ReplicaRegion` equal to `ap-southeast-4` with no other Region. `terraform_data.envelope_key_policy` enforces that length and that sixth action.
- The replica's region is `ap-southeast-4`, `primary_key_arn` is the envelope key ARN, `deletion_window_in_days` is 30, and `bypass_policy_lockout_safety_check` is false.
- The replica policy has exactly one statement, Sid `Admin`. It does not contain `kms:Decrypt`, `kms:GenerateDataKey`, or the task role ARN.
- The replica alias name is `alias/ch-staging-envelope` when `name` is `ch-staging`, and its region is `ap-southeast-4`. The Sydney alias is unchanged.
- `env/staging.tfvars` still has `enable_database = false` and `desired_count = 0`, and still does not set `service_image` or `enable_kms_endpoint`.
- The region check passes `region = var.aws_region`, and it passes `region = "ap-southeast-4"` on `aws_kms_replica_key.envelope` and `aws_kms_alias.envelope_replica` in the envelope module. It fails a database instance, an S3 bucket, a log group, and a provider block with that region. It fails a resource whose literal region is `us-east-1`. It fails a resource with `region = var.other_region`.
- `prevent_destroy` on the replica is required by the terraform-invariants envelope rule. A fixture with the replica and without that lifecycle fails the check. Terraform tests do not assert `prevent_destroy`.

No application test changes. The KMS client region is still `ap-southeast-2`.

## Catalogue

The last commit on this branch updates `docs/roadmap.md` and the repository-state line in `AGENTS.md`. `kms-mrk-replica` is **done** and links this spec. Phase 0 becomes 23 rows: 22 done, 1 superseded (`api-au-hostname`), 0 not started. The snapshot's next chunk is `admin-shell`. The snapshot's Phase row reads `1 — Core platform`. The snapshot's Later phases row reads `not started`. The sentence under the Phase 0 table names `admin-shell`. The Next spec section names `admin-shell`. No other AGENTS.md sentence changes. Prettier may reflow the header table. `architecture.md` is not edited.
