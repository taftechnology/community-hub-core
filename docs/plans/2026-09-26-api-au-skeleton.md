# Plan: api-au skeleton

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A regional `apps/api` Worker that serves `GET /health` through a shared kernel request handler, with change-scoped idempotency keys and an offline `region_key` check.

**Architecture:** `createRequestHandler` and `withChangeKey` live on `@community-hub/kernel` `.` and do not import `./module`. Gateway and `apps/api` both pass `healthRequest`. `publish` still reads `idempotencyKey` only from the nested change context. `region_key` is a required AU Terraform variable with no default; `residency-cell` compares every enabled cell's tfvars to `cloudflareRegionalServices`.

**Tech Stack:** TypeScript 5.8, Vitest 3, `@cloudflare/vitest-pool-workers`, Wrangler 4, Terraform 1.11.4.

**Spec:** `docs/specs/2026-09-26-api-au-skeleton.md` (approved 2026-09-26, Abdus Salam)

Status: approved (2026-09-26, Abdus Salam)

**Branch:** `feat/2026-09-26-api-au-skeleton` · one PR · 7 tasks, one commit each

## Global Constraints

- App directory `apps/api`, Wrangler `name` `api`, package `@community-hub/api`. `worker.meta.json` is `{ "class": "regional" }`. `workers_dev: false`, `preview_urls: false`, `compatibility_flags: ["nodejs_als"]`, `compatibility_date` `2026-03-10`.
- `acceptInboundRequestId` is true on gateway and false on `apps/api`. Default is false.
- The wrapper never copies `requestId` into `clientIdempotencyKey` or `idempotencyKey`.
- `Idempotency-Key` is kept only when it matches `^[A-Za-z0-9._:-]{1,255}$`. Anything else is ignored and not logged.
- `withRequest` takes `requestId` and optional `clientIdempotencyKey` only. It does not take `idempotencyKey`.
- `withChangeKey(aggregateId, version, fn)` is the only way to set `idempotencyKey`. `aggregateId` is a UUID (`8-4-4-4-12` hex), stored lowercase. `version` matches `^(0|[1-9][0-9]*)$`. Errors do not echo the rejected value.
- Key shape: `client:<key>:<aggregateId>:<version>` when a client key is present, otherwise `change:<aggregateId>:<version>`.
- `publish` has no key argument. Outside `withRequest` it throws `Request context is missing`. Inside `withRequest` but outside `withChangeKey` it throws `idempotencyKey is missing`. Check the key immediately after `getRequestContext()`, before the publishes check and Zod parse.
- `info` accepts only `{ method, path, status, duration, requestId }`. `path` is the pathname. `duration` is `Math.round` of elapsed milliseconds. One line after `handle` settles. A throw yields status 500, empty body, and no error message or stack in the body or the line.
- `healthRequest`: `GET /health` returns `{ ok: true }`. Anything else, including `POST /health`, is 404 with an empty body.
- `.` does not import `./module`. Neither Worker imports `@community-hub/kernel/module`. No Hono. No `@community-hub/db` or `@community-hub/crypto` import from `apps/api`.
- `region_key` on `infra/regions/au` has no default and validates `== "au"`. Do not add a default to make `terraform test` pass. File-level `variables { region_key = "au" }` in each AU root `*.tftest.hcl`. Only the `"ee"` run overrides it. `enable_regional_hostnames` stays false.
- No `wrangler versions upload` for `apps/api`. The no-`zod` check searches files under `--outdir`, not Wrangler's console log.
- Do not edit `docs/specs/2026-09-19-kernel-runtime.md`. The last commit updates `docs/roadmap.md`: `api-au-skeleton` done, next `terraform-envelope-kms`, Phase 0 `9 / 11`, new row `api-au-hostname` after `terraform-envelope-kms`. Session scratch is never committed.

**Stop and report** (do not work around):

- The workerd wiring test cannot see `console.log` from `SELF.fetch`. Do not add a second fetch export just to capture logs.
- `terraform test` fails for a missing `region_key` and the fix that comes to mind is a variable default. Do not add one.

