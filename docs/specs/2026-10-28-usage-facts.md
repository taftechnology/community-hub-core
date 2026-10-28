# Spec: Usage facts

Slug: usage-facts
Status: approved (2026-10-28, Adnan Bin Hossen)
Architecture refs: §6.3, §10.2, §12.1, §19.3, §26 Q15, Q17. Implements the `usage-facts` row, the last Phase 1 row. Depends on `tenancy-implicit-org` and `people-households`, both on `main`. Staging stays parked.

## Problem

Nobody can answer "how are communities using the platform?" Architecture §19.3 sets the grain at community × feature × day and names `core/usage` as the writer of `usage_facts_daily`. Neither exists. Every later feature chunk needs somewhere to count its success action, and the ops console's adoption views (Q17) need counts to read.

## Scope

**In**

- `modules/core/usage`, package `@community-hub/usage`. `pnpm-workspace.yaml` gains the line `modules/core/usage`. No other workspace glob.
- `package.json` copies people's shape: `exports: { ".": dist/public }`, `files: ["dist"]`, dependencies `@community-hub/db`, `@community-hub/kernel` and `drizzle-orm` at the same pinned version as people (so the schema file drizzle-kit loads and `pgSchema` from `packages/db` share one drizzle instance), and people's dev dependencies.
- `turbo.json` gains `"@community-hub/usage#test": { "dependsOn": ["^build", "@community-hub/identity#test"] }`, and `@community-hub/people#test` changes to depend on `["^build", "@community-hub/usage#test"]`. The Docker test database suites stay one serial chain. `modules/core/usage/vitest.config.ts` copies people's (`globalSetup` from `packages/db/test/global-setup.ts`, `fileParallelism: false`).
- `module.manifest.ts` calls `defineModule` with `key` `core.usage`, `version` 1, `requires: []`, empty `publishes`, `subscribes`, `ports`, `features` and `permissions`. No `entitlement`. No `website`. `dataClasses` lists every column in [Data](#data). Core modules are never entitlement-gated (§10.2).
- One table, `app.usage_facts_daily`, contributed from `modules/core/usage/db/schema.ts` as `usageTables(app)`. That function does not call `pgSchema` and imports no value from `@community-hub/db`. `packages/db/drizzle.schema.ts` calls `usageTables` through a relative import, as it does for the other modules. `packages/db/src` does not import `@community-hub/usage`.
- One product journal entry after `0012`. Drizzle Kit generates it, including `ENABLE ROW LEVEL SECURITY` from `.enableRLS()`. The same migration hand-appends `FORCE ROW LEVEL SECURITY` and the `REVOKE` below, each after a `--> statement-breakpoint`. It is additive and touches no other table.
- `modules/core/usage/public/index.ts` exports `recordSuccess` and `UsageError`, nothing else.
- The first producer: `createPerson` in `modules/core/people` calls `recordSuccess(tx, "people.directory", input.now)` as its last statement, after `appendAuditEvent` and outside the `person_insert` savepoint, in the same transaction. Every path then takes the per-organisation audit lock before the usage row lock, so no lock cycle can form, and a caught duplicate never leaves a count behind. `modules/core/people/module.manifest.ts` gains `requires: ["core.usage"]`. No other manifest field changes. `@community-hub/people` gains a workspace dependency on `@community-hub/usage`.
- `apps/api/Dockerfile` adds `--filter @community-hub/usage` to the first build line, and the `apps/api/src/image.test.ts` list includes it, because `apps/api` reaches people through `@community-hub/access`.
- `architecture.md` §19.3 and §26 Q17 are updated in this PR to say what this chunk decided and what it deferred (see [Decisions](#decisions-this-chunk-records)).
- The last commit updates `docs/roadmap.md`: the row **done**, the snapshot, and the Open item named under [Out-of-band](#out-of-band).

**Out**

- Q17: the scheduled job, the `platform` copy table, and any ops console usage view. Deferred to a later chunk (working name `ops-usage-view`) that adds the scheduler and names its monthly cost.
- The columns `entitled`, `toggled`, `staff_active_count` and `surface_open_count` from §19.3. Each is added by the chunk that first fills it. No column ships that nothing writes.
- Admin beacons (`admin.feature.opened`), staff session counts, and any HTTP route. There is no read route and no permission.
- Hard usage limits (Q15). `recordSuccess` never refuses an action and is not a limit counter.
- An outbox dispatcher. No module publishes a domain event today.
- A retention purge job.
- Any people route. `createPerson` has no production caller today, so no production row is written until a people route ships. The count is proven through `createPerson`'s integration tests.

## Behaviour

- `recordSuccess(tx: AppTransaction, featureKey: string, at: Date): Promise<void>` adds one to `success_count` for the current organisation, the current community, `featureKey`, and the UTC calendar date of `at`. The first call for that key and day inserts the row with `success_count = 1`.
- The caller has already entered `withAppTransaction` with both `app.org_id` and `app.community_id` set. The function does not open a connection, does not call `set_config`, and does not call `sql.begin`. `org_id` and `community_id` are written from `current_setting`, never from an argument.
- The write is one statement: `INSERT … ON CONFLICT (org_id, community_id, feature_key, day) DO UPDATE SET success_count = usage_facts_daily.success_count + 1`. Two concurrent transactions recording the same key and day both count, including the first insert of the day. The second waits on the first and does not fail. `recordSuccess` assumes READ COMMITTED, the `withAppTransaction` default.
- The count rolls back with the caller's transaction. A person insert that fails (duplicate email, missing household) records nothing.
- `featureKey` must match the entitlement key shape (`^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$`, at most 64 characters). A key outside that shape throws `UsageError("invalid_feature_key")` before any SQL runs. `createPerson` does not catch it, so `createPerson` rejects. Callers pass a constant, so this is a programming error, not user input.
- `at` that is not a valid date throws `UsageError("invalid_time")` before any SQL runs.
- The day is the UTC date. A domain function computes it in TypeScript (`at.toISOString().slice(0, 10)` after the validity check), and the SQL binds it as `${day}::date`. SQL never casts a timestamp to a date, because no connection pins the session time zone. A person created at 23:59:59.999Z counts on that date. One created at 00:00:00.000Z the next day counts on the next. Communities have no stored time zone today. See [Decisions](#decisions-this-chunk-records).
- `createPerson` counts every created person once, adult or minor. The row carries no person id, no `is_minor`, and nothing that tells a minor apart.
- `UsageError` messages are the fixed code only. They carry no key value, SQL, host or stack.

## Data

`app.usage_facts_daily`, community-scoped.

| Column          | Type                                                        | Class    |
| --------------- | ----------------------------------------------------------- | -------- |
| `org_id`        | `uuid not null`                                             | internal |
| `community_id`  | `uuid not null`                                             | internal |
| `feature_key`   | `text not null`, check: length 1–64 and the key shape above | internal |
| `day`           | `date not null`                                             | internal |
| `success_count` | `integer not null`, check `success_count >= 1`              | internal |

- Primary key `(org_id, community_id, feature_key, day)`. It starts with `org_id`. No other unique key and no foreign key. `community_id` has no foreign key to `platform`, the same as every other `app` table.
- No `id` column. The natural key is the identity, as for `app.person_tag_links` and `app.custom_role_permissions`. This departs from the §6.3 template on purpose.
- Row level security `community_isolation`, `FOR ALL TO public`, `USING` and `WITH CHECK` both `org_id = current_setting('app.org_id')::uuid and community_id = current_setting('app.community_id')::uuid`. `FORCE ROW LEVEL SECURITY`.
- Grants are the defaults from `0000_schemas.sql`, then `REVOKE DELETE, TRUNCATE ON app.usage_facts_daily FROM app`. `SELECT`, `INSERT` and `UPDATE` stay, since the upsert needs all three. `identity` and `platform` get nothing.
- No column is encrypted. Nothing here is personal data. A row has no person dimension: no person id, no `is_minor`, nothing that tells a minor apart. A low count (for example 1 in a small community on one day) can still support inference when combined with outside knowledge. That is acceptable while the facts stay tenant-internal under row level security, with no read route and no platform copy. The chunk that builds the ops usage view decides small-count suppression, coarser windows or a minimum cohort before any count is copied to `platform`. No blind index or derived clear column applies (§12.2.1).
- Every column goes into `modules/core/usage/module.manifest.ts` `dataClasses` and into `modules/core/usage/domain/manifest.test.ts`, in the same task as the migration.

## Rules touched

- Tenancy: a new `app` table with `org_id`, `community_id`, row level security and `FORCE`. Scope comes from the transaction only.
- Residency: none. The table is in the regional database. Nothing leaves the service.
- Children: a minor's creation is counted with no distinguishing column. Usage facts never carry a person dimension.
- §1 rule 5: the table, its errors and its logs carry no personal data.
- §1 rule 6: no analytics SDK. This is the first-party alternative §19.3 prescribes.
- Entitlements, permissions, consent, retention: none. Usage is a core module and is never gated. There is no route, so there is no permission.

## Contracts

- Public API: `recordSuccess(tx, featureKey, at)` and `UsageError` with codes `invalid_feature_key` and `invalid_time`.
- Manifest: `core.usage` as above. `core.people` gains `requires: ["core.usage"]`.
- No route, no event, no port, no website collection, island or block.

## Decisions this chunk records

These go into `architecture.md` in the same PR. ADR 0009 is not edited. Its Q17 leaning stays a leaning.

1. **Q17 is deferred.** `usage-facts` ships the regional table only. The scheduled job and the `platform` copy are decided by the chunk that builds the ops usage view. The Q17 row and §19.3 say so.
2. **Success actions are counted in the action's transaction.** §19.3 calls a success action a domain event and lists the outbox as the primary source. Until an outbox dispatcher exists, a module calls `recordSuccess` in the same transaction as the action. That is exact, needs no scheduler, and rolls back with the action. A later chunk may move a producer to an event without changing the table.
3. **Columns arrive with their producers.** §19.3's column list becomes the target set, not the first migration.
4. **The day is the UTC date.** Default chosen because no community has a stored time zone. An Australian parish's day therefore starts at 10:00 or 11:00 local time. Revisit when communities get a time zone, before any customer-facing usage view.

## Risks

- **Cross-tenant write or read.** Mitigation: scope from `current_setting` only, community predicate on `USING` and `WITH CHECK`, `FORCE`, and a test with two organisations and two communities in one organisation proving neither reads nor bumps the other's row.
- **A failed count blocks the action.** A bad key or a database error in `recordSuccess` fails `createPerson`. Accepted. The key is a constant, a test calls the real producer, and a silent drop would hide a broken count.
- **Lock order.** Audit appends are serialised per organisation. A producer that took the usage row lock before its audit append could deadlock against one that did the reverse. Mitigation: the call is the last statement of `createPerson`, after `appendAuditEvent`. Later producers follow the same order.
- **Hot row.** Every person created in one community on one day updates the same row. At parish scale that is a short row lock. A bulk import later runs in its own transaction. If it becomes contention, a later chunk batches the increment.
- **Parallel test databases.** Each Docker database suite starts, rotates and tears down the shared test database. A package outside the `turbo.json` test chain would run alongside the others and break them. Mitigation: usage joins the chain between identity and people.
- **Packaging.** `apps/api` now depends on `@community-hub/usage` through access and people. A missing Dockerfile filter breaks the image build. `image.test.ts` pins the list.
- **Schema loader.** `usageTables` must import no value from `@community-hub/db`, because the migration generator loads schema files with `require()`. `packages/db/src/generate.test.ts` covers the new file once `drizzle.schema.ts` imports it, and it also proves the generated migration matches the schema.
- **Over-counting on retry.** An application-level retry of a whole transaction counts once per committed attempt, which is correct. There is no retry inside `recordSuccess`.

## Tests

- Unit: key shape (valid, uppercase, single segment, 65 characters, empty), invalid date, UTC day at 23:59:59.999Z, 00:00:00.000Z and 29 February.
- Integration (Docker test database). The suites share one fixture helper for organisation and community setup.
  - First call inserts 1. A second call on the same day gives 2. A different day gives a new row.
  - Rollback of the caller's transaction leaves no row.
  - Time zone: inside a transaction that runs `set local time zone 'Australia/Sydney'`, a call at 23:59:59.999Z writes that UTC date (read as `day::text`). This fails if the date derivation moves into SQL.
  - Two organisations, and two communities in one organisation: a call under one scope never reads, inserts into, or updates another's row. Under scope A, `select` returns only A's rows. The two-communities `select` is the behaviour test that pins the community predicate.
  - Concurrency on the insert path, without sleeps: no row exists. Transaction A records and stays open. Transaction B starts the same key and day without being awaited. An observer connection polls `pg_stat_activity` until B's pid shows `wait_event_type = 'Lock'`, with a bounded deadline (pattern: `modules/core/identity/infrastructure/operator.integration.test.ts`). A commits, then B is awaited and commits. The count is 2.
  - Privileges: the `app` role cannot `DELETE`. `relforcerowsecurity` is true. The `TRUNCATE` and `platform` or `identity` assertions are kept, but they cannot fail because of this migration, since those grants never existed.
  - `createPerson` for an adult and for a minor each adds 1 to `people.directory`. A `createPerson` that fails on a duplicate adds nothing.
- Schema: exact column list, primary key column order starting with `org_id`, and the policy's `USING` and `WITH CHECK` text, each exactly the predicate in [Data](#data), parsed from the migration SQL. The schema source contains no `pgSchema`, as `modules/core/entitlements/db/schema.test.ts` checks.
- Boundaries: `modules/core/usage` imports no `@community-hub/people`, `@community-hub/tenancy` or `@community-hub/identity`, and staging stays parked (a copy of people's `domain/boundaries.test.ts`).
- Manifest: whole-manifest `toEqual` for `core.usage`, and the people manifest test updated for `requires`.
- Image: `image.test.ts` build list includes `@community-hub/usage`.
- Settings the plan must check by weakening source: `REVOKE DELETE` (removing it turns the DELETE assertion red), `FORCE`, the community predicate, the call's position after `appendAuditEvent`, and the TypeScript day derivation.

## Size

Estimated about 1,000 changed lines excluding the migration and lockfile. Integration tests are about half of it, because the tenant, concurrency and privilege suites each need their own setup. That is over the ~800 target in AGENTS.md §3. A clean split exists: chunk A is the usage module and table, and chunk B is the people producer. The cost is that chunk A ships a writer with no caller. See [Human](#human).

## Cost

None. No new AWS resource. Staging stays parked.

## Out-of-band

- No legal sign-off, no new subprocessor, no ADR.
- Sensitive chunk under AGENTS.md §2: tenancy, and children's data through `createPerson`. The owner's assistant runs the second review in a fresh session when the last task is pushed. The pull request does not merge until that review is written.
- AGENTS.md §8 asks for behaviour verified on the staging hostname. Nothing in production calls `recordSuccess` yet, so a staging run would prove only that migration `0013` applies. Proposed: no unpark in this chunk. The roadmap commit adds an Open item: the next chunk that unparks staging verifies `0013` (table present, `relrowsecurity` and `relforcerowsecurity` true, `app` lacks `DELETE`). The owner decides.

## Human

- Approves this spec and the plan.
- Decides three things:
  1. UTC day (the default above).
  2. No staging run in this chunk.
  3. Size: one pull request of about 1,000 lines (recommended, because the producer is what proves the writer works in a real path), or the A/B split.

## Rollback

Revert the PR. The migration is additive. The table can stay empty, or a later contract migration drops it.

## Next spec after this lands

Phase 1 is complete. The next chunk is the first Phase 2 row, or the ops usage view if the owner wants Q17 next.
