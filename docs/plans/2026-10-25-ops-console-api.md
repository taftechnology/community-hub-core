Spec: docs/specs/2026-10-25-ops-console-api.md

# Ops console API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The regional service answers the ops routes on the ops hostname over the identity operator functions, holds operator and enrolment sessions in `__Host-` session cookies behind an exact `Origin` check, can serve a static bundle on the ops host, and returns a read-only directory to operators holding `ops.directory.view`. No change to tenant routes, Terraform, the Dockerfile or the database.

**Architecture:** `server.ts` learns to send several `Set-Cookie` headers. The gate gains a `static` route flag and adds the ops-host security headers to every ops-host response. Three new `apps/api` files hold static serving, cookies and `Origin`, and the ops routes. Tenancy gains one read function and the permission key; contracts gain the ops schemas.

Slug: ops-console-api
Status: draft

## Who does what

| Actor                     | Writes repo commits                             | Runs `terraform apply` | Puts secret values, runs AWS one-offs | Applies or merges |
| ------------------------- | ----------------------------------------------- | ---------------------- | ------------------------------------- | ----------------- |
| Implementer (Antigravity) | Yes — Tasks 1–8, only the files each task names | Never                  | Never                                 | Never             |
| Reviewer (fresh Claude)   | Never                                           | Never                  | Never                                 | Never             |
| Human owner (Abdus)       | Never during the run                            | Not needed             | Not needed                            | Merges the PR     |
| Developer (Adnan)         | Never during the run                            | Never                  | Never                                 | Never             |

The owner approves this plan after the independent assistant's check (AGENTS.md §2, §4).

## Global constraints

- The spec is approved and no task edits it. Refinements are listed in **Deviations from the spec** and repeated in the PR body.
- Work only in the worktree `C:\Recovered\Taftech\wt-ops-console-api` on branch `feat/2026-10-25-ops-console-api`. Commit locally; never push.
- No agent runs `terraform`, `aws` or `docker push`. Runs start with no AWS credentials and pushes blocked.
- Staging stays parked. No task touches `infra/`, a Dockerfile, a workflow, `turbo.json`, any `package.json` dependency list, scripts or workspace list (the one sanctioned `package.json` edit is the `./ops` export entry in `packages/contracts/package.json`, Task 5), a `tsconfig*.json`, an ESLint config, a checker, `modules/core/identity`, or any migration. No new dependency.
- No account id, real hostname, email address, secret, token or IP address in any commit. Tests use synthetic UUIDs, `example.test` addresses and hostnames `ops.example.test`, `api.example.test`, `auth.example.test`, `webhooks.example.test`.
- **Existing tests:** no existing assertion is changed or removed, except two: the tenancy `manifest.test.ts` expectation gains `permissions: ["ops.directory.view"]` (Task 4, named by the spec), and `apps/api/src/index.test.ts`'s production route assertions (`toHaveLength(22)` and the exact route `Map`, about `:696`) gain the ten ops API routes, all `exempt` (Task 6, deviation 3). The reviewer checks `git diff origin/main -- '*.test.ts'` shows only added lines elsewhere.
- **Test helpers:** WebAuthn helpers (`clientData`, `coseKey`, `authenticatorData`, signing) and `MemoryMail` are **copied** from `apps/api/src/auth-flow.integration.test.ts` (`:78-160`) into the new integration test, not moved.
- **Identity key in tests:** the new integration file follows the existing pattern: one `createLocalKmsPort()` for the file and `delete from identity.identity_keys` in `beforeAll` (`auth-flow.integration.test.ts:229`), so it never depends on run order.
- **Operator rows:** the identity role cannot delete `identity.operator_grants` or `identity.operator_events`. The integration file deletes them over the owner connection (`createPlaintextDirectSql(runtime.productOnlyUrl)`) in `beforeAll` and `afterAll`, without swallowing errors, before any `delete from identity.users`.
- Only one run at a time uses the Docker test database.
- `apps/api` tests run against built packages. After changing `packages/contracts` or `modules/core/tenancy`, run `pnpm --filter <package> build` before the `apps/api` tests.
- Time is injected (`now`). Every `fetch` in integration tests carries `AbortSignal.timeout(5000)`. Any wait on concurrent work polls with a 20 ms interval and a 5 s cap that fails with a clear message; no test asserts on elapsed time beyond such caps.
- **Known Windows exceptions:** `packages/db/src/generate.test.ts` (ENOENT spawning `drizzle-kit`) and occasional Windows-only timeouts in `migrate.integration`, `plaintext-dist` and identity "forty parallel wrong guesses". They pass on Linux CI. Any other failure is real.
- Before the PR: `pnpm turbo run test --force --continue` (not plain `pnpm test --force`: a `db` failure would skip dependent packages), then `pnpm gate`, with only the exceptions above. LF line endings.
- **Implementer runs have a hard time limit:** append each weakening's result to the task report as you see it, and commit as soon as the gate passes, before polishing the report.
- Second fresh-context review is required (authentication). The owner's assistant starts it when the PR opens.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed. Reports go to `.superpowers/sdd/task-N-report.md`.

