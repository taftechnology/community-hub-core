# Plan: kernel runtime

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `defineModule` / `defineEvent`, ALS request context, an organisation-scoped `app.outbox` table, and the payload/duplicate-name gates, without putting Postgres or Zod on the gateway graph.

**Architecture:** Kernel owns types and ALS; it never binds the transaction type parameter. db owns the branded client, `withOrgTransaction`, and the adapter (one-way import of `@community-hub/kernel/module`). Gateway imports `@community-hub/kernel` only. `withRequest` wraps **inside** the function `createFetch` returns (not around `export default`), so both `SELF.fetch` and `createFetch(logger)` see a populated store. `/health` still returns `healthPayload()`.

**Tech Stack:** Node 24 + workerd (`nodejs_als`), `zod@4.6.5` (exact, `/module` only), Drizzle 0.45.2, postgres.js 3.4.9, existing Docker Postgres 17 + PgBouncer, typescript-eslint, Vitest.

**Spec:** `docs/specs/2026-09-19-kernel-runtime.md` (approved 2026-09-19, Abdus Salam)

Status: approved

**Branch:** `feat/2026-09-19-kernel-runtime` · one PR · 9 tasks, one commit each

## Global Constraints

- Kernel never imports `@community-hub/db`, `postgres`, or Drizzle — including `import type`.
- Gateway never imports `@community-hub/db` or `@community-hub/kernel/module` (including `import type`).
- `zod@4.6.5` is an exact dependency of the kernel `/module` entry only. Gateway dry-run graph must not list `zod`.
- `OutboxPort<Tx>` is never bound in kernel. db supplies `Tx`.
- `idempotency_key` is `NOT NULL` and comes from ALS, never `newId()` at publish.
- Insert `org_id` from `current_setting('app.org_id')::uuid`, not a caller argument.
- `withOrgTransaction` is a separate function; `withAppTransaction` still requires both ids.
- No Queue, `waitUntil`, sweeper, claim/retry columns, FIFO, RFC 9457, or `residency-payload` changes.
- Last commit updates `docs/roadmap.md` (`kernel-runtime` **done**) and architecture §8.3 / §12.1.
- Session scratch is never committed.
- Gateway mints `requestId` with `crypto.randomUUID()` (or an inbound request-id header). It must not import `newId()` from `@community-hub/db`. For `/health`, `idempotencyKey` equals `requestId`.
- `withRequest` wraps **inside** the function `createFetch` returns. Do not wrap only `export default { fetch }` — `createFetch(logger)` is a direct test path and would then run with an empty store. An empty store throwing is a fail, not a reason to make context optional.
- `app.outbox` is visible to Drizzle Kit through `packages/db/src/schema.ts` (`drizzle.config.ts` schema path is exactly `./src/schema.ts`).

**Stop and report** (do not work around):

- `nodejs_als` is not accepted at the pinned `compatibility_date` of `2026-03-10`.
- `AsyncLocalStorage` is not usable in the Workers test pool (`@cloudflare/vitest-pool-workers`).

In either case: **stop**. Do not drop `withRequest` from the gateway. Do not move the context onto a function argument. Do not switch the gateway to Node-only tests and call the workerd path done.

---

## Tooling decisions this plan makes

