# Plan: KMS worker adapter

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A regional `KmsPort` that calls the in-cell broker, and a check that the only Workers VPC binding is `KMS_BROKER` on `apps/api`.

**Architecture:** `@community-hub/kms-aws` implements `KmsPort` with an injected `fetch`. It does not import the AWS SDK or the broker app. `apps/api` holds one `vpc_services` binding and does not call it. `kms-broker-binding` rejects every other network binding, including `remote`, `wrangler.toml`, and `cf1:network` anywhere in the parsed config.

**Tech Stack:** Node 24, pnpm 10.26.0, TypeScript, Vitest, Wrangler 4.134. No Terraform change.

**Spec:** `docs/specs/2026-10-01-kms-worker-adapter.md`

Status: draft

**Branch:** `feat/2026-10-01-kms-worker-adapter` · one PR · 5 tasks, one commit each

## Global Constraints

- Do not edit `@community-hub/crypto`. Implementing `KmsPort` is not a call the ESLint rule flags. If `@community-hub/no-kms-port-outside-crypto` flags this package, stop and report.
- No AWS SDK. No product route. `apps/api` does not import `@community-hub/kms-aws`.
- Production code in `@community-hub/kms-aws` does not import `@community-hub/kms-broker-app`. The app package is a devDependency of the contract test only.
- The request URL is `http://127.0.0.1:8080` plus the path. The client takes no port. Routing is the VPC service configuration. Do not document the URL as the thing that routes.
- `new Error("kms_failed")` only. Do not pass `cause`. Do not log the fetch error or the response body. Do not check that plaintext is 32 bytes. Do not zero the bytes the port returns.
- `service_id` stays `REPLACE_AFTER_APPLY`. Do not invent a UUID. Do not set `remote`.
- Do not apply Terraform, push an image, deploy `apps/api`, or call a live broker.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- The last commit updates `docs/roadmap.md`: `kms-worker-adapter` **done**, next `api-au-hostname`, Phase 0 `12 / 14`. Do not insert rows.
- Each task is a fresh implementer. The human reviews each commit before the next task starts. Implementer and reviewer cross Grok and Composer. A second fresh-context review of the final diff is required before merge. This chunk touches encryption and residency.
- The PR body says the running-preview check is deferred to `api-au-hostname`. That chunk replaces the sentinel, deploys `apps/api`, performs the unwrap, and makes `service_id` `REPLACE_AFTER_APPLY` fail this checker.

**Rollback:** Revert the PR. No migration, no Terraform, no image. The sentinel binding is unused until `api-au-hostname`.

---

### Task 1: Broker client

**Files:**

- Create: `packages/kms-aws/package.json`
- Create: `packages/kms-aws/tsconfig.json`
- Create: `packages/kms-aws/tsconfig.test.json`
- Create: `packages/kms-aws/vitest.config.ts`
- Create: `packages/kms-aws/eslint.config.js`
- Create: `packages/kms-aws/src/index.ts`
- Create: `packages/kms-aws/src/client.test.ts`
- Create: `packages/kms-aws/src/drift.test.ts`
- Modify: `tsconfig.json` (add `{ "path": "./packages/kms-aws" }` next to `kms-broker`)
- Modify: `pnpm-lock.yaml` (`pnpm install`)

**Interfaces:**

- Consumes: `KmsPort` and `KmsContext` from `@community-hub/crypto` (`import type` only). The drift test calls `readContract()` from `@community-hub/kms-broker`. The client does not.
- Produces:
  - `KMS_LOGICAL_KEY_ID = "envelope"`
  - `GENERATE_DATA_KEY_PATH = "/v1/generate-data-key"`
  - `DECRYPT_PATH = "/v1/decrypt"`
  - `createKmsBrokerClient(fetchImpl: KmsFetch, deadlineMs?: number): KmsPort`
  - `deadlineMs` defaults to `5000`.
  - `generateDataKey` returns `{ plaintext: Uint8Array; blob: Uint8Array }`.
  - `decrypt` takes `blob: Uint8Array` and returns `Uint8Array`.

