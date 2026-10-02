# Spec: KMS worker adapter

Slug: `kms-worker-adapter`
Status: approved (2026-10-01, Abdus Salam)
Supersedes: —
Architecture refs: §7.3 rule 5, §12.2, §20; D8; ADR 0008; AGENTS.md §1 (1, 7, 10), §6, §8, §10
Branch: `feat/2026-10-01-kms-worker-adapter`, from `origin/main`. This spec is drafted on that branch. Implementation starts after this spec and its plan are both approved.

Follows: `docs/specs/2026-10-01-kms-broker-service.md`. That chunk runs the broker in the cell when `enable_kms_broker_tasks` is true and registers an HTTP Workers VPC service to `127.0.0.1:8080` on the broker tunnel. This chunk is the client. It does not apply the cell, push an image, or replace the service id.

## Problem

`@community-hub/crypto` can mint and unwrap an organisation root only through a `KmsPort`. The local test port does not call the broker. The regional Worker must not hold an AWS credential, and nothing in `apps/api` can call the broker that now exists in the cell.

## Scope

**In**

- `@community-hub/kms-aws`: a `KmsPort` that `fetch`es the broker using `kms-port-v1.json`. No AWS SDK. Added to `regionalOnlyPackages`.
- One Node contract test in that package. It starts `createServer` from `@community-hub/kms-broker-app` with a fake KMS, listens on port 0, and points the client's `fetch` at that port. The app package is a devDependency. Production code in `kms-aws` does not import it. The package build runs before the test.
- Fake-`fetch` tests for failure mapping and for a 2xx body that must not be returned.
- `apps/api/wrangler.jsonc`: one `vpc_services` binding, name `KMS_BROKER`, `service_id` `REPLACE_AFTER_APPLY`. No route calls it. `apps/api` does not import `@community-hub/kms-aws`.
- A checker, `kms-broker-binding`, in `check:boundaries`, with must-fail fixtures. AGENTS.md §10 lists it in the same pull request.
- A `residency-cell` fixture where a global Worker imports `@community-hub/kms-aws`.
- Architecture §12.2: the client and the binding exist; `apps/api` still does not call them. The runbook lists the order a person follows before the live call. Roadmap, last commit: this chunk **done**, next `api-au-hostname`, Phase 0 `12 / 14`.

**Out**

- A live unwrap, a deploy of `apps/api`, and replacing `REPLACE_AFTER_APPLY` with a real service id. That is `api-au-hostname`.
- Applying Terraform, pushing the broker image, or setting `enable_kms_broker_tasks`.
- A product route, a cache of unwrapped keys, or an edit to `@community-hub/crypto`.
- `kms-mrk-replica`.
- Ordering test suites so two packages do not share port 8080. The contract test does not use that port.

## Behaviour

### Constants

`@community-hub/kms-aws` exports the logical key id and the two routes as constants. A drift test reads `packages/kms-broker/contract/kms-port-v1.json` and fails if any of these differ:

- logical key id `envelope`
- `POST /v1/generate-data-key`
- `POST /v1/decrypt`

Callers in later chunks pass `"envelope"`. Any other `keyId` is sent as given. The broker returns 400, and the adapter maps that to the generic error. The Worker does not read the JSON file at runtime.

### Calls

The package takes a `fetch` function. `generateDataKey` and `decrypt` `POST` JSON through it: `content-type: application/json`, the caller's `keyId`, and the caller's context. `decrypt` also sends `blob` as base64. The request URL is `http://127.0.0.1:8080` plus the path from the constants. A VPC service binding connects to the host and port registered on the service. The host in the `fetch` URL only fills the `Host` header, and its port is ignored. The URL is kept identical to the broker's listen address so the broker sees a familiar request. The contract test injects a `fetch` that reads that path and forwards the body to the ephemeral port. It proves the path and the body. It does not prove routing. Routing is proved by the live call in `api-au-hostname`. The client does not take a port argument.

The Worker's deadline is 5000 ms. The broker's is 3000 ms, so a broker 502 arrives first. The signal passed to `fetch` is that deadline. A test that needs the timeout uses a short deadline and a `fetch` that never resolves. It does not sleep 5000 ms.