| Choice             | Decision                                                                                                                                                                         | Why                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Kernel entries     | `@community-hub/kernel` = `healthPayload` + `withRequest`. `@community-hub/kernel/module` = `defineModule`, `defineEvent`, `bindPublisher`, `OutboxPort`, health `defineModule`. | Combined index would put Zod in the gateway graph even with tree-shaking hopes.                         |
| Publisher          | `bindPublisher(module, outbox)` does ALS read, `publishes` check, Zod `parse`, then `outbox.append`. Adapter only inserts.                                                       | Kernel owns the rules; db owns SQL.                                                                     |
| Brand              | `OrgTransaction` / `AppTransaction` are `TransactionSql` plus a unique-symbol brand, cast at the `with*Transaction` callback.                                                    | Pooled `Sql` is not assignable.                                                                         |
| Duplicate names    | New `@community-hub/check-event-names` under `tooling/checks`, wired in `run.ts`.                                                                                                | Turbo ESLint cannot see two packages.                                                                   |
| Restricted imports | Root `eslint.config.js` `no-restricted-imports` plus the same patterns in the encrypted-column fixture ESLint (must-fail gateway-shaped files).                                  | Spec asked for ESLint, not a new checker.                                                               |
| Zod pin            | `4.6.5` exact.                                                                                                                                                                   | Same pin style as `drizzle-orm` / `postgres`.                                                           |
| Event name         | Shared regex string in kernel and the ESLint rule (comment: must match the spec). Do not import kernel from the plugin.                                                          | Plugin is plain ESM JS with no kernel build edge.                                                       |
| Kit schema         | `app.outbox` is defined in `outbox.ts` **and re-exported from `schema.ts`**.                                                                                                     | `drizzle.config.ts` schema is exactly `./src/schema.ts`.                                                |
| Workerd ALS        | Gateway test reads `getRequestContext()` on the `/health` path under the Workers pool. Wrapping lives inside `createFetch`.                                                      | Same Node-versus-workerd gap as crypto. `SELF.fetch` and `createFetch(logger)` must both see the store. |
| Named conflict     | Adapter hard-codes Kit's `conname`; a `pg_constraint` test locks it.                                                                                                             | `onConflictDoNothing` in 0.45.2 cannot take a constraint name.                                          |

**Rollback:** revert the PR. Docker data is disposable. Nothing applied to RDS.

---

## File map

| Path                                                            | Role                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `packages/kernel/src/request.ts`                                | ALS `withRequest` / `getRequestContext`                          |
| `packages/kernel/src/health.ts`                                 | Unchanged `healthPayload`                                        |
| `packages/kernel/src/index.ts`                                  | Re-exports health + request only                                 |
| `packages/kernel/src/event.ts`                                  | Name regex, `defineEvent`                                        |
| `packages/kernel/src/define-module.ts`                          | `defineModule`                                                   |
| `packages/kernel/src/health-module.ts`                          | Live `defineModule` with `publishes: []`                         |
| `packages/kernel/src/outbox-port.ts`                            | `OutboxPort<Tx>`, `bindPublisher`                                |
| `packages/kernel/src/module.ts`                                 | `/module` barrel                                                 |
| `packages/kernel/package.json`                                  | `exports` `.` and `./module`; `zod` `4.6.5`                      |
| `apps/gateway/src/index.ts`                                     | `withRequest` inside the function `createFetch` returns          |
| `apps/gateway/wrangler.jsonc`                                   | `compatibility_flags: ["nodejs_als"]`                            |
| `packages/db/src/tx.ts`                                         | Brands + `withOrgTransaction`                                    |
| `packages/db/src/app-transaction.ts`                            | Keep requiring both ids; brand `AppTransaction`                  |
| `packages/db/src/outbox.ts`                                     | Drizzle table `app.outbox`                                       |
| `packages/db/src/schema.ts`                                     | Re-exports the outbox table (required: Kit reads only this file) |
| `packages/db/src/outbox-adapter.ts`                             | `append` implementation                                          |
| `packages/db/drizzle/0001_*.sql`                                | Kit generate + hand `FORCE ROW LEVEL SECURITY`                   |
| `tooling/eslint-plugin-community-hub/rules/no-event-payload.js` | Type-aware payload + name rule                                   |
| `tooling/checks/encrypted-column/fixtures/`                     | Payload + restricted-import fixtures                             |
| `tooling/checks/event-names/`                                   | Duplicate-name checker                                           |
| `tooling/checks/sql-session-ban/`                               | Timeout exception + fixtures                                     |
| `tooling/checks/worker-config/`                                 | Scan app `src` for kernel value imports                          |
| `eslint.config.js`                                              | New rule + `no-restricted-imports`                               |
| `tooling/checks/run.ts`                                         | Wire event-names                                                 |
| `docs/adr/`                                                     | none                                                             |
| `architecture.md`                                               | §8.3, §12.1                                                      |
| `docs/roadmap.md`                                               | last commit                                                      |

Do not add `packages/contracts`. Do not edit merged specs other than this chunk's spec status (already approved).

---

## Interfaces (locked for later tasks)