The JSON fields `plaintext` and `blob` are base64 strings. After they round-trip, decode them to `Uint8Array`. That is the `KmsPort` shape. Encode and decode with `btoa` / `atob`.

`tsconfig.json` follows `packages/crypto`: `"lib": ["ES2022"]` and `"types": ["@cloudflare/workers-types"]`, and it excludes `src/**/*.test.ts`. `tsc --build` typechecks `src/` against Workers types only. A `Buffer` in `src/` fails that build. `apps/api` has `nodejs_als` and no `node:buffer`.

`tsconfig.test.json` typechecks the tests, including the contract test, with `"types": ["@cloudflare/workers-types", "node"]`. DevDependencies: `@cloudflare/workers-types` at the same range as `@community-hub/crypto`, and `@types/node`. `@community-hub/kms-broker` is a devDependency so the drift test can call `readContract()`. Production dependencies stay `@community-hub/crypto` only.

- [ ] **Step 1: Write the failing tests**

`drift.test.ts` imports `readContract` from `@community-hub/kms-broker` and asserts the three constants equal `logicalKeyId`, `routes.generateDataKey` (`method` `POST`, `path`), and `routes.decrypt`. It does not read the JSON file by a relative path. `src/index.ts` does not import `readContract`.

`client.test.ts` uses a fake `fetch`. Assert all of the following. Every thrown error has `message === "kms_failed"` and `cause === undefined`.

- generate and decrypt POST `http://127.0.0.1:8080` plus the path constant, `content-type: application/json`, the caller's `keyId`, and the caller's context. Decrypt's body `blob` is the base64 of the `Uint8Array` argument.
- A 200 whose body is not JSON.
- A 200 missing `plaintext` on each method.
- A 200 whose `plaintext` is not a string, and one whose base64 does not round-trip (decoding then encoding yields a different string).
- generate: missing `blob`, `blob` not a string, `blob` `""`, `blob` that does not round-trip.
- A hanging `fetch` that rejects only when `init.signal` aborts, with `deadlineMs` of `30`. The test finishes without waiting 5000 ms.
- A `fetch` that throws. The thrown value is not attached as `cause`.
- A 400 and a 502. The response body is not part of the message.
- A short plaintext (fewer than 32 bytes) that is valid base64 is returned, not thrown. Length stays the caller's check.

Org context: `{ key_kind: "org", org_id: "org-1", key_version: "v1" }`. Identity context: `{ key_kind: "identity", region: "au", key_version: "v1" }`.

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @community-hub/kms-aws test`

Expected: FAIL, package or exports missing.

- [ ] **Step 3: Implement**

Copy `packages/kms-broker`'s `package.json` scripts, `vitest.config.ts`, and `eslint.config.js`. Copy `packages/crypto`'s `tsconfig.json` for `src/`. Write `tsconfig.test.json` as above, with `node` added to `types`. Dependency: `@community-hub/crypto` workspace. DevDependencies include `@community-hub/kms-broker`, `@cloudflare/workers-types`, and `@types/node`. No AWS SDK. No broker app. The app package arrives in task 2.

`createKmsBrokerClient` builds `KmsPort`. Both methods `POST` JSON. Pass `{ signal: AbortSignal.timeout(deadlineMs) }` to `fetch`. On throw, non-2xx, non-object JSON, a missing or non-string `plaintext`, a `plaintext` that fails the base64 round-trip, or (generate only) a missing, empty, non-string, or non-round-tripping `blob`: `throw new Error("kms_failed")`. Return the decoded bytes. Do not read plaintext length. Do not zero. Do not log.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @community-hub/kms-aws test && pnpm --filter @community-hub/kms-aws typecheck && pnpm --filter @community-hub/kms-aws lint`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kms-aws tsconfig.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(kms): call the broker through an injected fetch

The port rejects a 2xx that is not a round-tripping key body, and every
failure is kms_failed with no cause, so a bad blob cannot be stored.

