# Regional service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `apps/api` into one Node process that answers `GET /health`, reshape the KMS adapter onto `KmsPort`, and ship an ARM image whose probe fails closed when the environment is missing.

**Architecture:** Nine commits. The logger learns the new fields, then the kernel logs a caller-supplied path. The gate in `apps/api` refuses before the kernel runs and before any body byte is read. The adapter becomes a `KmsPort` with a 3000 ms deadline. The server validates the environment and listens without calling a database factory or KMS. The probe is a second entrypoint. The image and CI build it for `linux/arm64` and do not push it. The last commit updates the roadmap.

**Tech Stack:** TypeScript, Node 24, Vitest, `node:http`, `@aws-sdk/client-kms`, `@community-hub/crypto` `KmsPort`, `@community-hub/db` `createDirectSql`, Docker. No new AWS resource. No Terraform edit.

Spec: docs/specs/2026-10-05-regional-service.md

Status: approved (2026-10-05, Abdus Salam)

**Branch:** `feat/2026-10-05-regional-service` · one PR · 9 tasks, one commit each

## Global Constraints

- The spec is approved. Do not edit `docs/specs/2026-10-05-regional-service.md`, `docs/specs/2026-10-03-personal-data-on-aws.md`, `docs/specs/2026-10-04-ingress.md`, `docs/specs/2026-10-04-db-tls.md`, ADR 0009, or `infra/`. `service_image` stays null.
- `keepAliveTimeout` is 65000. `requestTimeout` and `headersTimeout` are 30000. `headersTimeout` equals `requestTimeout`, as Node requires. The production entrypoint does not pass other values. 5000 is Node's default and is not the value. The first staging apply's steady-traffic 5xx count confirms these values or changes them.
- On SIGTERM the process may accept for up to 5000 ms, then stops accepting. At 25000 ms after SIGTERM every socket that is still open is destroyed. The process exits 0 before the 30000 ms stop timeout.
- Listen and `GET /health` call no `createDirectSql`, `createAppSql`, `createIdentitySql`, `createPlatformSql`, and no KMS `send`. There is no pooled checkout.
- The probe is `node /app/probe.js`. Stdout is the line `pass` or `fail`. Stderr on failure is one of `env`, `db_app`, `db_identity`, `db_platform`, `kms_generate`, `kms_decrypt`. Each line is the word plus one newline. Exit 0 or 1. Nothing else is printed.
- KMS failures throw `Error` whose `message` is exactly `kms_failed` and whose `cause` is `undefined`. The deadline default is 3000 ms. `maxAttempts` is 1. The client region is `ap-southeast-2`.
- The certificate SHA-256 is `d73890748b5a95551800df8a6f07c9c800e32ed34da7e6c9505918bf8ac2398b`. The image base is `node:24-slim@sha256:24b8bc17702002d2ed0c1da9ad66c3ee507cc279d0856726662ff2b6fc35c149`, the linux/arm64 manifest resolved from registry-1.docker.io on 2026-10-05. A tag-only `FROM` fails review.
- No migration wave. There is no expand, migrate, or contract step.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- This plan is past the ~800 changed-line guide. Nine tasks, about 2,400 changed lines. The reason: the gate, the adapter, the probe, and the image describe one process. An image that booted the current fetch handler would answer `GET /health` with no peer check and no hostname check. The probe's `env` failure is the CI proof that the image contains the command, and it is meaningless against a different layout. Do not split this plan. The PR body repeats this paragraph.
- Implement every task in order. Do not stop for review between tasks. Commit each task as this plan specifies, then report when the plan is complete. This chunk touches encryption and residency. A second fresh-context review reads the final diff and has not seen the implementation. Leave that line open in the PR. Do not pin a model name. Do not write the second review yourself.
- AGENTS.md §8's staging-hostname check does not apply. Nothing is deployed. `service_image` stays null and the image is not pushed. Say that in the PR body.
- Traceability stays red until this plan is approved and the PR body links the spec and the plan. Do not weaken the check. Do not mark this plan approved yourself.
- Every task runs this gate before its commit, with the filter named in that task: `pnpm lint && pnpm typecheck && pnpm test --filter <filter> && pnpm check:boundaries`. Task 9 runs the full CI sequence below, not only this gate.
- No password, live hostname, or real account id in tests or logs. An ARN account id in a test is `123456789012`.

**Rollback:** Revert the PR. There is no migration and no Terraform change. No image was pushed and no task was applied. Staging is unchanged.

## File map

