# Spec: kernel runtime

Slug: `kernel-runtime`
Status: approved (2026-09-19, Abdus Salam)
Architecture refs: §6.3, §7.3 rules 1–2, §8.1–8.3, §12.1, §17, §18; ADR 0004; AGENTS.md §1 (1, 2, 3, 7), §6, §7, §8, §10
Supersedes: —

## Problem

Modules, request context, DI and the organisation-scoped outbox are decided in architecture and missing in code. `@community-hub/kernel` exports only `healthPayload()`. The first publisher must not invent event names, payload shape, tenant scope, or an idempotency key that is a fresh id on every retry.

## Scope

**In**

- `@community-hub/kernel`: `defineModule`, `defineEvent`, `withRequest` (`AsyncLocalStorage`), `OutboxPort` (type only), unchanged `healthPayload()`. No Postgres, no Drizzle, no `@community-hub/db` (value or `import type`).
- Kernel package exports (subpaths, so the gateway graph does not pull Zod):
  - `@community-hub/kernel` — `healthPayload`, `withRequest`. No Zod.
  - `@community-hub/kernel/module` — `defineModule`, `defineEvent`, `OutboxPort`. Depends on `zod@4.6.5` (exact, same pin style as `drizzle-orm@0.45.2` / `postgres@3.4.9`).
- `@community-hub/db`: `app.outbox` (first product table), `withOrgTransaction`, Postgres outbox adapter, branded transaction client so `publish` cannot take a pooled `Sql`. db may import kernel `/module` for the port type (one-way).
- Gateway: wrap `/health` in `withRequest`; body still `healthPayload()`. Import only `@community-hub/kernel` (not `/module`). Set `nodejs_als` (or `nodejs_compat`).
- A `defineModule` in `packages/kernel/src` for health (`publishes: []`), so the duplicate-name checker has a live declaration on day one.
- ESLint in `tooling/eslint-plugin-community-hub`: type-aware payload shape on `defineEvent` (allow-listed value types + banned keys + fail-closed on unreadable Zod). Per-package lint is enough for this rule.
- Repo-wide checker for **duplicate event names** (turbo lint cannot see two packages). Wired through `check:boundaries`.
- `sql-session-ban`: allow `SET LOCAL lock_timeout` and `SET LOCAL statement_timeout` only in migration SQL. Everything else stays banned. Own must-fail fixtures.
- `worker-config`: today it reads Wrangler + `worker.meta.json` only. This chunk also scans `apps/<name>/src/**/*.ts` for a **value** import of `@community-hub/kernel` or `@community-hub/kernel/module`. If found, `compatibility_flags` must include `nodejs_als` or `nodejs_compat`. Must-fail fixture: kernel value import, flag missing. `import type` of kernel does not require the flag (it does not evaluate ALS).
- ESLint `no-restricted-imports`: `@community-hub/db` (and the adapter path) forbidden from `apps/gateway` and `packages/kernel`, including `import type`. Gateway must not import `@community-hub/kernel/module`. Must-fail fixture: a gateway-shaped file importing `@community-hub/db` (value or type).
- Architecture §8.3 last bullet: replace "dependency-cruiser rules plus a custom check over manifests" with the enforcement this chunk actually ships (`no-restricted-imports` + checkers). §12.1: platform-table classification list; `app.outbox` row. Last commit of the branch updates `docs/roadmap.md` (`kernel-runtime` **done**).

**Out** (explicitly)

- Queue, `ctx.waitUntil`, Cron sweeper, claim/retry columns, parsed `event_version` column.
- Per-organisation FIFO.
- RFC 9457 / domain-error mapping (later, with a real API).
- Host → organisation resolution (`tenancy-implicit-org`).
- Enforcing entitlements, permissions, widgets, or `dataClasses` (declared and type-checked only).
- Dispatch for `subscribes` (declared and type-checked only; no handlers run).
- Replacing or extending `residency-payload` (queue/workflow JSON glob stays; its zero-files notice stays honest).
- JSON snapshots of event payloads.
- First product publisher (giving, people, …). Tests publish through a test module and the db adapter.
- `packages/contracts`, OpenAPI, `apps/api`.
- dependency-cruiser.

