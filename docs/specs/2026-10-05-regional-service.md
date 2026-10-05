# Spec: Regional service

Slug: regional-service
Status: draft
Architecture refs: §7, §7.3, §12, ADR 0009. Implements the `regional service` row in `docs/roadmap.md`. `docs/specs/2026-10-03-personal-data-on-aws.md`, `docs/specs/2026-10-04-ingress.md`, `docs/specs/2026-10-04-db-tls.md`, and ADR 0009 are not edited.

## Problem

`apps/api` still exports a fetch handler. It has no Node process, no image, and no way to tell an ops hostname from a tenant hostname. The KMS adapter still speaks `BrokerKms`, which takes an abort signal the `KmsPort` type does not have. The RDS certificate bundle is not in the tree, so nothing can yet pass `ca` into the `db-tls` factories.

The first staging apply has to run a probe as its own task. This chunk builds that command and the image that contains it. The running server does not open a database connection or call KMS.

## Scope

**In**

- `apps/api` becomes one Node process. It listens on `0.0.0.0` and the port in `PORT`. The Worker-style default export goes away.
- A route gate in `apps/api`, in front of the kernel handler. `GET /health` returns `{ ok: true }`.
- The kernel log's `path` is the matched route pattern, or `unmatched`. `gatewayRequestId` is a separate field. `acceptInboundRequestId` stays false.
- The observability logger allow-list gains the fields named under Logging, and checks each new value.
- The KMS adapter implements `KmsPort`. `BrokerKms` is deleted.
- The committed RDS bundle and its SHA-256. The server checks the digest before listen. The probe passes the bytes as `ca`.
- `probe.js` at `/app/probe.js`. The server stays the entrypoint.
- An ARM image. CI builds it and does not push it. CI then runs the probe with no environment.
- The last commit updates `docs/roadmap.md` and the repository-state line in `AGENTS.md`.

**Out**

- Any `terraform apply`, any image push, and any edit to `infra/modules/aws-ingress`. `service_image` stays null.
- Opening a database connection or calling KMS from the running server, including during startup and `GET /health`.
- Pooled checkout of `createAppSql`, `createIdentitySql`, and `createPlatformSql`. Nothing in this chunk calls those factories. The first chunk that serves a database route adds that checkout together with the password re-read.
- A cache of unwrapped organisation keys.
- An alarm on `missing_hostname_header`.
- A startup check that the database or KMS answers. That question belongs to the first chunk that serves a route which needs either one.
- SQS, EventBridge, S3, and any product route other than `GET /health`.

**Size**

This chunk is past the ~800-line guide. The size exception has four terms: at most ten tasks, an estimate on each, the reason recorded in the plan and the PR body, and a second fresh-context review.

The gate, the adapter, the probe, and the image describe one process. An image that booted the current fetch handler would answer `GET /health` with no peer check and no hostname check. The probe's `env` failure is the CI proof that the image contains the command, and it is meaningless against a different layout. Pooled checkout is absent, so the server task is the environment check, the listen path, and the certificate pin. Nine tasks, about 2,400 lines:

1. Logger allow-list and value checks. About 180 lines.
2. Kernel `path` and `gatewayRequestId`. About 220 lines.
3. Route registration, the hostname gate, and the unread-body test. About 480 lines.
4. `KmsPort` adapter, deadline, and the probe-file lint allow. About 400 lines.
5. Startup validation, listen, and the certificate pin. About 260 lines.
6. The probe and the planted-marker test. About 320 lines.
7. The image, keep-alive, and the ingress-contract checks, including a request that never finishes. About 420 lines.
8. The CI ARM build and the Stage 3 sentence in `AGENTS.md`. About 80 lines.
9. `docs/roadmap.md` and the repository-state line. About 40 lines.

## Behaviour

### Process

Startup checks the environment, then the route table, then listens. It does not call `createDirectSql`, `createAppSql`, `createIdentitySql`, `createPlatformSql`, or KMS `send`. A test asserts that listen and `GET /health` call no factory and no `send`.

Importing the module does not bind a port. The process listens only when the file is the entrypoint. Tests call the gate with a request and a peer address.