| File                                           | Responsibility                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/observability/src/logger.ts`         | Allow-list and value checks for the six new fields                             |
| `packages/kernel/src/request-handler.ts`       | `pathFor`, `gatewayRequestId`, `acceptInboundRequestId` stays false by default |
| `apps/api/src/gate.ts`                         | Route table, hostname decision, refusal log. Does not read a body              |
| `apps/api/src/kms/aws-kms-adapter.ts`          | `KmsPort` implementation                                                       |
| `apps/api/src/env.ts`                          | Environment, ARN, and certificate digest                                       |
| `apps/api/src/server.ts`                       | Listen, keep-alive, SIGTERM                                                    |
| `apps/api/src/probe.ts`                        | The only `KmsPort` caller outside `packages/crypto/src`                        |
| `apps/api/certs/rds-ap-southeast-2-bundle.pem` | The pinned bundle                                                              |
| `apps/api/Dockerfile`                          | ARM image, user `node`, `/tmp`, health check, entrypoint                       |
| `.github/workflows/ci.yml`                     | Build the image, do not push, run the probe with no environment                |

---

### Task 1: Logger allow-list and value checks

About 180 changed lines.

**Files:**

- Modify: `packages/observability/src/logger.ts`
- Modify: `packages/observability/src/logger.test.ts`
- Modify: `packages/observability/src/logger.types.test.ts`

**Interfaces:**

- Consumes: the existing `createLogger` and `getDroppedFieldCount`.
- Produces: `LogFields` with optional `gatewayRequestId`, `reason`, `hostname`, `operation`, `key_kind`, and `outcome`. A failing value is omitted and counted. The line is still written.

**Rule this must not break:** `name` and `email` are still dropped. A wide `Record<string, unknown>` is still a type error. Existing `method`, `path`, `status`, `duration`, and `requestId` keep their current checks.

- [ ] **Step 1: Write the failing test**

Add this test to `packages/observability/src/logger.test.ts`:

```ts
it("keeps a valid new field and drops a failing value", () => {
  const lines: string[] = [];
  const logger = createLogger({ write: (line) => lines.push(line) });
  logger.info("request", {
    gatewayRequestId: "abc/+=_-",
    reason: "missing_hostname_header",
    hostname: "au.api.example.test",
    operation: "decrypt",
    key_kind: "identity",
    outcome: "rejected",
  });
  logger.info("request", {
    gatewayRequestId: "has space",
    reason: "nope" as "missing_hostname_header",
    hostname: "NOT-LOWER",
    operation: "sign" as "decrypt",
    key_kind: "root" as "org",
    outcome: "maybe" as "ok",
  });
  const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  expect(first.gatewayRequestId).toBe("abc/+=_-");
  expect(first.reason).toBe("missing_hostname_header");
  expect(first.hostname).toBe("au.api.example.test");
  expect(first.operation).toBe("decrypt");
  expect(first.key_kind).toBe("identity");
  expect(first.outcome).toBe("rejected");
  const second = lines[1] ?? "";
  expect(second).not.toContain("has space");
  expect(second).not.toContain("NOT-LOWER");
  expect(second).not.toContain("nope");
  expect(logger.getDroppedFieldCount()).toBe(6);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test --filter @community-hub/observability`

Expected: FAIL because the new keys are dropped as unknown fields.

- [ ] **Step 3: Write the minimal implementation**

Extend `LogFields` with the six optional keys. In `sanitizeFields`, accept a value only when it matches:

| Field              | Check                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `gatewayRequestId` | `/^[A-Za-z0-9+/=_-]{1,128}$/`                                                                               |
| `reason`           | `missing_hostname_header`, `unknown_hostname`, `ops_route_on_other_hostname`, `other_route_on_ops_hostname` |
| `hostname`         | `/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/` and length at most 253                                           |
| `operation`        | `generate_data_key`, `decrypt`                                                                              |
| `key_kind`         | `org`, `identity`                                                                                           |
| `outcome`          | `ok`, `rejected`, `failed`, `timeout`                                                                       |

Any other value increments `dropped`. Do not write the rejected text into the line.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/observability && pnpm check:boundaries`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/observability/src/logger.ts packages/observability/src/logger.test.ts packages/observability/src/logger.types.test.ts
git commit -m "$(cat <<'EOF'
feat(observability): check the service log fields

A refusal and a KMS call need a small allow-list. A value that fails
its check is counted and left out of the line.

Refs: docs/plans/2026-10-05-regional-service.md task 1
EOF
)"
```

---

### Task 2: Kernel path and gatewayRequestId

About 220 changed lines.

**Files:**

- Modify: `packages/kernel/src/request-handler.ts`
- Modify: `packages/kernel/src/request-handler.test.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**

- Consumes: `createRequestHandler` from task 1's logger only at the `apps/api` call site. The kernel does not import the logger.
- Produces: `createRequestHandler` requires `pathFor: (request: Request) => string`. `RequestLogFields` gains optional `gatewayRequestId?: string`. `acceptInboundRequestId` still defaults to false. `path` in the log is exactly the string `pathFor` returns.

**Rule this must not break:** an inbound `x-request-id` is not copied into `requestId` or any other field when `acceptInboundRequestId` is false. The kernel does not read `pathname` into the log. Do not build the hostname gate here.

- [ ] **Step 1: Write the failing test**

In `packages/kernel/src/request-handler.test.ts`, replace the assertion that `POST /health` logs pathname `/health`. `pathFor` returns `"/health"` for `GET` and `"unmatched"` otherwise. Add:

```ts
it("logs pathFor and a valid gateway request id, not the URL path", async () => {
  const info = vi.fn();
  const marker = "caller-supplied-segment";
  const run = createRequestHandler(
    {
      info,
      pathFor: (request) => (new URL(request.url).pathname === "/health" ? "/health" : "unmatched"),
    },
    () => new Response(null, { status: 204 }),
  );
  await run(
    new Request(`https://example.test/health/${marker}?query-leak-token`, {
      headers: {
        "x-community-hub-request-id": "gateway-id_1",
        "x-request-id": "22222222-2222-4222-8222-222222222222",
        "x-community-hub-client-ip": "203.0.113.5",
      },
    }),
  );
  const fields = info.mock.calls[0]![0] as Record<string, unknown>;
  expect(fields.path).toBe("unmatched");
  expect(fields.gatewayRequestId).toBe("gateway-id_1");
  expect(fields.requestId).not.toBe("22222222-2222-4222-8222-222222222222");
  expect(JSON.stringify(fields)).not.toContain(marker);
  expect(JSON.stringify(fields)).not.toContain("query-leak-token");
  expect(JSON.stringify(fields)).not.toContain("203.0.113.5");
});
```

A second call with `x-community-hub-request-id: "bad id"` omits `gatewayRequestId`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test --filter @community-hub/kernel`

Expected: FAIL because `pathFor` is not a parameter and `gatewayRequestId` is absent.

- [ ] **Step 3: Write the minimal implementation**

`createRequestHandler` reads `options.pathFor(request)` inside the `finally` block and passes that string as `path`. It sets `gatewayRequestId` only when the header matches `/^[A-Za-z0-9+/=_-]{1,128}$/`. It does not put `request.url` into the log object.

In `apps/api/src/index.ts`, pass `pathFor` so the package still typechecks. Return `"/health"` when the method is `GET` and the pathname is `"/health"`, and `"unmatched"` otherwise. Task 3 replaces this function with the gate. Leave `acceptInboundRequestId: false`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/kernel && pnpm test --filter @community-hub/api && pnpm check:boundaries`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/request-handler.ts packages/kernel/src/request-handler.test.ts apps/api/src/index.ts
git commit -m "$(cat <<'EOF'
feat(kernel): log the route pattern the caller supplies

The request line no longer copies the URL path. A gateway request id
is a separate field, and the kernel UUID stays minted here.

Refs: docs/plans/2026-10-05-regional-service.md task 2
EOF
)"
```

---

### Task 3: Route registration, the hostname gate, and the unread body

About 480 changed lines.

**Files:**

- Create: `apps/api/src/gate.ts`
- Create: `apps/api/src/gate.test.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**

- Consumes: `createRequestHandler` and `healthRequest` from `@community-hub/kernel`. `createLogger` from `@community-hub/observability`.
- Produces:

```ts
export type Surface = "ops" | "tenant" | "all";

