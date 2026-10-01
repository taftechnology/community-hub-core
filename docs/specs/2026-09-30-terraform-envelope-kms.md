# Spec: envelope wrapping key

Slug: `terraform-envelope-kms`
Status: approved (2026-10-01, Abdus Salam)
Supersedes: —
Architecture refs: §5, §7.3 rule 5, §12.2, §20, §22, §23.2; D8; ADR 0002; ADR 0005; AGENTS.md §1 (1, 7, 10), §3, §6, §8, §12
Branch: `feat/2026-09-30-terraform-envelope-kms`, from `origin/main`.

## Problem

Organisation and identity roots are specified as AWS `GenerateDataKey` / `Decrypt` (`KmsPort`, ADR 0005), and the AU cell has no wrapping key and no caller that can use one. The only KMS key in the cell encrypts RDS storage. A Workers secret cannot hold the credential that unwraps every organisation key: §7.3 rule 5 distributes Worker secrets globally. The regional Worker has to reach KMS without that secret.

## Scope

**In**

- A single-region envelope wrapping key in `ap-southeast-2`, its alias, and its key policy.
- A KMS interface VPC endpoint in the public subnet's availability zone, and an `aws:SourceVpce` condition on every cryptographic statement.
- The broker task role (no identity policy), the broker security group (`ingress = []`), the execution role, the tunnel secret, and the log group. No ECS task assumes the role in this chunk.
- A Cloudflare tunnel, token, and secret for that future task, distinct from the Postgres tunnel. Ingress origin `http://127.0.0.1:8080` plus a 404 catch-all.
- The storage key's existing default policy made explicit, not narrowed.
- `depends_on = [aws_iam_role.task]` on the envelope key, so KMS does not see a principal that has not been created.
- ADR 0008. Architecture edits named below. A runbook section for this apply.
- Roadmap, last commit of this branch: this chunk **done**, next `kms-broker-service`, Phase 0 `10 / 14`.

**Out** (explicitly)

- The broker process, container image, `docker build`, ECR repository, ECS task and service, and the Workers VPC service. Those are `kms-broker-service` (`docs/specs/2026-10-01-kms-broker-service.md`).
- The Worker adapter and any edit to `apps/api`. That is `kms-worker-adapter`.
- A cache of unwrapped keys.
- The Multi-Region replica in `ap-southeast-4`. Row `kms-mrk-replica`.
- Live AWS calls in CI. Apply stays a human step.
- Changing `@community-hub/crypto`.
- A second route on the Postgres tunnel.

This chunk is infrastructure only. AGENTS §3: the broker service is a second spec and a second PR, not the second half of this one.

## Behaviour

### Keys

`infra/modules/aws-kms-envelope` creates `aws_kms_key.envelope`:

- `region = "ap-southeast-2"`. Variable validation rejects anything else.
- `enable_key_rotation = true`.
- `deletion_window_in_days = 30`.
- `bypass_policy_lockout_safety_check = false`, set explicitly.
- `lifecycle { prevent_destroy = true }`.
- `depends_on = [aws_iam_role.task]`. The principal in the policy is still the string ARN `arn:aws:iam::${aws_account_id}:role/${name}-kms-broker-task`, so the guard and the tests can read it at plan time. The string does not create a Terraform dependency. KMS rejects a key policy whose principal does not exist yet, and a mocked plan cannot show that. The `depends_on` is what orders the first apply. A test asserts the argument is present in the module source.
- Alias `alias/${name}-envelope`. The storage alias stays `alias/${name}-storage`.

`aws-kms-storage` is a different key. This chunk gives it an explicit key policy that matches the default it already has: one statement, principal the account root, action `kms:*`, so the JSON is visible to `terraform test`. Do not narrow that policy. RDS depends on it. The envelope key's cryptographic principal does not appear in it. Account root is a principal on both policies; that is the same trust boundary as `PutKeyPolicy`, not a shared cryptographic principal. If a live storage key already has any other statement, stop and report. Do not overwrite it to make the test pass.

