# Spec: KMS broker service

Slug: `kms-broker-service`
Status: draft
Supersedes: —
Architecture refs: §5, §7.3 rule 5, §12.2, §20, §22; D8; ADR 0008; AGENTS.md §1 (1, 7, 10), §3, §6, §8
Branch: `feat/2026-10-01-kms-broker-service`, from `origin/main`. This spec is drafted on that branch. Its plan is written after this spec is approved. Implementation starts after both are approved.

Follows: `docs/specs/2026-09-30-terraform-envelope-kms.md`. That chunk creates the envelope key, the task role, the broker security group, the tunnel, the secret, the log group, and the KMS endpoint. This chunk assumes those resources exist. It does not recreate them. It adds three outputs to `aws-kms-envelope`, and no resources.

## Problem

The AU cell can plan a wrapping key and a tunnel to `127.0.0.1:8080`, and nothing listens. Organisation roots still cannot be minted. The regional Worker must not hold an AWS credential, so the process that calls KMS has to be the broker in the cell, on the task role this tunnel was built for.

## Scope

**In**

- `@community-hub/kms-broker`: the protocol fixture `contract/kms-port-v1.json` and the context check. No AWS SDK. Not added to `regionalOnlyPackages`.
- `apps/kms-broker`: the HTTP server, the AWS SDK call, and the container image. A Node container, deliberately not a Worker: no `wrangler` config and no `worker.meta.json`. `worker-config` and `residency-cell` key off Wrangler files and ignore it.
- CI: `docker build` of that image, no push and no registry login. A broken Dockerfile fails the job. The build pulls the pinned base image and installs from the lockfile. It does not log in to ECR.
- An ECR repository in `ap-southeast-2`. The task image is a digest (`@sha256:`) from that repository. A tag fails validation. An image from any other registry fails validation.
- An ECS service, separate from the Postgres connector: its own cluster, `cloudflared` and the broker as sidecars, broker bound to `127.0.0.1:8080`, task role and security group from the envelope module. `desired_count` is 2 when tasks are enabled. `enable_kms_broker_tasks` defaults to `false`.
- Three outputs on `aws-kms-envelope`, and no resource change there: `tunnel_secret_arn` (`aws_secretsmanager_secret.broker_tunnel.arn`), `execution_role_name` (`aws_iam_role.execution.name`), and `log_group_name` (the existing local). The task definition's `secrets.valueFrom` needs the full secret ARN. AWS appends a random suffix, so the name cannot be turned into that ARN. `aws_iam_role_policy.role` takes the role name or id, not the ARN. The log group name is only a local today. The module's five runs (`happy`, `probe_create_grant`, `wrong_region`, `rotation_off`, `log_retention_zero`) still pass. `happy` asserts the three new outputs.
- A pull-only identity policy on the envelope execution role, for the broker repository only. `role` is `execution_role_name`. The envelope module's existing execution policy (secret and logs, no `kms:`) stays as it is. `cloudflared` is not pulled from this repository.
- A Workers VPC HTTP service on the broker tunnel, created only when that flag is true. Output is null when the flag is false.
- Runbook steps for the image build, the revision label, the push, and the flag. ADR 0008 consequences for the sidecar and for Workers VPC being in beta. Architecture §12.2 updated so the broker process is this chunk and the Worker caller remains `kms-worker-adapter`. Roadmap, last commit: this chunk **done**, next `kms-worker-adapter`, Phase 0 `11 / 14`.

**Out** (explicitly)