## Shared definitions

- **Ops POST routes (eight):** `enrolment/start`, `enrolment/verify`, `passkey/register/options`, `passkey/register/verify`, `passkey/authenticate/options`, `passkey/authenticate/verify`, `session/refresh`, `session/end`, each under `/v1/ops/`.
- **Expected origin:** `https://` + `OPS_HOSTNAME` lower-cased; the request's `Origin` is lower-cased before comparing.
- **Cookie attributes:** set = `<name>=<value>; Secure; HttpOnly; SameSite=Strict; Path=/` with no `Max-Age`, `Expires` or `Domain`; clear = `<name>=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`.
- **Ops-host headers:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Strict-Transport-Security: max-age=31536000`.
- **OpsDeps:** `{ checkout: Checkout<Sql>, kms (a lazy getter, as in the other deps), keyArn, mail: OtpMail, now: () => Date, opsHostname: string, permissions: ReadonlyMap<string, readonly string[]>, log }`, built in `bindServices` (`index.ts`) from the shared `checkout` (`checkout("identity", run)` for operator functions, `checkout("platform", run)` for the directory). `permissions` defaults to the static map with the three role keys written literally (`platform_admin`, `platform_support`, `platform_security` → `["ops.directory.view"]`); identity does not export its role type and is not changed.
- **opsRpId:** `OPS_HOSTNAME` lower-cased, passed to every identity operator function that takes `opsRpId`. Test helpers sign with origin `https://ops.example.test` and that RP ID.
- **Identity calls:** written in full in the code, e.g. `readSessionWithKind(sql, kms, keyArn, { accessToken, now, kinds: ["enrolment"] })`.

## Deviations from the spec (repeated in the PR body)

1. **The permission map is a dependency** (`OpsDeps.permissions`), defaulting to the static map the spec names, so a test can prove a role without the permission gets 403. Production always uses the static map.
2. **`/health` on the ops host** keeps answering (it is `surface: "all"`), now with the ops-host headers. The spec does not mention it.
3. **`index.test.ts` production route assertions change**: the count goes from 22 to 32 and the exact route map gains the ten ops API routes. Static routes appear only when `OPS_STATIC_DIR` is set, which that test does not set.
4. **`packages/contracts/package.json` gains an `./ops` export** (the package has no index; each module is its own subpath export).
5. **Spec pin 5's refresh clause is a regression pin only**: `refreshOperatorSession` hard-codes `kinds: ["operator"]` in identity, which this chunk does not change, so no route-layer weakening can make that case fail.

## Security pins

The implementer weakens the source once as described, sees the named test fail, restores the source, and reports the failure output in the task report. A weakened tree is never committed.