Destruction of the envelope key makes every organisation and identity root in the cell unreadable. `prevent_destroy` is not visible to `terraform test`. The terraform-invariants checker requires it on `aws_kms_key.envelope` in this module, with a must-fail fixture that omits it. The checker does not start requiring it on `aws_kms_key.storage`.

### Key policy

The policy is `jsonencode` of a local, so the actions and condition keys are plan-time literals. The only interpolated identifier in a condition value is the VPC endpoint id. There is no `data.aws_iam_policy_document`.

Five statements. No wildcards in any action list.

**Admin.** Principal: account root. Actions, exactly this set:

- `kms:DescribeKey`
- `kms:GetKeyPolicy`
- `kms:GetKeyRotationStatus`
- `kms:ListResourceTags`
- `kms:PutKeyPolicy`
- `kms:CreateAlias`
- `kms:DeleteAlias`
- `kms:EnableKey`
- `kms:DisableKey`
- `kms:EnableKeyRotation`
- `kms:DisableKeyRotation`
- `kms:UpdateKeyDescription`
- `kms:TagResource`
- `kms:UntagResource`
- `kms:ScheduleKeyDeletion`
- `kms:CancelKeyDeletion`

**Cryptographic statements.** Four of them: `GenerateDataKey` for `org`, `GenerateDataKey` for `identity`, `Decrypt` for `org`, `Decrypt` for `identity`. Each allows one action. The principal on all four is the broker task role, written as `arn:aws:iam::${aws_account_id}:role/${name}-kms-broker-task` so the string is known at plan time. Each statement has all of:

- `StringEquals` on `aws:SourceVpce`, value the KMS interface endpoint id.
- `StringEquals` on `kms:EncryptionContext:key_kind`, value `org` or `identity` for that statement.
- `ForAllValues:StringEquals` on `kms:EncryptionContextKeys`, equal to `key_kind`, `org_id`, `key_version` on an org statement, and `key_kind`, `region`, `key_version` on an identity statement.
- `Null` = `false` (key must be present) for each required context key.
- `Null` = `true` (key must be absent) for the other scope key: `region` on org, `org_id` on identity.

`ForAllValues` is vacuously true when the context is empty. The `Null` conditions are what reject that request. Both are required.

No statement grants `kms:CreateGrant`, `kms:Encrypt`, `kms:ReEncrypt`, `kms:ReEncryptFrom`, `kms:ReEncryptTo`, `kms:GenerateDataKeyWithoutPlaintext`, `kms:GenerateDataKeyPair`, or `kms:GenerateDataKeyPairWithoutPlaintext`. `GenerateDataKey` and `Decrypt` appear only on the four cryptographic statements.

A `terraform_data` precondition reads that statement local, not the encoded string, so it still works when the endpoint id is unknown. It fails the plan unless all of these hold: there are exactly five statements; their `Sid`s are `Admin`, `GenerateDataKeyOrg`, `GenerateDataKeyIdentity`, `DecryptOrg`, and `DecryptIdentity`; the admin action list is exactly the set above; each cryptographic statement's action list is exactly its one action. A sixth statement, including one that grants `kms:Encrypt`, fails the plan. A `check` block only warns, so it is not this guard. There is no variable that turns the precondition off.

`policy_probe_action` defaults to null and is unset in both tfvars files. When it is set, that action is appended to the admin list inside the same local the precondition reads. Any set value, including one committed in tfvars, fails the plan. The test run sets `kms:CreateGrant` and expects that precondition to fail. The probe cannot apply.

The task role has no identity policy. The key policy is the only grant. An identity policy that also allowed `kms:Decrypt` would be a second document that could drift.

An account administrator who can `kms:PutKeyPolicy` can rewrite this policy and grant themselves `Decrypt`. That is the trust boundary. ADR 0008 names it. CloudTrail records the change. This chunk does not add an alarm.

### VPC endpoint

One interface endpoint for `com.amazonaws.ap-southeast-2.kms`, in the public subnet only (one availability zone). Private DNS enabled, so the SDK's `kms.ap-southeast-2.amazonaws.com` resolves to the endpoint from inside the VPC. The endpoint security group admits TCP 443 from the broker security group and from nobody else.