---

## File map

| File                                                                                | Responsibility                                                  |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/kernel/src/request.ts`                                                    | Context, `withRequest`, `withChangeKey`                         |
| `packages/kernel/src/request-handler.ts`                                            | `createRequestHandler`, `healthRequest`                         |
| `packages/kernel/src/outbox-port.ts`                                                | `publish` throws when the key is absent                         |
| `packages/kernel/src/index.ts`                                                      | `.` exports. No `./module` import                               |
| `packages/db/test/outbox.integration.test.ts`                                       | Publishes go through `withChangeKey`                            |
| `packages/db/test/audit-events.integration.test.ts`                                 | Drop the unused `idempotencyKey` argument                       |
| `apps/gateway/src/index.ts`, `index.test.ts`                                        | Task 1 drops the request-id key; task 3 uses the shared handler |
| `apps/api/**`                                                                       | Regional Worker, `acceptInboundRequestId: false`                |
| `infra/regions/au/variables.tf`, `main.tf`, `env/*.tfvars`, `tests/cell.tftest.hcl` | Required `region_key`                                           |
| `tooling/checks/residency-cell/**`                                                  | Compare `region_key` to the catalog                             |
| `.github/workflows/ci.yml`                                                          | `apps/api` dry-run and both `--outdir` checks                   |
| `docs/roadmap.md`                                                                   | Last commit only                                                |

## Interfaces (locked)

```ts
export type RequestContext = {
  requestId: string;
  clientIdempotencyKey?: string;
  idempotencyKey?: string;
};

export function withRequest<T>(
  ctx: { requestId: string; clientIdempotencyKey?: string },
  fn: () => Promise<T>,
): Promise<T>;

export function withChangeKey<T>(
  aggregateId: string,
  version: string,
  fn: () => Promise<T>,
): Promise<T>;

export type RequestLogFields = {
  method: string;
  path: string;
  status: number;
  duration: number;
  requestId: string;
};

export function createRequestHandler(
  options: {
    info: (fields: RequestLogFields) => void;
    acceptInboundRequestId?: boolean;
  },
  handle: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response>;

export function healthRequest(request: Request): Response;
```

`withChangeKey` outside `withRequest` throws the same error as `getRequestContext()` (`Request context is missing`).

---

### Task 1: Change-scoped idempotency keys

**Files:** `packages/kernel/src/request.ts`, `request.test.ts`, `outbox-port.ts`, `outbox-port.test.ts`, `packages/db/test/outbox.integration.test.ts`, `packages/db/test/audit-events.integration.test.ts`, `apps/gateway/src/index.ts`, `apps/gateway/src/index.test.ts`.

**Interfaces:** Produces `withRequest`, `withChangeKey`, and `RequestContext` as locked above. `publish` reads `idempotencyKey` and throws `idempotencyKey is missing` when it is absent.

**Must not break:** `publish` still has no key argument. Do not edit the merged kernel-runtime spec. Audit append still reads `requestId` only. Gateway still serves `GET /health` through `createFetch`. Do not swap in `createRequestHandler` here. `outbox-adapter.test.ts` uses `idempotencyKey` as an append-row field and is not edited.

- [ ] **Step 1:** Rewrite `request.test.ts` so concurrent and nested `withRequest` calls pass only `requestId`. Add tests: `withChangeKey` outside `withRequest` throws `Request context is missing`; `aggregateId` `not-a-uuid` throws `aggregateId must be a UUID` and the message does not contain `not-a-uuid`; versions `-1`, `1.5`, and `01` throw `version must be a non-negative integer` and the message does not contain the bad version; version `0` is accepted; inside the scope `getRequestContext().idempotencyKey` is `change:<lowercase-uuid>:1` and after the scope it is `undefined`; two sibling scopes with versions `1` and `2` produce those two distinct keys and neither sees the other; a nested `withChangeKey` with version `2` sees `…:2` and, after it returns, the outer scope still sees `…:1`; a `clientIdempotencyKey` of `00000000-0000-7000-8000-000000000001:3` with aggregate `00000000-0000-7000-8000-000000000002` and version `1` yields `client:00000000-0000-7000-8000-000000000001:3:00000000-0000-7000-8000-000000000002:1`.

- [ ] **Step 2:** In `outbox-port.test.ts`, check the missing key before the publishes check. Update the three publish tests to enter `withChangeKey("00000000-0000-7000-8000-000000000002", "1", …)` so they still reach the publishes error, the Zod error, and a successful append. The successful append's stored key is `change:00000000-0000-7000-8000-000000000002:1`, not a caller-supplied string. Add: `publish` inside `withRequest` but outside `withChangeKey` rejects with `idempotencyKey is missing`; `publish` inside a scope stores the derived key; `publish` after that scope returns rejects with `idempotencyKey is missing`.

- [ ] **Step 3:** Run `pnpm test --filter @community-hub/kernel`. Expected: FAIL (tests call `withChangeKey` or the new errors, and `withRequest` still requires `idempotencyKey`).

- [ ] **Step 4:** Implement `request.ts` and the key check in `outbox-port.ts`.

```ts
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^(0|[1-9][0-9]*)$/;

export function withChangeKey<T>(
  aggregateId: string,
  version: string,
  fn: () => Promise<T>,
): Promise<T> {
  const outer = getRequestContext();
  if (!UUID.test(aggregateId)) {
    throw new Error("aggregateId must be a UUID");
  }
  if (!VERSION.test(version)) {
    throw new Error("version must be a non-negative integer");
  }
  const id = aggregateId.toLowerCase();
  const idempotencyKey = outer.clientIdempotencyKey
    ? `client:${outer.clientIdempotencyKey}:${id}:${version}`
    : `change:${id}:${version}`;
  return storage.run(
    {
      requestId: outer.requestId,
      clientIdempotencyKey: outer.clientIdempotencyKey,
      idempotencyKey,
    },
    fn,
  );
}
```

`withRequest` stores `requestId` and, only when provided, `clientIdempotencyKey`. It does not set `idempotencyKey`. In `publish`, immediately after `getRequestContext()`:

```ts
if (ctx.idempotencyKey === undefined) {
  throw new Error("idempotencyKey is missing");
}
```

- [ ] **Step 5:** Update callers so the tree typechecks. In `audit-events.integration.test.ts`, delete every `idempotencyKey` property passed to `withRequest`. Leave `requestId` as it is, including `"not-a-uuid"`. In `outbox.integration.test.ts`, import `withChangeKey` from `@community-hub/kernel`. Drop `idempotencyKey` from `withRequest`. Wrap each `publish` in `withChangeKey` using a UUID from `newId()` and version `"1"` when the test wants one shared key (the retry test, the two-event test). Do not pass a free-form string as the outbox key. In `apps/gateway/src/index.ts`, change the call to `withRequest({ requestId }, …)` and delete the `if` that throws `idempotencyKey must equal requestId`. Delete the test `"GET /health logs requestId from ALS and keeps idempotencyKey equal"` in `apps/gateway/src/index.test.ts`. Leave `createFetch` and the other gateway tests in place.

- [ ] **Step 6:** These pass: `pnpm test --filter @community-hub/kernel`, `pnpm test --filter @community-hub/gateway`, `pnpm exec tsc --build --pretty false -p packages/db`, `pnpm exec tsc --build --pretty false -p apps/gateway`. The db integration suite needs Docker; run `pnpm test --filter @community-hub/db` once before the commit.

- [ ] **Step 7:** Commit

```
feat(kernel): scope idempotency keys to one change

publish reads a nested withChangeKey context. Gateway drops the
request-id key so this commit still typechecks and serves /health.

Refs: docs/plans/2026-09-26-api-au-skeleton.md task 1
```

### Task 2: Shared request handler

**Files:** `packages/kernel/src/request-handler.ts`, `request-handler.test.ts`, `index.ts`.

**Interfaces:** Consumes `withRequest` and `getRequestContext`. Produces `createRequestHandler` and `healthRequest` as locked above. Export both from `index.ts` only.

**Must not break:** `index.ts` does not import `./module.js`. `healthRequest` does not call `withChangeKey`.

- [ ] **Step 1:** Failing tests in `request-handler.test.ts` (node Vitest, not workerd):
  - `info` is called once. `Object.keys(fields).sort()` equals `["duration", "method", "path", "requestId", "status"]`. Query token `query-leak-token`, header token `header-leak-token`, and body token `body-leak-token` appear in none of the values. `path` is `/health` with no `?`. `duration` is an integer. `POST /health` is status 404.
  - `acceptInboundRequestId: true` and header `11111111-1111-4111-8111-111111111111`: the handler's `getRequestContext().requestId` equals that UUID, and `idempotencyKey` is `undefined`.
  - Missing header, header `not-a-uuid`, and `acceptInboundRequestId: false` with a UUID header: `requestId` matches the UUID regex, is not the inbound value, and the inbound value is absent from the fields.
  - Header `Idempotency-Key: abc.DEF_123` sets `clientIdempotencyKey` to that string and leaves `idempotencyKey` unset. A value containing a space, and a value of 256 `a`s, leave `clientIdempotencyKey` unset and are absent from the fields.
  - `handle` throws `new Error("secret-stack-token")`: one line with `status` 500, response status 500, empty body, and `secret-stack-token` in neither the body nor the fields.
  - `healthRequest` of `GET /health` returns 200 and `{ ok: true }`. `POST /health` returns 404 and `""`.

- [ ] **Step 2:** `pnpm test --filter @community-hub/kernel`. Expected: FAIL (module missing).

- [ ] **Step 3:** Implement. Header name via `request.headers.get("idempotency-key")`. UUID test is the same `UUID` regex as `withChangeKey`, case-insensitive; store the inbound UUID as received when accepted. Mint with `crypto.randomUUID()`. `path` is `new URL(request.url).pathname`. Time with `performance.now()` and `Math.round`. `try/catch` around `await handle(request)`. On throw, `new Response(null, { status: 500 })`. Call `info` once in `finally`. Do not put the error object into `info`.

```ts
export function healthRequest(request: Request): Response {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json(healthPayload());
  }
  return new Response(null, { status: 404 });
}
```

Export `createRequestHandler`, `healthRequest`, and `RequestLogFields` from `index.ts`. Do not export them from `module.ts`.

- [ ] **Step 4:** Kernel tests pass.

- [ ] **Step 5:** Commit

```
feat(kernel): share the worker request handler

One function mints or accepts the request id, keeps a valid
Idempotency-Key apart from it, and writes a single log line.

Refs: docs/plans/2026-09-26-api-au-skeleton.md task 2
```

### Task 3: Gateway uses the shared handler

**Files:** `apps/gateway/src/index.ts`, `apps/gateway/src/index.test.ts`.

**Interfaces:** Consumes `createRequestHandler` and `healthRequest` from `@community-hub/kernel`, `createLogger` from `@community-hub/observability`.

**Must not break:** Gateway does not import `@community-hub/kernel/module`. `preview_urls` stays true. Task 1 already removed the `idempotencyKey` argument and the mismatch throw. This task replaces `createFetch` with `createRequestHandler`. Do not reintroduce `createFetch`.

- [ ] **Step 1:** Replace `index.test.ts` with one test. `vi.spyOn(console, "log")` during `SELF.fetch("https://gateway.test/health", { headers: { "x-request-id": "11111111-1111-4111-8111-111111111111" } })`. Expect status 200, body `{ ok: true }`, one log line, and `requestId` equal to that UUID.

- [ ] **Step 2:** `pnpm test --filter @community-hub/gateway`. Expected: FAIL until `index.ts` uses the shared handler and the spy sees the line. If the spy never sees a line because the workers pool isolates `console`, stop and report. Do not reintroduce `createFetch`.

- [ ] **Step 3:** Replace `index.ts`:

```ts
import { createRequestHandler, healthRequest } from "@community-hub/kernel";
import { createLogger } from "@community-hub/observability";

const logger = createLogger();

export default {
  fetch: createRequestHandler(
    {
      info: (fields) => logger.info("request", fields),
      acceptInboundRequestId: true,
    },
    healthRequest,
  ),
};
```

- [ ] **Step 4:** Gateway test passes.

- [ ] **Step 5:** Commit

```
refactor(gateway): log requests through the kernel handler

Gateway fetch is createRequestHandler with acceptInboundRequestId
true, so an inbound UUID stays the logged request id.

Refs: docs/plans/2026-09-26-api-au-skeleton.md task 3
```

### Task 4: Regional apps/api Worker

**Files:** `apps/api/package.json`, `tsconfig.json`, `wrangler.jsonc`, `worker.meta.json`, `vitest.config.ts`, `src/index.ts`, `src/index.test.ts`. Modify `tsconfig.json` (repo root) to add `{ "path": "./apps/api" }`. Modify `eslint.config.js` to ban `@community-hub/kernel/module` on `**/apps/api/**/*.{js,ts}` with the same message shape gateway uses. Do not ban `@community-hub/db` on `apps/api`.

**Interfaces:** Consumes `createRequestHandler` and `healthRequest`. `acceptInboundRequestId` is false.

**Must not break:** No Hono. No db or crypto import. `preview_urls` false. `workers_dev` false.

- [ ] **Step 1:** Copy gateway's package shape. Name `@community-hub/api`. Same devDependencies (`@cloudflare/vitest-pool-workers`, workers types, typescript, vitest, wrangler) and dependencies (`@community-hub/kernel`, `@community-hub/observability`). `wrangler.jsonc` matches gateway except `"name": "api"` and `"preview_urls": false`. `worker.meta.json` is `{ "class": "regional" }`. `vitest.config.ts` and `tsconfig.json` match gateway's, including the kernel and observability project references.

- [ ] **Step 2:** `src/index.ts` is the gateway file with `acceptInboundRequestId: false`.

- [ ] **Step 3:** One workerd test. Inbound `x-request-id` is `22222222-2222-4222-8222-222222222222`. `SELF.fetch("https://api.test/health", { headers })`. Status 200, body `{ ok: true }`, one `console.log` line, `requestId` matches the UUID regex, `requestId` is not the inbound value, and the line does not contain the inbound value. Same stop rule as task 3 if the spy cannot see the line.

- [ ] **Step 4:** `pnpm test --filter @community-hub/api` and `pnpm --filter @community-hub/api... build` pass. `pnpm check:boundaries` passes (`worker-config` accepts the new app).

- [ ] **Step 5:** Commit

```
feat(api): add the regional health worker