| #   | Setting (spec pin)                                        | Test that pins it (Task)                                                                                                                                                                                                                                                                                                                        | Weakening that must make it fail                                                   |
| --- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1a  | Two `Set-Cookie` values reach the wire (1)                | `server.test.ts` "writes every Set-Cookie value" (T1): a route returns two appended cookies; the raw `set-cookie` header from `node:http` has both                                                                                                                                                                                              | Restore the `headers[key] = value` loop for every header                           |
| 1b  | Cookie attributes (1)                                     | `ops-cookies.test.ts` "sets session cookies with the full attribute set" (T5): exact strings, no `Max-Age`, `Expires` or `Domain`                                                                                                                                                                                                               | Drop `HttpOnly`                                                                    |
| 1c  | Tokens never in a body (1)                                | `ops-flow.integration.test.ts` "sign-in sets both cookies and returns only expiresIn" (T7): body keys are exactly `["expiresIn"]`; both cookies present                                                                                                                                                                                         | Add `accessToken` to the sign-in body                                              |
| 2   | `Origin` on every POST (2)                                | `ops-flow.integration.test.ts` "every ops POST refuses a missing, null or foreign Origin" (T6, extended in T7 to all eight): 403, and no new `otp_challenges`, `passkey_challenges`, `sessions`, `passkey_credentials` or `operator_events` rows                                                                                                | Accept a missing `Origin`                                                          |
| 3   | Host separation (3)                                       | `ops-flow.integration.test.ts` "ops routes are 404 on other hosts" (T7), sent with a valid `Origin` and, for `GET /v1/ops/me`, a valid operator cookie, so only the gate can answer 404 and `gate.test.ts` "static routes answer only on the ops host" (T2)                                                                                     | Remove the `ops_route_on_other_hostname` branch in `gate.ts`                       |
| 4   | Bearer ignored (4)                                        | `ops-flow.integration.test.ts` "an operator token as a bearer is not accepted" (T7)                                                                                                                                                                                                                                                             | Fall back to the `Authorization` header when the cookie is absent                  |
| 5a  | Enrolment session cannot read (5)                         | `ops-flow.integration.test.ts` "an enrolment cookie cannot read me or the directory" (T7); plus a regression case: an enrolment access token sent as `__Host-ops_rt` does not refresh (deviation 5)                                                                                                                                             | Read `/me` with `readSessionWithKind(["operator", "enrolment"])`                   |
| 5b  | Enrolment verify clears a stale refresh cookie (5)        | `ops-flow.integration.test.ts` "enrolment verify clears an operator refresh cookie" (T6)                                                                                                                                                                                                                                                        | Do not clear `__Host-ops_rt` on enrolment verify                                   |
| 6   | Enrolment start answers alike and does not wait (6)       | `ops-flow.integration.test.ts` "enrolment start answers 204 alike with and without a grant" (T6): mail port that never resolves (response arrives within the 5 s cap) and one that rejects (process survives; no unhandled rejection)                                                                                                           | (i) `await` the identity call; (ii) remove the `.catch`                            |
| 7   | Failures clear both cookies (7)                           | `ops-flow.integration.test.ts` "failed sign-in, refresh and enrolment verify clear both cookies" (T7)                                                                                                                                                                                                                                           | Return 401 on a failed refresh without clearing                                    |
| 8a  | Directory fields and role (8)                             | `communities.integration.test.ts` "listDirectory returns only the directory fields" (T4): exact `Object.keys` (in order) of each organisation and community, sort order, the 500 cap and `truncated`; runs as the `platform` role                                                                                                               | Select `*` from `platform.communities` and return rows unmapped (spread)           |
| 8b  | Directory permission (8)                                  | `ops-flow.integration.test.ts` "the directory needs ops.directory.view" (T7): operator with an empty permission map → 403; no session → 401                                                                                                                                                                                                     | Skip the permission check                                                          |
| 9   | Static serving (9)                                        | `ops-static.test.ts` (T3): listed files served with A4 headers; `/index.html`, a dotfile (`.secret.js`), a nested path, a disallowed extension, an upper-case extension, a symlinked file and a junction-linked `assets` directory are not routes; a missing directory, no `index.html` and a 5 MiB + 1 byte bundle each throw `StaticRejected` | (i) register `/index.html`; (ii) include dotfiles; (iii) remove the size check     |
| 10  | `assertRoutes` static rules (10)                          | `gate.test.ts` "rejects malformed static routes" (T2): `POST`, `surface: "tenant"`, `/assets/a/b.js`, `/assets/..`, `/x y`, `billing: \"read\"` and a `largeBody` static route each throw `RoutesRejected`                                                                                                                                      | Drop the surface check for static routes                                           |
| 11  | Sign-out ends a session with an expired access token (11) | `ops-flow.integration.test.ts` "sign-out after the access token expired ends the session" (T7): at `now + 16 min`, end → 204; the refresh cookie then fails                                                                                                                                                                                     | Return 204 without calling `endOperatorSession` when `readOperatorSession` is null |
| 12  | Duplicate or malformed cookies are absent (12)            | `ops-cookies.test.ts` "treats duplicate and malformed cookies as absent" (T5)                                                                                                                                                                                                                                                                   | Take the first value of a duplicated name                                          |
| 13  | Ops-host headers on every ops response (13)               | `gate.test.ts` "adds the ops-host headers to every ops-host response" (T2): a gate 404, a route 200 and `/health` on the ops host carry them; an api-host response does not                                                                                                                                                                     | Add the headers only to responses that came from a route                           |
| 14  | Body checked after `Origin` (14)                          | `ops-flow.integration.test.ts` "a malformed body is 400 only after a valid Origin" (T6): bad JSON with a foreign `Origin` is 403, with the right `Origin` 400, and nothing changes                                                                                                                                                              | Parse the body before the `Origin` check                                           |

