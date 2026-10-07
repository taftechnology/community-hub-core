# Spec: KMS multi-Region replica

Slug: kms-mrk-replica
Status: draft
Architecture refs: §7.3, §22, ADR 0009. Implements the `kms-mrk-replica` row. Depends on `foundations`, which set `multi_region = true` on the envelope key and is on `main`. Staging stays parked.

## Problem

The envelope key is a multi-Region primary in `ap-southeast-2`, and nothing has created its replica. The wrapping key exists in one Region. `ap-southeast-4` is opt-in and is not enabled. This row is that replica. It is not a copy of the database, the logs, or a restricted file.

## Scope

**In**

- `aws_kms_replica_key.envelope` in the envelope module. Its region is the literal `ap-southeast-4`. `primary_key_arn` is `aws_kms_key.envelope.arn`. The primary resource is not edited. `multi_region` stays true. Rotation stays on the primary. The replica resource does not set `enable_key_rotation`.
- `aws_kms_alias.envelope_replica` in `ap-southeast-4`, name `alias/${var.name}-envelope`, targeting the replica. The Sydney alias `aws_kms_alias.envelope` stays where it is.
- Both new resources set `deletion_window_in_days` to 30 where the resource has that argument, `bypass_policy_lockout_safety_check` false on the replica key, `prevent_destroy`, and the tags `environment` and `project`.
- The replica key policy is the same five statements as the primary: `Admin`, `GenerateDataKeyOrg`, `GenerateDataKeyIdentity`, `DecryptOrg`, `DecryptIdentity`, with the same actions. It omits `aws:SourceVpce`. It does not contain a VPC endpoint id. The Sydney policy is unchanged, including its endpoint condition when `enable_kms_endpoint` is true.
- The cell provider stays `var.aws_region`, which must remain `ap-southeast-2`. The replica uses the resource `region` argument. There is no provider block whose region is `ap-southeast-4`.
- A check that fails any `infra/**/*.tf` resource, other than those two, whose `region` is `ap-southeast-4`. A provider block with that region fails too. The must-fail fixtures are a database instance, an S3 bucket, and a log group in `ap-southeast-4`.
- The human enables `ap-southeast-4` on the staging account, then applies. The agent does not call AWS and does not enable the Region.
- The catalogue commit marks this row done. Phase 0 becomes 23 rows: 22 done, 1 superseded (`api-au-hostname`), 0 not started. Next is `admin-shell`.
- A runbook section after Image publish role. It records the apply SHA, the two additions, and the empty following plan. It does not record a key id or a key ARN.

**Out**

- Unparking staging. `enable_database` stays false. `desired_count` stays 0. `service_image` stays unset. `enable_kms_endpoint` stays unset in the committed staging file.
- Production. The resources are in the shared module, so a later production apply creates that account's replica. This chunk does not apply production and does not enable `ap-southeast-4` in the production account.
- A Melbourne VPC, subnet, security group, interface endpoint, task, database, log group, bucket, or secret. The service keeps calling KMS in `ap-southeast-2`. No file under `apps/` or `packages/` changes.
- Replicating the storage key, the secrets key, or the state key.
- An ADR, and any edit to `architecture.md`. §7.3 and §22 already name this replica.
- A NAT gateway, a load balancer, or an interface endpoint.
- A flag that leaves the replica out of staging. The two resources are unconditional.

## Behaviour

The human enables `ap-southeast-4` on the staging account and waits until the Region is enabled. The agent does not run that command. Enabling the production account's Region is not part of this chunk.

The human then applies the AU cell from the commit this spec's plan names, profile `ch-admin`, both var files, the gitignored file last. The agent does not apply.

The plan adds two resources and changes nothing else: `aws_kms_replica_key.envelope` and `aws_kms_alias.envelope_replica`. The primary key is not replaced and is not in the change set. The database, the cluster, and the service stay absent. If the plan shows anything else, the human answers no and stops.

A following plan shows no changes. The human reads the replica back: its Region is `ap-southeast-4`, and it is a replica of the envelope key. The runbook records the SHA and those two facts. It does not record the key id or the key ARN.

AGENTS.md §8 says a chunk's behaviour is verified on the staging hostname. That check does not apply. Nothing in this chunk serves traffic. The apply and the empty following plan are the proof.

The application keeps the Sydney key. A Sydney task is not retargeted at Melbourne.

## Data

No new table and no new column. The replica is key material. It is not a copy of ciphertext, a backup, a log, or a restricted file. Personal data stays in `ap-southeast-2`.