export type GateRoute = {
  method: string;
  pattern: string;
  surface: Surface;
  handle: (request: Request) => Response | Promise<Response>;
};

export class RoutesRejected extends Error {
  readonly code: "routes";
  constructor();
}

export type Hostnames = {
  api: string;
  auth: string;
  webhooks: string;
  ops: string;
};

export function assertRoutes(routes: readonly GateRoute[]): void;

export function createGate(options: {
  hostnames: Hostnames;
  routes: readonly GateRoute[];
  info: (message: string, fields: Record<string, unknown>) => void;
}): (input: { request: Request; remoteAddress: string }) => Promise<Response>;
```

`assertRoutes` throws `RoutesRejected` when a surface is missing, a method and pattern are duplicated, or `all` is used for anything other than `GET` `/health`. `createGate` calls `assertRoutes` before returning the function.

**Rule this must not break:** a refusal is an empty 404 and does not call the route handler or `createRequestHandler`. The decision uses method, pathname, headers, and `remoteAddress` only. `request.body`, `request.text()`, and `request.arrayBuffer()` are not called. An unmatched path on the ops hostname has no `reason`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/gate.test.ts`. Use hostnames `au.api.example.test`, `auth.au.example.test`, `webhooks.au.example.test`, and `ops.au.example.test`. Register `GET /health` with surface `all`, plus test routes `GET /ops-only` (`ops`) and `GET /tenant-only` (`tenant`).

Assert each row. The first matching reason wins.

| Remote             | Header                 | Method and path    | Status | Reason                        | Path           | Handler called |
| ------------------ | ---------------------- | ------------------ | ------ | ----------------------------- | -------------- | -------------- |
| `10.0.0.8`         | absent                 | `GET /health`      | 404    | `missing_hostname_header`     | `/health`      | no             |
| `127.0.0.1`        | absent                 | `GET /health`      | 200    | none                          | `/health`      | yes            |
| `::1`              | absent                 | `GET /health`      | 200    | none                          | `/health`      | yes            |
| `::ffff:127.0.0.1` | absent                 | `GET /health`      | 200    | none                          | `/health`      | yes            |
| `10.0.0.8`         | `OPS.AU.EXAMPLE.TEST`  | `GET /health`      | 200    | none                          | `/health`      | yes            |
| `10.0.0.8`         | `evil.example`         | `GET /health`      | 404    | `unknown_hostname`            | `/health`      | no             |
| `10.0.0.8`         | `au.api.example.test`  | `GET /ops-only`    | 404    | `ops_route_on_other_hostname` | `/ops-only`    | no             |
| `10.0.0.8`         | `ops.au.example.test`  | `GET /tenant-only` | 404    | `other_route_on_ops_hostname` | `/tenant-only` | no             |
| `10.0.0.8`         | `ops.au.example.test`  | `GET /missing`     | 404    | field absent                  | `unmatched`    | yes            |
| `10.0.0.8`         | `auth.au.example.test` | `GET /missing`     | 404    | field absent                  | `unmatched`    | yes            |

A refusal log includes `gatewayRequestId` when the header is `gateway-id_1`, and the line has no `requestId` and no `duration`. `hostname` on a known-host refusal is the lowercased environment value. `unknown_hostname` omits `hostname`.

The client-IP marker `203.0.113.9` is absent from the served, refused, and unmatched lines.

The body test:

```ts
it("does not read a 1 MiB refused body", async () => {
  let reads = 0;
  const marker = "body-marker-not-in-logs";
  const body = new ReadableStream({
    pull(controller) {
      reads += 1;
      controller.enqueue(new TextEncoder().encode(marker.repeat(20_000)));
      controller.close();
    },
  });
  const request = new Request("https://api.test/health", {
    method: "POST",
    body,
    duplex: "half",
    headers: { "x-community-hub-client-ip": "203.0.113.9" },
  });
  const response = await gate({ request, remoteAddress: "10.0.0.8" });
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("");
  expect(reads).toBe(0);
  expect(JSON.stringify(lines)).not.toContain(marker);
});
```

`assertRoutes` throws `RoutesRejected` for a route whose surface is `all` and whose pattern is `/other`, and for a duplicate `GET /health`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test --filter @community-hub/api`

Expected: FAIL because `apps/api/src/gate.ts` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Implement `assertRoutes` and `createGate` in `apps/api/src/gate.ts`. Loopback peers are exactly `127.0.0.1`, `::1`, and `::ffff:127.0.0.1`. Compare hostnames after `toLowerCase()` on the header and on the four environment values. An absent or empty header is missing. Do not trim a present header.

Match a route when method and pathname are equal to the registered method and pattern. Refusal order:

1. Missing header, and the request is not loopback `GET /health`: `missing_hostname_header`.
2. Header equals none of the four: `unknown_hostname`.
3. Matched surface is `ops` and the header is not the ops hostname: `ops_route_on_other_hostname`.
4. Header is the ops hostname and the matched surface is `tenant`: `other_route_on_ops_hostname`.

An unmatched path calls the handler with `pathFor` returning `"unmatched"`, including on the ops hostname. A served or unmatched request goes through `createRequestHandler` with `acceptInboundRequestId: false`. A refusal writes one `logger.info("request", ...)` line and returns `new Response(null, { status: 404 })` without calling `createRequestHandler`.

`apps/api/src/index.ts` keeps its fetch export until task 5 so the existing health test still runs. The wrapper calls `createGate` with `remoteAddress: "127.0.0.1"`, which is the loopback health check. Production routes in that wiring are only `GET /health`. Task 5 removes the fetch export.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/api && pnpm check:boundaries`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gate.ts apps/api/src/gate.test.ts apps/api/src/index.ts
git commit -m "$(cat <<'EOF'
feat(api): refuse a request before the kernel sees it

Health on the loopback probe has no hostname header. Every other
request is matched to one of the four hostnames, and a refusal does
not read the body.