Regression (not a weakening): every existing `apps/api`, tenancy and contracts suite passes unchanged.

## Rollback

| Point        | Rollback                                                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before merge | Revert with new commits.                                                                                                                                                                           |
| After merge  | Revert the merge. No migration, no infrastructure or secret change. Without `OPS_STATIC_DIR` no static route exists; the ops routes are new and unused by any client until `ops-console-ui` ships. |

## Stop and ask (AGENTS.md §12)

Implementer, stop and report if:

- the plan or spec is wrong or ambiguous, or a test cannot be written as described;
- a change is needed in `modules/core/identity`, a migration, Terraform, a Dockerfile, a workflow, `turbo.json`, a `package.json` (other than the contracts `./ops` export), a `tsconfig*.json`, an ESLint config or a checker;
- an existing test assertion needs changing (other than the two named in Global constraints);
- a concurrency or detached-work test hangs or is order-dependent;
- the same step fails twice; or a command fails to start (process creation error): report which steps remain, retry at most once.

---

### Task 1: Send every `Set-Cookie` value

**Files:** Modify `apps/api/src/server.ts`, `apps/api/src/server.test.ts`.

**Shape (spec A11):** `writeResponse` (`server.ts:66-74`) builds headers from `response.headers` as today, except `set-cookie`, which it takes from `response.headers.getSetCookie()` and passes to `res.writeHead` as an array. No other behaviour changes.

**Test first (RED):** pin 1a; plus a response with no cookies keeps today's headers.

**Rule this must not break:** every existing `server.test.ts` case.

**Commit subject:** `fix(api): send every Set-Cookie header`

- [ ] RED, GREEN. Pin 1a.
- [ ] `pnpm --filter @community-hub/api test`, `pnpm gate`.

### Task 2: Gate — static routes and ops-host headers

**Files:** Modify `apps/api/src/gate.ts`, `apps/api/src/gate.test.ts`.

**Shape (spec A4, A5):**

- `GateRoute` gains `static?: true`. `assertRoutes` throws `RoutesRejected` for a static route unless `method === "GET"`, `surface === "ops"`, `billing === "exempt"`, no `largeBody`, and the pattern is `/`, `/<name>` or `/assets/<name>` with `<name>` matching `^[A-Za-z0-9._-]+$` and not `.` or `..`.
- In `createGate`'s returned handler, when the presented hostname is the ops host, every response (gate 404s, the kernel's responses) is returned as a new `Response(response.body, { status, headers })` where `headers = new Headers(response.headers)` plus the ops-host headers (this copy keeps every `Set-Cookie` value; a `forEach`/`set` copy would not). Requests on other hosts are untouched.

**Test first (RED):** pins 10, 13, and the static half of pin 3; plus an ops-host route that appends two cookies keeps both after the wrap (a valid static route on the api host is 404 with `reason: "ops_route_on_other_hostname"`).

**Rule this must not break:** every existing `gate.test.ts` case; no header change for non-ops hosts.

**Commit subject:** `feat(api): let the gate carry static ops routes and ops-host headers`

- [ ] RED, GREEN. Pins 3 (static), 10, 13.
- [ ] `pnpm --filter @community-hub/api test`, `pnpm gate`.