Refs: docs/plans/2026-10-01-kms-worker-adapter.md task 1
EOF
)"
```

**Must not break:** §1 rule 7 (no personal data in the error). No edit to `crypto`.

---

### Task 2: Contract test against the broker server

**Files:**

- Modify: `apps/kms-broker/package.json` (subpath export only)
- Modify: `packages/kms-aws/package.json` (devDependency and test script)
- Create: `packages/kms-aws/src/contract.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `createKmsBrokerClient` from task 1. `createServer` from `apps/kms-broker/src/server.ts` (`BrokerKms`, `envelopeKeyArn`).
- Produces: nothing later tasks import.

- [ ] **Step 1: Export the server for the test**

Add to `apps/kms-broker/package.json`. Do not add a package-root export.

```json
"exports": {
  "./server": {
    "types": "./dist/server.d.ts",
    "import": "./dist/server.js"
  }
}
```

Add `@community-hub/kms-broker-app` as a devDependency of `@community-hub/kms-aws`. Change that package's test script to:

```json
"test": "pnpm --filter @community-hub/kms-broker-app run build && pnpm run build && vitest run --config vitest.config.ts"
```

`src/` of `kms-aws` still has no import of the app. Only `contract.test.ts` imports `@community-hub/kms-broker-app/server`.

- [ ] **Step 2: Write the failing contract test**

Start the server with a fake `BrokerKms` that stores a 32-byte plaintext and a blob, keyed by the base64 of the blob, and returns that plaintext on decrypt when the context matches. Pass `envelopeKeyArn: "arn:aws:kms:ap-southeast-2:123456789012:key/broker-test-envelope"`.

```ts
const { server } = createServer({ kms, envelopeKeyArn });
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve());
});
```

Do not call `start()`. Do not bind port 8080. Close the server in `afterEach`.

The injected `fetch` parses the URL the client used and asserts `origin` is `http://127.0.0.1:8080`. It asserts the client sent `content-type: application/json`. It forwards `method`, that `content-type`, and the body to `http://127.0.0.1:<ephemeral port>`. The broker returns 400 when `content-type` is not `application/json`. Record `cache-control` from the upstream response.

Assert:

- generate then decrypt round-trips for the org context and the identity context. Plaintext bytes match. `keyId` is `"envelope"`.
- `generateDataKey("not-envelope", orgContext)` throws `kms_failed`, `cause === undefined`, and the recorded header is `no-store` (broker 400).
- A fake KMS that throws makes decrypt throw `kms_failed` with `cause === undefined`, and the recorded header is `no-store` (broker 502).

- [ ] **Step 3: Run the test**

Run: `pnpm --filter @community-hub/kms-aws test`

Expected: FAIL until the client and the export agree, then PASS. If it fails because port 8080 is in use, the test called `start()`. Fix the test. Do not add a turbo `dependsOn` between the two packages' test tasks.

- [ ] **Step 4: Commit**

```bash
git add apps/kms-broker/package.json packages/kms-aws pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
test(kms): round-trip the port against the broker server

The server listens on port 0. The test forwards method, content-type,
and body, and checks the path rather than routing.

Refs: docs/plans/2026-10-01-kms-worker-adapter.md task 2
EOF
)"
```

**Must not break:** broker tests still call `start()` on 8080. This test must not.

---

### Task 3: Binding check

**Files:**

- Create: `tooling/checks/kms-broker-binding/package.json`
- Create: `tooling/checks/kms-broker-binding/tsconfig.json`
- Create: `tooling/checks/kms-broker-binding/vitest.config.ts`
- Create: `tooling/checks/kms-broker-binding/check.ts`
- Create: `tooling/checks/kms-broker-binding/selftest.ts`
- Create: `tooling/checks/kms-broker-binding/fixtures/**` (listed below)
- Modify: `tooling/checks/run.ts`
- Modify: `AGENTS.md` §10 Stage 1 list
- Modify: `apps/api/wrangler.jsonc`
- Modify: `tsconfig.json` (add `{ "path": "./tooling/checks/kms-broker-binding" }`)
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Consumes: nothing from tasks 1–2.
- Produces: `check(root?: string): { ok: boolean; violations: { app: string; message: string }[] }`. `run.ts` calls `check()` with the repo root.