Refs: docs/plans/2026-10-05-regional-service.md task 3
EOF
)"
```

---

### Task 4: KmsPort adapter, deadline, and the probe-file lint allow

About 400 changed lines.

**Files:**

- Modify: `apps/api/src/kms/aws-kms-adapter.ts`
- Modify: `apps/api/src/kms/aws-kms-adapter.test.ts`
- Delete: `apps/api/src/kms/broker-kms.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/tsconfig.json`
- Modify: `tooling/eslint-plugin-community-hub/rules/no-kms-port-outside-crypto.js`
- Create: `tooling/checks/encrypted-column/fixtures/fail/apps/api/src/kms/leak.ts`
- Create: `tooling/checks/encrypted-column/fixtures/fail/apps/api/src/probe.ts`
- Create: `tooling/checks/encrypted-column/fixtures/pass/apps/api/src/probe.ts`
- Modify: `tooling/checks/encrypted-column/selftest.ts`

Do not modify `tooling/eslint-plugin-community-hub/lib/ast.js`.

**Interfaces:**

- Consumes: `KmsPort` and `KmsContext` from `@community-hub/crypto`. `checkContext` from `apps/api/src/kms/context.ts`. The SDK commands stay `GenerateDataKey` with `KeySpec: "AES_256"` and `Decrypt`, both with `KeyId` and `EncryptionContext`.
- Produces:

```ts
export function createAwsKmsPort(options: {
  client: {
    send: (
      command: GenerateDataKeyCommand | DecryptCommand,
      options?: { abortSignal?: AbortSignal },
    ) => Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array }>;
  };
  keyArn: string;
  deadlineMs?: number;
  info: (fields: {
    operation: "generate_data_key" | "decrypt";
    key_kind?: "org" | "identity";
    outcome: "ok" | "rejected" | "failed" | "timeout";
  }) => void;
}): KmsPort;
```

`deadlineMs` defaults to 3000. The production server in task 5 does not pass it.

**Rule this must not break:** `checkContext` still rejects a context outside its allow-list. Response buffers are zeroed after they are copied. Bytes that arrive after the deadline are zeroed and not returned. `ContextRejected` does not escape. A `KmsPort` call under `apps/api/src/kms/` still fails the encrypted-column fixture. The existing `packages/db` fixtures still fail.

- [ ] **Step 1: Write the failing test**

Rewrite `apps/api/src/kms/aws-kms-adapter.test.ts` against `createAwsKmsPort`. Cover:

- `checkContext` rejects `{ key_kind: "org" }` before `send`. Outcome `rejected`. `key_kind` is `org`. Thrown `message` is `kms_failed` and `cause` is `undefined`.
- A `keyId` other than `keyArn` does not call `send`. Outcome `rejected`.
- A context whose `key_kind` is `"nope"` omits `key_kind` from the log.
- `deadlineMs` defaults to 3000: a client that records `abortSignal` sees it already aborted after a fake timer advance of 3000 ms, or the test passes `deadlineMs: 5` and asserts the default by reading a test-only export `DEFAULT_DEADLINE_MS === 3000`. Do not wait 3000 ms.
- A response that resolves after abort is outcome `timeout`, the returned plaintext bytes are not the caller's, and the source buffer is filled with 0.
- An incomplete response is outcome `failed`.
- When `send` rejects and the abort signal has already fired, the outcome is `timeout`, not `failed`. The fake client rejects when the signal aborts. `deadlineMs` is 5 so the test does not wait 3000 ms.
- Success is outcome `ok`, and the SDK plaintext buffer is filled with 0 after the copy is returned.
- One info call per operation. `operation` is `generate_data_key` or `decrypt`.

Add `apps/api` dependency `@community-hub/crypto` and a tsconfig reference to `packages/crypto` in this task, or the import does not resolve. The failing test comes first; add the dependency in the same red step so the test file typechecks enough to fail on the missing export.

The fail fixture `tooling/checks/encrypted-column/fixtures/fail/apps/api/src/kms/leak.ts` is the same call shape as `fixtures/fail/packages/db/src/kms-decrypt.ts`. The pass fixture `fixtures/pass/apps/api/src/probe.ts` calls `port.generateDataKey` and `port.decrypt`. The fail fixture `fixtures/fail/apps/api/src/probe.ts` is a copy of `fixtures/fail/sql-raw.ts`. Add both new fail files and the pass file to the `mustFail` and `mustPass` lists in `tooling/checks/encrypted-column/selftest.ts`. Do not change `isCryptoSource`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test --filter @community-hub/api`

Expected: FAIL because `createAwsKmsPort` is not exported. `createAwsBrokerKms` is still the old name.

- [ ] **Step 3: Write the minimal implementation**

Delete `BrokerKms`. `createAwsKmsPort` runs `checkContext` first, then compares `keyId` to `options.keyArn` with `===`. Either failure logs `rejected` and throws `new Error("kms_failed")` with no second argument. Catch `ContextRejected` and do not attach it as `cause`.

Pass `AbortSignal.timeout(options.deadlineMs ?? 3000)` to `send`. If `abortSignal.aborted` after `send` resolves, or `send` rejects after the signal has fired, zero every buffer and throw `kms_failed` with outcome `timeout`. If `send` rejects while the signal has not fired, or a required buffer is missing, zero what you hold and throw `kms_failed` with outcome `failed`. On success, copy the bytes, `fill(0)` the SDK buffers, and return the copies.

Do not change `isCryptoSource`. `no-encrypted-column-query` uses it in three places, and a probe exemption there would skip that rule too. In `tooling/eslint-plugin-community-hub/rules/no-kms-port-outside-crypto.js` only, return no listeners when the normalized filename ends with `/apps/api/src/probe.ts`, in addition to the existing `isCryptoSource` check. `fixtures/fail/apps/api/src/probe.ts` still reports `no-encrypted-column-query`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/api && pnpm test --filter @community-hub/check-encrypted-column && pnpm check:boundaries`

Expected: PASS. The `apps/api/src/kms` fixture fails `no-kms-port-outside-crypto`. The pass probe fixture does not. The fail probe fixture reports `no-encrypted-column-query`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/kms/aws-kms-adapter.ts apps/api/src/kms/aws-kms-adapter.test.ts apps/api/src/kms/broker-kms.ts apps/api/package.json apps/api/tsconfig.json tooling/eslint-plugin-community-hub/rules/no-kms-port-outside-crypto.js tooling/checks/encrypted-column/selftest.ts tooling/checks/encrypted-column/fixtures/fail/apps/api/src/kms/leak.ts tooling/checks/encrypted-column/fixtures/fail/apps/api/src/probe.ts tooling/checks/encrypted-column/fixtures/pass/apps/api/src/probe.ts
git commit -m "$(cat <<'EOF'
feat(api): reshape the KMS adapter onto KmsPort

The deadline and the ARN check live in the adapter. A failure is the
single message kms_failed, and only the probe file may call the port.

Refs: docs/plans/2026-10-05-regional-service.md task 4
EOF
)"
```

