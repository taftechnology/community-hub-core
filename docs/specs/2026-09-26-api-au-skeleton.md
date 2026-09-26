# Spec: api-au skeleton

Slug: `api-au-skeleton`
Status: draft
Supersedes: —
Architecture refs: §7.3, §8.1, §8.3, §17; ADR 0001; AGENTS.md §1 (1, 7), §6, §8, §10
Branch: `feat/2026-09-26-api-au-skeleton`, created from `origin/main` after `audit-log` merged. Not stacked on another open PR.

## Problem

The AU cell has no regional Worker. Gateway serves `GET /health` as a global Worker with `preview_urls: true`. Architecture places the HTTP API on `api-au`, at `au.api.<zone>`, and ADR 0001 forbids a `workers.dev` preview for that class. `packages-residency` left two checks for this chunk: pass `region_key` from the AU tfvars into `cf-regional-hostname`, and cross-check the catalog's `cloudflareRegionalServices` against it. Until both exist, that gap has no retirement date.

The gateway's request wrapper cannot be copied. It accepts any UUID `x-request-id` and stores that same value as `idempotencyKey`. On a Worker that will publish and write audit rows, a caller could plant a correlation id, force two writes to share an outbox key, or retry into a second event.

## Scope

**In**

- `apps/api`. Directory and Wrangler `name` are `api`, matching §8.1 the way `apps/gateway` is named `gateway`. Architecture's name `api-au` is this cell's Worker, reached later at `au.api.<zone>`. Package `@community-hub/api`.
- `worker.meta.json` `"class": "regional"`. Wrangler: `workers_dev: false`, `preview_urls: false`, `compatibility_flags: ["nodejs_als"]`, `compatibility_date` the same value gateway already uses (`2026-03-10`).
- `GET /health` returns `healthPayload()` (`{ ok: true }`). No other route.
- Shared request handler on the kernel `.` entry. Gateway and `apps/api` both use it. The kernel does not import observability, and `.` does not import `./module`.
- `withChangeKey(aggregateId, version, fn)` is the only way to set `idempotencyKey`. `publish` still reads the key only from the request context.
- AU root variable `region_key`, no default, passed into `cf-regional-hostname`. `residency-cell` requires it in every enabled cell's `env/*.tfvars` and compares it to `cloudflareRegionalServices`.
- Stage 3: `wrangler deploy --dry-run` for `apps/api`, and a no-`zod` assertion on that bundle and on gateway's. `versions upload` and the preview comment stay gateway-only.
- Roadmap, last commit of the implementation branch: `api-au-skeleton` **done**, next `terraform-envelope-kms`, Phase 0 `9 / 10`.

**Out** (explicitly)

- Hono, and mounting any module. Architecture describes `api-au` as a Hono app. Deferring that is a scope choice: the first module mount brings Hono and replaces `healthRequest` with that app. This chunk does not add the dependency.
- Database, Hyperdrive, KMS, queues, cron, or any import of `@community-hub/db` or `@community-hub/crypto`.
- Setting `enable_regional_hostnames` to true, a Terraform apply, a DNS record, or a Worker route. `au.api.<zone>` is already declared in `infra/regions/au` behind that flag, and `cf-regional-hostname` does not create the DNS record. The later chunk is the apply plus the route, not a new hostname resource.
- A `workers.dev` preview or `wrangler versions upload` for `apps/api`.
- Scoping a client idempotency key to the caller. That is `identity-otp` (out-of-band).
- Product routes, audit writes, or outbox publishes from this Worker. `healthRequest` does not publish.

## Behaviour

### Workers

`apps/api` exports a Worker `fetch`. It calls `createRequestHandler` with `acceptInboundRequestId: false` and `healthRequest`.

Gateway's `fetch` calls the same function with `acceptInboundRequestId: true` and `healthRequest`. Gateway deletes its local copy of the request-id check, the log line, and the `/health` branch.

Neither Worker imports `@community-hub/kernel/module`.

### Request handler

Lives on `@community-hub/kernel` `.`, beside `withRequest` and `healthPayload`. Signature:

```ts
type RequestLogFields = {
  method: string;
  path: string;
  status: number;
  duration: number;
  requestId: string;
};

function createRequestHandler(
  options: {
    info: (fields: RequestLogFields) => void;
    acceptInboundRequestId?: boolean; // default false
  },
  handle: (request: Request) => Response | Promise<Response>,
): (request: Request) => Promise<Response>;
```