### Task 3: Static serving from `OPS_STATIC_DIR`

**Files:** Create `apps/api/src/ops-static.ts`, `apps/api/src/ops-static.test.ts`. Modify `apps/api/src/env.ts`, `apps/api/src/env.test.ts`, `apps/api/src/index.ts`, `apps/api/src/index.test.ts`.

**Shape (spec A3, A4):**

- `export class StaticRejected extends Error { readonly code = "static" }`.
- `loadOpsStatic(dir: string): GateRoute[]`: synchronous read at boot. Lists `dir` and `dir/assets` only (no recursion); skips dotfiles, symlinks (`lstat`), directories other than `assets`, and files whose extension is not exactly one of the lower-case allow-list. Requires `index.html` at the top level. Sums file sizes; over 5 MiB (5 × 1024 × 1024 bytes) throws. A missing or unreadable directory throws. Each file becomes `{ method: "GET", pattern, surface: "ops", billing: "exempt", static: true, handle }` with the bytes in memory; `index.html` maps to `/` only. `handle` returns the bytes with `Content-Type` from the spec's table, `Content-Length`, the CSP, `Cross-Origin-Opener-Policy: same-origin`, and the cache rule (`no-cache` for `index.html`, `public, max-age=31536000, immutable` otherwise).
- `env.ts`: optional `OPS_STATIC_DIR`, read with the existing `text()` helper, which treats an empty string as unset.
- The 5 MiB sum counts the files that would be served, not skipped ones.
- `index.ts`: `run()` and `productionRoutes()` append `loadOpsStatic(env.OPS_STATIC_DIR)` when set. `run()` catches `StaticRejected` as it catches `RoutesRejected` (`index.ts:81-86`), writing `static\n` to stderr and returning 1; `boot()` passes the code to `exit`.

**Test first (RED):** pin 9 against a temporary directory built in the test (outside the repo, removed after). The `assets` junction case (`fs.symlinkSync(target, link, "junction")`, no privilege needed) runs everywhere; the file-symlink case tries `fs.symlinkSync` and, on `EPERM` or `EACCES` (Windows without developer mode), skips only that case with `ctx.skip()` and says so in the report; `env.test.ts` cases for set, unset and empty; `index.test.ts` case: `run()` with a bad `OPS_STATIC_DIR` returns 1 and writes `static`.

**Rule this must not break:** without `OPS_STATIC_DIR`, routes and behaviour are unchanged.

**Commit subject:** `feat(api): serve a static ops bundle from OPS_STATIC_DIR`

- [ ] RED, GREEN. Pin 9.
- [ ] `pnpm --filter @community-hub/api test`, `pnpm gate`.

### Task 4: The directory read and the permission key

**Files:** Modify `modules/core/tenancy/infrastructure/communities.ts`, `communities.integration.test.ts`, `modules/core/tenancy/public/index.ts`, `modules/core/tenancy/module.manifest.ts`, `modules/core/tenancy/domain/manifest.test.ts`.

**Shape (spec A6, A7):**

- `listDirectory(platform: Sql | TransactionSql): Promise<{ organisations: { id, slug, kind, region, communities: { id, slug }[] }[]; truncated: boolean }>`: one query for the first 501 organisations by `slug collate "C"` (only those four columns), one for their communities (only `id`, `organisation_id`, `slug`) ordered by slug; returns at most 500 with `truncated` true when 501 came back. Exported from `public/`.
- Manifest: `permissions: ["ops.directory.view"]`; the manifest test's expected object gains it.

**Test first (RED):** pin 8a with synthetic organisations and communities inserted for the test. The cap case runs entirely inside one `platform` transaction that inserts 501 organisations, calls `listDirectory(tx)`, asserts 500 rows and `truncated === true`, then throws a sentinel to roll back, so it holds whatever other rows exist and leaves nothing. Other cases assert only on rows with the test's own slug prefix. `listDirectory` orders with `collate "C"` so the order does not depend on the database collation. Plus the manifest expectation.

**Rule this must not break:** existing tenancy functions and tests; the `platform` role reads only `platform` tables.

**Commit subject:** `feat(tenancy): list the operator directory`

- [ ] RED, GREEN. Pin 8a.
- [ ] `pnpm --filter @community-hub/tenancy build`, tenancy tests, `pnpm gate`.

