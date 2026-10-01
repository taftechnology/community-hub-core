# Spec: envelope wrapping key and AU KMS broker

Slug: `terraform-envelope-kms`
Status: approved (2026-10-01, Abdus Salam)
Supersedes: —
Architecture refs: §5, §7.3 rule 5, §12.2, §20, §22, §23.2; D8; ADR 0002; ADR 0005; AGENTS.md §1 (1, 7, 10), §3, §6, §8, §12
Branch: `feat/2026-09-30-terraform-envelope-kms`, from `origin/main`. This spec is drafted on that branch. Implementation starts after this spec and its plan are both approved.

## Problem

Organisation and identity roots are specified as AWS `GenerateDataKey` / `Decrypt` (`KmsPort`, ADR 0005), and the AU cell has no wrapping key and no caller that can use one. The only KMS key in the cell encrypts RDS storage. A Workers secret cannot hold the credential that unwraps every organisation key: §7.3 rule 5 distributes Worker secrets globally. The regional Worker has to reach KMS without that secret.

## Scope

**In**

- A single-region envelope wrapping key in `ap-southeast-2`, its alias, and its key policy.
- A KMS interface VPC endpoint in the public subnet's availability zone, and a `aws:SourceVpce` condition on every cryptographic statement.
- A broker ECS service, separate from the Postgres connector, with its own Cloudflare tunnel, token, and secret. The broker process and `cloudflared` share a task and talk over loopback.
- `@community-hub/kms-broker`: the protocol fixture and the context check. `apps/kms-broker`: the HTTP server, the AWS SDK call, and the container image. It is a Node container, deliberately not a Worker: no `wrangler` config and no `worker.meta.json`. `worker-config` and `residency-cell` key off Wrangler files and ignore it.
- CI: `docker build` of that image, no push and no registry login. A broken Dockerfile fails the job.
- ADR 0008. Architecture edits named below. A runbook section for the image push and the first apply.
- Roadmap, last commit of the implementation branch: this chunk **done**, next `kms-worker-adapter`, Phase 0 `10 / 13`, plus two new rows (`kms-worker-adapter`, `kms-mrk-replica`).

**Out** (explicitly)

- The Worker adapter and any edit to `apps/api`. Package `@community-hub/kms-aws` implements `KmsPort` by calling this broker. It is `kms-worker-adapter`. That chunk adds the package to `regionalOnlyPackages` (the exact `toEqual` changes there, on purpose) and adds the checker that fails if any Worker other than `apps/api` holds the broker's Workers VPC binding.
- Wiring a VPC service binding in Wrangler. Terraform in this chunk creates the Workers VPC service. Wrangler binds it later.
- A cache of unwrapped keys. Callers may hold a `CryptoKey` in isolate memory for one request. That is already allowed. A TTL cache is later, when a caller exists.
- The Multi-Region replica in `ap-southeast-4`. Row `kms-mrk-replica`.
- SigV4 in our code. The AWS SDK on the broker signs.
- Live AWS calls in CI. No GitHub OIDC role. Apply stays a human step.
- Changing `@community-hub/crypto`. It stays WebCrypto-only.
- A second route on the Postgres tunnel.

This chunk is the first of two. AGENTS §3: the broker service and the Worker adapter are different modules, and together they pass the size split. The fixture below is the seam.

The plan counts changed lines, excluding fixtures and lockfiles. If that estimate is well past ~800, the plan splits before any task starts. The seam is infrastructure first (key, policy, endpoint, tunnel, and the storage-key policy), then the broker service, image, and protocol package. That decision is made in the plan, not during implementation.

`docs/plans/2026-10-01-terraform-envelope-kms.md` estimates the combined diff well past ~800 lines and takes that seam. It implements the infrastructure half only. The broker service, image, and protocol package are a following spec. This half does not mark the roadmap row done.

## Behaviour

### Keys

`infra/modules/aws-kms-envelope` creates `aws_kms_key.envelope`:

- `region = "ap-southeast-2"`. Variable validation rejects anything else.
- `enable_key_rotation = true`.
- `deletion_window_in_days = 30`.
- `bypass_policy_lockout_safety_check = false`, set explicitly.
- `lifecycle { prevent_destroy = true }`.
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

The cell has no NAT and no other VPC endpoints. The broker task keeps `assign_public_ip = true` so `cloudflared` can reach Cloudflare. Egress 443 to the internet stays open for that, which means the task can also reach the public KMS API. The key policy rejects those calls. A task-role credential copied to a laptop fails the same way: the laptop is not the endpoint.