apps/api is class regional with preview URLs off, and it mints
every request id instead of trusting the caller.

Refs: docs/plans/2026-09-26-api-au-skeleton.md task 4
```

### Task 5: AU region_key variable

**Files:** `infra/regions/au/variables.tf`, `main.tf`, `env/staging.tfvars`, `env/prod.tfvars`, `tests/cell.tftest.hcl`.

**Interfaces:** Consumes nothing from the TypeScript tasks. Produces `var.region_key` passed into `module.regional_hostname`.

**Must not break:** `enable_regional_hostnames` stays false. No default on `region_key`. The module's own `"ee"` test stays.

- [ ] **Step 1:** Add the variable with no default:

```hcl
variable "region_key" {
  type        = string
  description = "Cloudflare Regional Services region_key for au.api.<zone>. No default."

  validation {
    condition     = var.region_key == "au"
    error_message = "region_key must be au."
  }
}
```

Pass `region_key = var.region_key` on `module "regional_hostname"`. Add `region_key = "au"` to both tfvars files.

- [ ] **Step 2:** At the top of `tests/cell.tftest.hcl`, after the `mock_provider` blocks and before the first `run`:

```hcl
variables {
  region_key = "au"
}
```

Do not repeat `region_key` inside the existing run blocks. They inherit `"au"`. Add a run that copies `staging_happy`'s variables, sets `region_key = "ee"` and `enable_regional_hostnames = false`, and uses `expect_failures = [var.region_key]`. In `staging_happy` and `prod_tfvars`, assert the tfvars files with `can(regex(…))` so a no-match is a false condition. Paths are relative to the root module:

```hcl
assert {
  condition     = can(regex("(?m)^\\s*region_key\\s*=\\s*\"au\"", file("env/staging.tfvars")))
  error_message = "env/staging.tfvars must set region_key = \"au\""
}
```

`prod_tfvars` uses `file("env/prod.tfvars")` the same way.

- [ ] **Step 3:** Terraform 1.11.4 (locally `~/bin/terraform`). Run it. From `infra/regions/au`: `terraform init -backend=false -lockfile=readonly`, `terraform fmt -check`, `terraform validate`, `terraform test`. From `infra/modules/cf-regional-hostname`: `terraform test`. Expected: all pass. The new `"ee"` run fails the variable, which `expect_failures` treats as success.

- [ ] **Step 4:** Commit

```
feat(infra): require the AU region_key in tfvars