### Success

A 2xx is returned only when all of these hold:

- The body is a JSON object.
- `plaintext` is a string on both routes and its base64 round-trips: decoding it and encoding again yields the same string.
- On `generateDataKey`, `blob` is a non-empty string and its base64 round-trips the same way. A missing `blob`, or a `blob` that is not a string, fails the same way.

Each failure of those checks throws `new Error("kms_failed")`. A fake-`fetch` test covers each one: a 200 that is not JSON, a missing `plaintext` on each route, a missing `blob`, an empty `blob`, and base64 that does not round-trip.

The 32-byte check stays in `generateKmsRoot` / `unwrapKmsRoot`. Their error is not `kms_failed`. The adapter does not zero the bytes it returns. `generateKmsRoot` already zeroes the plaintext it was given.

### Failure

A connection failure, the deadline abort, and every non-2xx become `new Error("kms_failed")`. `cause` is `undefined`. The message is that string and nothing else. The fetch error and the response body are not attached and not logged. A test asserts the message and that `cause` is `undefined`.

Fake-`fetch` tests cover connection failure, the short deadline, and a non-2xx. The contract test covers a real 400 and a real 502 from `createServer`, including `cache-control: no-store` on those responses, and a successful generate plus decrypt round trip for an org context and an identity context.

### Binding

`apps/api/wrangler.jsonc`:

```jsonc
"vpc_services": [
  { "binding": "KMS_BROKER", "service_id": "REPLACE_AFTER_APPLY" }
]
```

Wrangler 4.134 `deploy --dry-run` accepts any `service_id` string, including this sentinel and an all-zero UUID. The sentinel is all caps so it cannot be mistaken for an assigned id. This chunk's checker allows that `service_id`.

The entry has exactly the keys `binding` and `service_id`. `remote` is absent. Wrangler's `vpc_services` example sets `"remote": true`, which makes `wrangler dev` use the real resource. A laptop running `apps/api` could then reach the cell broker and unwrap real organisation keys. That breaks §1 rule 9. If local development ever needs the broker, that is a later spec.

### Checker

`kms-broker-binding` discovers Worker apps the same way `worker-config` does: an immediate child of `apps/`. Every Worker today uses `wrangler.jsonc`. An app folder that contains `wrangler.toml` fails, even if a JSON config is also present, because a TOML file would be invisible to this check and to `worker-config`. Otherwise it parses `wrangler.jsonc` or `wrangler.json`. Named environments do not inherit bindings, so the same rules apply to the top-level object and to every object under `env`.

It fails when:

- any of those objects has a `vpc_networks` entry
- the parsed config, walked in full, contains the string `cf1:network`
- any Worker other than `apps/api` has a `vpc_services` entry
- `apps/api` does not have exactly one `vpc_services` entry, named `KMS_BROKER`, whose only keys are `binding` and `service_id`

`remote` on that entry fails because it is a key other than those two. Must-fail fixtures cover each rule, including one where the bad binding exists only under `env`, one where `KMS_BROKER` sets `remote`, and one app folder whose only config is `wrangler.toml`. The checker's self-test points it at those fixture trees. `check:boundaries` points it at the repo, which does not contain those fixtures. AGENTS.md §10 lists `kms-broker-binding` next to the other Stage 1 checkers in the same pull request.

The broker tunnel id is a Terraform output and is not in this repo. The checker does not compare tunnel ids.

### Residency

`packages/residency/src/catalog.json` adds `@community-hub/kms-aws` to `regionalOnlyPackages`. A `residency-cell` fixture with a global Worker importing that package fails. `apps/api` is regional and may import it later. It does not import it in this chunk.

## Data

No new tables or columns. No migration. Plaintext key bytes exist only in the Worker's isolate, as the `Uint8Array` the port returns, until `generateKmsRoot` or `unwrapKmsRoot` zeroes them. The service id in wrangler is the sentinel string, not a secret.

## Rules touched

- Residency: `@community-hub/kms-aws` is regional-only. A global Worker that imports it fails `residency-cell`.
- AGENTS.md §10: `kms-broker-binding` is a Stage 1 check with must-fail fixtures.
- Architecture §12.2: the client and the `KMS_BROKER` binding exist. `apps/api` does not call them. The live call is `api-au-hostname`.