## Behaviour

### Split (import graph)

| Package                 | Owns                                                                                 | Must not                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `@community-hub/kernel` | Module/event registry, ALS request context, `OutboxPort<Tx>` type, `healthPayload()` | Import `postgres`, Drizzle, or `@community-hub/db` (including `import type`) |
| `@community-hub/db`     | `app.outbox`, `withOrgTransaction`, branded tx, `OutboxPort<BrandedTx>` adapter      | Be imported by gateway or kernel                                             |
| `apps/gateway`          | `withRequest` around `/health`                                                       | Import db, the adapter, or `@community-hub/kernel/module`                    |

Kernel declares `OutboxPort<Tx>` and never binds `Tx`. It does not name or import a transaction type from `packages/db`. db defines the brand and supplies it: `OutboxPort<OrgTx | AppTx>`. That is a one-way import (db → kernel `/module`). A type-only kernel → db import is still a cycle and still forbidden.

A pooled `Sql` is not assignable to the branded client. Publishing with a pooled client does not compile. Both `withOrgTransaction` and `withAppTransaction` set `app.org_id`, so either branded client may be passed to `publish`; the row is still organisation-scoped.

Zod `4.6.5` is an exact dependency of the `/module` entry only. Gateway imports `@community-hub/kernel`, which does not import Zod. Wrangler dry-run / a bundle assertion must not list `zod` in the gateway graph. Relying on tree-shaking of a combined index is not enough.

### `defineModule`

Typed factory plus registry.

Required this chunk: `key`, `version`, `requires`, `publishes`, `subscribes`, `ports`.

Kernel ships a health module (`key` matching the gateway health surface, `publishes: []`) so the duplicate-name checker has a real `defineModule` in `packages/kernel/src` on day one.

Also accepted and **type-checked only** (not enforced):

| Field                     | Enforced in                                                  |
| ------------------------- | ------------------------------------------------------------ |
| `entitlement`, `features` | `entitlements-plans`                                         |
| `permissions`             | `access-roles`                                               |
| `websiteWidgets`          | website-widget / `packages-ui` chunk when widgets exist      |
| `dataClasses`             | the module that first ships classified columns in a manifest |

`publishes` is the set of event names the module may pass to `publish()`. An undeclared name is a type error and a runtime throw. `subscribes` is stored on the registry and unused: no dispatch, no queue consumer.

### `defineEvent`

Name shape (architecture §18): `<module>.<entity>.<verb>.v<n>`, e.g. `people.person.merged.v1`.

Regex: `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.v[1-9][0-9]*$`.

No parsed version column. Version lives in the name. Adding a column later is an expand migration, when a consumer filters on version.

Payload Zod allow-list (values, not keys):

- UUID (identifier)
- enum from a fixed set
- boolean
- integer
- timestamp

Anything else fails, including `z.string()` that is not a UUID. Nested objects are allowed only if every leaf is one of the above.

Banned-key list is a **second** line (so `z.string().uuid()` named `email` still fails). At least: `name`, `email`, `emailAddress`, `e_mail`, `full_name`, `fullName`, `dob`, `dateOfBirth`, `address`, `phone`, `notes`, `note`, `comment`, `label`, `amount`. The spec and the rule share one list.

`publish()` **parses** the payload with that event's Zod schema at runtime and throws on failure. Lint constrains the schema; parse constrains the value (including `unknown` crossing a module boundary).

### Request context

`withRequest({ requestId, idempotencyKey }, fn)` using `AsyncLocalStorage`.