```ts
// @community-hub/kernel (packages/kernel/src/request.ts)
export type RequestContext = { requestId: string; idempotencyKey: string };
export function withRequest<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T>;
export function getRequestContext(): RequestContext; // throws if missing

export function healthPayload(): { ok: true };

// @community-hub/kernel/module
export const EVENT_NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.v[1-9][0-9]*$/;

export type DefinedEvent<S extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  payload: S;
};
export function defineEvent<S extends z.ZodTypeAny>(spec: {
  name: string;
  payload: S;
}): DefinedEvent<S>; // throws if name fails EVENT_NAME_RE

export type ModuleDefinition = {
  key: string;
  version: number;
  requires: string[];
  publishes: string[];
  subscribes: string[];
  ports: string[];
  entitlement?: string;
  features?: string[];
  permissions?: string[];
  websiteWidgets?: string[];
  dataClasses?: Record<string, string>;
};
export function defineModule(def: ModuleDefinition): ModuleDefinition;

export type OutboxPort<Tx> = {
  append(
    tx: Tx,
    row: { eventName: string; payload: unknown; idempotencyKey: string },
  ): Promise<{ id: string }>;
};

export function bindPublisher<Tx>(
  module: ModuleDefinition,
  outbox: OutboxPort<Tx>,
): {
  publish(tx: Tx, event: DefinedEvent, payload: unknown): Promise<{ id: string }>;
};
```

`bindPublisher().publish`:

1. `getRequestContext()` (throw if missing).
2. Throw if `event.name` is not in `module.publishes`.
3. `event.payload.parse(payload)` (throw on failure).
4. `outbox.append(tx, { eventName: event.name, payload: parsed, idempotencyKey: ctx.idempotencyKey })`.

```ts
// packages/db
declare const appTxBrand: unique symbol;
declare const orgTxBrand: unique symbol;
export type AppTransaction = TransactionSql & { readonly [appTxBrand]: "app" };
export type OrgTransaction = TransactionSql & { readonly [orgTxBrand]: "org" };

export function withAppTransaction<T>(
  sql: Sql,
  scope: { orgId: string; communityId: string },
  fn: (tx: AppTransaction) => Promise<T>,
): Promise<T>;

export function withOrgTransaction<T>(
  sql: Sql,
  orgId: string,
  fn: (tx: OrgTransaction) => Promise<T>,
): Promise<T>; // sets app.org_id only

export function createOutbox(): OutboxPort<AppTransaction | OrgTransaction>;
```

`append` SQL (illustrative — postgres.js uses tagged-template interpolation, not `$n` placeholders):

```sql
INSERT INTO app.outbox (id, org_id, event_name, payload, idempotency_key)
VALUES (${id}, current_setting('app.org_id')::uuid, ${name}, ${payload}::jsonb, ${key})
ON CONFLICT ON CONSTRAINT <kit-generated-name> DO NOTHING
RETURNING id
```

If no row: `SELECT id FROM app.outbox WHERE org_id = current_setting('app.org_id')::uuid AND event_name = ${name} AND idempotency_key = ${key}`. Mint `id` with `newId()` in db. Do not send `occurred_at` (DEFAULT `now()`).

The adapter uses a postgres.js `sql` tagged template, not Drizzle's query builder. In drizzle-orm 0.45.2, `onConflictDoNothing` takes only column targets, so the named-constraint form cannot be expressed there. Do not rewrite this as `sql.raw` — `@community-hub/no-encrypted-column-query` bans it.

Banned payload keys (ESLint + spec, one list in the rule file): `name`, `email`, `emailAddress`, `e_mail`, `full_name`, `fullName`, `dob`, `dateOfBirth`, `address`, `phone`, `notes`, `note`, `comment`, `label`, `amount`.

---

### Task 1: ALS request context and gateway `/health`

**Files:** `packages/kernel/src/request.ts`, `request.test.ts`, `index.ts`; `apps/gateway/src/index.ts`; `apps/gateway/wrangler.jsonc`; `apps/gateway` tests.

**Interfaces:** Produces `withRequest`, `getRequestContext`, `RequestContext`. Consumes unchanged `healthPayload`.

**Must not break:** `GET /health` still `{ ok: true }`. Kernel `.` export must not import `./module.js`. Gateway must not import `@community-hub/db` (so it cannot call `newId()`).

**Stop and report** if Wrangler rejects `nodejs_als` at `compatibility_date` `2026-03-10`, or if `getRequestContext()` throws / is empty under `@cloudflare/vitest-pool-workers`. Do not drop `withRequest` from the gateway. Do not pass context as an argument.