`info` accepts that object and nothing wider. Each Worker adapts its logger: `info: (fields) => logger.info("request", fields)`. The kernel does not import `@community-hub/observability`.

`path` is the URL pathname. `duration` is `Math.round` of elapsed milliseconds, as gateway does today.

`x-request-id`: when `acceptInboundRequestId` is true and the header is a UUID (`8-4-4-4-12` hex), that value is `requestId`. Otherwise, including when the flag is false, the header is missing, or it is not a UUID, `requestId` is `crypto.randomUUID()`. A rejected header value is not written into the log line.

`Idempotency-Key`, read with the Fetch `Headers` API so the name is case-insensitive: kept only when it matches `^[A-Za-z0-9._:-]{1,255}$`. That value is stored as `clientIdempotencyKey`. Any other value is ignored and not logged. The wrapper never copies `requestId` into `clientIdempotencyKey` or `idempotencyKey`, and it never sets `idempotencyKey`.

The handler runs inside `withRequest({ requestId, clientIdempotencyKey })`. `idempotencyKey` is not an argument of `withRequest`.

Exactly one `info` call, after `handle` settles. On success, `status` is the response status. When `handle` throws, the wrapper still writes one line with `status: 500` and returns `new Response(null, { status: 500 })`. The body and the log fields contain neither the error message nor the stack.

### Health handler

`healthRequest` is exported from `.` next to `healthPayload`. The wrapper does not know the path.

- `GET` and pathname `/health` → `Response.json(healthPayload())`, `{ ok: true }`.
- Anything else, including `POST /health` → status 404, empty body.

### Idempotency key

This amends `docs/specs/2026-09-19-kernel-runtime.md` (Request context):

- `RequestContext` is `requestId`, optional `clientIdempotencyKey`, and optional `idempotencyKey`.
- `withRequest` takes `requestId` and optional `clientIdempotencyKey` only. It does not take `idempotencyKey`. Callers cannot pass `newId()` or any other string as the outbox key.
- `/health` no longer sets `idempotencyKey` equal to `requestId`.
- `withChangeKey(aggregateId, version, fn)` is the only way to set `idempotencyKey`. It nests a context for `fn` and restores the outer context afterwards.
- `publish` still has no key argument. It reads `idempotencyKey` from the context. Outside `withRequest` it throws, as today. Inside `withRequest` but outside `withChangeKey` it throws because the key is absent. The error text includes neither the request id nor any header.

`withChangeKey` requires an active `withRequest`. Called outside one, it throws the same missing-context error `getRequestContext` throws. It does not invent a request id. It validates, then sets the key for `fn`:

- `aggregateId` is a string and must match a UUID (`8-4-4-4-12` hex). The key uses the lowercase form. Anything else throws. The error does not echo the rejected value.
- `version` is a string and must match `^(0|[1-9][0-9]*)$`. `0` is valid. `-1`, `1.5`, `01`, and any string containing `:` throw. The error does not echo the rejected value.
- When `clientIdempotencyKey` is set: `client:<key>:<aggregateId>:<version>`.
- Otherwise: `change:<aggregateId>:<version>`.

The client key may contain `:`. The tail is a lowercase UUID and an integer, so the string parses from the right and a client cannot mint a string equal to someone else's `change:` key. A retry of the same request and the same change reproduces the same key. Two changes in one request are two keys, because each call passes its own aggregate and version.

`publish` inside `fn` sees that key. `publish` after `fn` returns sees no key and throws. Two sibling `withChangeKey` calls in one request do not see each other's key. A nested call sets its own key for its own `fn` and then restores the outer key.

`healthRequest` does not call `withChangeKey`.

### Regional hostname variable

`infra/regions/au` gains `variable "region_key"` with no default and validation `region_key == "au"`. `env/staging.tfvars` and `env/prod.tfvars` both set `region_key = "au"`. `module.regional_hostname` passes `region_key = var.region_key`. The module's own `region_key == "au"` validation and its `"ee"` test stay.

The module is behind `count = var.enable_regional_hostnames ? 1 : 0`, and that flag stays `false`. Module validation does not run while the count is zero, so the root variable's validation is what `terraform validate` enforces. The existing AU cell test passes `region_key = "au"` with hostnames disabled, asserts both tfvars files set `region_key = "au"`, and a run with `region_key = "ee"` expects the variable validation to fail.

### Checker