- **On the context:** `requestId`, `idempotencyKey` only.
- **Not on the context:** `orgId` (host → org is `tenancy-implicit-org`; the row's tenant comes from the transaction).
- No optional context argument on `publish` or `withRequest` "for tests". Tests call `withRequest`.
- `publish()` reads `idempotencyKey` from the store. Outside `withRequest` it throws.
- Two overlapping `withRequest` calls keep separate ids (concurrent test, not sequential).
- The stored outbox key is **never** `newId()` at publish time. It is the context key: client's `Idempotency-Key` when the caller has one, otherwise the identifiers of the change (aggregate id plus its new version). Gateway `/health` does not publish; it may set `idempotencyKey` equal to `requestId`.

Workers with a **value** import of `@community-hub/kernel` or `@community-hub/kernel/module` must set `compatibility_flags` to include `nodejs_als` or `nodejs_compat`. `worker-config` fails otherwise.

### Outbox table (`app.outbox`)

Organisation-scoped. No `community_id`. RLS policy references `app.org_id` only. `FORCE ROW LEVEL SECURITY`. `schema-rls` sees this as a real product `CREATE TABLE app.*` (the product-journal zero-tables notice goes away).

Every column is `NOT NULL`. Distinct NULLs do not collide in a unique index; a nullable `idempotency_key` would make retries insert a second row and `ON CONFLICT DO NOTHING` would never fire.

**Primary key:** composite `(org_id, id)`, same pattern as `app.synthetic` / `app.synthetic_crypto`.

**Idempotency uniqueness:** a **named unique constraint** on `(org_id, event_name, idempotency_key)`, not a standalone unique index. `INSERT … ON CONFLICT ON CONSTRAINT … DO NOTHING` then `SELECT` the row.

| Column            | Type          | Null       | Default | Class      | Notes                                                                                                                                                                           |
| ----------------- | ------------- | ---------- | ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | `uuid`        | `NOT NULL` | none    | `internal` | App-minted `newId()` (UUIDv7). No database default. Later sweeper order leans on `id`, not `occurred_at`.                                                                       |
| `org_id`          | `uuid`        | `NOT NULL` | none    | `internal` | Insert uses `current_setting('app.org_id')::uuid`, not a caller argument.                                                                                                       |
| `event_name`      | `text`        | `NOT NULL` | none    | `internal` | Full name including `.vN`.                                                                                                                                                      |
| `payload`         | `jsonb`       | `NOT NULL` | none    | `internal` | Identifiers/enums/bools/ints/timestamps only.                                                                                                                                   |
| `occurred_at`     | `timestamptz` | `NOT NULL` | `now()` | `internal` | Database default. Worker does not pass it. `ON CONFLICT DO NOTHING` keeps the first row's timestamp. `now()` is transaction-start time, which is another reason it is not FIFO. |
| `idempotency_key` | `text`        | `NOT NULL` | none    | `internal` | From request context, not a fresh id.                                                                                                                                           |

Same request key and two different event names → two rows. Same request key and the same event name → one row; `publish()` returns the existing `id`. Callers must not assume the return is a newly minted id. A test of two publishes of the same event under the same request key asserts **one row** (that is what would catch a nullable key).

No platform-role bypass. Future sweeper enumerates organisations and calls `withOrgTransaction` per batch.

Claim/retry columns are **not** created. They arrive with the sweeper as an expand migration.

No ordering guarantee across isolates. Concurrent writers in one org are allowed; `occurred_at` is not FIFO (`now()` is when the transaction opened, not commit order).

### Transactions

`withAppTransaction({ orgId, communityId }, fn)` still requires both ids.

`withOrgTransaction(orgId, fn)` is a **separate function**, not an optional `communityId`. Organisation-scoped work (outbox, later billing/entitlements) uses it deliberately.

Inside `withOrgTransaction`, `app.community_id` is **never set**. A policy that reads `current_setting('app.community_id')` raises. An org-only transaction cannot read community-scoped tables; it fails loudly, not with a partial set. Test: `app.synthetic_community` (drizzle-test table whose policy reads `current_setting('app.community_id')::uuid`) is unreadable inside `withOrgTransaction`. `app.synthetic` stays org-scoped.

Bleed test on `hub_reuse`: after a community-scoped `withAppTransaction`, a `withOrgTransaction` on the reused pooled connection must not see a leftover `community_id`.

### Duplicate event names

Not an ESLint rule (turbo lints one package at a time; a Set of seen names never sees two packages; cache makes that worse).

A checker under `tooling/checks` walks `defineEvent({ name })` and `defineModule({ publishes })` in **`packages/*/src`, `apps/*/src`, `modules/**`**. It does **not** scan vitest / `test/` trees for the live pass (fixtures stay under the checker's `fixtures/`).

**Day-one live input:** the health `defineModule` in `packages/kernel/src` (`publishes: []`). That is a real declaration, not an empty glob. Zero duplicate names among one module is a pass. If the live globs contain no `defineModule` and no `defineEvent`, the checker prints an honest notice **and fails** (not a silent pass). Must-fail fixture: two modules, same name. Must-pass fixture: the same name declared once.

### Payload ESLint (per file, type-aware)

On `defineEvent` calls. Uses the type checker (aliases and imported shapes resolve). Fail closed if the shape is not statically readable: `.extend()` the rule cannot resolve, object spread, `z.record`, `.passthrough()`, `.catchall()`. Must-fail fixtures for: free-form `z.string()`, banned key with an allowed type, `z.record`, `.passthrough()`, unreadable `.extend()`, nested object containing any of those, invalid event name, **imported** schema with a banned key / free-form string. Must-pass: ids, enums, boolean, timestamp, **imported** ids-only schema. Disable of this rule stays banned (`no-restricted-disable`).

`residency-payload` is unchanged.

### Gateway

`GET /health` still returns `200` and `{ ok: true }` from `healthPayload()`. The handler runs inside `withRequest`. Contract does not move.

## Data

`app.outbox` as above. Every column `internal` (§12.1) and `NOT NULL`. Not encrypted (SQL must filter `org_id`, `event_name`, `idempotency_key`).

**Where classification is recorded.** Feature-module columns will use `dataClasses` on `defineModule` when those modules exist. Tables that are not a feature module (this outbox; later kernel/db platform tables) are listed in architecture §12.1 under **Platform tables**. This PR adds that list and the `app.outbox` row. There is no `column-classifications.json` (removed with `encrypted-query`).

Migration wave: expand only (`CREATE TABLE`, composite PK, unique constraint, RLS, FORCE). No drop, no NOT NULL on existing data.

`sql-session-ban` change (shipped checker):

| Statement                                                        | Where                                                               | Result  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- | ------- |
| `SET LOCAL lock_timeout = …` / `SET LOCAL statement_timeout = …` | `packages/db/drizzle/**/*.sql`, `packages/db/drizzle-test/**/*.sql` | allowed |
| Same `SET LOCAL`                                                 | `packages/db/src/**` or any other scanned TS/SQL                    | fail    |
| `SET LOCAL` of any other GUC (e.g. `work_mem`)                   | migration SQL                                                       | fail    |
| Session `SET lock_timeout` (no `LOCAL`)                          | anywhere scanned                                                    | fail    |

Must-fail fixtures for the three fail rows; must-pass fixture for `SET LOCAL lock_timeout` in a drizzle-shaped SQL file. Migrations **may** set those two LOCAL timeouts; they are not required on this small table, but the exception exists so the first product table does not teach "never set timeouts."

## Tests

Consolidated. Each item is independently testable; the plan maps one commit to a subset.

**Outbox / RLS**

- Cross-tenant insert on `app.outbox` refused; cross-tenant read refused.
- `FORCE ROW LEVEL SECURITY` present; `schema-rls` counts the product table (zero-tables notice gone).
- Policy uses `app.org_id` only.
- All six columns `NOT NULL` in the generated SQL.
- Primary key is `(org_id, id)`; unique constraint is `(org_id, event_name, idempotency_key)`.

**Publish / idempotency**

- Same unit of work twice (same request key, same event) → one row, same `id` returned both times.
- Two different events under the same request key → two rows.
- Rolled-back transaction leaves no outbox row; domain change rolls back with it.
- Publish + domain change commit together.
- `publish()` outside `withRequest` throws.
- `publish()` of an undeclared event: type error and runtime throw.
- `publish()` of an invalid event name: type/lint and runtime throw.
- `publish()` with a payload that fails the event Zod schema throws; no row.
- Two concurrent `withRequest` calls keep separate `requestId` / `idempotencyKey`.

**Transactions**

- `withAppTransaction` still requires `communityId`.
- Inside `withOrgTransaction`, reading `app.synthetic_community` fails loudly (`app.community_id` unset).
- `hub_reuse`: `withOrgTransaction` does not see a `community_id` left by an earlier `withAppTransaction`.
- Pooled `Sql` is not assignable to `publish`'s transaction argument.

**Lint / checkers**

- Payload ESLint must-fail: free-form `z.string()`, banned key with allowed type, `z.record`, `.passthrough()`, unreadable `.extend()`, nested object containing any of those, invalid event name, imported schema with a banned key / free-form string.
- Payload ESLint must-pass: ids, enums, boolean, timestamp, imported ids-only schema.
- Duplicate-name checker must-fail fixture (two modules, same name); must-pass (name declared once); live tree includes the health `defineModule`; empty live glob fails with a notice.
- `sql-session-ban`: three must-fail rows in the exception table; must-pass `SET LOCAL lock_timeout` in drizzle SQL.
- `worker-config` must-fail: value-import of kernel, no ALS flag.
- Gateway-shaped must-fail: `import` / `import type` of `@community-hub/db`.
- Gateway must not import `/module`; gateway graph / dry-run does not include `zod`.

**Gateway contract**

- `GET /health` still `200` `{ ok: true }` inside `withRequest`.

## Rules touched

- §1.1 / §1.7: gateway import graph; event payloads identifiers only.
- §1.2: outbox payloads are not personal data; `jobs` still does not exist.
- §1.3: `org_id`, RLS, FORCE; `set_config(..., true)` only; sweeper will be per-org `withOrgTransaction`.
- §1.4: nothing encrypted that SQL must query.
- Idempotency-Key (§17) is the request-context source when the client sends one.

## Contracts

- `healthPayload(): { ok: true }` unchanged.
- `GET /health` unchanged.
- `defineEvent` / `defineModule` / `withRequest` / `OutboxPort<Tx>` as above. No public HTTP event API.
- No widgets. Entitlement keys in manifests are type-only.

## Risks

| Risk                                            | Mitigation                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Gateway bundles db / ALS missing at deploy      | `no-restricted-imports` including `import type` + fixture; `worker-config` scans src imports + ALS flag + fixture |
| Zod in the gateway Worker                       | `/module` subpath; gateway imports `.` only; dry-run graph must not list `zod`                                    |
| Kernel ↔ db import cycle                        | Kernel never binds `Tx`; db supplies the brand; ban includes `import type`                                        |
| Nullable `idempotency_key` defeats unique       | All columns `NOT NULL`; two-publish test asserts one row                                                          |
| `orgId` on context disagrees with tx            | `orgId` is not on context; insert uses `current_setting('app.org_id')`                                            |
| Fresh `newId()` as idempotency key              | `publish()` reads ALS only; no key argument                                                                       |
| Unique key too wide; second event swallowed     | Unique constraint `(org_id, event_name, idempotency_key)`; test two names, one request key → two rows             |
| Duplicate event names across packages           | Repo-wide checker, not ESLint; health `defineModule` is day-one live input                                        |
| Zod source scanner skips `.extend` / `z.record` | Fail closed; fixtures                                                                                             |
| Lint-only payload, runtime `unknown`            | `publish()` parses with the event schema                                                                          |
| Org tx silently reads community tables          | `community_id` unset; `app.synthetic_community` policy test                                                       |
| Pooled client used to publish                   | Branded tx type; does not compile                                                                                 |
| Session `SET` in migration for timeouts         | Checker allows only `SET LOCAL` of the two timeout GUCs in drizzle SQL                                            |
| Classification with no home                     | Architecture §12.1 platform-tables list                                                                           |
| FIFO assumed from `occurred_at`                 | `now()` is transaction start, not commit order; sweeper later uses `id`                                           |

## Out-of-band

- Legal: none. New subprocessor: none.
- Architecture: §8.1 kernel line stays accurate; §8.3 enforcement sentence updated in this PR; §12.1 platform tables; §18 outbox sentence stays (write in the same transaction; enqueue/`waitUntil`/Cron are still later).
- ADR: none new unless implementation is forced to change ADR 0004 (it should not: no `BYPASSRLS`).

## Next spec after this lands

`packages-residency`, unless the human picks another remaining Phase 0 row.