The cell has no NAT and no other VPC endpoints. The broker security group allows egress TCP 443 and 7844 to the internet, which is what `cloudflared` will need. That egress also reaches the public KMS API. The key policy rejects those calls. A task-role credential copied to a laptop fails the same way: the laptop is not the endpoint. The task that uses this group is `kms-broker-service`.

Cost, decided in this spec: about US$7–8 per month for one endpoint in one zone. ADR 0008 records it as an operating cost of D8, not an open question.

### Roles, secret, and security group

`infra/modules/aws-kms-envelope` creates these. It does not edit the connector task. The connector task role stays absent. This module does not create an ECS service, a task definition, a load balancer, or an ECR repository.

- Task role `${name}-kms-broker-task`. Trust `ecs-tasks.amazonaws.com` only. No identity policy. The key policy is the only grant.
- Broker security group: `ingress = []`. Egress TCP 443 and 7844 to the internet. No load balancer.
- Execution role may `secretsmanager:GetSecretValue` on the broker tunnel secret and write to the broker log group. It has no `kms:` action.
- Secret name `${name}/kms-broker-tunnel-token`, encrypted with the AWS-managed Secrets Manager key, not the envelope key and not the storage key.
- Log group `/community-hub/${name}/kms-broker`, `retention_in_days >= 1`. `0` fails validation. Nothing in this chunk writes to it. `kms-broker-service` attaches the containers.

The endpoint's monthly cost starts on the apply of this chunk, before a task exists. This chunk does not add a subnet. Loss of the public subnet's availability zone is named in ADR 0008.

### Tunnel

A second Cloudflare tunnel, name `${name}-au-kms`. Its own token. Its own secret, name `${name}/kms-broker-tunnel-token`. The Postgres tunnel and secret stay `${name}-au` and `${name}/cloudflare-tunnel-token`. The broker execution role's policy contains the broker secret name and does not contain the connector secret name. The connector execution role's policy does not contain the broker secret name.

Tunnel config is Terraform, not a dashboard: one origin, `http://127.0.0.1:8080`. A catch-all that returns 404 and names no origin is allowed. No rule's origin is the RDS hostname, and this config does not reference the Postgres tunnel id. Nothing listens on that port until `kms-broker-service`.

### Path

Plaintext roots will go from the broker over loopback, then this tunnel, then Cloudflare's network, to the regional Worker. That is the same path, and the same AU-only argument, as Postgres traffic today. ADR 0008 says so. The process that speaks on that path is `kms-broker-service`. The protocol fixture is defined there, not here.

## Data

No application tables. No classified columns.

Terraform state holds the broker tunnel token, same class of secret as the connector token: KMS-encrypted state in `ap-southeast-2`, `sensitive = true` on the output. The envelope key ARN and the endpoint id are infrastructure identifiers. This chunk writes no broker logs.

## Rules touched

- §7.3 rule 5: no AWS credential and no tenant key in a Workers secret. The task role is the cryptographic principal. `aws:SourceVpce` makes a copied task credential fail outside the cell. Nothing assumes the role yet.
- §1 rule 10: the tunnel token is a Secrets Manager secret. It is not in a task environment, the repo, or CI logs.
- D8: wrapping stays in-region KMS. ADR 0008 amends the operational shape. The Worker does not call KMS.
- Children, entitlements, consent, money: none.

## Contracts

- No `KmsPort` implementation in this chunk. The key policy allows `GenerateDataKey` and `Decrypt` only.
- No Workers VPC service output. `kms-broker-service` creates that service on this tunnel id.
- No product events, no `module.manifest.ts` keys.
- Module names here are Terraform modules.

## Tests

**Terraform, `command = plan`, mocked providers**

Happy path: no task definition, no ECS service, no Workers VPC service, no ECR repository. The envelope key, endpoint, task role, broker security group, broker tunnel, and broker secret are present.