Copy `tooling/checks/worker-config`'s `package.json`, `tsconfig.json`, and `vitest.config.ts`. Package name `@community-hub/check-kms-broker-binding`. Copy `stripJsoncComments` into this checker. Do not export it from `worker-config`.

- [ ] **Step 1: Write the failing self-test**

`check(root)` walks immediate children of `root/apps`.

Fail that child when `wrangler.toml` exists, even if `wrangler.jsonc` or `wrangler.json` is also there.

Otherwise parse `wrangler.jsonc` (comments stripped) or `wrangler.json`. Ignore a child with neither file (`apps/kms-broker`).

On the parsed value, walk every string. If any equals `cf1:network`, fail. This includes `env` and fields other than `binding`, `type`, and `network_id`.

Also collect the top-level object and every object under `env`. On each:

- fail when `vpc_networks` is a non-empty array, or is present and not an array
- collect `vpc_services` entries

`apps/api` must have exactly one collected entry, counted across the top level and every `env` block. Its only keys are `binding` and `service_id`, `binding` is `KMS_BROKER`, and `service_id` is a non-empty string. Any other key, including `remote`, fails. Any other app with a collected entry fails.

`apps/api` has no `env` block today, so that count is the right rule. Do not relax it in this chunk. `api-au-hostname` already edits this checker to retire the sentinel. Wrangler environments do not inherit bindings, so when that chunk adds `env.staging` it declares `KMS_BROKER` again on that object. The spec's Out-of-band tells that chunk to relax this rule to: one `KMS_BROKER` per object that declares `vpc_services`, and the top level must declare it.

Must-fail fixtures, each otherwise a valid `apps/api` binding plus the one fault:

| Fixture                     | Fault                                                            |
| --------------------------- | ---------------------------------------------------------------- |
| `vpc-networks`              | `vpc_networks` with one object on `apps/gateway`                 |
| `cf1-network`               | `env.staging.vars.note` is the string `cf1:network`              |
| `env-only-vpc-services`     | `apps/gateway` has `vpc_services` only under `env.production`    |
| `remote-on-broker`          | the `KMS_BROKER` entry also has `"remote": true`                 |
| `wrangler-toml`             | `apps/other/wrangler.toml` exists; no JSON config in that folder |
| `missing-broker`            | `apps/api` has no `vpc_services`                                 |
| `extra-vpc-service`         | `apps/api` has two `vpc_services` entries                        |
| `other-worker-vpc-services` | `apps/gateway` has a top-level `vpc_services` entry              |

Must-pass fixture `valid`: `apps/api` has exactly `{ "binding": "KMS_BROKER", "service_id": "REPLACE_AFTER_APPLY" }`, `apps/gateway` has a JSON config and no vpc keys, and `apps/kms-broker` has no wrangler file.

Self-test shape matches `worker-config/selftest.ts`: each must-fail is `ok === false` with at least one violation; `valid` is `ok === true` and `violations` equals `[]`. Also `check(repoRoot)` on this repo, four directories up from the checker file. That assertion stays red until `apps/api/wrangler.jsonc` has the binding in this same commit.

- [ ] **Step 2: Run the self-test**

Run: `pnpm --filter @community-hub/check-kms-broker-binding test`

Expected: FAIL.

- [ ] **Step 3: Implement the checker, the binding, and the Stage 1 line**

`apps/api/wrangler.jsonc` gains:

```jsonc
"vpc_services": [
  { "binding": "KMS_BROKER", "service_id": "REPLACE_AFTER_APPLY" }
]
```

No other key. `apps/api` does not import the client.

`run.ts` imports `check` and, on failure, prints `${v.app}: ${v.message}` and sets `failed`. On success print `kms-broker-binding: ok`.