Cost, decided in this spec: about US$7–8 per month for one endpoint in one zone. ADR 0008 records it as an operating cost of D8, not an open question.

### Broker task

A new module, `infra/modules/aws-ecs-kms-broker`. It does not edit the connector task. The connector task role stays absent.

Two containers in one Fargate task, `network_mode = awsvpc`:

- `kms-broker` listens on `127.0.0.1:8080` only.
- `cloudflared` runs `tunnel --no-autoupdate run`. `TUNNEL_TOKEN` comes from Secrets Manager. The task definition has no plaintext token and no AWS access key.

The broker security group has `ingress = []` and no load balancer. Egress matches the connector's outbound needs: TCP 443 and 7844 to the internet. Plaintext roots cross the loopback interface and then the tunnel. They do not cross the VPC, so there is no second TLS hop.

`desired_count` is 2 when tasks are enabled. Both tasks sit in the one public subnet. That survives a dead task. Loss of that availability zone takes the broker down with the connector. This chunk does not add a subnet.

`enable_kms_broker_tasks` defaults to `false`. When false, the plan contains the key, the key policy, the task role, the execution role, the tunnel, the secret, the ECR repository, and the VPC endpoint. It does not contain a task definition, an ECS service, or the Workers VPC service. The image digest is required only when the flag is true, and it must contain `@sha256:`. A tag fails validation. The flag exists because the ECR repository and the task that pulls from it cannot be satisfied in one first apply, and the VPC service should not be created against a tunnel with no replica. The runbook orders the push, then the flag. The endpoint's monthly cost starts on that first apply, while tasks are still off.

Log group `/community-hub/${name}/kms-broker`, `retention_in_days >= 1`. `0` fails validation. Both containers use that group.

The execution role may `secretsmanager:GetSecretValue` on the broker tunnel secret and write to that log group. It has no `kms:` action. The secret uses the AWS-managed Secrets Manager key, not the envelope key and not the storage key. The task role is what calls KMS, through the key policy.

### Tunnel

A second Cloudflare tunnel, name `${name}-au-kms`. Its own token. Its own secret, name `${name}/kms-broker-tunnel-token`. The Postgres tunnel and secret stay `${name}-au` and `${name}/cloudflare-tunnel-token`. The broker execution role's policy contains the broker secret name and does not contain the connector secret name. The connector execution role's policy does not contain the broker secret name.

Tunnel config is Terraform, not a dashboard: one origin, `http://127.0.0.1:8080`. A catch-all that returns 404 and names no origin is allowed. No rule's origin is the RDS hostname, and this config does not reference the Postgres tunnel id.

The Workers VPC service is created only when `enable_kms_broker_tasks` is true. It uses this tunnel id and not the Postgres tunnel id. Terraform owns the service (ADR 0002). If `cloudflare_connectivity_directory_service` cannot express an HTTP service through that tunnel, stop and report. Do not point it at a VPC address. When the flag is false, the AU root output for the service id is null.

### Protocol

Fixture: `packages/kms-broker/contract/kms-port-v1.json`. The version is in the filename. The server loads this file. Chunk 2's adapter tests load the same file. The package has no AWS SDK and is not added to `regionalOnlyPackages`.

```json
{
  "version": 1,
  "listen": "127.0.0.1:8080",
  "logicalKeyId": "envelope",
  "routes": {
    "generateDataKey": { "method": "POST", "path": "/v1/generate-data-key" },
    "decrypt": { "method": "POST", "path": "/v1/decrypt" }
  },
  "contextKeys": {
    "org": ["key_kind", "org_id", "key_version"],
    "identity": ["key_kind", "region", "key_version"]
  },
  "error": {
    "statusRejected": 400,
    "statusFailed": 502,
    "body": { "error": "kms_failed" }
  },
  "responseHeaders": { "cache-control": "no-store" },
  "logFields": ["operation", "key_kind", "outcome"]
}
```

`generateDataKey` request: `{ "keyId", "context" }`. Response: `{ "plaintext", "blob" }`, standard base64, plaintext decodes to 32 bytes. `decrypt` request: `{ "keyId", "blob", "context" }`. Response: `{ "plaintext" }`.

`keyId` must equal `logicalKeyId`. The process maps that id to the envelope key ARN from the environment (`ENVELOPE_KEY_ARN`). The request does not carry an ARN. Any other `keyId` is rejected before KMS is called.

Context check, same allow-list as the local `KmsPort`: `key_kind` is `org` or `identity`; org has `org_id` and not `region`; identity has `region` and not `org_id`; `key_version` is a string; no extra key. Empty `{}`, a missing required key, both scope keys, neither scope key, and an extra key are rejected before KMS is called. The empty object is a named test: `ForAllValues` would allow it, and the broker must not.