- Recreating the envelope key, its policy, the endpoint, the task role, the broker security group, the tunnel, or the secret. Those resources are `terraform-envelope-kms`. The three outputs above are the only edit to that module.
- An ECR pull-through cache, a Docker Hub credential in Secrets Manager, and `ecr:BatchImportUpstreamImage` or `ecr:CreateRepository` on the execution role. Later work. This chunk pulls `cloudflared` from Docker Hub by digest.
- The Worker adapter and any edit to `apps/api`. Package `@community-hub/kms-aws` implements `KmsPort` by calling this broker. It is `kms-worker-adapter`. That chunk adds the package to `regionalOnlyPackages` and adds the checker described under Out-of-band.
- A cache of unwrapped keys. A TTL is later, when a caller exists.
- The Multi-Region replica. Row `kms-mrk-replica`.
- SigV4 in our code. The AWS SDK on the broker signs.
- Live AWS calls in CI. No push to ECR from CI.
- Changing `@community-hub/crypto`.
- A route on the Postgres tunnel, a task on the connector, or an edit to `infra/modules/aws-ecs-tunnel` or `infra/modules/cf-vpc-service`.
- A human IAM principal for pushing. The people who already apply the cell push. This chunk does not create that principal.

## Behaviour

### Flag

`enable_kms_broker_tasks` defaults to `false`. The ECR repository is in the plan either way. When the flag is false, the plan contains no task definition, no ECS service, no Workers VPC service, and no pull policy. The image digest is required only when the flag is true. The first apply creates the repository and cannot pull from it yet. The runbook pushes into that repository, then enables the flag.

When true, `desired_count` is 2. Both tasks use the one public subnet from `terraform-envelope-kms`. That survives a dead task. Loss of that availability zone takes the broker down. This chunk does not add a subnet.

### Task

Own cluster, name `${name}-kms-broker`. Two containers, `network_mode = awsvpc`, `requires_compatibilities = ["FARGATE"]`, `cpu = "512"`, `memory = "1024"`, `assign_public_ip = true` because the cell has no NAT. `runtime_platform` is `LINUX` / `X86_64`, matching the connector. No load balancer.

Both containers set `essential = true`. If either dies, ECS replaces the task. A live tunnel with nothing behind it is not a steady state.

- `kms-broker` listens on `127.0.0.1:8080` only. Image is `var.kms_broker_image`. The health check command, run inside this image, is `node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`. Interval, timeout, retries, and start period are the ECS defaults.
- `cloudflared` runs `tunnel --no-autoupdate run`. `dependsOn` the broker container with condition `HEALTHY`, so the tunnel does not register before the broker listens. `TUNNEL_TOKEN` comes from `tunnel_secret_arn`. The task definition has no plaintext token and no AWS access key. Image is `var.kms_broker_cloudflared_image`.

The task uses `aws_iam_role.task` and `aws_security_group.broker` from the envelope module. It does not create a second role or a second security group.

ECS serves the task role's credentials to every container in the task. There is no per-container scope. `cloudflared` can call `Decrypt`, and `aws:SourceVpce` does not stop it, because the call still comes from inside the VPC. That is a consequence of the loopback design, and the loopback design stays. The sidecar is trusted code inside D8's boundary. ADR 0008 says so. An unpinned `cloudflared:latest` is not a later convenience.

`kms_broker_cloudflared_image` is a variable on the new broker task module. `aws-ecs-tunnel` is not edited. The whole value matches `^docker\.io/cloudflare/cloudflared@sha256:[0-9a-f]{64}$`. A foreign repository fails that validation, including `docker.io/anyone/cloudflared@sha256:` plus 64 hex characters. The image is pulled from Docker Hub by digest, the same shape as the connector's default. The broker security group already allows TCP 443 to `0.0.0.0/0`, which covers that pull. A pull-through cache would also need `ecr:BatchImportUpstreamImage`, `ecr:CreateRepository`, and a Docker Hub credential. This chunk does not create those.

`kms_broker_image`, when the flag is true, is a whole-string match, lowercase hex:

`^` + `{aws_account_id}.dkr.ecr.ap-southeast-2.amazonaws.com/{name}/kms-broker@sha256:` + `[0-9a-f]{64}` + `$`

