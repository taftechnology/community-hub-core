# Spec: kernel runtime

Slug: `kernel-runtime`
Status: draft
Architecture refs: §6.3, §7.3 rules 1–2, §8.1–8.3, §12.1, §17, §18; ADR 0004; AGENTS.md §1 (1, 2, 3, 7), §6, §7, §8, §10
Supersedes: —

## Problem

Modules, request context, DI and the organisation-scoped outbox are decided in architecture and missing in code. `@community-hub/kernel` exports only `healthPayload()`. The first publisher must not invent event names, payload shape, tenant scope, or an idempotency key that is a fresh id on every retry.

## Scope

**In**

- `@community-hub/kernel`: `defineModule`, `defineEvent`, `withRequest` (`AsyncLocalStorage`), `OutboxPort` (type only), unchanged `healthPayload()`. No Postgres, no Drizzle, no `@community-hub/db`.
- `@community-hub/db`: `app.outbox` (first product table), `withOrgTransaction`, Postgres outbox adapter, branded transaction client so `publish` cannot take a pooled `Sql`.
- Gateway: wrap `/health` in `withRequest`; body still `healthPayload()`. Set `nodejs_als` (or `nodejs_compat`). Do not import db or the adapter.
- ESLint in `tooling/eslint-plugin-community-hub`: type-aware payload shape on `defineEvent` (allow-listed value types + banned keys + fail-closed on unreadable Zod). Per-package lint is enough for this rule.
- Repo-wide checker for **duplicate event names** (turbo lint cannot see two packages). Wired through `check:boundaries`.
- `sql-session-ban`: allow `SET LOCAL lock_timeout` and `SET LOCAL statement_timeout` only in migration SQL. Everything else stays banned. Own must-fail fixtures.
- `worker-config`: fail a Worker that imports `@community-hub/kernel` without `nodejs_als` or `nodejs_compat`. Must-fail fixture.
- ESLint `no-restricted-imports`: `@community-hub/db` (and the adapter path) forbidden from `apps/gateway` and `packages/kernel`. Must-fail fixture that looks like a gateway file importing db.
- Architecture §12.1: platform-table classification list; `app.outbox` row. Last commit of the branch updates `docs/roadmap.md` (`kernel-runtime` **done**).

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

## Behaviour

### Split (import graph)

| Package | Owns | Must not |
| ------- | ---- | -------- |
| `@community-hub/kernel` | Module/event registry, ALS request context, `OutboxPort` type, `healthPayload()` | Import `postgres`, Drizzle, or `@community-hub/db` |
| `@community-hub/db` | `app.outbox`, `withOrgTransaction`, branded tx, outbox adapter implementing `OutboxPort` | Be imported by gateway or kernel |
| `apps/gateway` | `withRequest` around `/health` | Import db or the adapter |

`OutboxPort` is generic over the branded transaction client defined in `packages/db`, so kernel does not import `postgres`. A pooled `Sql` is not assignable to that client. Publishing with a pooled client does not compile (preferred) or throws. Both `withOrgTransaction` and `withAppTransaction` set `app.org_id`, so either client may be passed to `publish`; the row is still organisation-scoped.

Zod is a new kernel dependency: it is the event schema language this chunk introduces. It does not replace `packages/contracts` (out).

### `defineModule`

Typed factory plus registry.

Required this chunk: `key`, `version`, `requires`, `publishes`, `subscribes`, `ports`.

Also accepted and **type-checked only** (not enforced):

| Field | Enforced in |
| ----- | ----------- |
| `entitlement`, `features` | `entitlements-plans` |
| `permissions` | `access-roles` |
| `websiteWidgets` | website-widget / `packages-ui` chunk when widgets exist |
| `dataClasses` | the module that first ships classified columns in a manifest |

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

Workers that import `@community-hub/kernel` must set `compatibility_flags` to include `nodejs_als` or `nodejs_compat`. `worker-config` fails otherwise (must-fail fixture: kernel import, flag missing).

### Outbox table (`app.outbox`)

Organisation-scoped. No `community_id`. RLS policy references `app.org_id` only. `FORCE ROW LEVEL SECURITY`. `schema-rls` sees this as a real product `CREATE TABLE app.*` (the empty-tree notice on the product journal goes away).

| Column | Type | Default | Class | Notes |
| ------ | ---- | ------- | ----- | ----- |
| `id` | `uuid` | none | `internal` | App-minted `newId()` (UUIDv7). No database default. Later sweeper order leans on `id`, not `occurred_at`. |
| `org_id` | `uuid` | none | `internal` | Insert uses `current_setting('app.org_id')::uuid`, not a caller argument. |
| `event_name` | `text` | none | `internal` | Full name including `.vN`. |
| `payload` | `jsonb` | none | `internal` | Identifiers/enums/bools/ints/timestamps only. |
| `occurred_at` | `timestamptz` | `now()` | `internal` | Database default. Worker does not pass it. `ON CONFLICT DO NOTHING` keeps the first row's timestamp. |
| `idempotency_key` | `text` | none | `internal` | From request context, not a fresh id. |

Unique `(org_id, event_name, idempotency_key)`. Same request key and two different event names → two rows. Same request key and the same event name → one row; `publish()` returns the existing `id`. Callers must not assume the return is a newly minted id.

`INSERT … ON CONFLICT DO NOTHING` then `SELECT` the row. No platform-role bypass. Future sweeper enumerates organisations and calls `withOrgTransaction` per batch.

Claim/retry columns are **not** created. They arrive with the sweeper as an expand migration.

No ordering guarantee across isolates. Concurrent writers in one org are allowed; `occurred_at` is not FIFO.

### Transactions

`withAppTransaction({ orgId, communityId }, fn)` still requires both ids.