The required environment variables are the ingress contract's names, except `TURNSTILE_SECRET`, which stays optional and unused. Each required value is a non-empty string. `PORT` is an integer from 1 to 65535. `PGPORT` is that same kind of integer. `AWS_REGION` is `ap-southeast-2`. `NODE_ENV` is `production` or `test`. `COMMUNITY_HUB_ENVIRONMENT` is `staging` or `prod`. The four hostnames, compared after lowercasing, are distinct. `ENVELOPE_KEY_ARN` matches the pattern under KMS. The certificate file's SHA-256 matches the pin under Database.

A failed check exits 1 before the port is bound. Stdout is empty. Stderr is the line `env` for a bad environment, ARN, or certificate, and the line `routes` for a bad route table. The line is the code plus one newline. A value that failed the check is not printed. The route table is checked only after the environment check has passed.

On SIGTERM the process may keep accepting for up to 5 seconds. It then stops accepting. A request that finishes before the force-close still receives its response. At 25 seconds after SIGTERM, every connection that is still open is destroyed. The process then exits 0, which is before the 30-second stop timeout. A connection that arrives after accepting has stopped receives no HTTP response. A test holds a request that never finishes and asserts the connection is destroyed and the process has exited before 30 seconds.

The server sets `keepAliveTimeout` to 5000 milliseconds and `headersTimeout` to 10000 milliseconds. `headersTimeout` is longer than `keepAliveTimeout`, so an idle keep-alive socket is closed by the keep-alive timer. Five seconds of inactivity after a response destroys the socket. Ten seconds is the limit for the complete headers to arrive.

### Health and the gate

Every route is registered with a method, an exact path pattern, a surface, and a handler. The surface is `ops`, `tenant`, or `all`. A missing surface, a duplicate method and pattern, or a surface the checker rejects fails startup with `routes`. `all` is accepted only for `GET` and the pattern `/health`. Production registers only that route. Tests register further routes through the same function.

The peer address is the TCP peer. `x-community-hub-client-ip` is not read for any decision. Loopback peers are exactly `127.0.0.1`, `::1`, and `::ffff:127.0.0.1`. The process binds `0.0.0.0`, as the ingress contract requires.

Hostnames are compared after lowercasing the header and the four environment values. The header is missing when it is absent or empty. A present value is not trimmed.

`GET /health` with no hostname header is served only for a loopback peer. The body is `{ ok: true }`. Through either API it is served when the header equals any of the four hostnames, because the route's surface is `all`. This amends the ingress contract by statement. The ingress spec and `infra/modules/aws-ingress` stay as they are. The amendment is the loopback exception, and `GET /health` on `OPS_HOSTNAME`.

The first matching row wins. A refusal is status 404 and an empty body, and the kernel handler is not called. The path written on that line is still taken from the route table: a request whose method and path equal a registered route logs that pattern, including when an earlier row refuses it. `GET /health` with no header from a non-loopback peer logs path `/health` and reason `missing_hostname_header`.

| Order | Condition                                                                               | Reason                        |
| ----- | --------------------------------------------------------------------------------------- | ----------------------------- |
| 1     | The hostname header is missing, and the loopback `GET /health` exception does not apply | `missing_hostname_header`     |
| 2     | The lowercased header equals none of the four hostnames                                 | `unknown_hostname`            |
| 3     | The matched route's surface is `ops`, and the header is not `OPS_HOSTNAME`              | `ops_route_on_other_hostname` |
| 4     | The header is `OPS_HOSTNAME`, and the matched route's surface is `tenant`               | `other_route_on_ops_hostname` |

`ops` is served only on `OPS_HOSTNAME`. `tenant` is served only on `API_HOSTNAME`, `AUTH_HOSTNAME`, or `WEBHOOKS_HOSTNAME`. An unmatched path on `OPS_HOSTNAME` is not a refusal. It falls through to the kernel handler, as an unmatched path on a tenant hostname does. The handler returns an empty 404, the log's `path` is `unmatched`, and the line has no `reason`.

The gate decides from the method, the path, the headers, and the peer address before any body byte is read. The body of a refused request is not read and is not buffered. The body of an unmatched request is not read and is not buffered. A test sends a refused request whose body is 1 MiB of a marker. The marker is in no log line, and the body stream's read count stays 0.

### Logging

`createRequestHandler` takes a `pathFor` callback and logs its return value as `path`. It does not read the URL path into a log field. The gate passes the registered pattern, or `unmatched`. The existing kernel assertion that `POST /health` logs the URL pathname is replaced by an assertion on the string `pathFor` returns. A test requests a path that contains a caller-supplied segment and asserts that segment is in no log field.