In AGENTS.md §10, add `kms-broker-binding` to the `check:boundaries` list, in the same sentence as `worker-config`.

- [ ] **Step 4: Run the check**

Run: `pnpm --filter @community-hub/check-kms-broker-binding test && pnpm check:boundaries`

Expected: PASS, including `kms-broker-binding: ok`.

- [ ] **Step 5: Commit**

```bash
git add tooling/checks/kms-broker-binding tooling/checks/run.ts apps/api/wrangler.jsonc AGENTS.md tsconfig.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(kms): allow only the api broker binding

remote, wrangler.toml, vpc_networks, and cf1:network fail the check, so
a laptop or another Worker cannot reach the cell broker.

Refs: docs/plans/2026-10-01-kms-worker-adapter.md task 3
EOF
)"
```

**Must not break:** §1 rule 9. `worker-config` still passes `apps/api` (`workers_dev` false, `preview_urls` false, class regional).

---

### Task 4: Regional-only package

**Files:**

- Modify: `packages/residency/src/catalog.json`
- Modify: `packages/residency/src/index.test.ts`
- Create: `tooling/checks/residency-cell/fixtures/import-kms-aws/**`
- Modify: `tooling/checks/residency-cell/selftest.ts`

**Interfaces:**

- Consumes: package name `@community-hub/kms-aws` from task 1.
- Produces: the catalog entry later chunks rely on. No code imports the fixture.

- [ ] **Step 1: Write the failing catalog assertion and fixture**

`index.test.ts` expects:

```ts
["@community-hub/db", "@community-hub/crypto", "@community-hub/kms-aws"];
```

Copy `tooling/checks/residency-cell/fixtures/import-crypto` to `fixtures/import-kms-aws`. In the copy:

- `apps/gateway/src/index.ts` imports `@community-hub/kms-aws`
- `packages/residency/src/catalog.json` `regionalOnlyPackages` is `["@community-hub/db", "@community-hub/crypto", "@community-hub/kms-aws"]`
- add `packages/kms-aws/package.json` with `{ "name": "@community-hub/kms-aws" }`

Add `"import-kms-aws"` to the `mustFail` array in `selftest.ts`. Add a dedicated test for that fixture, beside the `missing-catalog` test. It asserts `ok === false` and that some violation message is `global-no-pii Worker must not import regional-only package "@community-hub/kms-aws"`. The generic loop only checks that a violation exists. This assertion is what stops the fixture passing for some other fault. Do not edit the other fixtures' catalogs.

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @community-hub/residency test && pnpm --filter @community-hub/check-residency-cell test`

Expected: `@community-hub/residency` FAIL. The test expects the three-package list and `catalog.json` is still `["@community-hub/db", "@community-hub/crypto"]`. `@community-hub/check-residency-cell` PASS. `import-kms-aws` already fails because its own catalog lists `@community-hub/kms-aws`.

- [ ] **Step 3: Update the catalog**

Append `@community-hub/kms-aws` to `packages/residency/src/catalog.json`.

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @community-hub/residency test && pnpm --filter @community-hub/check-residency-cell test`

Expected: PASS. `import-kms-aws` still fails with the message that names `@community-hub/kms-aws`. Existing must-pass fixtures still pass.

- [ ] **Step 5: Commit**

```bash
git add packages/residency/src/catalog.json packages/residency/src/index.test.ts tooling/checks/residency-cell
git commit -m "$(cat <<'EOF'
feat(residency): keep the broker client in the cell

A global Worker that imports @community-hub/kms-aws fails residency-cell.

Refs: docs/plans/2026-10-01-kms-worker-adapter.md task 4
EOF
)"
```

**Must not break:** §1 rule 1. `apps/api` still does not import the package.

---

### Task 5: Docs and full CI

**Files:**

- Modify: `architecture.md` (§12.2, the paragraph that names `kms-worker-adapter`)
- Modify: `docs/runbooks/apply-staging-au.md` (broker tunnel section)
- Modify: `docs/roadmap.md` (snapshot, the `kms-worker-adapter` row, Next spec)
- Modify: `docs/specs/2026-10-01-kms-worker-adapter.md` and this plan only if the human has set `Status:` to `approved`. Do not flip `Status:` yourself.