- [ ] **Step 1:** Failing tests in `packages/kernel/src/request.test.ts` (Node): `getRequestContext()` throws outside `withRequest`; two `Promise.all` `withRequest` calls keep distinct `requestId` / `idempotencyKey`; nested `withRequest` sees the inner context and restores the outer after. Failing workerd test in `apps/gateway/src/index.test.ts` using `createFetch` (so the structured log is visible): the `/health` handler **must** call `getRequestContext()` on the same path that returns `healthPayload()`, log that `requestId` (not a second mint), and the test asserts the logged value is a non-empty UUID and that `idempotencyKey` equals `requestId` (handler may compare the two fields and throw on mismatch; a 500 from an empty store is a fail, not a skip). `{ ok: true }` alone is not this test — kernel Node tests would still pass if the workerd store were empty.
- [ ] **Step 2:** Run `pnpm test --filter @community-hub/kernel --filter @community-hub/gateway`. Expected: FAIL (ALS module missing / context not read on the Worker path).
- [ ] **Step 3:** Implement ALS. `index.ts` exports only `healthPayload`, `withRequest`, `getRequestContext`. Inside the function **`createFetch` returns** (not around `export default { fetch }`): mint `requestId` with `crypto.randomUUID()` (or an inbound request-id header if present), then wrap the rest of that function in `withRequest({ requestId, idempotencyKey: requestId })`. Both `SELF.fetch` (default export) and the log test's `createFetch(logger)` must hit this wrap. Do not make `getRequestContext()` optional if a direct-call test sees an empty store — that is the banned escape hatch; the wrap is in the wrong place. The handler reads `getRequestContext()` (use that `requestId` for the structured log — one mint, not a second UUID). Wrangler: `"compatibility_flags": ["nodejs_als"]`.
- [ ] **Step 4:** Kernel tests pass. Gateway workerd tests pass, including the populated-context assertion and existing `{ ok: true }`. If ALS is empty under workerd, stop and report.
- [ ] **Step 5:** Commit

```
feat(kernel): store request id and idempotency key in AsyncLocalStorage

Gateway /health still returns healthPayload(), now inside withRequest.
nodejs_als is set so workerd can run the store.

Refs: docs/plans/2026-09-19-kernel-runtime.md task 1
```

---

### Task 2: `defineModule`, `defineEvent`, `bindPublisher`

**Files:** `packages/kernel/src/event.ts`, `define-module.ts`, `health-module.ts`, `outbox-port.ts`, `module.ts`, `*.test.ts`; `packages/kernel/package.json` (`zod`: `4.6.5` exact, `exports["./module"]`); `pnpm-lock.yaml`.

**Interfaces:** Consumes `getRequestContext`. Produces `/module` exports. `OutboxPort<Tx>` unbound.

- [ ] **Step 1:** Failing tests: `defineEvent` rejects a bad name; `bindPublisher` throws outside `withRequest`; throws when the event is not in `publishes`; throws when Zod parse fails; in-memory `OutboxPort` receives parsed payload and ALS key (not a fresh id); health module `publishes` is `[]`.
- [ ] **Step 2:** `pnpm test --filter @community-hub/kernel` FAIL.
- [ ] **Step 3:** Implement. `index.ts` still must not import `module.ts`. In-memory port is test-only.
- [ ] **Step 4:** Tests pass. `pnpm typecheck --filter @community-hub/kernel`.
- [ ] **Step 5:** Commit

```
feat(kernel): add defineModule, defineEvent, and bindPublisher

Zod 4.6.5 lives on the /module entry only. OutboxPort stays generic.

Refs: docs/plans/2026-09-19-kernel-runtime.md task 2
```

---

### Task 3: ESLint event payload rule

**Files:** `tooling/eslint-plugin-community-hub/rules/no-event-payload.js`; plugin `index.js` / `index.d.ts`; `eslint.config.js` (enable `@community-hub/no-event-payload`); `tooling/checks/encrypted-column/fixtures/fail|pass/` (see spec list); `selftest.ts`; `AGENTS.md` §10 rule name; `no-restricted-disable` must include the new id.

**Must-fail:** free-form `z.string()`, banned key with allowed type, `z.record`, `.passthrough()`, unreadable `.extend()`, nested object containing any of those, invalid event name, imported schema with a banned key / free-form string.