`requestId` stays the kernel UUID. `acceptInboundRequestId` stays false, and the server passes false. An inbound `x-request-id` is not that UUID and is not copied into a log line.

`gatewayRequestId` is set from `x-community-hub-request-id` when the header matches `^[A-Za-z0-9+/=_-]{1,128}$`. Otherwise the field is omitted. The kernel log for a served request keeps `method`, `path`, `status`, `duration`, and `requestId`.

The logger allow-list adds `gatewayRequestId`, `reason`, `hostname`, `operation`, `key_kind`, and `outcome`. A value that fails its check is omitted and `getDroppedFieldCount` increases. The line is still written.

| Field              | Accepted value                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `gatewayRequestId` | `^[A-Za-z0-9+/=_-]{1,128}$`                                                                                 |
| `reason`           | `missing_hostname_header`, `unknown_hostname`, `ops_route_on_other_hostname`, `other_route_on_ops_hostname` |
| `hostname`         | `^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$` and at most 253 characters                                         |
| `operation`        | `generate_data_key`, `decrypt`                                                                              |
| `key_kind`         | `org`, `identity`                                                                                           |
| `outcome`          | `ok`, `rejected`, `failed`, `timeout`                                                                       |

The gate writes the refusal through the same logger, with message `request`. The fields are `method`, `path`, `status` 404, and `reason`. `path` is the matched pattern, or `unmatched`. `hostname` is included only when the lowercased header equals one of the four environment values, and the value written is that environment value after lowercasing. `gatewayRequestId` is included when `x-community-hub-request-id` matches the pattern above, so the refusal can be matched to the access log. The refusal line has no kernel `requestId`, no `duration`, no query string, and no client IP. A served line uses message `request` and has no `reason`. A KMS line uses message `kms`.

A test sends `x-community-hub-client-ip` on a served request, a refused request, and an unmatched request. The header's value is in no log line.

### KMS

The adapter's type is `KmsPort` from `@community-hub/crypto`: `generateDataKey(keyId, context)` and `decrypt(keyId, blob, context)`. `BrokerKms` and its abort-signal argument are deleted. `checkContext` still rejects a context outside the allow-list in `apps/api/src/kms/context.ts`.

`checkContext` runs first. The `keyId` is then compared to the configured ARN. Either failure skips `send`, logs `outcome` `rejected`, and throws `kms_failed` with no `cause`. `ContextRejected` does not escape the adapter. When `checkContext` rejects and the raw `key_kind` is `org` or `identity`, the log includes that `key_kind`. Any other raw kind is omitted rather than copied.

The SDK commands stay `GenerateDataKey` (`KeySpec` `AES_256`) and `Decrypt`. Both send `KeyId` and the encryption context from the checked context. The client is constructed with `region: "ap-southeast-2"` and `maxAttempts: 1`. The client object may be constructed before listen. `send` is not called until a later call to the port.

The deadline lives in the adapter and defaults to 3000 ms. The production server does not pass a shorter value. Tests may. The adapter aborts `send` at the deadline. Response bytes are zeroed after they are copied out. Bytes that arrive after the deadline are zeroed and not returned. That outcome is `timeout`. An incomplete response or a thrown SDK error is `outcome` `failed`, and any bytes already in hand are zeroed. Success is `outcome` `ok`.

Every failure throws an error whose `message` is exactly `kms_failed` and whose `cause` is `undefined`. The ARN, the context, the SDK message, and the plaintext are not on the error.

One log line per call, message `kms`, fields `operation`, `key_kind` when it is known, and `outcome`. `operation` is `generate_data_key` or `decrypt`.

`ENVELOPE_KEY_ARN` is checked before listen. The value matches:

```text
^arn:aws:kms:ap-southeast-2:[0-9]{12}:key/(mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$
```

An alias ARN, another region, and an uppercase hex id fail the check. There is no in-memory cache of unwrapped keys. The first chunk that unwraps an organisation key decides that cache.

`@community-hub/no-kms-port-outside-crypto` still rejects a `KmsPort` call outside `packages/crypto/src`, with one added allow: a filename that ends in `/apps/api/src/probe.ts`. The adapter implements the port and does not call a `KmsPort` receiver. A must-fail fixture under `apps/api/src/kms/` still fails. The existing fixtures outside `apps/api` still fail.