**Interfaces:**

- Consumes: the behaviour from tasks 1–4. Changes no code contracts.
- Produces: the roadmap snapshot the next chunk reads.

- [ ] **Step 1: Replace the architecture paragraph**

The paragraph in §12.2 that ends with "That call is `kms-worker-adapter`." becomes:

The regional Worker does not call KMS and does not hold an AWS credential. `@community-hub/kms-aws` implements `KmsPort` by calling the in-cell broker. `apps/api` holds the `KMS_BROKER` binding and does not call it. The live unwrap is `api-au-hostname`. See ADR 0008.

- [ ] **Step 2: Update the runbook**

In `docs/runbooks/apply-staging-au.md`, replace the sentence that says the first live proof is a `fetch()` through the VPC service. The order a person follows, still without doing it in this chunk:

1. Push the broker image.
2. Set `enable_kms_broker_tasks`.
3. Apply.
4. Replace `REPLACE_AFTER_APPLY` in `apps/api` with the Workers VPC service id.
5. Deploy `apps/api`.

The unwrap itself is `api-au-hostname`, not a step this runbook performs. Keep the loopback-rejection stop: if that apply rejects the loopback service, stop and report.

- [ ] **Step 3: Update the roadmap**

Snapshot: last shipped `kms-worker-adapter`, next `api-au-hostname`, Phase 0 `12 / 14` done.

Row: `done`, and add the spec name `2026-10-01-kms-worker-adapter`. Do not insert rows.

Next spec: `api-au-hostname`.

- [ ] **Step 4: Full CI, in `.github/workflows/ci.yml` order**

```bash
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm typecheck
pnpm check:boundaries
pnpm audit --audit-level=high
pnpm test
```

`gitleaks` is the CI secret scan. Run it when the binary is installed. Do not install it only for this task if it is absent; say so in the report.

Terraform, for each dir in the `terraform` job matrix (`infra/bootstrap`, `infra/global`, `infra/regions/au`, and every module under `infra/modules/`): `terraform init -backend=false -lockfile=readonly`, `fmt -check`, `validate`, `tflint --init && tflint`, `terraform test`. No live plan. No credentials.

```bash
docker build -f apps/kms-broker/Dockerfile --label org.opencontainers.image.revision=local .
```

Do not push.

`pnpm --filter @community-hub/api exec wrangler deploy --dry-run` must accept `service_id` `REPLACE_AFTER_APPLY`.

- [ ] **Step 5: Commit**

```bash
git add architecture.md docs/runbooks/apply-staging-au.md docs/roadmap.md
git commit -m "$(cat <<'EOF'
docs(kms): record the worker adapter and point at the hostname

The client and the binding exist. The live unwrap, and retiring the
sentinel, wait for api-au-hostname.

Refs: docs/plans/2026-10-01-kms-worker-adapter.md task 5
EOF
)"
```

**Must not break:** the roadmap count. `main` is `11 / 14`. This commit is `12 / 14`. No new row.

---

## Self-review

- Spec coverage: client and drift via `readContract()` (task 1), contract test on port 0 forwarding method, content-type, and body (task 2), binding, `remote`, `wrangler.toml`, `cf1:network` deep scan, env blocks, AGENTS §10 (task 3), `regionalOnlyPackages` and a fixture whose violation names `@community-hub/kms-aws` (task 4), architecture, runbook, roadmap `12 / 14` (task 5). Live unwrap, sentinel rejection, and the per-object `KMS_BROKER` count stay in `api-au-hostname`.
- `src/` typechecks with Workers types. Tests add Node types. A `Buffer` in `src/` fails `tsc --build`.
- No new table, migration, entitlement, or product route.
- `KmsPort` blob is `Uint8Array` after the JSON string round-trips. Task 1 states that. Crypto is not edited.