- Key region `ap-southeast-2`, rotation on, deletion window 30, `bypass_policy_lockout_safety_check` false.
- `aws_kms_key.envelope` has `depends_on = [aws_iam_role.task]` in the module source. The principal in the policy is still the string ARN.
- Decoded policy: exactly five statements, `Sid`s `Admin`, `GenerateDataKeyOrg`, `GenerateDataKeyIdentity`, `DecryptOrg`, `DecryptIdentity`; admin actions equal the set above; `kms:PutKeyPolicy` is in that set; the forbidden actions appear in no statement; `GenerateDataKey` and `Decrypt` appear only on the four cryptographic statements; each of those has `aws:SourceVpce`, `StringEquals` on `key_kind`, `ForAllValues:StringEquals` on `kms:EncryptionContextKeys`, `Null` false for each required key, and `Null` true for the forbidden scope key.
- If the endpoint id makes `policy` unknown at plan, `mock_resource` the endpoint so the id is a known string and assert that string as the `SourceVpce` value. Do not switch the policy to `data.aws_iam_policy_document`.
- Broker security group `ingress = []`. No `aws_lb`.
- Endpoint ingress is TCP 443, `cidr_blocks` is empty, and the ingress source is `aws_security_group.broker.id`. A shared mock id is not that assertion: the test reads the source reference.
- Tunnel names and secret names differ from the Postgres tunnel. Mocked tunnel ids may be identical; assert the configured names.
- Storage key policy JSON does not contain the broker task role ARN. Envelope cryptographic principals are that role only. Connector execution role ARN is absent from the envelope policy. Broker execution policy contains no `kms:`.
- Endpoint is in the public subnet, private DNS on. The Postgres VPC service still uses the Postgres tunnel id.

Must-fail runs:

- `aws_region` other than `ap-southeast-2`.
- Rotation off.
- `policy_probe_action = "kms:CreateGrant"` appends that action and the `terraform_data` precondition fails the plan. `expect_failures` names that `terraform_data`. Both tfvars files leave the variable unset.
- Log retention `0`.

**Invariants checker**

Must-fail fixture: `aws_kms_key.envelope` without `prevent_destroy`. The storage key fixture is unchanged.

**Offline CI**

`terraform init -backend=false -lockfile=readonly`, `fmt -check`, `validate`, `tflint`, `terraform test` for the new modules and the AU root. No AWS credentials. No live `plan` job. No `docker build` in this chunk.

## Risks

| Risk | Mitigation |
| --- | --- |
| A Workers secret holds a credential that unwraps every organisation key | Broker task role. No AWS key in Worker secrets. ADR 0008. |
| Copied task-role credentials call KMS from a laptop | `aws:SourceVpce` plus the interface endpoint. Egress 443 stays open for `cloudflared`; the policy is the control. |
| `CreateGrant` or `Encrypt` on the admin statement, or a sixth statement, bypasses the crypto statements | Precondition fails the plan unless there are exactly five statements with the five `Sid`s and the admin list is exactly the allowed set. The probe run proves that precondition. A tfvars value cannot apply an extra action. |
| Empty encryption context satisfies `ForAllValues` | `Null` conditions on every crypto statement. The broker's rejection test is `kms-broker-service`. |
| First apply creates the key before the task role exists | `depends_on = [aws_iam_role.task]` on the key. The string ARN stays. A test asserts the argument. The runbook names the failure KMS returns if it is missing. |
| Account root rewrites the key policy | Named trust boundary in ADR 0008. `PutKeyPolicy` is explicit. `bypass_policy_lockout_safety_check` stays false, so the lockout safety check stays enabled. CloudTrail records the change. |
| Envelope key and storage key share a principal or a policy | Separate keys, aliases, and policies. Task role absent from the storage policy. Connector role absent from the envelope policy. |
| Broker added to the connector task, so the empty task role gains KMS | Separate service. Connector module untouched. |
| Second ingress on the Postgres tunnel; replicas without a broker answer, and the token is shared | Own tunnel, token, and secret. Cell test asserts they differ. |
| Plaintext roots on the VPC network | Broker security group `ingress = []`. No load balancer. The loopback task is `kms-broker-service`. |
| This code is not applied in the PR | Same as `terraform-au-cell`. Mocked plans catch the policy shape. The first human apply is the first AWS test, including principal ordering. |
| Single public subnet | Named in ADR 0008. This chunk does not add a subnet or a task. |
| Endpoint cost | Accepted. About US$7–8 per month, starting on this apply, before a task exists. Recorded in ADR 0008. |
| `prevent_destroy` skipped because `terraform test` cannot see lifecycle | Invariants checker, must-fail fixture. |
| Storage key policy made explicit and narrower than the default, breaking RDS | Explicit policy is the current default (`kms:*` for account root). Not narrowed. |