### Database

The committed file is `apps/api/certs/rds-ap-southeast-2-bundle.pem`. It is the `ap-southeast-2` bundle from `https://truststore.pki.rds.amazonaws.com/ap-southeast-2/ap-southeast-2-bundle.pem`, fetched on 2026-10-05: 4,616 bytes, three certificates, SHA-256 `d73890748b5a95551800df8a6f07c9c800e32ed34da7e6c9505918bf8ac2398b`. The object last-modified time was Wed, 11 Sep 2024 23:33:23 GMT. The server and the probe hash the file they open and continue only when the digest matches. They do not download it at runtime.

The image copies the file to `/app/certs/rds-ap-southeast-2-bundle.pem`. Unit tests open the committed path. The probe passes the file's text as `ca`, with `host` set to `PGHOST` and `servername` omitted, so the factory checks the certificate against `PGHOST`. The server checks the digest and does not pass the bytes to a factory.

### Probe

The server entrypoint stays the server. The probe is `node /app/probe.js`. It is not the container health check. The health check stays the ingress `node -e` fetch of `http://127.0.0.1:8080/health`.

The probe runs the steps below and stops at the first failure. Each step has a 10 second budget. The adapter's 3000 ms deadline fires inside a KMS step, so that step reports `kms_generate` or `kms_decrypt` when KMS is slow. The 10 second budget is the backstop when a call never returns.

| Step | Work                                                                                                                                               | Stderr         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| 1    | The same environment, ARN, and certificate checks as the server                                                                                    | `env`          |
| 2    | `createDirectSql` as `app`, then `SELECT 1`                                                                                                        | `db_app`       |
| 3    | `createDirectSql` as `identity`, then `SELECT 1`                                                                                                   | `db_identity`  |
| 4    | `createDirectSql` as `platform`, then `SELECT 1`                                                                                                   | `db_platform`  |
| 5    | `generateDataKey` on the `KmsPort`, `keyId` the configured ARN, context `{ key_kind: "identity", region: "ap-southeast-2", key_version: "probe" }` | `kms_generate` |
| 6    | `decrypt` that blob with the same `keyId` and context, compare the bytes, then zero both copies                                                    | `kms_decrypt`  |

A compare mismatch is `kms_decrypt`. Both copies are zeroed on success and on mismatch. Each direct connection is closed after its `SELECT 1` returns.

Stdout is the line `pass` or the line `fail`. Stderr on failure is one of the six codes. On success, stderr is empty. Each line is the word plus one newline. The process exits 0 or 1. An uncaught exception or an unhandled rejection prints `fail` and the current step's code, or `env` when no step has started, and exits 1. No stack, no driver text, and no other bytes are written.

A test plants a marker in a thrown error and in a password. The marker appears in neither stdout nor stderr, including the uncaught path. CI runs the image's probe with no contract environment and expects exit 1, stdout the line `fail`, and stderr the line `env`.

The first staging apply runs the probe as a standalone task. This chunk does not run that task. The task uses container name `service`, command `["node", "/app/probe.js"]`, a public subnet, the task security group, and a public IP. The service's `desired_count` stays 0. ECS Exec stays off.

### Image and CI

The runtime stage is `node:24-slim` pinned by digest for `linux/arm64`: `FROM node:24-slim@sha256:` and 64 lowercase hex characters. The plan records the digest current when that task is written. A tag-only `FROM` fails review. The build installs with `pnpm install --frozen-lockfile`. The runtime stage has production dependencies, runs as `USER node`, and contains `/app/index.js`, `/app/probe.js`, and the certificate file. It bakes no contract environment variable and no secret. The entrypoint is `node /app/index.js` in exec form.

The image creates `/tmp` owned by `node` and declares `VOLUME ["/tmp"]`. The image `HEALTHCHECK` is the ingress health command in exec form. Its first argument is `node`. The argument list contains no shell.

CI builds `--platform linux/arm64` and does not push, log in to a registry, or take AWS credentials. It then runs the probe with no contract environment.

The image job runs on `ubuntu-24.04-arm`. That label is a standard GitHub-hosted runner for private repositories: 2 vCPU, 8 GB RAM, 14 GB SSD, arm64 ([GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), read 2026-10-05). The organisation `taftechnology` is on GitHub Free (`plan.name` `free`, read the same day). GitHub Free for organisations includes 2,000 Actions minutes a month. This runner draws on those minutes. After the quota, the rate is USD 0.005 per minute, SKU `actions_linux_arm` ([Actions runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing), read 2026-10-05). A larger ARM runner is not used. Included minutes do not cover larger runners.