Rejected requests, including a body over 64 KiB, a non-JSON body, and a wrong `content-type`, return status 400 and the error body. AWS errors and a KMS response that is not 32 bytes return status 502 and the same body. The body has no other field. It contains no key ARN, context value, AWS error code, or AWS message.

Every response, including errors and `GET /health`, sends `cache-control: no-store`. `GET /health` returns 200 with an empty body and does not call KMS. It is not a `KmsPort` route. It exists so the task can be health-checked.

Logs are one object per request. Keys are exactly `operation`, `key_kind`, and `outcome` (`ok`, `rejected`, or `failed`). `key_kind` is omitted when the body did not parse. The log line does not contain plaintext, a blob, a request or response body, `org_id`, `region`, `key_version`, or a key ARN. The server fills the SDK `Uint8Array` with zeroes after it has copied the bytes into the response. That zeroing is best-effort. The base64 string inside the JSON body cannot be wiped, and it lives until garbage collection. ADR 0008 says that, and does not claim the plaintext is gone once the response is sent.

The SDK call is `GenerateDataKey` with `KeySpec` `AES_256`, or `Decrypt`, both with `KeyId` set to the configured ARN and `EncryptionContext` set to the validated context. Region is `ap-southeast-2`. Credentials are the task role's default chain. No static key in the environment.

When KMS is unreachable, the broker returns 502 `kms_failed`. It does not try another key, the storage key, or a local unwrap.

### Availability and the client contract

Two tasks, one public subnet, fail closed. Chunk 2's adapter treats a connection failure, a timeout, and any non-2xx as the same generic failure `@community-hub/crypto` already surfaces. No fallback path. This chunk does not implement that client.

### Path

Plaintext roots go from the broker over loopback, then this tunnel, then Cloudflare's network, to the regional Worker. That is the same path, and the same AU-only argument, as Postgres traffic today. ADR 0008 says so and points at §7.3 and the Tunnel design in `terraform-au-cell`.

## Data

No application tables. No classified columns.

Terraform state holds the broker tunnel token, same class of secret as the connector token: KMS-encrypted state in `ap-southeast-2`, `sensitive = true` on the output. The envelope key ARN and the endpoint id are infrastructure identifiers.

Broker logs are `operation`, `key_kind`, and `outcome`. `key_kind` is `org` or `identity`. No personal data, no key material.

## Rules touched

- §7.3 rule 5: no AWS credential and no tenant key in a Workers secret. The task role is the cryptographic principal. `aws:SourceVpce` makes a copied task credential fail outside the cell.
- §1 rule 1 and rule 7: plaintext roots are not logged, not written to state, and not sent to a global Worker. No global Worker imports this server.
- §1 rule 10: the tunnel token is a Secrets Manager secret. It is not in the task environment, the repo, or CI logs.
- D8: wrapping stays in-region KMS. ADR 0008 amends the operational shape. The Worker does not call KMS. The broker does.
- Children, entitlements, consent, money: none.

## Contracts

- Fixture `packages/kms-broker/contract/kms-port-v1.json`, as above. Both sides' tests read it. This chunk ships the server side.
- `KmsPort` is unchanged. The broker's two routes match `generateDataKey` and `decrypt`. There is no encrypt route and no key-id route.
- Workers VPC service id is an output of `infra/regions/au` when `enable_kms_broker_tasks` is true, and null when it is false. Wrangler binding is `kms-worker-adapter`.
- No product events, no `module.manifest.ts` keys.
- Module names here are Terraform modules.

## Tests

**Broker, against the fixture**

- `generateDataKey` with an org context and with an identity context calls `GenerateDataKey` once, with the configured ARN and that context, and returns 32-byte plaintext plus a blob.
- `decrypt` of that blob with the same context returns the same plaintext. A different context, a different configured ARN, or a tampered blob returns 502 `kms_failed` and does not return plaintext.
- Empty context does not call KMS and returns 400 `kms_failed`. The test name records why: `ForAllValues` would accept it.
- Missing `key_version`, both `org_id` and `region`, neither, an extra key, `key_kind` other than `org` or `identity`, and `keyId` other than `envelope` do not call KMS.
- An AWS error whose message contains the key ARN and the `org_id` becomes 502 with body exactly `{"error":"kms_failed"}`. The ARN and the `org_id` are absent from the body and from the log line.
- Log keys on success are exactly `operation`, `key_kind`, `outcome`. A fixture plaintext and blob do not appear.
- `cache-control: no-store` on success, on 400, and on 502.
- The listen address is `127.0.0.1:8080`.
- `GET /health` is 200, empty, and does not call KMS.