`withOrgTransaction(orgId, fn)` is a **separate function**, not an optional `communityId`. Organisation-scoped work (outbox, later billing/entitlements) uses it deliberately.

Inside `withOrgTransaction`, `app.community_id` is **never set**. A policy that reads `current_setting('app.community_id')` raises. An org-only transaction cannot read community-scoped tables; it fails loudly, not with a partial set. Test: `app.synthetic` (existing community-scoped test table) is unreadable / errors inside `withOrgTransaction`.

Bleed test on `hub_reuse`: after a community-scoped `withAppTransaction`, a `withOrgTransaction` on the reused pooled connection must not see a leftover `community_id`.

### Duplicate event names

Not an ESLint rule (turbo lints one package at a time; a Set of seen names never sees two packages; cache makes that worse).

A checker under `tooling/checks` walks `defineEvent({ name })` and `defineModule({ publishes })` across the repo (including `modules/**` fixtures). Duplicate name → fail. Must-fail fixture: two modules, same name. Must-pass: the same name declared once. This is the input for the registry, not a grep of string literals in arbitrary files.

### Payload ESLint (per file, type-aware)

On `defineEvent` calls. Uses the type checker (aliases and imported shapes resolve). Fail closed if the shape is not statically readable: `.extend()` the rule cannot resolve, object spread, `z.record`, `.passthrough()`, `.catchall()`. Must-fail fixtures for: free-form `z.string()`, banned key with an allowed type, `z.record`, `.passthrough()`, unreadable `.extend()`, nested object containing any of those, invalid event name. Must-pass: ids, enums, boolean, timestamp. Disable of this rule stays banned (`no-restricted-disable`).

`residency-payload` is unchanged.

### Gateway

`GET /health` still returns `200` and `{ ok: true }` from `healthPayload()`. The handler runs inside `withRequest`. Contract does not move.

## Data

`app.outbox` as above. Every column `internal` (§12.1). Not encrypted (SQL must filter `org_id`, `event_name`, `idempotency_key`).

**Where classification is recorded.** Feature-module columns will use `dataClasses` on `defineModule` when those modules exist. Tables that are not a feature module (this outbox; later kernel/db platform tables) are listed in architecture §12.1 under **Platform tables**. This PR adds that list and the `app.outbox` row. There is no `column-classifications.json` (removed with `encrypted-query`).

Migration wave: expand only (`CREATE TABLE`, RLS, FORCE, unique index). No drop, no NOT NULL on existing data.

`sql-session-ban` change (shipped checker):

| Statement | Where | Result |
| --------- | ----- | ------ |
| `SET LOCAL lock_timeout = …` / `SET LOCAL statement_timeout = …` | `packages/db/drizzle/**/*.sql`, `packages/db/drizzle-test/**/*.sql` | allowed |
| Same `SET LOCAL` | `packages/db/src/**` or any other scanned TS/SQL | fail |
| `SET LOCAL` of any other GUC (e.g. `work_mem`) | migration SQL | fail |
| Session `SET lock_timeout` (no `LOCAL`) | anywhere scanned | fail |

Must-fail fixtures for the three fail rows; must-pass fixture for `SET LOCAL lock_timeout` in a drizzle-shaped SQL file. Migrations **may** set those two LOCAL timeouts; they are not required on this small table, but the exception exists so the first product table does not teach "never set timeouts."

## Rules touched

- §1.1 / §1.7: gateway import graph; event payloads identifiers only.
- §1.2: outbox payloads are not personal data; `jobs` still does not exist.
- §1.3: `org_id`, RLS, FORCE; `set_config(..., true)` only; sweeper will be per-org `withOrgTransaction`.
- §1.4: nothing encrypted that SQL must query.
- Idempotency-Key (§17) is the request-context source when the client sends one.

## Contracts

- `healthPayload(): { ok: true }` unchanged.
- `GET /health` unchanged.
- `defineEvent` / `defineModule` / `withRequest` / `OutboxPort` as above. No public HTTP event API.
- No widgets. Entitlement keys in manifests are type-only.

## Risks

| Risk | Mitigation |
| ---- | ---------- |
| Gateway bundles db / ALS missing at deploy | `no-restricted-imports` + fixture; `worker-config` ALS flag + fixture |
| `orgId` on context disagrees with tx | `orgId` is not on context; insert uses `current_setting('app.org_id')` |
| Fresh `newId()` as idempotency key | `publish()` reads ALS only; no key argument |
| Unique key too wide; second event swallowed | Unique is `(org_id, event_name, idempotency_key)`; test two names, one request key → two rows |
| Duplicate event names across packages | Repo-wide checker, not ESLint |
| Zod source scanner skips `.extend` / `z.record` | Fail closed; fixtures |
| Lint-only payload, runtime `unknown` | `publish()` parses with the event schema |
| Org tx silently reads community tables | `community_id` unset; synthetic table test |
| Pooled client used to publish | Branded tx type; compile or throw |
| Session `SET` in migration for timeouts | Checker allows only `SET LOCAL` of the two timeout GUCs in drizzle SQL |
| Classification with no home | Architecture §12.1 platform-tables list |
| FIFO assumed from `occurred_at` | Spec: no ordering; sweeper later uses `id` |

## Out-of-band

- Legal: none. New subprocessor: none.
- Architecture: §8.1 kernel line stays accurate; §12.1 platform tables; §18 outbox sentence stays (write in the same transaction; enqueue/`waitUntil`/Cron are still later).
- ADR: none new unless implementation is forced to change ADR 0004 (it should not: no `BYPASSRLS`).

## Next spec after this lands

`packages-residency`, unless the human picks another remaining Phase 0 row.