## Out-of-band

- **Same PR, ADR 0008.** Context: D8 wraps keys with in-region KMS, and §7.3 rule 5 forbids putting the unwrap credential in a Worker secret. Decision: the regional Worker calls an in-VPC broker; the broker task role is the only cryptographic principal; calls must arrive through the KMS interface endpoint. One sentence on the path: loopback, then the tunnel, then Cloudflare, to the regional Worker — the same path and the same AU-only argument as Postgres (`terraform-au-cell`, §7.3). Alternatives rejected: a long-lived IAM access key as a Workers secret; IAM Roles Anywhere (the private key would still be a Workers secret). Consequences: about US$7–8 per month for one endpoint in one zone; two tasks in one public subnet; loss of that zone takes unwrap with it; no unwrap cache in this chunk; Melbourne replica is `kms-mrk-replica`. Trust boundary: an account administrator can `PutKeyPolicy` and grant themselves `Decrypt`; CloudTrail records it; `bypass_policy_lockout_safety_check` stays false. Plaintext: zeroing the SDK buffer is best-effort; the base64 response body lives until garbage collection.
- **Same PR, architecture.** §5 diagram: `API --> KMS` becomes API to the broker to KMS. §12.2: the Worker reaches KMS through the broker, not with a Workers secret. §22's Multi-Region sentence stays, with a pointer that the replica is a later row and this key is single-region. D8's decision text stays; ADR 0008 amends the operational shape.
- **Same PR, runbook.** `docs/runbooks/apply-staging-au.md` gains: the AU apply creates the envelope key, the KMS endpoint (the monthly cost starts here), the task role, and the broker tunnel and its secret. No broker task and no image. The key depends on the task role; if KMS reports an invalid principal, the role was not created first. Rotate that tunnel token the way the connector token rotates. Do not apply prod from this runbook.
- **`kms-broker-service`:** the process, image, CI `docker build`, ECS task, and Workers VPC service. Its own spec, plan, and branch. Image push and `enable_kms_broker_tasks` live there.
- **`kms-worker-adapter`:** `@community-hub/kms-aws` implements `KmsPort` against the fixture. Generic failures only. VPC binding on `apps/api` alone, checker plus must-fail fixture. `regionalOnlyPackages` `toEqual` updated there. Fail closed when the broker is down. No cache.
- **`kms-mrk-replica`:** Multi-Region replica of this key in `ap-southeast-4`. Not this chunk.
- **`api-au-hostname`:** unchanged, still after the adapter.
- Legal: none. New subprocessor: none. AWS and Cloudflare are already in the architecture.
- Scaffold waits until this spec and its plan are both `approved`.

## Next spec

`kms-broker-service`, unless the human picks another remaining Phase 0 row.

This chunk's last commit updates `docs/roadmap.md`:

- Snapshot: last shipped `terraform-envelope-kms`, next `kms-broker-service`, Phase 0 `10 / 14` done.
- Row `terraform-envelope-kms` → **done**. Text: wrapping key, key policy, KMS endpoint, broker tunnel. Spec `2026-09-30-terraform-envelope-kms`.
- Insert, not started, in this order: `kms-broker-service` (broker process, image, ECS task, Workers VPC service), then `kms-worker-adapter` (Worker `KmsPort` against `kms-port-v1.json`; VPC binding only on `apps/api`), then the existing `api-au-hostname` row, then `kms-mrk-replica` (Multi-Region replica of the envelope key in `ap-southeast-4`).
- The next-spec paragraph names `kms-broker-service`.