**Must-pass:** ids, enums, boolean, timestamp, imported ids-only schema.

- [ ] **Step 1:** Add fixtures and selftest rows (counts). Run `pnpm test --filter @community-hub/check-encrypted-column`. Expected: FAIL (missing fixtures or 0 hits).
- [ ] **Step 2:** Implement the type-aware rule; fail closed on unreadable shapes. Copy `EVENT_NAME_RE` source text.
- [ ] **Step 3:** Tests pass (include the new cases). `pnpm lint` green on kernel health module.
- [ ] **Step 4:** Commit

```
feat(tooling): lint defineEvent payloads by allowed value types

Fail closed on z.record, passthrough, and unreadable extend.
Banned keys are a second line.

Refs: docs/plans/2026-09-19-kernel-runtime.md task 3
```

---

### Task 4: Duplicate event-name checker

**Files:** `tooling/checks/event-names/` (`check.ts`, `selftest.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, fixtures); `tooling/checks/run.ts`.

Live globs: `packages/*/src`, `apps/*/src`, `modules/**`. Day-one input: `packages/kernel/src/health-module.ts`. Zero `defineModule`/`defineEvent` in those globs → notice **and** `ok: false`.

- [ ] **Step 1:** Must-fail fixture (two modules, same `publishes` name). Must-pass (name once). Empty-tree fixture fails with a notice. Selftest written first.
- [ ] **Step 2:** Implement walk of `defineEvent({ name })` and `defineModule({ publishes })`. Wire `run.ts`.
- [ ] **Step 3:** `pnpm test --filter @community-hub/check-event-names` and `pnpm check:boundaries` pass on the live tree (health module present).
- [ ] **Step 4:** Commit

```
feat(tooling): fail duplicate event names across the repo

Turbo lint cannot see two packages. The health defineModule is the
day-one live declaration.

Refs: docs/plans/2026-09-19-kernel-runtime.md task 4
```

---

### Task 5: `sql-session-ban` migration timeouts

**Files:** `tooling/checks/sql-session-ban/check.ts`, `README.md`, `selftest.ts`, new fixtures.

Allow only `SET LOCAL lock_timeout` and `SET LOCAL statement_timeout` in `packages/db/drizzle/**/*.sql` and `packages/db/drizzle-test/**/*.sql`.

Must-fail: same `SET LOCAL` in `packages/db/src`; `SET LOCAL work_mem` in drizzle SQL; session `SET lock_timeout` in drizzle SQL. Existing `set-local` fixture still fails.

Must-pass: `SET LOCAL lock_timeout` in a drizzle-shaped SQL file.

- [ ] **Step 1:** Fixtures + selftest rows. Run tests. FAIL until the checker changes.
- [ ] **Step 2:** Implement the exception. Existing bans unchanged.
- [ ] **Step 3:** Tests pass. `pnpm check:boundaries`.
- [ ] **Step 4:** Commit

```
fix(tooling): allow SET LOCAL lock_timeout in migration SQL

Session SET and any other SET LOCAL stay banned. First product table
must not teach "never set timeouts."

Refs: docs/plans/2026-09-19-kernel-runtime.md task 5
```

---

### Task 6: worker-config ALS and restricted imports

**Files:** `tooling/checks/worker-config/check.ts` (parse `compatibility_flags`; scan `apps/<name>/src/**/*.ts` for value `from "@community-hub/kernel"` or `/module`; `import type` does not count); fixtures `kernel-import-no-als` (must-fail), update `valid-global` to include the flag if it value-imports kernel; `eslint.config.js` `no-restricted-imports` for `apps/gateway/**` and `packages/kernel/**` blocking `@community-hub/db` (paths and types) and for `apps/gateway/**` blocking `@community-hub/kernel/module`; encrypted-column fixtures `fail/apps/gateway/src/import-db.ts` and `import-type-db.ts` with the same restricted-imports config in `selftest.ts`.

- [ ] **Step 1:** worker-config selftest FAIL on new fixture. ESLint fixture FAIL (0 hits).
- [ ] **Step 2:** Implement. Live gateway already has `nodejs_als` from T1.
- [ ] **Step 3:** Checker tests + encrypted-column fixtures pass. `pnpm lint` on gateway/kernel green.
- [ ] **Step 4:** Commit

```
feat(tooling): require nodejs_als when a Worker imports kernel

no-restricted-imports also bans db from gateway and kernel, including
import type.

Refs: docs/plans/2026-09-19-kernel-runtime.md task 6
```

---

### Task 7: `withOrgTransaction`

**Files:** `packages/db/src/tx.ts` (or extend `app-transaction.ts`), `index.ts`; `packages/db/test/pooling.integration.test.ts` (and/or a new `org-transaction.integration.test.ts`).

- [ ] **Step 1:** Failing tests: `withOrgTransaction` + `select current_setting('app.community_id')` fails (see error note below); `select` from `app.synthetic_community` (policy reads `app.community_id`) fails loudly; `hub_reuse` after `withAppTransaction` does not leak `community_id` into a following `withOrgTransaction`; `withAppTransaction` still requires `communityId` (typecheck).

  **Unset GUC on a reused connection.** `set_config(..., true)` is transaction-local. Once a custom GUC has been set in a session, Postgres reverts it to `''` rather than unsetting it. So `current_setting('app.community_id')` inside `withOrgTransaction` is fail-closed in two ways:
  - fresh connection: raises `unrecognized configuration parameter` (**42704**);
  - connection that earlier ran `withAppTransaction`: returns `''`, and a policy `::uuid` cast fails with `invalid input syntax for type uuid` (**22P02**).

  The test asserts the query **fails** and accepts **either** SQLSTATE. Do not assert one message — `hub_reuse` would flake depending on connection order.

- [ ] **Step 2:** Implement. Do not set `app.community_id`. Brand the callback client.
- [ ] **Step 3:** Integration tests pass through PgBouncer.
- [ ] **Step 4:** Commit

```
feat(db): add withOrgTransaction for organisation-scoped work

Community GUC stays unset so community-scoped policies fail closed.
Bleed test runs on hub_reuse.

Refs: docs/plans/2026-09-19-kernel-runtime.md task 7
```

---

### Task 8: `app.outbox` and the Postgres adapter

**Files:** `packages/db/src/outbox.ts` (Drizzle table definition); `packages/db/src/schema.ts` (**must** re-export the table — `drizzle.config.ts` schema is `./src/schema.ts`; a table that lives only in `outbox.ts` is invisible to Kit); `outbox-adapter.ts`; `packages/db/package.json` (dependency `@community-hub/kernel`); `drizzle/` Kit generate **then** hand-add `ALTER TABLE app.outbox FORCE ROW LEVEL SECURITY`; optional `SET LOCAL lock_timeout` at the top of the migration; `test/outbox.integration.test.ts`; `@ts-expect-error` that pooled `Sql` is not assignable to `append`.

Table: all columns `NOT NULL`; PK `(org_id, id)`; unique constraint named so `ON CONFLICT ON CONSTRAINT` works — use Kit's generated name and **put that exact name in the adapter**. Policy `org_id = current_setting('app.org_id')::uuid`. No `community_id`. `id` no default. `occurred_at` default `now()`.

Adapter SQL is a postgres.js tagged template with `ON CONFLICT ON CONSTRAINT`. Do not switch to Drizzle `onConflictDoNothing` (0.45.2: column targets only) and do not use `sql.raw`.

- [ ] **Step 1:** Failing integration tests from the spec Tests section (RLS, FORCE, one-row retry, two events one key, rollback, commit together, Zod failure leaves no row) **plus** a query against `pg_constraint` that the unique constraint's `conname` equals the identifier hard-coded in the adapter. A later Kit rename would otherwise surface as a runtime error in an unrelated chunk.
- [ ] **Step 2:** Define the table in `outbox.ts`, re-export it from `schema.ts`, generate SQL, add FORCE, implement the adapter using `current_setting('app.org_id')::uuid`, `createOutbox()`. If Kit emits nothing for `app.outbox`, `schema.ts` is not exporting the table — fix that, do not point Kit at a second file.
- [ ] **Step 3:** Tests pass, including the `pg_constraint` name assertion. `schema-rls` on the live tree is ok (product table exists). Generated SQL grep: every column `NOT NULL`.
- [ ] **Step 4:** Commit

```
feat(db): persist organisation-scoped outbox rows under RLS

Idempotency is a NOT NULL unique constraint. org_id comes from the
transaction GUC. Claim/retry columns are not in this migration.

Refs: docs/plans/2026-09-19-kernel-runtime.md task 8
```

---

### Task 9: Architecture, AGENTS, roadmap, full gate

**Files:** `architecture.md` §8.3 last bullet; §12.1 **Platform tables** with `app.outbox` columns all `internal`; `AGENTS.md` §10 (new ESLint id + event-names checker); `docs/roadmap.md` (this chunk **done**, snapshot, next `packages-residency`).

§8.3 replacement (exact intent): enforcement is ESLint `no-restricted-imports` (global apps and kernel must not import `@community-hub/db`, including `import type`) plus checkers (worker-config, schema-rls, event-names, sql-session-ban). dependency-cruiser is not used until it has a real input and a must-fail fixture.

- [ ] **Step 1:** Apply doc edits. Roadmap last.
- [ ] **Step 2:** Full gate, uncached, matching CI Stage 1–2 commands:

```
pnpm exec prettier --check .
pnpm lint --force
pnpm typecheck --force
pnpm check:boundaries
pnpm test --force
```

Expected: all green. Encrypted-column fixtures include the new cases. Gateway tests still `{ ok: true }`. `pnpm exec wrangler deploy --dry-run` in `apps/gateway` succeeds; output / generated bundle must not mention the `zod` package.

- [ ] **Step 3:** Commit (roadmap is this commit — last on the branch)

```
docs: record kernel-runtime as done

Platform-table classifications and §8.3 enforcement match what CI
actually runs.

Refs: docs/plans/2026-09-19-kernel-runtime.md task 9
```

---

## Spec coverage

| Spec item                                                                                                                                                               | Task         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| ALS, no orgId, no escape hatch, concurrent store                                                                                                                        | 1            |
| Gateway `/health` + `nodejs_als`; `requestId` from `crypto.randomUUID()` / inbound header; `/health` `idempotencyKey === requestId`; `withRequest` inside `createFetch` | 1            |
| Workerd test: `getRequestContext()` populated on the `/health` path                                                                                                     | 1            |
| `defineModule` / `defineEvent` / parse / undeclared                                                                                                                     | 2            |
| Health `defineModule` live input                                                                                                                                        | 2            |
| Zod 4.6.5 on `/module` only                                                                                                                                             | 2, 9 dry-run |
| Payload ESLint + fixtures + disable ban (including imported schema)                                                                                                     | 3            |
| Duplicate names repo-wide                                                                                                                                               | 4            |
| `sql-session-ban` exception                                                                                                                                             | 5            |
| worker-config src scan + restricted imports including `import type`                                                                                                     | 6            |
| `withOrgTransaction` fail-loudly + bleed; `app.synthetic_community` policy reads `app.community_id`; unset GUC accepts 42704 or 22P02                                   | 7            |
| `app.outbox` NOT NULL, PK, unique constraint, adapter, RLS tests; table exported from `schema.ts`; `pg_constraint` name matches adapter                                 | 8            |
| §8.3, §12.1, roadmap last                                                                                                                                               | 9            |

## Self-review

- No TBD. Constraint name: implementer uses Kit's generated name, wires `ON CONFLICT ON CONSTRAINT` to that identifier, and a `pg_constraint` test locks it.
- Table is re-exported from `schema.ts` so Kit (`drizzle.config.ts` → `./src/schema.ts`) generates SQL. `outbox.ts` alone is not enough.
- `append` SQL in Interfaces is illustrative tagged-template, not `$n` placeholders. Adapter stays on postgres.js `sql`, not `sql.raw`, not Drizzle `onConflictDoNothing`.
- Unset `app.community_id` tests accept 42704 or 22P02 so `hub_reuse` does not flake.
- Gateway `requestId` is `crypto.randomUUID()` (or inbound request-id header), never `newId()`. Workerd test reads ALS on the `/health` path. `withRequest` wraps inside `createFetch`, covering `SELF.fetch` and `createFetch(logger)`.
- Stop-and-report: `nodejs_als` rejected at `2026-03-10`, or ALS empty under the Workers test pool. Do not drop `withRequest` or pass context as an argument.
- `bindPublisher` / `append` names are used consistently from the Interfaces section.
- Final task runs prettier, lint, typecheck, boundaries, test `--force`, and gateway wrangler dry-run (Stage 3 subset that this chunk can run without Cloudflare upload secrets).
