Spec: docs/specs/2026-10-28-usage-facts.md

# Usage facts Implementation Plan

Slug: usage-facts
Status: approved (2026-10-28, Abdus Salam)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A module can count a success action for its community and day in its own transaction. `createPerson` counts every created person toward `people.directory`. The table is `app.usage_facts_daily`. It holds counts only, has forced row level security, and `app` cannot delete from it. No route, Terraform, workflow or live run.

**Architecture:** A new `modules/core/usage` package has the same shape as people: `domain/` (key and day rules, `UsageError`), `db/schema.ts` (`usageTables(app)`), `infrastructure/record.ts` (`recordSuccess`), and `public/index.ts`. `packages/db` keeps the single journal and gains migration `0013`. People depends on usage through `public/` and calls it last in `createPerson`.

## Who does what

| Actor                     | Writes repo commits                            | Runs `terraform apply` | Puts secret values, runs AWS one-offs | Applies or merges |
| ------------------------- | ---------------------------------------------- | ---------------------- | ------------------------------------- | ----------------- |
| Implementer (Antigravity) | Yes. Tasks 1–6, only the files each task names | Never                  | Never                                 | Never             |
| Reviewer (fresh Claude)   | Never                                          | Never                  | Never                                 | Never             |
| Human owner (Abdus)       | Never during the run                           | Not needed             | Not needed                            | Merges the PR     |
| Developer (Adnan)         | Never during the run                           | Never                  | Never                                 | Never             |

The owner approves this plan after the independent assistant's check (AGENTS.md §2, §4).

## Global constraints

- The spec is approved, and no task edits it. Refinements are listed under **Deviations from the spec** and repeated in the PR body.
- Work only in the worktree `C:\Recovered\Taftech\wt-usage-facts`, on branch `feat/2026-10-28-usage-facts`. Commit locally and never push.
- No agent runs `terraform`, `aws` or `docker push`. Every run starts with no AWS credentials and with pushes blocked.
- Staging stays parked. No task touches `infra/`, `.github/`, a workflow, an ESLint config, or a checker. The only Dockerfile change is Task 4's one `--filter` addition.
- `package.json`, `tsconfig*.json`, `turbo.json`, `pnpm-workspace.yaml` and `pnpm-lock.yaml` change only where a task names them.
- No new third-party dependency. The new package's dependencies are workspace packages, `drizzle-orm` at people's pin `0.45.2`, and `postgres` at `3.4.9`. Every other module has the same pair, so pnpm resolves one drizzle instance (deviation 3).
- No account id, ARN, real hostname, email address, secret or IP address in any commit. Tests use synthetic UUIDs and `example.test` addresses. No fixture string may look like a real key or token (contiguous `sk_live_`, `sk_test_`, `rk_`, `whsec_`, `AKIA` and the like).
- **Existing tests:** no existing assertion is changed or removed, except the people manifest test's `requires` line (Task 4) and the `image.test.ts` build list, which gains one name (Task 4). The reviewer checks that `git diff origin/main -- '*.test.ts'` shows only those changes and added lines.
- **Test database:** only one run at a time uses the Docker test database. Integration tests run the shared global setup (`packages/db/test/global-setup.ts`). Each usage integration file applies the product migrations in `beforeAll`, as `modules/core/people/infrastructure/person.integration.test.ts:61-68` does. Each file uses synthetic scopes with fresh UUIDs from one fixture helper, `modules/core/usage/test/fixtures/scopes.ts`. That helper is test-only and outside the build, following the precedent of `packages/db/test/fixtures/database-fixture.ts`. Each file cleans up its own rows over the owner connection (`createPlaintextDirectSql(runtime.productOnlyUrl)`) and does not swallow errors.
- **Builds:** `apps/api` and people tests run against built dist. After changing usage, run `pnpm --filter @community-hub/usage build` before people's tests, and `pnpm --filter @community-hub/people build` before `apps/api`'s tests.
- **Known Windows exceptions**, allowed and nothing else:
  - `packages/db/src/generate.test.ts` (ENOENT spawning `drizzle-kit`);
  - `tooling/checks/image-publish/scan-decision.test.ts` symlink EPERM;
  - occasional Windows-only timeouts in `migrate.integration`, `plaintext-dist`, and identity's "forty parallel wrong guesses".

  They pass on Linux CI. The `image.test.ts` image cases run only with `RUN_IMAGE_TESTS=1`, which CI Stage 3 sets.