### Task 5: Ops contracts, cookies and the `Origin` check

**Files:** Create `packages/contracts/src/ops.ts`, `packages/contracts/src/ops.test.ts`, `apps/api/src/ops-cookies.ts`, `apps/api/src/ops-cookies.test.ts`. Modify `packages/contracts/package.json`: add the `"./ops"` export entry, in the same form as `"./billing"` (deviation 4). Nothing else in that file.

**Shape (spec A1, A2, A11, Contracts):**

- `ops.ts`: Zod schemas for every request body and response body in the spec's Contracts table (strict objects; byte fields are base64url strings; `email` a string; codes strings).
- `ops-cookies.ts`: `setSessionCookies(headers, { access, refresh? })`, `clearSessionCookies(headers)`, `readOpsCookie(request, name)` (strict parse: `name=value` pairs split on `; `; a duplicate name, a pair without `=`, or a value not matching `^[A-Za-z0-9_-]+$` → `undefined`), `originAllowed(request, opsHostname)`, and `readJson(request, schema)` → parsed value or `undefined`.

**Test first (RED):** pins 1b, 12; Origin cases (exact, upper-case host, trailing slash, `null`, missing, other host, `http://`); schema accept and reject cases.

**Rule this must not break:** existing contracts exports and tests.

**Commit subject:** `feat(api): add ops contracts and operator cookies`

- [ ] RED, GREEN. Pins 1b, 12.
- [ ] `pnpm --filter @community-hub/contracts build`, contracts and api tests, `pnpm gate`.

### Task 6: Ops routes — enrolment and passkey registration, and wiring

**Files:** Create `apps/api/src/ops-routes.ts`, `apps/api/src/ops-flow.integration.test.ts`. Modify `apps/api/src/index.ts` (`OpsDeps` in `bindServices`; `opsRoutes(bound.ops)` in `run()` and `productionRoutes()`) and `apps/api/src/index.test.ts` (deviation 3: count 32 and the ten ops entries).

**Shape (spec A2, A8, A9, Behaviour 1–2):**

- `opsRoutes(deps: OpsDeps): GateRoute[]`, all `surface: "ops"`, `billing: "exempt"`. Every `POST` handler: `originAllowed` first (403, nothing read), then `readJson` (400), then work. Every API response has `cache-control: no-store`.
- `enrolment/start`: 204; `void Promise.resolve().then(() => startOperatorEnrolment(...)).catch(() => deps.log("ops_enrolment_start_failed"))` with no address in the log.
- `enrolment/verify`: as spec Behaviour 1 (set access cookie and clear refresh; or clear both).
- `passkey/register/options` and `verify`: as spec A9 (401 without the access cookie; `false` → 400; `200 {activated}` using `readSessionWithKind(["enrolment"])` after a successful finish; clear the access cookie when activated).
- Test setup builds the real routes with `MemoryMail`, the local KMS port, and a `checkout` that switches on role: an identity-role `Sql` (`createPlaintextIdentitySql`) for `"identity"` and a platform-role `Sql` (`createPlaintextPlatformSql`) for `"platform"`, against the test database; grants an operator with `grantOperator`, and drives enrolment and registration through `fetch` against `startServer` with the `x-community-hub-hostname` header set to `ops.example.test` and `Origin: https://ops.example.test`.

**Test first (RED):** pins 2 (the four routes in this task), 5b, 6, 14. For pin 6: every `fetch` carries `AbortSignal.timeout(5000)` so weakening (i) fails rather than hangs; the test registers `process.on("unhandledRejection", spy)`, polls (20 ms, 5 s cap) until the injected `log` has received `ops_enrolment_start_failed`, then asserts `spy` was not called and removes the listener; every detached-start test waits for its detached work to settle before it ends, so no late write races another test or `afterAll`; "alike" compares status, body and the `cache-control` and `set-cookie` headers (not `date` or request ids); plus: enrolment verify success sets only the access cookie; registering two passkeys returns `activated: false` then `true`; a third call after activation is 401.

**Rule this must not break:** tenant routes and their tests unchanged; no address, code or token in a log line.

**Commit subject:** `feat(api): add ops enrolment and passkey registration routes`