The committed job uses `ubuntu-24.04-arm` only. It does not also run an emulation job. If a run is not queued because that label is unavailable, the fallback is to change that job to `ubuntu-latest` and build with `docker buildx build --platform linux/arm64`, then run the same probe. That runner is USD 0.006 per minute, SKU `actions_linux`, against the same 2,000 minutes.

The image job also checks the ingress rows this process owns:

| Check          | What passes                                                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User           | The image user is `node`                                                                                                                                                                            |
| `/tmp`         | The image creates `/tmp` owned by `node`, and `VOLUME` includes `/tmp`                                                                                                                              |
| Writes         | A container started `--read-only` with a writable `/tmp` serves loopback `GET /health` and stops on SIGTERM                                                                                         |
| Listen         | With `PORT` `8080` the process accepts on `0.0.0.0:8080`                                                                                                                                            |
| Health command | `node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"` exits 0, invoked as `node` with no shell                                               |
| SIGTERM        | Accepting stops within 5 seconds, an in-flight request that finishes still receives its response, a request that never finishes is destroyed at 25 seconds, and the process exits before 30 seconds |
| Keep-alive     | `keepAliveTimeout` is 5000 and `headersTimeout` is 10000                                                                                                                                            |

Those container checks set every required variable to a synthetic value, including an ARN whose account id is `123456789012`. They do not contact a database or KMS. Listen and `GET /health` still call no factory and no `send`.

`AGENTS.md` §10 Stage 3 is updated in the CI task. It says Stage 3 builds this ARM image, does not push it, and does not call Wrangler or require a Cloudflare token. Verification of a running task stays the staging hostname.

## Data

No new table and no new column. The certificate file is Amazon's public bundle. Log fields are method, route pattern, status, duration, the kernel UUID, the gateway request id, a reason code, a configured hostname, a KMS operation, a key kind, and an outcome. Those values are not personal data. `x-community-hub-client-ip` is not written.

The probe is the only caller of `packages/db` in this chunk. It uses `createDirectSql`. This chunk adds no pooled factory and no query of an `app` table.

## Rules touched

Residency. The process is what will run in `ap-southeast-2`. This chunk does not deploy it. The image build pulls a public base image and does not copy tenant data.

Children. No new public path, directory, or projection.

Tenancy. No query of tenant rows. No request calls a database factory. The probe's `SELECT 1` uses `createDirectSql` and is not a tenant query.

Encryption. The adapter is the process's KMS boundary. Failures carry `kms_failed` and nothing from the request or the key. The probe's data key is compared and zeroed in that process. It is not stored.

Secrets. Passwords, the ARN, and SDK errors stay out of stdout, stderr, and log lines. The image contains none of them. The task role's grants are unchanged because this chunk does not edit Terraform.

Money. No payment path.

Rule 5. The client IP, the raw path, and the query string stay out of logs. The tests under Logging cover a served, a refused, and an unmatched request.

## Contracts

The process conforms to the ingress contract, with the health amendment in this spec. `GET /health` is 200 and `{ ok: true }` for a loopback peer with no hostname header, and for any of the four hostnames when the header matches. The listen address, port 8080 in the task, user `node`, read-only root, `/tmp`, SIGTERM, and the health command stay as ingress wrote them.

`createRequestHandler` requires `pathFor`. `RequestLogFields` gains optional `gatewayRequestId`. The observability `LogFields` type gains the six fields in the table above.

`apps/api` depends on `@community-hub/crypto` and `@community-hub/db`. The adapter exports a `KmsPort`. The probe is the only new caller of that port outside `packages/crypto/src`.

Deep links and website events stay ids only. This chunk publishes no application route other than `GET /health`, and no event.

## Cost

No NAT gateway, no load balancer, and no interface endpoint. The task size stays 0.25 vCPU and 0.5 GB. `service_image` stays null, so this chunk adds no running task and no ECR storage.

The new CI job uses the standard ARM runner priced above. A few minutes per build sit inside the 2,000 included minutes. The probe, when the first staging apply runs it, is two symmetric KMS requests. That price stays the parent spec's USD 0.03 per 10,000 requests. It is not a new monthly line.