No new entitlement, permission, event, or website key.

## Contracts

- `KmsPort.generateDataKey` and `KmsPort.decrypt`, implemented by `@community-hub/kms-aws`.
- Exported constants for `envelope`, `POST /v1/generate-data-key`, and `POST /v1/decrypt`, checked against `kms-port-v1.json`.
- Wrangler binding `KMS_BROKER` on `apps/api` only.

No new HTTP route on `apps/api`. No product event.

## Risks

| Risk                                                                                          | Mitigation                                                                                                                                                         |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A 200 with a bad blob is stored as the organisation's wrapped root and can never be unwrapped | The adapter rejects a non-JSON body, a missing `plaintext`, a missing or empty `blob`, and base64 that does not round-trip, all as `kms_failed`, before returning. |
| A fetch error or the broker body is attached as `cause` and leaks into logs                   | `new Error("kms_failed")` with `cause` left `undefined`. A test asserts that.                                                                                      |
| The Worker aborts before the broker's 502                                                     | Worker deadline 5000 ms, broker deadline 3000 ms.                                                                                                                  |
| `REPLACE_AFTER_APPLY` is deployed and mistaken for a real service                             | It is not a UUID. `api-au-hostname` makes the checker reject that sentinel once a real id is in the file.                                                          |
| `remote: true` lets `wrangler dev` unwrap real organisation keys from a laptop                | The `KMS_BROKER` entry has only `binding` and `service_id`. A must-fail fixture sets `remote`.                                                                     |
| A `vpc_networks` or `cf1:network` binding reaches every address behind a tunnel               | The checker rejects every `vpc_networks` entry, and any `cf1:network` string in the parsed config, at the top level and under `env.*`.                             |
| A Worker configured with `wrangler.toml` hides a network binding from the check               | Any `apps/*` folder that contains `wrangler.toml` fails.                                                                                                           |
| Another Worker holds `vpc_services`                                                           | The checker allows that array only on `apps/api`, and only the one `KMS_BROKER` entry.                                                                             |
| A global Worker imports the client                                                            | `regionalOnlyPackages` plus a must-fail `residency-cell` fixture.                                                                                                  |
| The contract test fights the broker tests for port 8080                                       | It calls `server.listen(0, "127.0.0.1")` and does not call `start()`.                                                                                              |

## Out-of-band

- **Same PR, architecture §12.2.** The client and the `KMS_BROKER` binding exist. `apps/api` does not call them. The live call is `api-au-hostname`.
- **Same PR, runbook.** Before that live call, a person pushes the broker image, sets `enable_kms_broker_tasks`, applies, replaces `REPLACE_AFTER_APPLY` with the Workers VPC service id, and deploys `apps/api`. This chunk does not do those steps.
- **Same PR, AGENTS.md §10.** `kms-broker-binding` is listed with the Stage 1 checkers.
- **`api-au-hostname`.** This is the first chunk that deploys `apps/api`. It replaces the sentinel with the real service id, deploys, and performs the unwrap. That is the running-preview check for this client. The same chunk tightens `kms-broker-binding` so `service_id` `REPLACE_AFTER_APPLY` fails, and the sentinel cannot return once a real id exists. `apps/api` has no `env` block in this chunk, so the checker counts one `KMS_BROKER` across the top level and every `env` object. Wrangler environments do not inherit bindings. When `api-au-hostname` adds `env.staging`, it declares `KMS_BROKER` on that object too, and it relaxes the rule to: one `KMS_BROKER` per object that declares `vpc_services`, and the top level must declare it. The pull request for this chunk says that preview check is deferred, and why.
- Legal: none. New subprocessor: none.
- Scaffold waits until this spec and its plan are both `approved`.

## Next spec

`api-au-hostname`, after this chunk. `kms-mrk-replica` stays behind it.

This chunk's last commit updates `docs/roadmap.md`: `kms-worker-adapter` **done**, next `api-au-hostname`, Phase 0 `12 / 14`. It does not insert rows.