Nothing may follow the digest. A variable validation cannot read `aws_ecr_repository.repository_url`. The expected prefix is built from `aws_account_id` and `name`, via a cross-variable validation (Terraform 1.11.4 supports that) or a precondition on the task definition. A tag, an uppercase hex digest, a suffix after the digest, and a digest from any other registry, including another region's ECR, fail validation. Those must-fail tests live in the broker task module's own tests. A root test cannot `expect_failures` on a child-module resource (envelope plan deviation 4).

Both containers log to `log_group_name` from the envelope module, which is `/community-hub/${name}/kms-broker`.

### Image

The image is Node 24, the same major as `engines` (`>=24`) and CI (`node-version: 24`). Node 22 also has the `fetch` the health check uses. The image stays on 24 so the process that holds the unwrap credential is not a second runtime.

The Dockerfile pins that base by digest: `FROM node:24-slim@sha256:` and 64 lowercase hex characters, and the install is `pnpm install --frozen-lockfile` against this repo's lockfile. A tag-only `FROM` fails review. That pin is a review rule, not a CI checker. AGENTS.md §10 adds a check only with a must-fail fixture, and this chunk does not add that checker. CI's `docker build` proves the Dockerfile builds. It does not prove the `FROM` line is digest-pinned.

The repository `${name}/kms-broker` has `image_tag_mutability = "IMMUTABLE"` and `scan_on_push = true`.

Push actions `ecr:PutImage`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, and `ecr:CompleteLayerUpload` are absent from the task role and from every policy on the execution role. No repository policy grants them to either role.

The execution role gains one new `aws_iam_role_policy`, pull only, and only when the flag is true. Actions are `ecr:GetAuthorizationToken` on `*`, and `ecr:BatchCheckLayerAvailability`, `ecr:GetDownloadUrlForLayer`, and `ecr:BatchGetImage` on this repository. `BatchCheckLayerAvailability` is what ECS needs to pull. It is not a push action. The envelope module's existing execution policy is not edited.