## Risks

| Risk                                                                                               | What this chunk does                                                                                                               |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A client sends `x-community-hub-client-ip: 127.0.0.1` and is treated as the health check           | The loopback check reads the TCP peer. The header is ignored. A missing hostname from any other peer is `missing_hostname_header`. |
| The health check has no hostname header, so a blanket refusal would keep the task out of Cloud Map | Loopback `GET /health` is the one exception. The ECS command already uses `127.0.0.1`.                                             |
| A refusal log copies the raw path or the client IP                                                 | The path field is the pattern or `unmatched`. The client-IP test covers three outcomes.                                            |
| The adapter's error or log carries the ARN or plaintext                                            | The thrown message is `kms_failed` with no cause. The log fields are the three named above. Bytes are zeroed.                      |
| The probe prints a password or a key                                                               | Stdout and stderr are the two words and the step code. The marker test includes an uncaught throw.                                 |
| `KmsPort` becomes callable from the whole service                                                  | The lint allow is the probe file only. A fixture under `apps/api/src/kms/` still fails.                                            |
| Listen opens a database connection                                                                 | Listen and `GET /health` call no factory and no KMS `send`. This chunk has no pooled checkout.                                     |
| The ARM label cannot be queued                                                                     | The fallback is emulation on `ubuntu-latest`, still building `linux/arm64`.                                                        |

`missing_hostname_header` from a non-loopback peer should have no steady traffic. An alarm on it is an open item on the first staging apply row. This chunk does not create the alarm.

## Tests

Kernel and logger tests cover `pathFor`, a caller-supplied path segment, `gatewayRequestId` accepted and dropped, and each new field's rejected value.

Gate tests cover the four refusal reasons in order, loopback `GET /health` without a header, the same request from a non-loopback peer, `GET /health` on each of the four hostnames, an ops route on a tenant hostname, a tenant route on the ops hostname, an unmatched path on each kind of hostname, a missing surface, and `all` on any route other than `GET /health`. An unmatched path on `OPS_HOSTNAME` has no `reason`. A refusal with a valid `x-community-hub-request-id` logs `gatewayRequestId` and logs no kernel `requestId`. The client-IP marker is absent on a served, a refused, and an unmatched request. The 1 MiB body marker on a refused request is absent, and that body is not read.

Adapter tests cover context rejected before `send`, a mismatched `keyId` before `send`, the 3000 ms default, a call aborted at the deadline, bytes zeroed when they settle after the deadline, `kms_failed` with no cause, and one log line whose outcome is `ok`, `rejected`, `failed`, or `timeout`. The ARN check accepts a Sydney UUID key id and an `mrk-` id, and rejects an alias and another region.

Server tests cover startup `env` and `routes`, listen without a factory or a KMS `send`, and `GET /health` the same way. The certificate test fails when one byte of the bundle changes.

Probe tests cover each step code, the byte compare, zeroing, and the planted marker on a caught failure and an uncaught throw.

The image job covers the contract table, the unpushed ARM build, and the probe with no environment.

## Out-of-band

No legal sign-off. No new subprocessor. No ADR. `architecture.md` is not edited. The ingress amendment is the statement in this spec.

This chunk touches encryption and residency. A second fresh-context review reads the final diff and has not seen the implementation. The review that writes this spec does not count. The PR records that pass.

The last commit updates the catalogue. `regional service` is **done** and links this spec. The snapshot is 20 rows: 17 done, 1 superseded (`api-au-hostname`), 2 not started. Next chunk is `first staging apply`. The repository-state line in `AGENTS.md` matches. The `first staging apply` row gains these sentences: an alarm on `missing_hostname_header` from a non-loopback address is an open item for that row; the probe runs as the standalone task described here, with `desired_count` still 0; 5xx responses under steady light traffic are counted, not only during a deploy. The open-items section gains two lines. Whether startup should prove the database or KMS is decided by the first chunk that serves a route which needs either one. A cache of unwrapped organisation keys is decided by the first chunk that unwraps one. The password re-read item gains one sentence: that same chunk adds pooled checkout of `createAppSql`, `createIdentitySql`, and `createPlatformSql`.

No password, account id, or live hostname appears in this spec, the plan, the tests, or the logs. Tests that need an account id inside an ARN use `123456789012`.
