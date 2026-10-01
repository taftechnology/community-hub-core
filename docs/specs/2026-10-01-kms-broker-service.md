# Spec: KMS broker service

Slug: `kms-broker-service`
Status: draft
Supersedes: —
Architecture refs: §5, §7.3 rule 5, §12.2, §20, §22; D8; ADR 0008; AGENTS.md §1 (1, 7, 10), §3, §6, §8
Branch: `feat/2026-10-01-kms-broker-service`, from `origin/main`. This spec is drafted on that branch. Its plan is written after this spec is approved. Implementation starts after both are approved.

Follows: `docs/specs/2026-09-30-terraform-envelope-kms.md`. That chunk creates the envelope key, the task role, the broker security group, the tunnel, the secret, the log group, and the KMS endpoint. This chunk assumes those exist. It does not recreate them.

## Problem

The AU cell can plan a wrapping key and a tunnel to `127.0.0.1:8080`, and nothing listens. Organisation roots still cannot be minted. The regional Worker must not hold an AWS credential, so the process that calls KMS has to be the broker in the cell, on the task role this tunnel was built for.

## Scope

**In**

- `@community-hub/kms-broker`: the protocol fixture `contract/kms-port-v1.json` and the context check. No AWS SDK. Not added to `regionalOnlyPackages`.
- `apps/kms-broker`: the HTTP server, the AWS SDK call, and the container image. A Node container, deliberately not a Worker: no `wrangler` config and no `worker.meta.json`. `worker-config` and `residency-cell` key off Wrangler files and ignore it.
- CI: `docker build` of that image, no push and no registry login. A broken Dockerfile fails the job.
- An ECR repository in `ap-southeast-2`. The task image is a digest (`@sha256:`). A tag fails validation.
- An ECS service, separate from the Postgres connector: `cloudflared` and the broker as sidecars, broker bound to `127.0.0.1:8080`, task role and security group from the envelope module. `desired_count` is 2 when tasks are enabled. `enable_kms_broker_tasks` defaults to `false`.
- A Workers VPC service on the broker tunnel, created only when that flag is true. Output is null when the flag is false.
- Runbook steps for the image push and the flag. Roadmap, last commit: this chunk **done**, next `kms-worker-adapter`, Phase 0 `11 / 14`.

**Out** (explicitly)

- The envelope key, its policy, the endpoint, the task role, the broker security group, the tunnel, and the secret. Those are `terraform-envelope-kms`.
- The Worker adapter and any edit to `apps/api`. Package `@community-hub/kms-aws` implements `KmsPort` by calling this broker. It is `kms-worker-adapter`. That chunk adds the package to `regionalOnlyPackages` and adds the checker that fails if any Worker other than `apps/api` holds this VPC binding.
- A cache of unwrapped keys. A TTL is later, when a caller exists.
- The Multi-Region replica. Row `kms-mrk-replica`.
- SigV4 in our code. The AWS SDK on the broker signs.
- Live AWS calls in CI. No push to ECR from CI.
- Changing `@community-hub/crypto`.
- A route on the Postgres tunnel, or a task role on the connector.

## Behaviour

### Flag

`enable_kms_broker_tasks` defaults to `false`. When false, the plan contains no task definition, no ECS service, and no Workers VPC service. The image digest is required only when the flag is true. The first apply cannot both create the ECR repository and pull an image from it. The runbook orders the push, then the flag.

When true, `desired_count` is 2. Both tasks use the one public subnet from `terraform-envelope-kms`. That survives a dead task. Loss of that availability zone takes the broker down. This chunk does not add a subnet.

### Task

Two containers, `network_mode = awsvpc`, `assign_public_ip = true` because the cell has no NAT:

- `kms-broker` listens on `127.0.0.1:8080` only. Image is `var.kms_broker_image`, which must contain `@sha256:`.
- `cloudflared` runs `tunnel --no-autoupdate run`. `TUNNEL_TOKEN` comes from the existing broker secret. The task definition has no plaintext token and no AWS access key.

The task uses `aws_iam_role.task` and `aws_security_group.broker` from the envelope module. It does not create a second role or a second security group. No load balancer.

Both containers log to the existing log group `/community-hub/${name}/kms-broker`.

### Protocol

The server loads `packages/kms-broker/contract/kms-port-v1.json`. Later, `kms-worker-adapter` tests load the same file.

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

`keyId` must equal `logicalKeyId`. The process maps that id to `ENVELOPE_KEY_ARN` from the environment. The request does not carry an ARN. Any other `keyId` is rejected before KMS is called.

Context check, same allow-list as the local `KmsPort`: `key_kind` is `org` or `identity`; org has `org_id` and not `region`; identity has `region` and not `org_id`; `key_version` is a string; no extra key. Empty `{}`, a missing required key, both scope keys, neither scope key, and an extra key are rejected before KMS is called. The empty object is a named test, because `ForAllValues` on the key policy would allow it.

Rejected requests, including a body over 64 KiB, a non-JSON body, and a wrong `content-type`, return status 400 and the error body. AWS errors and a KMS response that is not 32 bytes return status 502 and the same body. The body has no other field. It contains no key ARN, context value, AWS error code, or AWS message.

Every response, including errors and `GET /health`, sends `cache-control: no-store`. `GET /health` returns 200 with an empty body and does not call KMS. It is not a `KmsPort` route.

Logs are one object per request. Keys are exactly `operation`, `key_kind`, and `outcome` (`ok`, `rejected`, or `failed`). `key_kind` is omitted when the body did not parse. The log line does not contain plaintext, a blob, a request or response body, `org_id`, `region`, `key_version`, or a key ARN. The server fills the SDK `Uint8Array` with zeroes after copying the bytes into the response. That zeroing is best-effort. The base64 string in the JSON body cannot be wiped, and it lives until garbage collection.