`residency-cell`, for each enabled cell, reads every `infra/regions/<id>/env/*.tfvars`:

- The file must assign `region_key`. Omitting it is a violation, including if the root variable later grows a default.
- The assigned value must equal that cell's `cloudflareRegionalServices`.

Must-fail fixtures: tfvars omit `region_key`; tfvars set `region_key = "ee"` while the catalog says `"au"`. Disabled cells are not read, same as `awsRegion` today. The real tree passes: AU tfvars say `"au"`, and `apps/api` is a `regional` Worker.

`worker-config` on the real tree passes `apps/api`: class `regional`, `preview_urls` false, and `nodejs_als` because the Worker value-imports `@community-hub/kernel`.

### Preview exception

AGENTS.md §8 says a chunk's behaviour is verified against a running preview, not only tests. §10 says a regional Worker is verified on `staging-au` or a Regional Services hostname when that app exists. This chunk creates the app and does not create the hostname.

For this chunk only, the running-preview check is deferred. What stands in for it:

- `@cloudflare/vitest-pool-workers` tests for gateway and `apps/api`.
- `wrangler dev` against the built `apps/api` Worker, locally, when someone wants a process. Not a CI step.

The chunk that retires the exception is the one that sets `enable_regional_hostnames` true, applies, and attaches the `api` Worker route on `au.api.<zone>`. That chunk is not `terraform-envelope-kms`.

CI Stage 3 `build-preview` keeps `wrangler versions upload` and the preview comment for `apps/gateway` only. It gains `pnpm exec wrangler deploy --dry-run` in `apps/api`. Both dry-runs must succeed. The no-`zod` check is the one under Tests: `--outdir` into a temp directory, then the bundle files, not Wrangler's console log. Tree-shaking a combined kernel entry is not the mechanism: `.` does not import `./module`.

## Data

No new table and no new column. No personal data in the health response or the log line. The five log fields are method, path, status, duration, and requestId.

`region_key` is a Terraform variable, not a database column. Classification is not applicable. No migration.

## Rules touched

- **Amends `kernel-runtime`.** `RequestContext.idempotencyKey` is optional. `withRequest` no longer accepts it. `/health` no longer sets it equal to `requestId`. Optional `clientIdempotencyKey` is the validated header, kept separate from the request id. `withChangeKey` is how a publisher obtains `idempotencyKey`. `publish` still reads only the context and still takes no key argument.
- **AGENTS.md §8**, for this chunk only: the running-preview check is the exception written under Preview exception. The general rule is unchanged.
- **AGENTS.md §10 Stage 3:** `apps/api` is dry-run only. Preview upload stays on gateway because gateway is `global-no-pii`.
- Residency: the catalog's `cloudflareRegionalServices` for an enabled cell must match `region_key` in that cell's tfvars. No personal data leaves the regional class. This Worker holds none.
- Audit: a future `audit_events.request_id` is the minted `requestId`. `apps/api` does not accept an inbound `x-request-id`, so a caller cannot plant one. Gateway still accepts one, because it does not write audit rows.

## Contracts

No new HTTP route beyond `GET /health` on `apps/api`, the same payload gateway already returns. No new event, entitlement, or module manifest key.

Kernel `.` exports `createRequestHandler`, `healthRequest`, `withChangeKey`, and the existing `healthPayload`, `withRequest`, and `getRequestContext`. `withChangeKey` is not exported from `./module`.

`RequestContext` gains optional `clientIdempotencyKey`. `idempotencyKey` remains the outbox key and is present only inside `withChangeKey`.

## Risks

| Risk | What this chunk does |
| --- | --- |
| Inbound `x-request-id` planted in a future audit row | `acceptInboundRequestId` is false on `apps/api`. The wiring test sends a UUID and asserts the log line's `requestId` is a different UUID, and that the inbound value is absent. |
| Client key equals a derived key, or one client key covers two changes | Prefixed keys. The client key does not replace the change. `withChangeKey` validates the UUID and the integer. |
| `publish` called with `newId()` | `publish` has no key argument. `withRequest` does not accept `idempotencyKey`. |
| `zod` on a Worker bundle | `.` does not import `./module`. The dry-run `--outdir` bundle for each Worker is searched for `zod`. |
| Regional Worker previewed on `workers.dev` | `preview_urls: false`, `workers_dev: false`. No `versions upload` for `apps/api`. |
| `region_key` drifts from the catalog, or disappears behind a default | No default. Checker fails a missing assignment and an `"ee"` assignment. Root validation fails `"ee"` while hostnames are disabled. |
| Personal data in the log line | `info` takes five fields. Tests use tokens that must be absent from those fields. A thrown error's message is absent from the 500 body and the line. |