The KMS client in tests is a fake. No network.

**Terraform, `command = plan`, mocked providers**

Happy path, tasks disabled: no task definition, no ECS service, no Workers VPC service; the envelope key, endpoint, broker tunnel, and broker secret are present. The service-id output is null.

Happy path, tasks enabled, image `example@sha256:` plus 64 hex chars:

- Key region `ap-southeast-2`, rotation on, deletion window 30, `bypass_policy_lockout_safety_check` false.
- Decoded policy: exactly five statements, `Sid`s `Admin`, `GenerateDataKeyOrg`, `GenerateDataKeyIdentity`, `DecryptOrg`, `DecryptIdentity`; admin actions equal the set above; `kms:PutKeyPolicy` is in that set; the forbidden actions appear in no statement; `GenerateDataKey` and `Decrypt` appear only on the four cryptographic statements; each of those has `aws:SourceVpce`, `StringEquals` on `key_kind`, `ForAllValues:StringEquals` on `kms:EncryptionContextKeys`, `Null` false for each required key, and `Null` true for the forbidden scope key.
- If the endpoint id makes `policy` unknown at plan, `mock_resource` the endpoint so the id is a known string and assert that string as the `SourceVpce` value. Do not switch the policy to `data.aws_iam_policy_document`.
- Broker security group `ingress = []`. No `aws_lb`.
- `desired_count` 2. Image contains `@sha256:`.
- Two tunnel ids differ. Two secret names differ. Execution policies do not cross.
- Storage key policy JSON does not contain the broker task role ARN. Envelope cryptographic principals are that role only. Connector execution role ARN is absent from the envelope policy. Broker execution policy contains no `kms:`.
- Endpoint is in the public subnet, private DNS on, and its security group ingress is 443 from the broker security group only.
- Workers VPC service tunnel id is the broker tunnel, not the Postgres tunnel.

Must-fail runs:

- `aws_region` other than `ap-southeast-2`.
- Rotation off.
- Image tag when tasks are enabled.
- `policy_probe_action = "kms:CreateGrant"` appends that action and the `terraform_data` precondition fails the plan. `expect_failures` names that `terraform_data`. Both tfvars files leave the variable unset.
- Log retention `0`.

**Invariants checker**

Must-fail fixture: `aws_kms_key.envelope` without `prevent_destroy`. The storage key fixture is unchanged.

**Offline CI**

`terraform init -backend=false -lockfile=readonly`, `fmt -check`, `validate`, `tflint`, `terraform test` for the new modules and the AU root. No AWS credentials. No live `plan` job.

**Image.** CI runs `docker build` on `apps/kms-broker/Dockerfile`. No `docker push`, no registry login, no AWS credentials. The job fails if the build fails. It does not replace the runbook push: CI proves the Dockerfile builds, and the human push is what ECR receives.

## Risks

| Risk | Mitigation |
| --- | --- |
| A Workers secret holds a credential that unwraps every organisation key | Broker task role. No AWS key in Worker secrets. ADR 0008. |
| Copied task-role credentials call KMS from a laptop | `aws:SourceVpce` plus the interface endpoint. Egress 443 stays open for `cloudflared`; the policy is the control. |
| `CreateGrant` or `Encrypt` on the admin statement, or a sixth statement, bypasses the crypto statements | Precondition fails the plan unless there are exactly five statements with the five `Sid`s and the admin list is exactly the allowed set. The probe run proves that precondition. A tfvars value cannot apply an extra action. |
| Empty encryption context satisfies `ForAllValues` | `Null` conditions on every crypto statement. Broker test rejects `{}` before KMS. |
| Account root rewrites the key policy | Named trust boundary in ADR 0008. `PutKeyPolicy` is explicit. `bypass_policy_lockout_safety_check` stays false, so the lockout safety check stays enabled. CloudTrail records the change. |
| Envelope key and storage key share a principal or a policy | Separate keys, aliases, and policies. Task role absent from the storage policy. Connector role absent from the envelope policy. |
| Broker added to the connector task, so the empty task role gains KMS | Separate service. Connector module untouched. |
| Second ingress on the Postgres tunnel; replicas without a broker answer, and the token is shared | Own tunnel, token, and secret. Cell test asserts they differ. |
| Plaintext roots on the VPC network | Loopback sidecar. `ingress = []`. No load balancer. |
| Plaintext or context in logs or error bodies | Three log fields. Fixed error body. Tests use a distinctive ARN and `org_id`. SDK buffer zeroing is best-effort; the response string is not wiped. |
| A broken broker Dockerfile is found only at the staging apply | CI `docker build`, no push. |
| First apply cannot both create ECR and pull the image | `enable_kms_broker_tasks` default false. Runbook: push, then enable. |
| This code is not applied in the PR | Same as `terraform-au-cell`. Mocked plans catch the policy shape. The first human apply is the first AWS test. |
| Single public subnet | `desired_count` 2 covers a dead task. AZ loss is named in ADR 0008 and not solved here. |
| Endpoint cost | Accepted. About US$7–8 per month. Recorded in ADR 0008. |
| Workers VPC resource cannot express HTTP to the broker tunnel | Stop and report. Do not publish the broker on a VPC address. |
| `prevent_destroy` skipped because `terraform test` cannot see lifecycle | Invariants checker, must-fail fixture. |
| Storage key policy made explicit and narrower than the default, breaking RDS | Explicit policy is the current default (`kms:*` for account root). Not narrowed. |