The SDK call is `GenerateDataKey` with `KeySpec` `AES_256`, or `Decrypt`, both with `KeyId` set to the configured ARN and `EncryptionContext` set to the validated context. Region is `ap-southeast-2`. Credentials are the task role's default chain. No static key in the environment.

When KMS is unreachable, the broker returns 502 `kms_failed`. It does not try another key, the storage key, or a local unwrap. There is no cache.

### Workers VPC service

Created only when `enable_kms_broker_tasks` is true. It uses the broker tunnel id and not the Postgres tunnel id. Terraform owns the service (ADR 0002). If `cloudflare_connectivity_directory_service` cannot express an HTTP service through that tunnel, stop and report. Do not point it at a VPC address. When the flag is false, the AU root output for the service id is null.

### Availability

Two tasks, one public subnet, fail closed. `kms-worker-adapter` treats a connection failure, a timeout, and any non-2xx as the same generic failure `@community-hub/crypto` already surfaces. This chunk does not implement that client.

## Data

No application tables. No classified columns.

The task definition references the existing secret by ARN. The image digest and the envelope key ARN are infrastructure identifiers in the task environment. Broker logs are `operation`, `key_kind`, and `outcome` only.

## Rules touched

- §7.3 rule 5: the task role credential stays on the task. No AWS key is added to a Workers secret.
- §1 rules 1 and 7: plaintext is not logged. No global Worker imports this server.
- §1 rule 10: the tunnel token stays in Secrets Manager. It is not in the task environment or CI logs.
- Children, entitlements, consent, money: none.

## Contracts

- Fixture `packages/kms-broker/contract/kms-port-v1.json`, as above. This chunk ships the server. `kms-worker-adapter` ships the client.
- Workers VPC service id is an output of `infra/regions/au` when the flag is true, and null when it is false.
- No product events, no `module.manifest.ts` keys.

## Tests

**Broker, against the fixture.** The KMS client is a fake. No network.

- `generateDataKey` with an org context and with an identity context calls `GenerateDataKey` once, with the configured ARN and that context, and returns 32-byte plaintext plus a blob.
- `decrypt` of that blob with the same context returns the same plaintext. A different context or a tampered blob returns 502 `kms_failed` and does not return plaintext.
- Empty context does not call KMS and returns 400 `kms_failed`.
- Missing `key_version`, both `org_id` and `region`, neither, an extra key, a bad `key_kind`, and `keyId` other than `envelope` do not call KMS.
- An AWS error whose message contains the key ARN and an `org_id` becomes 502 with body exactly `{"error":"kms_failed"}`. Those values are absent from the body and from the log line.
- Log keys on success are exactly `operation`, `key_kind`, `outcome`.
- `cache-control: no-store` on success, on 400, and on 502.
- The listen address is `127.0.0.1:8080`.
- `GET /health` is 200, empty, and does not call KMS.

**Terraform, `command = plan`, mocked providers.**

- Flag false: no task definition, no ECS service, no Workers VPC service. The service-id output is null.
- Flag true, image `example@sha256:` plus 64 hex characters: `desired_count` is 2, the image contains `@sha256:`, the task role is the envelope module's task role, the security group is the envelope module's broker group, token comes from the existing secret, and the VPC service's tunnel id is the broker tunnel.
- Flag true with an image tag fails validation.
- The Postgres tunnel and the connector task are unchanged.

**Image.** CI runs `docker build` on `apps/kms-broker/Dockerfile`. No `docker push`, no registry login, no AWS credentials.

## Risks

| Risk | Mitigation |
| --- | --- |
| The task is added to the connector, so the empty connector role gains KMS | Separate service. Connector module untouched. The task uses the envelope role. |
| Plaintext crosses the VPC | Sidecar on `127.0.0.1`. The security group already has `ingress = []`. |
| Error bodies or logs carry the key ARN or context | Fixed error body. Three log fields. Tests use a distinctive ARN and `org_id`. |
| Zeroing is treated as erasure | Best-effort on the SDK buffer only. ADR 0008 already says the base64 body lives until garbage collection. |
| First apply cannot pull an image from an empty repository | Flag defaults to false. Runbook: push, then enable. CI builds without pushing. |
| Workers VPC resource cannot express HTTP to the tunnel | Stop and report. Do not publish the broker on a VPC address. |
| One public subnet | `desired_count` 2 covers a dead task. AZ loss stays as ADR 0008 left it. |

## Out-of-band

- **Same PR, runbook.** Build `apps/kms-broker`, push to the cell ECR repository, set `kms_broker_image` to that `@sha256:` digest, then apply with `enable_kms_broker_tasks = true`. That apply creates the tasks and the Workers VPC service. Do not apply prod from this runbook.
- **`kms-worker-adapter`:** the `KmsPort` client, the VPC binding only on `apps/api`, and the `regionalOnlyPackages` change.
- Legal: none. New subprocessor: none.
- Scaffold waits until this spec and its plan are both `approved`.

## Next spec

`kms-worker-adapter`, after this chunk. `api-au-hostname` and `kms-mrk-replica` stay behind it.

This chunk's last commit updates `docs/roadmap.md`: `kms-broker-service` **done**, next `kms-worker-adapter`, Phase 0 `11 / 14` done. It does not insert rows. `terraform-envelope-kms` inserts `kms-broker-service`, `kms-worker-adapter`, and `kms-mrk-replica`.