If `broker-kms.ts` is already deleted, do not `git add` a missing path. Add `selftest.ts` only when that file changed.

---

### Task 5: Startup validation, listen, and the certificate pin

About 260 changed lines.

**Files:**

- Create: `apps/api/src/env.ts`
- Create: `apps/api/src/env.test.ts`
- Create: `apps/api/src/server.ts`
- Create: `apps/api/src/server.test.ts`
- Create: `apps/api/certs/rds-ap-southeast-2-bundle.pem`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/index.test.ts`

**Interfaces:**

- Consumes: `createGate`, `assertRoutes`, and `GateRoute` from `./gate.js`. `createLogger` from `@community-hub/observability`. The server module does not import `@community-hub/db` or `./kms/aws-kms-adapter.js`.
- Produces:

```ts
export const CERT_SHA256 = "d73890748b5a95551800df8a6f07c9c800e32ed34da7e6c9505918bf8ac2398b";
export const IMAGE_CERT_PATH = "/app/certs/rds-ap-southeast-2-bundle.pem";
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 30_000;
export const ACCEPT_AFTER_SIGTERM_MS = 5_000;
export const FORCE_CLOSE_AFTER_SIGTERM_MS = 25_000;

export function readServiceEnv(
  source: NodeJS.ProcessEnv,
  pem: string,
): { ok: true; env: ServiceEnv } | { ok: false };

export type SignalSource = {
  on(signal: "SIGTERM", listener: () => void): void;
};