CI builds and does not push, so the digest in ECR is built on a person's machine. The runbook builds from a clean checkout of the merged commit and stamps `org.opencontainers.image.revision=<sha>` with that commit. CI passes the same label from the checkout SHA, so the build argument exists, and the label on the pushed image is what makes a running digest traceable.

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
  "limits": { "maxBodyBytes": 65536 },
  "responseHeaders": { "cache-control": "no-store" },
  "logFields": ["operation", "key_kind", "outcome"]
}
```

`generateDataKey` request: `{ "keyId", "context" }`. Response: `{ "plaintext", "blob" }`, standard base64, plaintext decodes to 32 bytes. `decrypt` request: `{ "keyId", "blob", "context" }`. Response: `{ "plaintext" }`.

`keyId` must equal `logicalKeyId`. The process maps that id to `ENVELOPE_KEY_ARN` from the environment. The request does not carry an ARN. Any other `keyId` is rejected before KMS is called.

Context check, same allow-list as the local `KmsPort`: `key_kind` is `org` or `identity`; org has `org_id` and not `region`; identity has `region` and not `org_id`; `key_version` is a string; no extra key. Empty `{}`, a missing required key, both scope keys, neither scope key, and an extra key are rejected before KMS is called. The empty object is a named test, because `ForAllValues` on the key policy would allow it.

The body limit is enforced while reading. A `Content-Length` over 65536 is rejected before the body is read. A chunked body is abandoned once 65536 bytes have been read. Rejected requests, including that oversized body, a non-JSON body, and a wrong `content-type`, return status 400 and the error body. AWS errors and a KMS response that is not 32 bytes return status 502 and the same body. The body has no other field. It contains no key ARN, context value, AWS error code, or AWS message.

Every response, including errors and `GET /health`, sends `cache-control: no-store`. `GET /health` returns 200 with an empty body and does not call KMS. It is not a `KmsPort` route.

Any other method or path, including `GET /v1/decrypt`, `PUT /v1/generate-data-key`, and `/anything`, returns 404 with the same error body and `cache-control: no-store`, and does not call KMS.

Logs are one object per request. Keys are exactly `operation`, `key_kind`, and `outcome` (`ok`, `rejected`, or `failed`). `key_kind` is omitted when the body did not parse. The log line does not contain plaintext, a blob, a request or response body, `org_id`, `region`, `key_version`, or a key ARN. The server fills the SDK `Uint8Array` with zeroes after copying the bytes into the response. That zeroing is best-effort. The base64 string in the JSON body cannot be wiped, and it lives until garbage collection.

The SDK call is `GenerateDataKey` with `KeySpec` `AES_256`, or `Decrypt`. Both set `KeyId` to the configured envelope ARN and `EncryptionContext` to the validated context. With `KeyId` set, KMS refuses a blob from any other key. Region is `ap-southeast-2`. Credentials are the task role's default chain. No static key in the environment.

The KMS client sets `maxAttempts` to 1. The server aborts the call after 3000 ms and returns 502 `kms_failed`. The AWS SDK v3 client has no request timeout unless one is set, and a fake that never resolves must still produce that 502. The server's own deadline is what the test observes.

Before it listens, the process checks `ENVELOPE_KEY_ARN`. Missing, empty, or not matched by `^arn:aws:kms:ap-southeast-2:[0-9]{12}:key/.+$` exits non-zero and does not listen. The health check then never passes, and `cloudflared` does not register.

When KMS is unreachable, the broker returns 502 `kms_failed`. It does not try another key, the storage key, or a local unwrap. There is no cache.

### Workers VPC service

Created only when `enable_kms_broker_tasks` is true. New module. `infra/modules/cf-vpc-service` stays the Postgres TCP service.

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

`https_port` is null. `tls_settings` is absent. Verification mode applies to TLS origins, and this origin is plaintext HTTP on loopback. `host.ipv4` is `127.0.0.1`. There is no hostname. `host.network.tunnel_id` is the broker tunnel id, not the Postgres tunnel id.

A VPC service routes to that host from `cloudflared` itself. The ingress rules on the broker tunnel are the public-hostname mechanism and are not this path. The catch-all from `terraform-envelope-kms` stays. The first live proof is a `fetch()` through this VPC service reaching the broker at `127.0.0.1:8080`. If that fails while the catch-all behaves differently, the `fetch()` is the result that matters.

Workers VPC is in beta. Cloudflare's docs say features and APIs may change before general availability. The cell's only path to unwrap organisation keys runs through it. That is accepted. If the first apply rejects this shape, including a loopback address, stop and report. Do not point the service at a VPC address, and do not switch it to a `vpc_networks` binding.

When the flag is false, the AU root output for the service id is null.

### Availability

Two tasks, one public subnet, fail closed. `kms-worker-adapter` treats a connection failure, a timeout, and any non-2xx as the same generic failure `@community-hub/crypto` already surfaces. This chunk does not implement that client.

## Data

No application tables. No classified columns.

The task definition references the existing secret by ARN. The image digest, the revision label, and the envelope key ARN are infrastructure identifiers in the task environment or image config. Broker logs are `operation`, `key_kind`, and `outcome` only.

## Rules touched

- §7.3 rule 5: the task role credential stays on the task. No AWS key is added to a Workers secret. The sidecar holds that same credential. Its image is digest-pinned.
- §1 rules 1 and 7: plaintext is not logged. No global Worker imports this server.
- §1 rule 10: the tunnel token stays in Secrets Manager. It is not in the task environment or CI logs.
- Children, entitlements, consent, money: none.

## Contracts

- Fixture `packages/kms-broker/contract/kms-port-v1.json`, as above. This chunk ships the server. `kms-worker-adapter` ships the client.
- Workers VPC service id is an output of `infra/regions/au` when the flag is true, and null when it is false.
- No product events, no `module.manifest.ts` keys.

## Tests

**Broker, against the fixture.** The KMS client is a fake. No network.

- `generateDataKey` with an org context and with an identity context calls `GenerateDataKey` once, with the configured ARN, `KeySpec` `AES_256`, and that context, and returns 32-byte plaintext plus a blob.
- `decrypt` of that blob with the same context calls `Decrypt` once with `KeyId` equal to that ARN and returns the same plaintext. A different context or a tampered blob returns 502 `kms_failed` and does not return plaintext.
- Empty context does not call KMS and returns 400 `kms_failed`.
- Missing `key_version`, both `org_id` and `region`, neither, an extra key, a bad `key_kind`, and `keyId` other than `envelope` do not call KMS.
- A `Content-Length` over 65536 does not read the body and returns 400. A chunked body with no `Content-Length` that exceeds 65536 returns 400 and stops reading at the limit.
- An AWS error whose message contains the key ARN and an `org_id` becomes 502 with body exactly `{"error":"kms_failed"}`. Those values are absent from the body and from the log line.
- Log keys on success are exactly `operation`, `key_kind`, `outcome`.
- `cache-control: no-store` on success, on 400, and on 502.
- The listen address is `127.0.0.1:8080`.
- `GET /health` is 200, empty, and does not call KMS.
- `GET /v1/decrypt`, `PUT /v1/generate-data-key`, and `/anything` are 404, body `{"error":"kms_failed"}`, `cache-control: no-store`, and do not call KMS.
- A fake KMS client that never resolves returns 502 `kms_failed`. The test finishes. It does not wait on the client.
- A missing `ENVELOPE_KEY_ARN`, and an ARN in a region other than `ap-southeast-2`, each exit non-zero and do not listen.

**Terraform, `command = plan`, mocked providers.**

- Flag false: the ECR repository is present, with immutable tags and scan on push. No task definition, no ECS service, no Workers VPC service, no pull policy. The service-id output is null. The image variable is not required.
- Flag true, image `{aws_account_id}.dkr.ecr.ap-southeast-2.amazonaws.com/{name}/kms-broker@sha256:` plus 64 lowercase hex characters and nothing after: `desired_count` is 2, both containers `essential`, `cloudflared` `dependsOn` the broker with `HEALTHY`, the health-check command is the `node -e` `fetch` above, the task role is the envelope module's task role, the security group is the envelope module's broker group, `secrets.valueFrom` is `tunnel_secret_arn`, the log group is `log_group_name`, and the VPC service's tunnel id is the broker tunnel.
- That VPC service: `type` is `http`, `http_port` is 8080, `https_port` is null, `tls_settings` is absent, `host.ipv4` is `127.0.0.1`, no hostname, `host.network.tunnel_id` is the broker tunnel and not the Postgres tunnel.
- In the broker task module's own tests, not from the AU root: a tag, an uppercase hex digest, a trailing suffix, and a digest from another registry each fail `kms_broker_image` validation. `docker.io/anyone/cloudflared@sha256:` plus 64 hex characters fails `kms_broker_cloudflared_image` validation. A root `expect_failures` on the child module is not the proof.
- The pull policy's actions are the four named above, and neither the task role nor any execution policy contains a push action.
- The Postgres tunnel module, the connector module, and `cf-vpc-service` are unchanged.

**Image.** CI runs `docker build` on `apps/kms-broker/Dockerfile` with `org.opencontainers.image.revision` set to the checkout SHA. No `docker push`, no registry login, no AWS credentials. The digest pin on `FROM` and `--frozen-lockfile` are the review rule in the Image section, not an assertion in this list.

## Risks

| Risk | Mitigation |
| --- | --- |
| The task is added to the connector, so the empty connector role gains KMS | Separate cluster and service. Connector module untouched. The task uses the envelope role. |
| `cloudflared` holds the unwrap credential | Named in ADR 0008. The image is only `docker.io/cloudflare/cloudflared` pinned by digest. A foreign repository fails validation. |
| Anonymous Docker Hub pulls from Fargate are rate-limited | Accepted here, as with the connector's default. A pull-through cache is later work and is not built in this chunk. |
| A digest-pinned image from another registry gets the unwrap role | `kms_broker_image` is a whole-string match of this cell's ECR repository URL, lowercase hex, nothing after the digest. |
| The base image or the lockfile drifts on a rebuild | `FROM` is digest-pinned and install is `--frozen-lockfile`, enforced at review. CI builds the Dockerfile and does not check the pin. |
| A pushed digest cannot be tied to source | Runbook builds a clean checkout of the merged commit and sets `org.opencontainers.image.revision`. |
| Plaintext crosses the VPC | Sidecar on `127.0.0.1`. The security group already has `ingress = []`. |
| Error bodies or logs carry the key ARN or context | Fixed error body. Three log fields. Tests use a distinctive ARN and `org_id`. |
| Zeroing is treated as erasure | Best-effort on the SDK buffer only. ADR 0008 already says the base64 body lives until garbage collection. |
| First apply cannot pull an image from an empty repository | The flag-off apply creates the repository and no task. Runbook: push, then enable. CI builds without pushing. |
| Workers VPC is in beta and may reject loopback | Accepted. ADR 0008 names it. If the first apply rejects the shape, stop and report. Do not point the service at a VPC address. |
| A `vpc_networks` binding bypasses the one-host, one-port limit | Out of this chunk. `kms-worker-adapter` fails that binding. See Out-of-band. |
| One public subnet | `desired_count` 2 covers a dead task. AZ loss stays as ADR 0008 left it. |
| The tunnel registers before the broker listens | Both containers essential. `cloudflared` waits until the broker is `HEALTHY`. |

## Out-of-band

- **Same PR, ADR 0008 consequences.** The broker task's sidecar is trusted code holding KMS-capable credentials. Its image is `docker.io/cloudflare/cloudflared` pinned by digest, and an unpinned tag or a foreign repository is not a convenience. An ECR pull-through cache is later work, not this plan. Workers VPC is in beta. Features and APIs may change before general availability. The unwrap path uses it. If the first apply rejects the HTTP loopback service, stop and report.
- **Same PR, architecture §12.2.** The cell runs this broker. The regional Worker still does not call it. That call is `kms-worker-adapter`.
- **Same PR, runbook.** From a clean checkout of the merged commit, build `apps/kms-broker` with `org.opencontainers.image.revision` set to that SHA, push to the cell ECR repository, set `kms_broker_image` to that `@sha256:` digest, then apply with `enable_kms_broker_tasks = true`. `cloudflared` stays on the Docker Hub digest. That apply creates the tasks and the Workers VPC service. The first live proof is a `fetch()` through that service to `127.0.0.1:8080`. Do not apply prod from this runbook.
- **`kms-worker-adapter`:** the `KmsPort` client, the VPC service binding only on `apps/api`, and the `regionalOnlyPackages` change. Its checker fails if any Worker other than `apps/api` holds this service binding. It also fails if any Worker, `apps/api` included, holds a `vpc_networks` binding whose `tunnel_id` is the broker tunnel, or a `cf1:network` binding, which reaches every tunnel in the account. A network binding can reach any address behind the tunnel and would bypass the one host and one port this service registers.
- Legal: none. New subprocessor: none.
- Scaffold waits until this spec and its plan are both `approved`.

## Next spec

`kms-worker-adapter`, after this chunk. `api-au-hostname` and `kms-mrk-replica` stay behind it.

This chunk's last commit updates `docs/roadmap.md`: `kms-broker-service` **done**, next `kms-worker-adapter`, Phase 0 `11 / 14` done. It does not insert rows.