- [ ] RED, GREEN. Pins 2 (part), 5b, 6, 14.
- [ ] Contracts and tenancy built; `pnpm --filter @community-hub/api test` (unit and integration); `pnpm gate`.

### Task 7: Ops routes — sign-in, me, refresh, sign-out, directory

**Files:** Modify `apps/api/src/ops-routes.ts`, `apps/api/src/ops-flow.integration.test.ts`.

**Shape (spec A1, A6, A10, Behaviour 3–7):**

- `passkey/authenticate/options` and `verify`; `GET /v1/ops/me` (`readOperatorSession`; `{roles}`); `session/refresh` (`refreshOperatorSession` with the refresh cookie; set both or clear both); `session/end` (if an access cookie is present call `endOperatorSession` regardless of whether it still reads; always 204 and clear both); `GET /v1/ops/directory` (`readOperatorSession`, then the permission map, then `listDirectory` through `deps.platform`).
- Tokens only in cookies; bodies only `{expiresIn}`, `{roles}`, or the directory.

**Test first (RED):** pins 1c, 2 (all eight routes), 3 (API routes), 4, 5a, 7, 8b, 11; plus: the full flow grant → enrol → two passkeys → sign in → me → directory → refresh (`expiresIn` 900 at `now`, then below 900 when the injected `now` is set 7 h 50 min after sign-in) → sign out → me 401. Directory assertions look only for the test's own organisation ids and never assert `truncated: false` or a total count.

**Rule this must not break:** every existing suite; no token in a body or log.

**Commit subject:** `feat(api): add ops sign-in, session and directory routes`

- [ ] RED, GREEN. Pins 1c, 2, 3, 4, 5a, 7, 8b, 11.
- [ ] `pnpm --filter @community-hub/api test` (unit and integration), `pnpm gate`.

### Task 8: Architecture and catalogue (last task on this branch)

**Files:**

- Modify `architecture.md` §8.5 Ops console row (`:484`): "with passkeys" → "with passkeys and cookie-held operator sessions". Nothing else.
- Modify `docs/roadmap.md`: the `ops-console-api` row (`:129`) **done**, its description rewritten to "Ops routes, cookie-held operator sessions, static serving on the ops host, and the read-only directory. Spec `docs/specs/2026-10-25-ops-console-api.md`." (dropping the one-off, which moved); add a row after it: `not started | ops-operator-oneoff | The ops-operator one-off, the provision-owner shape refusal, the operator runbook including recovery, and the PR #62 follow-ups.`; snapshot (`:24-25`) last shipped `ops-console-api`, next `ops-operator-oneoff`; the "Next is" line (`:99`) and the Next spec sentence (`:312`) name `ops-operator-oneoff`. Phase 0 counts unchanged.
- Modify `AGENTS.md` Repository state row (it currently ends the done list with `ops-operator-identity` and says "Next is `ops-console-api`."): add `ops-console-api` to the done list; "Next is `ops-operator-oneoff`."

**Test first:** none (docs). `pnpm gate` (format).

**Commit subject:** `docs: record the ops console API in architecture and roadmap`

- [ ] `rm -f docs/plans/*-report.md`; `git status --short` shows only this task's files.
- [ ] `pnpm turbo run test --force --continue`, then `pnpm gate` (Windows exceptions only).

## Definition of done (AGENTS.md §8)

- All eight tasks committed, each reviewed by diff with its security pins reported.
- Local full test run and `pnpm gate` green apart from the Windows exceptions; CI green on the PR.
- No file under `infra/`, `.github/`, `modules/core/identity` or any Dockerfile changed; no existing assertion changed except the tenancy manifest expectation.
- Staging parked. Staging verification: none possible until `ops-console-ui` ships a bundle and `ops-console-proof` runs; stated in the PR body.
- `architecture.md`, roadmap and `AGENTS.md` updated in this PR, last.
- The PR body lists the implementer and reviewer configurations, the owner's check, the second-review line, the deviations, and the changed-line count (estimate 650–800 source and 800–1,000 test lines).
- No `docs/plans/*-report.md` on disk, and nothing under `.superpowers/` staged.

## Probe record

No Terraform in this chunk; no probe needed (AGENTS.md §4 Phase 2).