export function startServer(options: {
  env: ServiceEnv;
  routes: readonly GateRoute[];
  signals?: SignalSource;
  exit?: (code: number) => void;
  acceptForMs?: number;
  forceCloseMs?: number;
}): import("node:http").Server;
```

`ServiceEnv` holds the required names from the spec: `PORT`, `AWS_REGION`, `NODE_ENV`, `COMMUNITY_HUB_ENVIRONMENT`, the four hostnames, `PGHOST`, `PGPORT`, `PGDATABASE`, the three users, the three passwords, `ENVELOPE_KEY_ARN`, and the three secret ARNs. `TURNSTILE_SECRET` is optional and unused.

`readServiceEnv` returns `{ ok: false }` unless every required value is a non-empty string, `PORT` and `PGPORT` are integers from 1 to 65535, `AWS_REGION` is `ap-southeast-2`, `NODE_ENV` is `production` or `test`, `COMMUNITY_HUB_ENVIRONMENT` is `staging` or `prod`, the four lowercased hostnames are distinct, `ENVELOPE_KEY_ARN` matches `^arn:aws:kms:ap-southeast-2:[0-9]{12}:key/(mrk-[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`, and `pem`'s SHA-256 equals `CERT_SHA256`.

**Rule this must not break:** `server.ts` does not import `@community-hub/db` or the KMS adapter. Listen and `GET /health` do not call a factory or `send`. The entrypoint does not pass `acceptForMs`, `forceCloseMs`, `signals`, or `exit`. Importing `index.ts` does not bind a port. The process listens only when the file is the entrypoint. The shutdown test does not send a real signal and does not call `process.exit`.

- [ ] **Step 1: Write the failing test**

Download the bundle once and commit it only when the digest matches:

```bash
curl -fsSL "https://truststore.pki.rds.amazonaws.com/ap-southeast-2/ap-southeast-2-bundle.pem" -o apps/api/certs/rds-ap-southeast-2-bundle.pem
shasum -a 256 apps/api/certs/rds-ap-southeast-2-bundle.pem
```

Expected digest: `d73890748b5a95551800df8a6f07c9c800e32ed34da7e6c9505918bf8ac2398b`. If it differs, stop. Do not change `CERT_SHA256`.

`env.test.ts` asserts `{ ok: false }` for a missing `PGHOST`, an alias ARN, an uppercase key id, a one-byte change to the PEM, and equal ops and api hostnames. A complete synthetic env with account `123456789012` and a `mrk-` id of 32 hex characters returns `{ ok: true }`.

`server.test.ts` mocks `@community-hub/db` and `./kms/aws-kms-adapter.js` before importing the server. After `listen` and a loopback `GET /health` with no hostname header, `createDirectSql`, `createAppSql`, `createIdentitySql`, `createPlatformSql`, and `createAwsKmsPort` have zero calls. The body is `{ ok: true }`, `server.keepAliveTimeout` is 65000, and `server.requestTimeout` and `server.headersTimeout` are 30000. The address is `0.0.0.0` and the port is the `PORT` value. Use a free port from 1 to 65535, not 0.

The shutdown test passes `acceptForMs: 30`, `forceCloseMs: 80`, a `signals` object whose `on("SIGTERM", listener)` stores the listener, and `exit` that records the code. It does not call `process.kill` and it does not let the server call `process.exit`. Invoking the stored listener starts the drain. A request that finishes before the force-close still receives its response. A request the test route never finishes is destroyed, and `exit` is called with 0 before 500 ms.

`index.test.ts` no longer imports a fetch default. It imports the module and asserts no port is open until `start` is called. Run `start` only from a `import.meta.url === pathToFileURL(process.argv[1]).href` check.

Do not add `@community-hub/db` in this task. The probe task adds that dependency.

Startup failure is exercised by calling the same function the entrypoint uses:

```ts
export function run(source: NodeJS.ProcessEnv, pem: string, routes: readonly GateRoute[]): number;
```

`run` writes nothing to stdout. On `{ ok: false }` it writes `env\n` to stderr and returns 1 without listening. On `RoutesRejected` it writes `routes\n` and returns 1. The failed value is not in the stderr string.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test --filter @community-hub/api`

Expected: FAIL because `readServiceEnv` and `startServer` do not exist.

- [ ] **Step 3: Write the minimal implementation**

Implement `env.ts`, `server.ts`, and the entrypoint check in `index.ts`. Bind `server.listen(env.PORT, "0.0.0.0")`. Set the two timeout properties from the constants. Build each `Request` with method and headers and no body. `signals` defaults to `process` and `exit` defaults to `(code) => process.exit(code)`. On the SIGTERM listener, wait `acceptForMs ?? ACCEPT_AFTER_SIGTERM_MS`, then `server.close()`. At `forceCloseMs ?? FORCE_CLOSE_AFTER_SIGTERM_MS`, call `server.closeAllConnections()` and `exit(0)`. Do not import the database factories or the KMS adapter from `server.ts`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/api && pnpm check:boundaries`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/env.ts apps/api/src/env.test.ts apps/api/src/server.ts apps/api/src/server.test.ts apps/api/src/index.ts apps/api/src/index.test.ts apps/api/certs/rds-ap-southeast-2-bundle.pem
git commit -m "$(cat <<'EOF'
feat(api): listen after the environment check

The process checks the envelope key and the RDS bundle, then binds.
Health does not open a database connection or call KMS.

Refs: docs/plans/2026-10-05-regional-service.md task 5
EOF
)"
```

---

### Task 6: The probe and the planted-marker test

About 320 changed lines.

**Files:**

- Create: `apps/api/src/probe.ts`
- Create: `apps/api/src/probe.test.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/tsconfig.json`

**Interfaces:**

- Consumes: `readServiceEnv` and `CERT_SHA256` from `./env.js`. `createAwsKmsPort` from `./kms/aws-kms-adapter.js`. `createDirectSql` from `@community-hub/db`. `KmsPort` from `@community-hub/crypto`.
- Produces:

```ts
export const STEP_MS = 10_000;

export type ProbeDeps = {
  source: NodeJS.ProcessEnv;
  pem: string;
  connect: typeof createDirectSql;
  kms: KmsPort;
  stepMs?: number;
};

export async function runProbe(deps: ProbeDeps): Promise<{
  exitCode: 0 | 1;
  stdout: "pass\n" | "fail\n";
  stderr:
    | ""
    | "env\n"
    | "db_app\n"
    | "db_identity\n"
    | "db_platform\n"
    | "kms_generate\n"
    | "kms_decrypt\n";
}>;
```

The entrypoint at the bottom of `probe.ts` installs `uncaughtException` and `unhandledRejection` handlers first, then calls `runProbe` and writes only `stdout` and `stderr`. It exits with `exitCode`.

**Rule this must not break:** the server entrypoint stays `index.ts`. The probe uses `createDirectSql` with `host` from `PGHOST` and `servername` omitted. It does not call `createAppSql`, `createIdentitySql`, or `createPlatformSql`. Each direct connection is closed after `SELECT 1`. Plaintext copies are `fill(0)` after the compare, including on mismatch. A thrown marker does not appear in `stdout` or `stderr`.

- [ ] **Step 1: Write the failing test**

Add `@community-hub/db` to `apps/api` dependencies and a tsconfig reference to `packages/db` before the probe test imports `createDirectSql`. The server module still does not import it. `probe.test.ts` uses a synthetic env and the real PEM. Stub `connect` and `kms`.

- Missing `PGHOST` returns exit 1, stdout `fail\n`, stderr `env\n`, and `connect` is not called.
- `connect` throws `Error("marker-db-secret")` for user `app`. Stderr is `db_app\n`. The marker is absent from both strings.
- The same for `identity` and `platform`, after the previous role's `SELECT 1` returned `[{ n: 1 }]`.
- `generateDataKey` throws `Error("marker-kms")`. Stderr is `kms_generate\n`. The marker is absent.
- `decrypt` returns different bytes. Stderr is `kms_decrypt\n`. Both the generated plaintext and the decrypted copy are filled with 0.
- Success: `generateDataKey` returns a 32-byte plaintext and a blob. `decrypt` returns an equal copy. Stdout is `pass\n`, stderr is `""`, exit 0. The context passed to both methods is `{ key_kind: "identity", region: "ap-southeast-2", key_version: "probe" }`, and `keyId` is the configured ARN.
- Call the exported uncaught handler with `Error("marker-uncaught")` after a step has been set to `db_app` by a test hook `setProbeStepForTest("db_app")`. The strings passed to the writer are `fail\n` and `db_app\n` only.

`stepMs` in tests is 50. The production call does not pass `stepMs`, so the budget is `STEP_MS`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test --filter @community-hub/api`

Expected: FAIL because `runProbe` does not exist.

- [ ] **Step 3: Write the minimal implementation**

`runProbe` stops at the first failure. Wrap each step in a timeout of `deps.stepMs ?? STEP_MS`. On timeout or throw, return the step's stderr code. Do not include `error.message` in either string.

Database steps call `connect` with that role's user and password, `ca: deps.pem`, and no `servername`, then `` sql`select 1 as n` ``, then `sql.end({ timeout: 1 })`.

KMS steps call `deps.kms.generateDataKey` and `deps.kms.decrypt`. Compare with a length check and `timingSafeEqual` when the lengths match. Then `fill(0)` both copies.

The uncaught handler closes over the current step, defaulting to `env` before the first step.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/api && pnpm test --filter @community-hub/check-encrypted-column && pnpm check:boundaries`

Expected: PASS. `probe.ts` is allowed to call `KmsPort`. The `apps/api/src/kms` fixture still fails.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/probe.ts apps/api/src/probe.test.ts apps/api/package.json apps/api/tsconfig.json
git commit -m "$(cat <<'EOF'
feat(api): add the standalone database and KMS probe

The probe stops at the first failed step and prints only pass or fail.
A planted marker stays out of both streams, including an uncaught throw.

Refs: docs/plans/2026-10-05-regional-service.md task 6
EOF
)"
```

---

### Task 7: The image, keep-alive, and the ingress-contract checks

About 420 changed lines.

**Files:**

- Create: `apps/api/tsconfig.emit.json`
- Create: `apps/api/Dockerfile`
- Create: `apps/api/src/image.test.ts`
- Modify: `apps/api/package.json` if the image test needs a script. `build-preview` runs this test with `RUN_IMAGE_TESTS=1`. The default `pnpm test` job does not set that flag. The build-preview job does, so the contract checks run in CI.

**Interfaces:**

- Consumes: `KEEP_ALIVE_TIMEOUT_MS`, `HEADERS_TIMEOUT_MS`, `IMAGE_CERT_PATH`, and the entrypoints `index.ts` and `probe.ts`. The emit config writes `/app/index.js` and `/app/probe.js` by copying `dist` to `/app` in the image, so those files exist at the image root. `limits` constants are emitted to `/app/env.js` if they live in `env.ts`. Import them from that file in the image check.
- Produces: an image tagged `community-hub-api:local` by the test, not pushed. User `node`. `/tmp` owned by `node`. `VOLUME ["/tmp"]`. `ENTRYPOINT ["node", "/app/index.js"]`. `HEALTHCHECK` exec form whose first argument is `node` and whose argument list contains no shell. The command string is `fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`.

**Rule this must not break:** the image sets no contract environment variable. The Dockerfile `FROM` lines are the digest in Global Constraints, both stages. The test does not call AWS and does not open a database. `infra/` is not edited.

- [ ] **Step 1: Write the failing test**

`apps/api/src/image.test.ts` skips unless `RUN_IMAGE_TESTS=1`. Vitest's include is `src/**/*.test.ts`, so the file lives under `src`. When the flag is set, the test runs:

```bash
docker build --platform linux/arm64 -f apps/api/Dockerfile -t community-hub-api:local .
```

Then assert, from `docker inspect community-hub-api:local`:

- `Config.User` is `node`.
- `Config.Entrypoint` is `["node", "/app/index.js"]`.
- `Config.Volumes` includes `/tmp`.
- `Config.Healthcheck.Test` starts with `CMD` and `node`, and the joined arguments do not contain `sh` or `bash`.
- `Config.Env` contains no `PGHOST`, `PGPASSWORD_APP`, `ENVELOPE_KEY_ARN`, `API_HOSTNAME`, or `TURNSTILE_SECRET`.

Run `docker run --rm --read-only --tmpfs /tmp --user node` with a synthetic environment: `PORT=8080`, `AWS_REGION=ap-southeast-2`, `NODE_ENV=production`, `COMMUNITY_HUB_ENVIRONMENT=staging`, distinct hostnames under `example.test`, `PGHOST=db.example.test`, `PGPORT=5432`, `PGDATABASE=communityhub`, the three users and three passwords set to `synthetic`, the three secret ARNs set to `arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:synthetic`, and `ENVELOPE_KEY_ARN=arn:aws:kms:ap-southeast-2:123456789012:key/mrk-0123456789abcdef0123456789abcdef`. No AWS credentials.

Assert loopback `GET http://127.0.0.1:8080/health` returns 200 and `{ ok: true }`. Exec the health command as `docker exec <id> node -e "<the fetch script>"` and expect exit 0.

Exec `node --input-type=module -e` inside the container to import `KEEP_ALIVE_TIMEOUT_MS` and `HEADERS_TIMEOUT_MS` from `/app/server.js` and exit 0 only when they are 65000 and 30000.

Start a second container on the same image. The production process serves only `GET /health`, so do not add a slow route. Hold the connection with a raw TCP socket that sends incomplete request headers and then writes nothing else. Send `docker kill --signal=TERM`. The container exits 0, and the elapsed time is greater than 20 seconds and less than 30 seconds. A request that completed before the force-close returned its response. This test uses the real timers. Do not pass `acceptForMs`.

Run the probe with no environment:

```bash
docker run --rm --entrypoint node community-hub-api:local /app/probe.js
```

Expected: exit 1, stdout `fail\n`, stderr `env\n`.

`tsconfig.emit.json` sets `noEmit` false, `outDir` `dist`, `rootDir` `src`, excludes tests, and extends the app config's module settings. The Dockerfile compiles with `pnpm --filter @community-hub/api exec tsc -p tsconfig.emit.json` after `pnpm install --frozen-lockfile` and after building `@community-hub/kernel`, `@community-hub/observability`, `@community-hub/crypto`, and `@community-hub/db`. `pnpm --filter @community-hub/api deploy --prod --legacy /out` then receives the emitted `dist` files copied onto `/out` so `/out/index.js` and `/out/probe.js` exist, and the cert directory copied to `/out/certs`. Without `--legacy`, pnpm 10.26.0 fails with `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`. The runtime stage copies `/out` to `/app` with `--chown=node:node`, creates `/tmp` owned by `node`, and declares `VOLUME ["/tmp"]`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `RUN_IMAGE_TESTS=1 pnpm --filter @community-hub/api exec vitest run --config vitest.config.ts src/image.test.ts`

Expected: FAIL because `apps/api/Dockerfile` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Add `tsconfig.emit.json` and `apps/api/Dockerfile` as specified. Both `FROM` lines use the digest in Global Constraints. `USER node` is the runtime user. `HEALTHCHECK` is exec form. Do not add a shell. Do not set `ENV` for a contract variable.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/api && RUN_IMAGE_TESTS=1 pnpm --filter @community-hub/api exec vitest run --config vitest.config.ts src/image.test.ts && pnpm check:boundaries`

Expected: PASS. The SIGTERM container exits before 30 seconds. The no-environment probe prints `fail` and `env`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/tsconfig.emit.json apps/api/Dockerfile apps/api/src/image.test.ts
git commit -m "$(cat <<'EOF'
feat(api): build the ARM image for the regional service

The image runs as node, answers the loopback health check, and keeps
idle gateway connections for 65 seconds. The probe is not the entrypoint.

Refs: docs/plans/2026-10-05-regional-service.md task 7
EOF
)"
```

---

### Task 8: The CI ARM build and the Stage 3 sentence

About 80 changed lines.

**Files:**

- Modify: `.github/workflows/ci.yml`
- Modify: `AGENTS.md` only the Stage 3 bullet that says the service chunk replaces the package build. Do not change the repository-state cell. That is task 9.

**Interfaces:**

- Consumes: `apps/api/Dockerfile` and `/app/probe.js` from task 7.
- Produces: job `build-preview` runs on `ubuntu-24.04-arm`. It builds `--platform linux/arm64`, does not push, does not log in to a registry, and does not read AWS credentials. It sets up pnpm and Node, then runs `apps/api/src/image.test.ts` with `RUN_IMAGE_TESTS=1`. That run includes the probe with no contract environment, which expects exit 1, stdout `fail`, and stderr `env`.

**Rule this must not break:** Stages 1 and 2 stay as they are. The job does not also run an emulation build. If `ubuntu-24.04-arm` cannot be queued, stop and report. Do not add the emulation fallback in this commit. Terraform is not edited. `service_image` is not set.

- [ ] **Step 1: Write the failing check**

Replace the `build-preview` job. A test that skips in CI is not a check. The job checks out, sets up pnpm and Node 24, installs, builds the image, then runs the image test with the flag set.

```yaml
build-preview:
  name: build-preview
  runs-on: ubuntu-24.04-arm
  steps:
    - uses: actions/checkout@v4

    - uses: pnpm/action-setup@v4

    - uses: actions/setup-node@v4
      with:
        node-version: 24
        cache: pnpm

    - name: Enable corepack
      run: corepack enable

    - name: Install dependencies
      run: pnpm install --frozen-lockfile

    - name: Build the ARM image
      run: docker build --platform linux/arm64 -f apps/api/Dockerfile -t community-hub-api:local .

    - name: Image contract checks
      env:
        RUN_IMAGE_TESTS: "1"
      run: pnpm --filter @community-hub/api exec vitest run --config vitest.config.ts src/image.test.ts
```

`image.test.ts` builds `community-hub-api:local` only when `docker image inspect` fails, so this job does not build twice. It still runs every assertion, including the no-environment probe and the incomplete-header SIGTERM check. Those assertions do not skip.

In `AGENTS.md` §10, replace the Stage 3 bullet with: Stage 3 builds this ARM image, does not push it, and does not call Wrangler or require a Cloudflare token. Verification of a running task stays the staging hostname.

- [ ] **Step 2: Run the workflow file's commands locally**

Run the `docker build` tagged `community-hub-api:local`, then `RUN_IMAGE_TESTS=1 pnpm --filter @community-hub/api exec vitest run --config vitest.config.ts src/image.test.ts`.

Expected: the image test exits 0. The probe assertion inside it sees exit 1, `fail`, and `env`. `git diff -- .github/workflows/ci.yml` contains no `docker push` and no `aws`.

- [ ] **Step 3: Confirm the rest of the local gate**

Run: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/api && pnpm check:boundaries`

Expected: PASS. `RUN_IMAGE_TESTS` is set only for the image test command in Step 2. The default unit test command does not set it.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml AGENTS.md
git commit -m "$(cat <<'EOF'
ci(api): build the ARM image and run the probe

Stage 3 no longer stops at the package build. The image is not pushed,
and a probe with no environment exits on the env step.

Refs: docs/plans/2026-10-05-regional-service.md task 8
EOF
)"
```

---

### Task 9: Roadmap, repository state, and the CI sequence

About 40 changed lines.

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md` repository-state cell only

**Interfaces:**

- Consumes: the eight commits above. This task does not change runtime code.
- Produces: the Phase 0 catalogue. `regional service` is done. Next chunk is `first staging apply`.

**Rule this must not break:** do not mark `first staging apply` done. Do not edit the spec or this plan's `Status` line. Do not create the `missing_hostname_header` alarm. Do not add pooled checkout.

- [ ] **Step 1: Update the catalogue**

In `docs/roadmap.md`:

- Snapshot: last shipped `regional service`. Next chunk `first staging apply`. Phase 0 is `20 rows: 17 done, 1 superseded (api-au-hostname), 2 not started`.
- The `regional service` row becomes **done** and links `docs/specs/2026-10-05-regional-service.md`.
- Append to the `first staging apply` cell: an alarm on `missing_hostname_header` from a non-loopback address is an open item for that row. The probe runs as a standalone task, container `service`, command `["node", "/app/probe.js"]`, a public subnet, the task security group, a public IP, with `desired_count` still 0 and ECS Exec off. 5xx responses under steady light traffic are counted, not only during a deploy, and that count is what confirms the keep-alive timeout of 65000 and the request timeout of 30000 or changes them.
- Under `Open items`, add: whether startup should prove the database or KMS is decided by the first chunk that serves a route which needs either one. A cache of unwrapped organisation keys is decided by the first chunk that unwraps one.
- Add one sentence to the existing password re-read item: that same chunk adds pooled checkout of `createAppSql`, `createIdentitySql`, and `createPlatformSql`.

In `AGENTS.md`, the repository-state cell becomes:

`Phase 0: 20 rows, 17 done, 1 superseded (api-au-hostname), 2 not started. Next is the first staging apply.`

Leave the rest of that cell as it is. Leave the Stage 3 bullet from task 8 as it is.

- [ ] **Step 2: Run the full CI sequence locally**

Postgres first: `docker compose -f packages/db/test/docker-compose.yml up -d postgres`

Then, in the order of `.github/workflows/ci.yml`:

```bash
pnpm format
pnpm lint
pnpm typecheck
pnpm check:boundaries
pnpm audit --audit-level=high
pnpm test
docker build --platform linux/arm64 -f apps/api/Dockerfile -t community-hub-api:local .
RUN_IMAGE_TESTS=1 pnpm --filter @community-hub/api exec vitest run --config vitest.config.ts src/image.test.ts
```

The image test exits 0. Inside it, the probe stdout is `fail` and stderr is `env`. There is no `docker push`.

For each directory in the terraform matrix (`infra/bootstrap`, `infra/regions/au`, `infra/modules/aws-network`, `infra/modules/aws-kms-storage`, `infra/modules/aws-kms-envelope`, `infra/modules/aws-db-secrets`, `infra/modules/aws-budgets`, `infra/modules/aws-rds`, `infra/modules/aws-ingress`):

```bash
terraform init -backend=false -lockfile=readonly
terraform fmt -check
terraform validate
tflint --init
tflint
terraform test
```

Secret scanning: if `gitleaks` is on `PATH`, run `gitleaks detect --source . --config .gitleaks.toml --verbose --redact --exit-code 1`. If the binary is missing, report `GITLEAKS_MISSING` and do not treat that as a pass. Traceability runs in CI on the pull request, not in this local sequence.

Do not run `pnpm --filter @community-hub/api... build` as the Stage 3 proof. The image build replaced it.

Expected: every command that ran exits 0, except the probe's exit 1 and the missing-gitleaks report.

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark the regional service done

The process and the image are on this branch. The next chunk is the
first staging apply, which counts steady-traffic 5xx responses.

Refs: docs/plans/2026-10-05-regional-service.md task 9
EOF
)"
```

---

## Pull request

Open the PR only after the human asks. Title: `feat(api): run the regional service as one process`.

The body uses `.github/PULL_REQUEST_TEMPLATE.md` and includes these paragraphs verbatim.

Size exception:

> This plan is past the ~800 changed-line guide. Nine tasks, about 2,400 changed lines. The reason: the gate, the adapter, the probe, and the image describe one process. An image that booted the current fetch handler would answer `GET /health` with no peer check and no hostname check. The probe's `env` failure is the CI proof that the image contains the command, and it is meaningless against a different layout. Do not split this plan.

Staging hostname:

> The staging-hostname check does not apply. Nothing is deployed. `service_image` stays null and the image is not pushed.

Second review, left open:

> Second review: open. A fresh session that has not seen the implementation reads the final diff. This chunk touches encryption and residency.

Also state: implementer configuration, reviewer is the human (single-agent), and whether gitleaks ran locally. Do not fill in the second review. If task 7 or task 9 stopped, there is no PR.
