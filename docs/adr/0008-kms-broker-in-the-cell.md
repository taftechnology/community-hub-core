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