- **Windows gate sequence.** On Windows, `pnpm gate` exits at `pnpm test` because of `generate.test.ts`, so `check:boundaries` never runs. Wherever a task says "gate", run these in order and report each result:
  1. `pnpm format`
  2. `pnpm lint`
  3. `pnpm typecheck`
  4. `pnpm check:boundaries`, which must pass
  5. `pnpm turbo run test --continue`, where only the exceptions above may fail
  6. `pnpm gate` last, which is expected to stop only at the known exception
- Before the PR: the same sequence with `pnpm turbo run test --force --continue` in step 5. LF line endings.
- **Implementer runs have a hard time limit:** append each weakening's result to the task report as you see it, and commit as soon as the gate passes.
- Sensitive chunk (tenancy, children's data). The owner's assistant runs the second fresh-context review when the last task is pushed. The PR does not merge until it is written.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed. Reports go to `.superpowers/sdd/task-N-report.md`.

## Deviations from the spec (repeated in the PR body)

1. **Task order splits the spec's single "migration task".** The manifest `dataClasses` and the manifest test land in Task 2, together with the migration, as the spec requires. Task 1 ships the manifest with an empty `dataClasses`, and Task 2 fills it.
2. **The lock-order pin is a deterministic deadlock test** (pin 8), not a source-order check. It uses the `pg_stat_activity` lock-wait pattern from the concurrency test.
3. **`@community-hub/usage` also depends on `postgres` `3.4.9`.** The spec lists `@community-hub/db`, `@community-hub/kernel` and `drizzle-orm`. Without `postgres`, pnpm can resolve a second drizzle-orm variant for this importer, which is what the spec's version pin exists to prevent. Every other module has the same pair.

## Security pins

The implementer weakens the source once, as described, and sees the named test fail. It then restores the source and puts the failure output in the task report. A weakened tree is never committed. A weakening of migration SQL takes effect on the next run, because the global setup recreates the test database each run.

| #   | Setting                                                 | Test that pins it (Task)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Weakening that must make it fail                                                  |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 1   | `REVOKE DELETE` from `app`                              | `usage-facts.integration.test.ts` "the app role cannot delete usage facts" (T2): `delete` under a full tenant scope raises 42501                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Remove `DELETE` from the hand-appended `REVOKE` in `0013`                         |
| 2   | `FORCE ROW LEVEL SECURITY`                              | `usage-facts.integration.test.ts` "forces row level security" (T2): `relrowsecurity` and `relforcerowsecurity` are both true for `app.usage_facts_daily`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Remove the `FORCE` line from `0013`                                               |
| 3   | Community predicate on `USING`                          | `record.integration.test.ts` "two communities in one organisation see only their own facts" (T3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Drop the `community_id` comparison from the policy in `schema.ts` and `0013`      |
| 4   | Organisation predicate on `USING`                       | `record.integration.test.ts` "two organisations see only their own facts" (T3): the organisations use the same community UUID string in the fixture, so only `org_id` tells them apart                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Drop the `org_id` comparison from the policy in `schema.ts` and `0013`            |
| 5   | `WITH CHECK` equals `USING`                             | `schema.test.ts` "pins the policy text" (T2): `USING` and `WITH CHECK` are parsed from `0013` with the regex in `people/db/schema.test.ts:133-136`. Each is exactly `"app"."usage_facts_daily"."org_id" = current_setting('app.org_id')::uuid and "app"."usage_facts_daily"."community_id" = current_setting('app.community_id')::uuid`                                                                                                                                                                                                                                                                                                                                                    | In `schema.ts` and the generated SQL, make `withCheck` always true                |
| 6   | Day computed in TypeScript, bound as a date             | `record.integration.test.ts` "keeps the UTC date under an Australian session time zone" (T3): `set local time zone 'Australia/Sydney'`, call at `2026-03-01T23:59:59.999Z`, `day::text` is `2026-03-01`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Bind `${at}::date` instead of `${utcDay(at)}::date`                               |
| 7   | One-statement upsert                                    | `record.integration.test.ts` "counts both of two racing first inserts" (T3): lock-wait observed through `pg_stat_activity`, count 2, no error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Replace the upsert with `select` and then `insert` or `update`                    |
| 8   | Count is last in `createPerson`, after the audit append | `person-usage.integration.test.ts` "does not deadlock with a writer that audits before it counts" (T4):<br>- Set up the community key before A starts, so B's first lock wait is the audit insert.<br>- Transaction A runs inside `withRequest`, calls `appendAuditEvent` with a registered action (`PERSON_CREATED`), and holds.<br>- B calls `createPerson` with the same `now`, in the same organisation and community.<br>- The observer (filtered on `datname = current_database()`) sees B wait on a lock.<br>- A calls `recordSuccess(tx, "people.directory", now)` and commits. B is awaited.<br>- No 40P01, and the count is 2.<br>- Observer deadline 3 s; `it` timeout `30_000` | Move the `recordSuccess` call to just before `appendAuditEvent` in `createPerson` |
| 9   | Count outside the savepoint, after it succeeds          | `person-usage.integration.test.ts` "a duplicate caught by the caller adds nothing" (T4): inside one transaction, the caller catches `createPerson`'s duplicate error and commits, and the count is unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Move the call to before the `person_insert` savepoint                             |
| 10  | Key shape checked before SQL                            | `domain/keys.test.ts` (T1): `People.directory`, `people`, a 65-character key and `""` throw `invalid_feature_key`. `record.integration.test.ts` "rejects a bad key before any SQL" (T3), with keys `people` and `People.directory`: the transaction is still usable after the throw, and no row exists. Under the weakening, `people` reaches SQL, the database CHECK raises 23514, and the transaction is no longer usable                                                                                                                                                                                                                                                                | Accept a single-segment key in `parseFeatureKey`                                  |
| 11  | Errors carry the code only                              | `domain/error.test.ts` (T1): `new UsageError("invalid_feature_key").message` equals `"invalid_feature_key"`, and a thrown error for key `"Bad.Key"` does not contain `Bad.Key`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Put the key into the message                                                      |
| 12  | Every column classified                                 | `domain/manifest.test.ts` whole-manifest `toEqual` (T2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Remove `"usage_facts_daily.day"` from `dataClasses`                               |
| 13  | Usage never imports people, tenancy or identity         | `domain/boundaries.test.ts` "does not import people, tenancy or identity" (T1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Add `import type {} from "@community-hub/people";` to `public/index.ts`           |
| 14  | Image builds usage                                      | `image.test.ts` "builds policy, tenancy, people, and access before the service" (T4), which reads the Dockerfile text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Remove `--filter @community-hub/usage` from the Dockerfile                        |
| 15  | No person dimension                                     | `schema.test.ts` exact column list (T2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Add `isMinor: boolean("is_minor")` to `schema.ts` and generate                    |
| 16  | Database CHECK on the key shape uses `[.]`              | `schema.test.ts` "pins the CHECK constraints" (T2): both CHECKs exactly as Kit emits them in `0013`, including `[.]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Write the regex with `\.` in `schema.ts` (it cooks to `.`) and generate           |

Regression, not a weakening: every existing people, access and `apps/api` test passes unchanged after Task 4.

## Rollback

| Point        | Rollback                                                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before merge | Revert with new commits.                                                                                                                                                                                                           |
| After merge  | Revert the merge commit. Migration `0013` is additive. If it has been applied anywhere, the table stays and nothing writes to it. A later contract migration may drop it. Staging is parked and does not run `0013` in this chunk. |

## Stop and ask (AGENTS.md §12)

Implementer, stop and report if:

- the plan or spec is wrong or ambiguous, or a test cannot be written as described;
- a change is needed in a file no task names, including any Dockerfile line other than Task 4's filter, a workflow, `infra/`, or a checker;
- `drizzle-kit generate` produces anything other than one new `app.usage_facts_daily` table, its policy and `ENABLE ROW LEVEL SECURITY`;
- an existing test assertion needs changing beyond the two named in Global constraints;
- the same step fails twice, or a command fails to start (process creation error). Report which steps remain, and retry at most once.

---

### Task 1: The usage package, its domain rules and its boundaries

**Files:**

- Create:
  - `modules/core/usage/package.json`: people's shape, name `@community-hub/usage`, dependencies `@community-hub/db`, `@community-hub/kernel` and `drizzle-orm` `0.45.2` and `postgres` `3.4.9`, people's dev dependencies, and no `crypto`;
  - `tsconfig.json`, `tsconfig.test.json` (people's, without the crypto path) and `vitest.config.ts` (people's, without the crypto alias). The test config has the `db/plaintext` alias, the include list, `globalSetup` and `fileParallelism: false`;
  - `module.manifest.ts`: `key` `core.usage`, `version` 1, empty `requires`, `publishes`, `subscribes`, `ports`, `features` and `permissions`, and `dataClasses: {}`;
  - `domain/error.ts`: `UsageError`, with codes `invalid_feature_key` and `invalid_time`. The message is the code;
  - `domain/keys.ts`: `parseFeatureKey`, using the entitlement regex and a limit of 64 characters;
  - `domain/day.ts`: `utcDay(at: Date): string`. It throws `invalid_time` on an invalid date, and when the sliced value does not match `^\d{4}-\d{2}-\d{2}$` (years outside 0000–9999). Otherwise it returns `at.toISOString().slice(0, 10)`;
  - `domain/keys.test.ts`, `domain/day.test.ts`, `domain/error.test.ts`;
  - `domain/boundaries.test.ts`, a copy of people's with the banned list `people`, `tenancy`, `identity` (each split as `"@community-hub/" + "…"`) and the same parked-staging check;
  - `public/index.ts`: exports `UsageError` only, for now.
- Modify:
  - `pnpm-workspace.yaml`: add `modules/core/usage` after `modules/core/people`;
  - `turbo.json`: add `"@community-hub/usage#test": { "dependsOn": ["^build", "@community-hub/identity#test"] }`, and change `@community-hub/people#test` to `["^build", "@community-hub/usage#test"]`;
  - `pnpm-lock.yaml`, through `pnpm install`.

**Test first:**

- `keys.test.ts`: `people.directory` and `a.b_c.d1` pass. `People.directory`, `people`, `.people`, `people.`, a 65-character key and `""` throw `invalid_feature_key`. A 64-character key passes.
- `day.test.ts`:
  - `2026-03-01T23:59:59.999Z` gives `2026-03-01`.
  - `2026-03-02T00:00:00.000Z` gives `2026-03-02`.
  - `2028-02-29T12:00:00Z` gives `2028-02-29`.
  - `new Date("x")` and `new Date(Date.UTC(10000, 0, 1))` throw `invalid_time`.
- `error.test.ts`: covers pin 11.
- `boundaries.test.ts`: covers pin 13.

**Commit subject:** `feat(usage): add the usage module with key and day rules`

- [ ] Write the tests, see them fail, then implement.
- [ ] Run `pnpm install`. In `pnpm-lock.yaml`, the `modules/core/usage` importer resolves `drizzle-orm` to the same variant as people's, and no new `drizzle-orm@0.45.2` snapshot appears. If one does, stop and report.
- [ ] Run `pnpm --filter @community-hub/usage test`, then `pnpm --filter @community-hub/usage typecheck`, then `pnpm --filter @community-hub/usage lint`.
- [ ] Run pins 10 (the unit half), 11 and 13.
- [ ] Run the Windows gate sequence.

### Task 2: `app.usage_facts_daily` and migration `0013`

**Files:**

- Create:
  - `modules/core/usage/db/schema.ts`: `usageTables(app: PgSchema)` returns `{ usageFactsDaily }`. It has the columns and primary key from the spec Data section, plus two checks:
    - `usage_facts_daily_feature_key`: `char_length(feature_key) between 1 and 64 and feature_key ~ '^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)+$'`. Write it with `[.]`, as in `entitlements/db/schema.ts:37`, and never `\.`, because inside a template literal `\.` becomes `.`;
    - `usage_facts_daily_success_count`: `success_count >= 1`.

    It also has `pgPolicy("community_isolation", …)` with the same predicate for `using` and `withCheck`, and `.enableRLS()`. It imports types and `drizzle-orm` only, with no value from `@community-hub/db`;

  - `modules/core/usage/db/schema.test.ts`:
    - the exact column list;
    - the primary key order (`org_id`, `community_id`, `feature_key`, `day`);
    - `USING` and `WITH CHECK` parsed from `0013` (pin 5);
    - both CHECK constraints, exactly as Kit emits them in `0013` (pin 16);
    - the `FORCE` and `REVOKE DELETE, TRUNCATE ON TABLE app.usage_facts_daily FROM app` lines present;
    - the source contains no `pgSchema(` call, as in `entitlements/db/schema.test.ts:62`;
  - `modules/core/usage/domain/manifest.test.ts`: whole-manifest `toEqual`;
  - `modules/core/usage/test/fixtures/scopes.ts` (test-only). It is outside `tsconfig.json`'s include, so it is not built. ESLint ignores `**/fixtures/**`, and the plaintext rule and `sql-session-ban` treat `test/` as test code. It returns synthetic scopes for `withAppTransaction` (`packages/db/src/app-transaction.ts:5-15` only sets the two settings, and `app.usage_facts_daily` has no foreign key, so no `platform` rows are needed). It gives organisation A with communities A1 and A2, and organisation B whose community has the same UUID as A1, for pin 4;
  - `modules/core/usage/infrastructure/usage-facts.integration.test.ts`: pins 1 and 2. Under a scope, `select` and `insert` succeed. `platform` and `identity` have no privilege (`has_table_privilege` false for each), and `app` has no `TRUNCATE`.
- Modify:
  - `module.manifest.ts`: `dataClasses` holds the five columns, each `"internal"`;
  - `modules/core/usage/tsconfig.test.json`: add `test/fixtures/scopes.ts` to `include`;
  - `packages/db/drizzle.schema.ts`: relative import of `usageTables`, and export `usageFactsDaily`;
  - generated: `packages/db/drizzle/0013_*.sql`, `meta/0013_snapshot.json` and `meta/_journal.json`.

**Migration:** run `pnpm exec drizzle-kit generate` from `packages/db`. Do not edit `0000`–`0012`. After the generated statements, hand-append these. Kit's last statement has no trailing breakpoint, so each appended statement goes on its own lines: a line `--> statement-breakpoint`, then the statement, as at the end of `0012_polite_bloodstrike.sql`.

- `ALTER TABLE "app"."usage_facts_daily" FORCE ROW LEVEL SECURITY;`
- `REVOKE DELETE, TRUNCATE ON TABLE app.usage_facts_daily FROM app;`

Do not hand-edit generated lines. If a check or the policy is missing, fix `schema.ts` and generate again. Then run `pnpm exec drizzle-kit generate` again. It must report no schema changes.

On Windows, `generate.test.ts` cannot spawn Kit (a known exception). The second generate run is the local evidence, and CI runs the test.

**Test first:** `schema.test.ts`, `manifest.test.ts` and the integration file, before `schema.ts` and the migration.

**Commit subject:** `feat(db): add app.usage_facts_daily`

- [ ] Write the tests, see them fail, implement and generate, then see them pass.
- [ ] Run `pnpm --filter @community-hub/db build`, then `pnpm --filter @community-hub/usage test`, then `pnpm --filter @community-hub/db test`. Only the Windows exceptions in Global constraints may fail.
- [ ] Run pins 1, 2, 5, 12, 15 and 16.
- [ ] Run the Windows gate sequence.

### Task 3: `recordSuccess`

**Files:**

- Create:
  - `modules/core/usage/infrastructure/record.ts`: `recordSuccess(tx: AppTransaction, featureKey: string, at: Date): Promise<void>`. It calls `parseFeatureKey` and `utcDay` first, then runs one statement:
    ```sql
    insert into app.usage_facts_daily (org_id, community_id, feature_key, day, success_count)
    values (current_setting('app.org_id')::uuid, current_setting('app.community_id')::uuid, ${key}, ${day}::date, 1)
    on conflict (org_id, community_id, feature_key, day)
    do update set success_count = app.usage_facts_daily.success_count + 1
    ```
    It does not call `set_config`, `sql.begin` or a savepoint;
  - `modules/core/usage/infrastructure/record.integration.test.ts`.
- Modify: `public/index.ts`, which exports `recordSuccess` and `UsageError` and nothing else.

**Test first** (`record.integration.test.ts`). Each case calls `withAppTransaction` with the fixture's scopes:

- The first call gives 1, a second call the same day gives 2, and a call the next UTC day makes a new row with 1.
- A transaction that records and then throws leaves no row.
- Australian session time zone (pin 6).
- Two organisations (pin 4): A records, B records the same key and day, and each `select` sees only its own row with count 1.
- Two communities in one organisation (pin 3): the same, at community level.
- Racing first inserts (pin 7), following `modules/core/identity/infrastructure/operator.integration.test.ts` (the lock-wait observer near `:2460–2530`). No row exists:
  - Transaction A records and stays open.
  - B starts without being awaited.
  - The observer polls `pg_stat_activity` until B's pid shows `wait_event_type = 'Lock'`, with a deadline of 3 s. The `it` has an explicit timeout of `30_000`.
  - A commits, then B is awaited.
  - The count is 2 and neither transaction raised an error.
- The bad keys `people` and `People.directory`, and an invalid date, each throw `UsageError` before any SQL. A later statement in the same transaction still succeeds, and no row exists (pin 10).

**Commit subject:** `feat(usage): record a success in the caller's transaction`

- [ ] Write the tests, see them fail, then implement.
- [ ] Run `pnpm --filter @community-hub/usage build`, then `pnpm --filter @community-hub/usage test`.
- [ ] Run pins 3, 4, 6, 7 and 10 (the integration half).
- [ ] Run the Windows gate sequence.

### Task 4: `createPerson` counts toward `people.directory`

**Files:**

- Modify:
  - `modules/core/people/infrastructure/person.ts`: as the last statement before `createPerson` returns, after `appendAuditEvent` and outside the savepoint, call `await recordSuccess(tx, "people.directory", input.now);`;
  - `modules/core/people/module.manifest.ts`: `requires: ["core.usage"]`;
  - `modules/core/people/domain/manifest.test.ts`: the `requires` line;
  - `modules/core/people/package.json`: add `"@community-hub/usage": "workspace:*"`;
  - `pnpm-lock.yaml`;
  - `apps/api/Dockerfile`: add `--filter @community-hub/usage` to the first `build` line, after `--filter @community-hub/tenancy`;
  - `apps/api/src/image.test.ts`: add `"@community-hub/usage"` to the build-list test's names.
- Create: `modules/core/people/infrastructure/person-usage.integration.test.ts`.

**Test first** (`person-usage.integration.test.ts`, people's existing integration setup):

- Creating an adult adds 1 to `people.directory` for that community and the UTC day of `now`.
- Creating a minor (with a household) adds 1 more. The row has the same five columns, and nothing in it identifies the person.
- Pin 9 and pin 8, as in the table.

**Commit subject:** `feat(people): count created people toward people.directory`

- [ ] Run `pnpm install`.
- [ ] Write the tests, see them fail, then implement.
- [ ] Build usage and then people, then run `pnpm --filter @community-hub/people test`, `pnpm --filter @community-hub/access test` and `pnpm --filter @community-hub/api test`. Existing tests stay unchanged and green.
- [ ] Run pins 8, 9 and 14.
- [ ] Run the Windows gate sequence.

### Task 5: Architecture records the decisions

**Files:** Modify `architecture.md` only.

- In §19.3, rewrite the paragraph that begins "`core/usage` writes `usage_facts_daily`" so it says:
  - `core/usage` writes `app.usage_facts_daily` (`org_id`, `community_id`, `feature_key`, `day`, `success_count`) in the regional database.
  - A module counts its success action by calling `recordSuccess` in the action's own transaction, last, after any audit append, until an outbox dispatcher exists.
  - The day is the UTC date until communities have a time zone.
  - `entitled`, `toggled`, `staff_active_count` and `surface_open_count` are the target columns. Each is added by the chunk that first fills it.
  - Q17 is deferred to the chunk that builds the ops usage view. Keep the existing leaning text.
- In §26 Q17: replace "Decided by `usage-facts` and `ops-console`." with "`usage-facts` shipped the regional table only. Decided by the chunk that builds the ops usage view." Keep the leaning and "The leaning is not a decision."
- Do not edit ADR 0009.

**Test first:** none (docs).

**Commit subject:** `docs(architecture): record the usage facts decisions`

- [ ] Run `pnpm exec prettier --check architecture.md`, then the Windows gate sequence.

### Task 6: Catalogue (last task on this branch)

**Files:**

- Modify `docs/roadmap.md`:
  - The `usage-facts` row becomes **done**, with `Spec docs/specs/2026-10-28-usage-facts.md`.
  - Snapshot: last shipped `usage-facts`, and next chunk `Groups` (Owner decisions item 1).
  - The "Next is" line and the Next spec section name that chunk.
  - Add an Open item: "The next chunk that unparks staging verifies migration `0013`: `app.usage_facts_daily` exists, `relrowsecurity` and `relforcerowsecurity` are true, and `app` lacks `DELETE`." Add another: "`createPerson` has no production caller, so no usage fact is written in production until a people route ships."
- Modify `AGENTS.md`: in the Repository state row, add `usage-facts` to the list of done chunks, and replace "Next is `usage-facts`." with "Phase 1 is complete with `usage-facts`. Next is `Groups`." Change nothing else in that row.

**Test first:** none (docs).

**Commit subject:** `docs: mark usage-facts done`

- [ ] Run `rm -f docs/plans/*-report.md`. `git status --short` must show only this task's files.
- [ ] Run the Windows gate sequence with `--force` (Before the PR).

## Owner decisions

The owner answers these once, at plan approval.

1. **Next chunk after this one** (Task 6 writes it into the roadmap). Phase 1 ends here, and no Phase 2 journey has a spec yet. Options:
   - (a) the first Phase 2 journey, `Groups`;
   - (b) `ops-usage-view`, Q17 and the scheduler;
   - (c) other.

   Decided: (a) `Groups`.

2. **Implementer:** Antigravity (agy), one plan task per run, in `C:\Recovered\Taftech\wt-usage-facts`. The model configuration is recorded in the PR.
3. **Per-task reviewer:** a fresh-context Claude session (Claude Code subagent) per task. It reviews by diff and runs the pins.
4. **Second review:** the standing default, the Cursor agent CLI on a pinned model from a third family. It starts when the last task is pushed.
5. **Deviations:** the two above. Further deviations are recorded in the PR body, and any that change behaviour stop the run.
6. **Size:** about 1,000 changed lines in one PR, accepted at spec approval.
7. **Staging:** stays parked. Migration `0013` is verified by the next unparking chunk (the Task 6 Open item).

## Definition of done (AGENTS.md §8)

- All six tasks are committed, each reviewed by diff, with its security pins reported.
- The local full test run and `pnpm gate` are green, apart from the Windows exceptions. CI is green on the PR.
- No file under `infra/` or `.github/` changed. The Dockerfile changed by one filter only. No existing assertion changed, except the two named.
- Staging is parked. There is no staging verification in this chunk (owner decision 7), and the PR body says so.
- `architecture.md`, the roadmap and `AGENTS.md` are updated in this PR, with the roadmap last.
- The PR body lists:
  - the implementer, reviewer and second-review configurations;
  - the owner's check;
  - the second-review line;
  - the deviations;
  - the changed-line count.
- No `docs/plans/*-report.md` is on disk, and nothing under `.superpowers/` is staged.

## Probe record

There is no Terraform in this chunk, so no probe is needed (AGENTS.md §4 Phase 2).