## Tests

**Kernel, against `createRequestHandler`**

- `info` is called once. Its keys are exactly `method`, `path`, `status`, `duration`, `requestId`. A query string, a header, and a body token appear in none of the values. `path` has no `?`.
- `duration` is a whole number of milliseconds.
- `acceptInboundRequestId: true` keeps a UUID `x-request-id` and puts that id on `getRequestContext().requestId`.
- A missing header, a non-UUID header, and `acceptInboundRequestId: false` each mint a UUID. The rejected header value is not in the log fields.
- A valid `Idempotency-Key` is `clientIdempotencyKey`. `idempotencyKey` is unset. `requestId` is not copied into either field.
- An invalid `Idempotency-Key` (space, or longer than 255) leaves `clientIdempotencyKey` unset and is absent from the log fields.
- `handle` throwing `Error` with a distinct message yields one line with `status` 500 and an empty 500 response. The message is in neither.

**Kernel, `healthRequest`**

- `GET /health` → 200 and `{ ok: true }`.
- `POST /health` → 404 and an empty body.

**Kernel, `withChangeKey` and `publish`**

- Inside the scope, `publish` stores `change:<lowercase-uuid>:<version>`. After the scope returns, `publish` throws, and the outer context has no `idempotencyKey`.
- Two sibling scopes in one request, two versions, produce two distinct keys. Neither scope sees the other's key.
- `clientIdempotencyKey` `00000000-0000-7000-8000-000000000001:3` with aggregate `00000000-0000-7000-8000-000000000002` and version `1` produces `client:00000000-0000-7000-8000-000000000001:3:00000000-0000-7000-8000-000000000002:1`, which is not equal to `change:00000000-0000-7000-8000-000000000002:1`.
- `aggregateId` `not-a-uuid` throws. Versions `-1`, `1.5`, and `01` each throw. Version `0` is accepted.
- `withChangeKey` outside `withRequest` throws the missing-context error.
- `withRequest` does not accept `idempotencyKey`. Existing tests that passed one move onto `withChangeKey`.

**Workers (one workerd test each)**

- Gateway: `GET /health` with a UUID `x-request-id` returns `{ ok: true }`, emits one line, and that line's `requestId` is the inbound UUID.
- `apps/api`: `GET /health` with a different UUID `x-request-id` returns `{ ok: true }`, emits one line, that line's `requestId` is a UUID other than the inbound value, and the inbound value is absent from the line.

**Boundaries, on the real tree**

- `worker-config` passes `apps/api`.
- `residency-cell` passes `apps/api` and the AU `region_key`.
- Must-fail fixtures: missing `region_key`; `region_key = "ee"` against catalog `"au"`.

**Terraform, offline**

- `terraform validate` and `terraform test` for the AU root and for `cf-regional-hostname`.
- Cell test: `region_key = "au"` with `enable_regional_hostnames = false` plans. Both tfvars files contain `region_key = "au"`. `region_key = "ee"` fails validation with hostnames still disabled.
- The module's existing `"ee"` test still fails.

**Bundles**

- In `apps/gateway` and in `apps/api`, `wrangler deploy --dry-run --outdir <temp>`. The command must succeed. Then fail if any file written under that directory contains the text `zod`. Wrangler's console log is not the artifact: it does not list module names. Delete the temp directory afterwards.

## Out-of-band

- **`identity-otp`:** scope a client idempotency key to the caller. Two users who send the same `Idempotency-Key` must not share an outbox slot. This chunk's prefix does not do that.
- **Regional hostname chunk:** set `enable_regional_hostnames` true, apply, attach the `api` route on `au.api.<zone>`, and verify the running Worker there. That retires this spec's preview exception. It is not `terraform-envelope-kms`.
- **First module mount:** add Hono and pass that app as `handle`. `createRequestHandler` stays.
- No new subprocessor. No ADR. ADR 0001 already requires `preview_urls: false` on `regional`.

## Next spec

`terraform-envelope-kms`, unless the human picks another remaining Phase 0 row. This chunk's last commit updates `docs/roadmap.md`: `api-au-skeleton` **done**, next `terraform-envelope-kms`, Phase 0 `9 / 10`.