## Out-of-band

- **Same PR, ADR 0008.** Context: D8 wraps keys with in-region KMS, and §7.3 rule 5 forbids putting the unwrap credential in a Worker secret. Decision: the regional Worker calls an in-VPC broker; the broker task role is the only cryptographic principal; calls must arrive through the KMS interface endpoint. One sentence on the path: loopback, then the tunnel, then Cloudflare, to the regional Worker — the same path and the same AU-only argument as Postgres (`terraform-au-cell`, §7.3). Alternatives rejected: a long-lived IAM access key as a Workers secret; IAM Roles Anywhere (the private key would still be a Workers secret). Consequences: about US$7–8 per month for one endpoint in one zone; two tasks in one public subnet; loss of that zone takes unwrap with it; no unwrap cache in this chunk; Melbourne replica is `kms-mrk-replica`. Trust boundary: an account administrator can `PutKeyPolicy` and grant themselves `Decrypt`; CloudTrail records it; `bypass_policy_lockout_safety_check` stays false. Plaintext: zeroing the SDK buffer is best-effort; the base64 response body lives until garbage collection.
- **Same PR, architecture.** §5 diagram: `API --> KMS` becomes API to the broker to KMS. §12.2: the Worker reaches KMS through the broker, not with a Workers secret. §22's Multi-Region sentence stays, with a pointer that the replica is a later row and this key is single-region. D8's decision text stays; ADR 0008 amends the operational shape.
- **Infrastructure PR, runbook.** `docs/runbooks/apply-staging-au.md` gains: the AU apply creates the envelope key, the KMS endpoint (the monthly cost starts here), and the broker tunnel and its secret. No broker task and no image yet. Rotate that tunnel token the way the connector token rotates. Do not apply prod from this runbook.
- **Broker half, runbook.** Build `apps/kms-broker`, push to the cell ECR repository, set `kms_broker_image` to that `@sha256:` digest, then apply with `enable_kms_broker_tasks = true` (tasks and the Workers VPC service). That half is the following spec.
- **`kms-worker-adapter`:** `@community-hub/kms-aws` implements `KmsPort` against the fixture. Generic failures only. VPC binding on `apps/api` alone, checker plus must-fail fixture. `regionalOnlyPackages` `toEqual` updated there. Fail closed when the broker is down. No cache.
- **`kms-mrk-replica`:** Multi-Region replica of this key in `ap-southeast-4`. Not this chunk.
- **`api-au-hostname`:** unchanged, still after the adapter.
- Legal: none. New subprocessor: none. AWS and Cloudflare are already in the architecture.
- Scaffold waits until this spec and its plan are both `approved`.

## Next spec

`kms-worker-adapter`, unless the human picks another remaining Phase 0 row. `api-au-hostname` stays catalogued after it. `kms-mrk-replica` is catalogued after that.

This chunk's last commit updates `docs/roadmap.md`:

- Snapshot: last shipped `terraform-envelope-kms`, next `kms-worker-adapter`, Phase 0 `10 / 13` done.
- Row `terraform-envelope-kms` → **done**.
- Insert, not started, in this order: `kms-worker-adapter` (Worker `KmsPort` against `kms-port-v1.json`; VPC binding only on `apps/api`), then the existing `api-au-hostname` row, then `kms-mrk-replica` (Multi-Region replica of the envelope key in `ap-southeast-4`).
- The next-spec paragraph names `kms-worker-adapter`.