## Rules touched

Residency. `ap-southeast-4` is in Australia. The only new resources there are the envelope replica and its alias. The region check fails a database, a bucket, a log group, or a provider in that Region.

Encryption. The primary stays a multi-Region key in `ap-southeast-2` with `prevent_destroy`. Rotation is not set on the replica. The replica policy grants the same task role the same `GenerateDataKey` and `Decrypt` actions, without the Sydney endpoint condition.

Tenancy and children. No query and no new column.

## Contracts

| Contract      | Value                                                                                           |
| ------------- | ----------------------------------------------------------------------------------------------- |
| Primary       | Unchanged. Region `ap-southeast-2`. `multi_region` true.                                        |
| Replica       | `aws_kms_replica_key.envelope`. Region `ap-southeast-4`. `primary_key_arn` is the envelope ARN. |
| Alias         | `alias/${name}-envelope` in `ap-southeast-4` only. The Sydney alias is unchanged.               |
| Policy        | The five primary statements, with no `aws:SourceVpce` and no VPC endpoint id.                   |
| Staging flags | `enable_database` false, `desired_count` 0, no `service_image`, no `enable_kms_endpoint`.       |
| Apply         | 2 to add, 0 to change, 0 to destroy. Anything else is a no.                                     |

## Cost

The replica is one customer managed key. [KMS pricing](https://aws.amazon.com/kms/pricing/) charges USD 1 a month for that key. ADR 0009 already prices five keys once this replica exists: USD 5 a month before the first rotation, then USD 10, then USD 15. Rotation stays configured on the primary. This chunk adds no second rotation setting.

Enabling the Region has no monthly charge of its own. The staging budget stays USD 50. The parked month gains this USD 1. No NAT gateway, no load balancer, and no interface endpoint.

## Risks

A change to `aws_kms_key.envelope` can replace a key that AWS will not convert back. This chunk does not edit that resource. The apply is a no if the primary appears in the change set.

Copying the Sydney `aws:SourceVpce` condition onto the replica would bind Melbourne to a Sydney endpoint id. The replica policy omits that condition. The Sydney policy keeps it when the endpoint flag is on.

`prevent_destroy` on the replica means a rollback is a later commit that removes the two resources, then a human apply. That plan must destroy only those two. The primary stays. Replica deletion uses the 30-day window and does not delete the primary.

An apply before the Region is enabled fails. The fix is to wait for the Region, not to put the replica in another Region.

A resource besides the replica and its alias in `ap-southeast-4` fails the check. The must-fail fixtures cover a database, a bucket, and a log group.

## Out-of-band

- The second fresh-context review. This chunk replicates the key that wraps personal data. The review that writes this spec does not count.
- The human enables `ap-southeast-4` on the staging account, then applies. The agent does neither.
- No key id, key ARN, or account id in this spec, the plan, the tests, or the runbook. Tests use account `123456789012`.

## Tests

Terraform tests are mocked plans. They use account `123456789012`.

- The primary key's region is `ap-southeast-2`, `multi_region` is true, and `prevent_destroy` remains.
- The replica's region is `ap-southeast-4`, `primary_key_arn` is the envelope key ARN, `deletion_window_in_days` is 30, and `bypass_policy_lockout_safety_check` is false.
- The replica policy has the same five SIDs and the same actions as the primary. It does not contain `aws:SourceVpce`. With `enable_kms_endpoint` true, the primary policy still contains `aws:SourceVpce` and the replica policy still does not.
- The replica alias name is `alias/ch-staging-envelope` when `name` is `ch-staging`, and its region is `ap-southeast-4`. The Sydney alias is unchanged.
- `env/staging.tfvars` still has `enable_database = false` and `desired_count = 0`, and still does not set `service_image` or `enable_kms_endpoint`.
- The region check passes the replica and its alias. It fails a database instance, an S3 bucket, a log group, and a provider block whose region is `ap-southeast-4`.

No application test changes. The KMS client region is still `ap-southeast-2`.

## Catalogue

The last commit on this branch updates `docs/roadmap.md` and the repository-state line in `AGENTS.md`. `kms-mrk-replica` is **done** and links this spec. Phase 0 becomes 23 rows: 22 done, 1 superseded (`api-au-hostname`), 0 not started. The snapshot's next chunk is `admin-shell`. The sentence under the Phase 0 table names `admin-shell`. No other AGENTS.md sentence changes. Prettier may reflow the header table. `architecture.md` is not edited.