The cell root has no default, so a Terraform test must pass au
and an ee override still fails while hostnames stay disabled.

Refs: docs/plans/2026-09-26-api-au-skeleton.md task 5
```

### Task 6: Checker compares region_key to the catalog

**Files:** `tooling/checks/residency-cell/check.ts`, `selftest.ts`, new fixtures `fixtures/missing-region-key/` and `fixtures/region-key-ee/`. Add `region_key = "au"` to every existing fixture `infra/regions/au/env/*.tfvars` except those two new ones.

**Interfaces:** Consumes the real AU tfvars from task 5. Produces violations when an enabled cell's tfvars omit `region_key` or set a value other than `cloudflareRegionalServices`.

**Must not break:** Disabled cells are not read. `aws_region` checks stay. The live repository passes only after task 5's tfvars exist; do not start this task before that commit.

- [ ] **Step 1:** Copy `fixtures/valid-au` to `fixtures/missing-region-key` and to `fixtures/region-key-ee`. Leave `region_key` absent in the first. Set `region_key = "ee"` in both env files of the second. Add both names to `mustFail`. Add `region_key = "au"` to every other fixture's `infra/regions/au/env/*.tfvars`.

- [ ] **Step 2:** `pnpm test --filter @community-hub/check-residency-cell` (use the package name in `tooling/checks/residency-cell/package.json` if it differs). Expected: FAIL, because `missing-region-key` and `region-key-ee` still pass, or the must-pass fixtures now fail once the check exists. Write the failing expectation first if the check is not in yet: the two new fixtures are in `mustFail` before `check.ts` looks at `region_key`, so they pass and the selftest fails.

- [ ] **Step 3:** In `validateEnabledCell`, after the `aws_region` scan, for each `env/*.tfvars` file read `assignmentValue(hcl, "region_key")`. Zero assignments: violation `enabled cell "<id>" env/*.tfvars must set region_key`, file is that tfvars path. A value other than `cell.cloudflareRegionalServices`: violation `region_key "<value>" does not match catalog cloudflareRegionalServices "<expected>" for enabled cell "<id>"`. Pass `cloudflareRegionalServices` in from the caller that already has the cell record. Do not read disabled cells.

- [ ] **Step 4:** Fixture selftest passes, and `check(repoRoot)` passes. `pnpm check:boundaries` passes.

- [ ] **Step 5:** Commit

```
feat(tooling): check region_key against the residency catalog

An enabled cell must set region_key in every tfvars file, and the
value must match cloudflareRegionalServices.

Refs: docs/plans/2026-09-26-api-au-skeleton.md task 6
```

### Task 7: Dry-run bundles, roadmap, full gate

**Files:** `.github/workflows/ci.yml`, `docs/roadmap.md`.

**Interfaces:** Consumes `apps/api` and the AU tfvars. Produces the Stage 3 dry-run and the roadmap row.

**Must not break:** Gateway `versions upload` and the preview comment stay. No upload step for `apps/api`. Do not edit `AGENTS.md` §8. The preview exception stays in the spec.

- [ ] **Step 1:** In `build-preview`, build both packages:

```yaml
- name: Build workspace packages
  run: pnpm --filter @community-hub/gateway... --filter @community-hub/api... build
```

Replace the gateway dry-run step and add an api step. Each step sets `working-directory` and runs the same script:

```yaml
- name: Wrangler deploy dry-run (gateway)
  working-directory: apps/gateway
  run: |
    dir=$(mktemp -d)
    pnpm exec wrangler deploy --dry-run --outdir "$dir"
    if grep -R -q "zod" "$dir"; then
      echo "bundle contains zod"
      exit 1
    fi
    rm -rf "$dir"

- name: Wrangler deploy dry-run (api)
  working-directory: apps/api
  run: |
    dir=$(mktemp -d)
    pnpm exec wrangler deploy --dry-run --outdir "$dir"
    if grep -R -q "zod" "$dir"; then
      echo "bundle contains zod"
      exit 1
    fi
    rm -rf "$dir"
```

Leave `versions upload` and the preview comment in `apps/gateway` only.

- [ ] **Step 2:** Update `docs/roadmap.md` snapshot: last shipped `api-au-skeleton`, next chunk `terraform-envelope-kms`, Phase 0 `9 / 11 done`. Row `api-au-skeleton` → **done**, text `Regional Worker, class regional, preview_urls false, health through kernel.`, spec `2026-09-26-api-au-skeleton`. Insert after `terraform-envelope-kms`:

```markdown
| not started | `api-au-hostname` | Set enable_regional_hostnames, apply, attach the api route on au.api.<zone>, and verify the running Worker. Retires the api-au-skeleton preview exception. After terraform-envelope-kms. |
```

Next-spec paragraph names `terraform-envelope-kms` and says `api-au-hostname` is catalogued after it.

- [ ] **Step 3:** Full gate, in CI order, uncached:

```bash
pnpm exec prettier --check .
pnpm lint --force
pnpm typecheck --force
pnpm check:boundaries
pnpm test --force
```

Terraform 1.11.4 (locally `~/bin/terraform`). From `infra/regions/au` and from `infra/modules/cf-regional-hostname`: `terraform init -backend=false -lockfile=readonly`, `terraform fmt -check`, `terraform validate`, `terraform test`.

From `apps/gateway` and from `apps/api`, the `--outdir` dry-run script above. Both must succeed and neither temp directory may contain `zod`.

- [ ] **Step 4:** Commit, last on the branch

```
docs: record api-au-skeleton as done

The regional Worker is on the roadmap as done, and api-au-hostname
is the later row that verifies it on a running hostname.

Refs: docs/plans/2026-09-26-api-au-skeleton.md task 7
```

---

## Spec coverage

| Spec item                                                                      | Task      |
| ------------------------------------------------------------------------------ | --------- |
| `withChangeKey`, prefixed keys, validation, publish throws with no key         | 1         |
| Existing `withRequest({ idempotencyKey })` callers, including gateway          | 1         |
| `createRequestHandler`, `healthRequest`, log line, bare 500, POST /health      | 2         |
| Gateway accepts inbound UUID; no `./module` on `.`                             | 2, 3      |
| `apps/api` mints request ids; regional Wrangler flags; `nodejs_als`            | 4         |
| `region_key` no default, tfvars, file-level test variable, `"ee"` run          | 5         |
| Checker missing and `"ee"` fixtures; live `worker-config` and `residency-cell` | 4, 6      |
| `--outdir` no-`zod` check; gateway upload unchanged                            | 7         |
| Roadmap `9 / 11` and `api-au-hostname`                                         | 7         |
| Merged kernel-runtime spec left untouched                                      | all tasks |
