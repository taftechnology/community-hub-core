Spec: docs/specs/2026-10-12-db-migrate-command.md

# Database migrate command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/app/db-migrate.js` to the service image. It connects as the master login, refuses to run before `db-bootstrap`, applies the product migrations through `applyProductMigrations`, and prints the tags it applied. It prints no driver text, no SQL, and no secret.

**Architecture:** Nine commits. `applyProductMigrations` first returns a report. The ops environment parsing and the SQLSTATE reduction are then shared modules with their own tests. The command is next, with a unit test on a fake driver. Two integration files prove it on the shared Docker cluster and on a throwaway non-superuser TLS container. The image test, the runbook section, and the catalogue follow. No apply, no migration, no Terraform.

**Tech Stack:** TypeScript, Node 24, Vitest, Drizzle ORM `0.45.2`, `postgres` `3.4.9`, Docker `postgres:17`, `openssl`. No new dependency, so no lockfile change.

Slug: db-migrate-command
Status: draft

**Branch:** `feat/2026-10-12-db-migrate-command` · one PR · 9 tasks, one commit each

## Global Constraints

- The spec is approved (`approved (2026-10-12, Abdus)`). Do not edit `docs/specs/2026-10-12-db-migrate-command.md`. Do not edit the draft `staging-proof-run` spec or its branch.
- Do not start Task 1 until this plan's Status line is `approved`. Do not mark this plan approved yourself.
- **Migration wave: none.** This chunk adds no migration and edits no file under `packages/db/drizzle/`, no snapshot, no `packages/db/sql/bootstrap.sql`. The only edits to those files are the two mutations in the Security pins table, each run once, seen to fail, and restored. They are never committed. Check `git diff --stat` for `packages/db/drizzle` and `packages/db/sql` before every commit.
- **Infra: none.** No Terraform change, no apply, no `.github/workflows` change, no Dockerfile change. Staging stays parked: do not touch `enable_database`, `desired_count`, or `service_image`. There are no Terraform asserts in this plan, so there is no scratch probe. Do not read any `*.local.tfvars` file.
- No dependency is added and `pnpm-lock.yaml` does not change.
- The program writes only the lines in the spec's output table. It never reads, logs, or interpolates `error.message`, `error.query`, `error.params`, or `error.stack`. It never writes a host, a port, a database name, a user, a password, or SQL text.
- Tests use synthetic values and the marker `planted-password-marker`. No account id, hostname, registry host, ARN, resource id, email, or real password in any file, test, runbook line, or commit message. The TLS test's server name is the constant `TLS_SERVER_NAME` exported by the fixture, not a literal in the new test.
- The master password goes only to the factory call for the master. Each role password goes only to that role's login check.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed. A commit holds only the files its task names.
- The agent does not apply, push an image, or merge. This chunk touches the database, tenancy (it applies the RLS migrations), and the master login. The second fresh-context review starts when the pull request opens. Leave that line open. Do not write the second review.
- Every task runs `pnpm gate` before its commit. Format the files in that commit first: `pnpm exec prettier --write` on those paths.
- Docker Postgres is started by the `@community-hub/db` test setup. Do not add a compose file. If Docker is missing, stop and report. Do not skip an integration test.

**Rollback:** Revert the merge. The command, the report, the shared modules, and the test files all go. The image already published stays in the registry and is harmless, because nothing runs the command unless a human overrides the command. There is no down-migration and none is added. A migration applied to staging is undone by the re-park, which destroys a database that holds no data.

**Size:** About 1,800 changed lines. About 1,100 are test code and about 130 are moved from `tls.integration.test.ts` into the fixture. Production code is about 300 lines. The AGENTS.md guide is about 800. The spec requires these tests and splits no further, because a split would merge the command without its proof. The per-task estimates are below.

## File map

| File                                                                            | Responsibility                                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/db/src/migrate.ts`                                                    | `applyMigrations` and `applyProductMigrations` return `{ applied, total }`.                               |
| `packages/db/src/index.ts`                                                      | Exports `MIGRATION_LOCK_ID` and the `MigrationReport` type.                                               |
| `packages/db/test/database-fixture.ts`                                          | `freshDatabase`: a new database on the shared cluster, dropped by the test.                               |
| `packages/db/test/tls-fixture.ts`                                               | Certificate generation and the throwaway TLS Postgres container, extracted from the TLS test.             |
| `packages/db/test/migrate.integration.test.ts`                                  | Report assertions and the role-and-lock pin.                                                              |
| `packages/db/test/tls.integration.test.ts`                                      | Uses the fixture. No assertion changes.                                                                   |
| `packages/db/tsconfig.test.json`, `eslint.config.js`                            | Include the fixtures in the type check and in the existing test-file lint lists.                          |
| `apps/api/src/env.ts`                                                           | Exports `text` and `portNumber`. Nothing else changes.                                                    |
| `apps/api/src/db-ops-env.ts`                                                    | The eight ops variables and the CA read, shared by both commands.                                         |
| `apps/api/src/db-ops-error.ts`                                                  | Reduces a caught error to a stage word and an optional SQLSTATE.                                          |
| `apps/api/src/db-bootstrap.ts`                                                  | Uses `db-ops-env.ts`. Behaviour unchanged.                                                                |
| `apps/api/src/db-migrate.ts`                                                    | `runDbMigrate` and the entry block. Emitted as `/app/db-migrate.js` by the existing `tsconfig.emit.json`. |
| `apps/api/src/db-ops-env.test.ts`, `db-ops-error.test.ts`, `db-migrate.test.ts` | Unit tests on a fake driver.                                                                              |
| `apps/api/src/db-migrate.integration.test.ts`                                   | Shared Docker cluster, plaintext, fresh database per test.                                                |
| `apps/api/src/db-migrate-tls.integration.test.ts`                               | Own non-superuser TLS container, verify-full.                                                             |
| `apps/api/src/image.test.ts`                                                    | `RUN_IMAGE_TESTS`-gated image assertions.                                                                 |
| `docs/runbooks/apply-staging-au.md`                                             | Section "Apply product migrations".                                                                       |
| `docs/roadmap.md`, `AGENTS.md`                                                  | The sentences the spec's Catalogue names.                                                                 |

## Test plumbing

| Test file                                                          | Vitest config                                                                                         | Postgres                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/db/test/migrate.integration.test.ts`                     | `packages/db/vitest.config.ts` (`test/**/*.test.ts`, `globalSetup`, `fileParallelism: false`)         | Shared compose cluster. A fresh database per test.                                                      |
| `db-ops-env.test.ts`, `db-ops-error.test.ts`, `db-migrate.test.ts` | `apps/api/vitest.config.ts` (`src/**/*.test.ts`, excludes `*.integration.test.ts`)                    | None.                                                                                                   |
| `db-migrate.integration.test.ts`                                   | `apps/api/vitest.integration.config.ts` (`globalSetup` is the db package's, `fileParallelism: false`) | Shared compose cluster. A fresh database per test. Roles and their passwords come from `.runtime.json`. |
| `db-migrate-tls.integration.test.ts`                               | Same integration config                                                                               | **Its own container.** Started in `beforeAll`, removed in `afterAll`. Not the compose cluster.          |
| `apps/api/src/image.test.ts`                                       | `apps/api/vitest.config.ts`, `RUN_IMAGE_TESTS=1`                                                      | None. Runs `docker build` and `docker run`.                                                             |

- **The TLS container.** The test file owns it. The name is `ch-db-migrate-tls-` plus four random bytes in hex. It publishes `127.0.0.1::5432`, so Docker picks a free loopback port. The compose cluster uses 5432 and PgBouncer uses 6432, so it never collides. It does not share a cluster, a role, or a password with any other suite. `afterAll` stops and removes it and deletes the certificate directory, whether or not a test failed.
- **Order.** The two apps/api integration files run one after the other, because `fileParallelism` is false. The db package's Postgres tests and the people, access, identity and tenancy suites cannot run during them: `turbo.json` already has `@community-hub/api#test` depend on `@community-hub/access#test`, which depends on people, identity, tenancy and db in a chain.
- **`turbo.json` does not change.** The new apps/api tests sit behind the existing chain. The new db tests sit inside `@community-hub/db#test`. Cache: `@community-hub/api#test` depends on `^build`, and each dependency's build hashes every tracked file in its package, so a change to a migration, to `sql/`, or to `packages/db/test` invalidates the api test hash. `eslint.config.js` is already a `globalDependencies` entry. If a reviewer finds a stale cache, stop and report. Do not add inputs speculatively.
- **CI.** The `test` job runs `pnpm test` with Docker. It starts the compose Postgres first. The TLS test pulls `postgres:17`, the image the compose file and the existing TLS test already use.

## Security pins

These are the settings the spec names in its Security pins table and its Tests section. For each one, during the task that adds the test, change the source once, see that test fail, restore the source, and report the failure. The report is session scratch. The weakened tree is never committed.

| Setting                                                  | Task | Test                                                                                                                          | Source change that must fail it                                                                                                             |
| -------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Role and lock released after a failure                   | 1    | `applyProductMigrations resets the role and frees the lock after a failure` in `packages/db/test/migrate.integration.test.ts` | Delete the `reset role` line in the `finally` of `applyMigrations` (role assertion). Delete the `pg_advisory_unlock` line (lock assertion). |
| A code is read only from a `PostgresError`               | 3    | `db-ops-error.test.ts`, the `EPIPE` plants                                                                                    | Return `error.code` or `error.cause.code` without the `name`/`severity` check.                                                              |
| `message`, `query`, `params`, `stack` are never read     | 3    | `db-ops-error.test.ts`, the throwing-getter error                                                                             | Read `error.message` in `failureLine`.                                                                                                      |
| Secrets stay out of the output                           | 4    | `db-migrate.test.ts`, the log-content test                                                                                    | Write `String(error)` to stderr in the `catch` of `runDbMigrate`.                                                                           |
| TLS verify-full to the master and to each role login     | 4    | `db-migrate.test.ts`, the factory-spy test                                                                                    | Pass `ca: ""` in the master factory call.                                                                                                   |
| Bootstrap check before the runner                        | 4    | `db-migrate.test.ts`, "no migrator row: the runner is never called"                                                           | Delete the bootstrap check, so `applyProductMigrations` is called.                                                                          |
| Passwords go only where the spec says                    | 4    | `db-migrate.test.ts`, the factory-spy test                                                                                    | Pass `master` as the password of a role-login call.                                                                                         |
| Migration record closed to other roles                   | 5    | `db-migrate.integration.test.ts`, "the record is closed"                                                                      | Add `GRANT USAGE ON SCHEMA migrator TO PUBLIC;` to `packages/db/sql/bootstrap.sql`.                                                         |
| `FORCE ROW LEVEL SECURITY` on every `app` table          | 5    | `db-migrate.integration.test.ts`, the first success test                                                                      | In `packages/db/drizzle/0001_fuzzy_ultimatum.sql`, delete the `FORCE ROW LEVEL SECURITY` line for `app.outbox`. Restore the file.           |
| The runner takes the advisory lock                       | 5    | `db-migrate.integration.test.ts`, the concurrency test                                                                        | Delete the `pg_advisory_lock` statement in `applyMigrations`.                                                                               |
| One transaction for the pending set                      | 5    | `db-migrate.integration.test.ts`, "failure half-way"                                                                          | None in this repo. The behaviour is Drizzle's, and `drizzle-orm` is an exact pin (`0.45.2`). Do not run a mutation. Say so in the report.   |
| Bootstrap check holds on a non-superuser master over TLS | 6    | `db-migrate-tls.integration.test.ts`, case 1                                                                                  | Delete the bootstrap check in `runDbMigrate`.                                                                                               |
| The image ships the command and the migration files      | 7    | `image.test.ts`, "ships db-migrate and the product migrations"                                                                | Remove `"drizzle"` from `files` in `packages/db/package.json`. Rebuild the image. Restore the file.                                         |

---

### Task 1: Report the migrations a run applied

**Files:**

- Modify: `packages/db/src/migrate.ts`
- Modify: `packages/db/src/index.ts`
- Create: `packages/db/test/database-fixture.ts`
- Modify: `packages/db/test/migrate.integration.test.ts`
- Modify: `packages/db/tsconfig.test.json`
- Modify: `eslint.config.js`

**Interfaces:**

- Produces: `type MigrationReport = { applied: string[]; total: number }`. `applyMigrations` and `applyProductMigrations` return `Promise<MigrationReport>`. `index.ts` exports `MIGRATION_LOCK_ID` and `type MigrationReport`.
- Produces: `freshDatabase(directUrl: string): Promise<{ name: string; url: string; drop(): Promise<void> }>`. It connects with `createPlaintextDirectSql`, creates a database named `hub_t_` plus 8 random hex characters, and returns a URL for it. `drop` runs `drop database ... with (force)`.
- How the report is built: `preflightFromDb` already reads the applied rows under the lock in the `migrator` session. It now returns them (an empty list when `to_regclass` is null). After Drizzle `migrate` returns, `applyMigrations` reads `created_at` from the journal table again. `applied` is the `tag` of each entry in `meta/_journal.json` (read from `opts.folder`) whose `when` is in the second set and not the first, in journal order. `total` is the journal length. When `migrate` throws, nothing is returned.

**Rule this must not break:** what is applied, the lock, the order, `SET ROLE`, the preflight and its three checks, and the `finally`. `applyTestMigrations` and the `drizzle-test` pairing guard are untouched. The existing two tests in `migrate.integration.test.ts` and `migrate.test.ts` pass unchanged.

**Decisions:** `MIGRATION_LOCK_ID` is exported from the package index and not imported by relative path. A relative import of `packages/db/src` from `apps/api` would load a second copy of `migrate.ts` and pull its imports into the api type check. The constant is not secret. The report reuses the preflight's read as its "before" set instead of adding a second query, because that read is the same session under the same lock. The tests derive the tags and the count from `meta/_journal.json`, not from the literal 8, so the next migration chunk does not break them.

- [ ] **Step 1: Write the failing tests**

Add `packages/db/test/database-fixture.ts` first. Add its path to `include` in `packages/db/tsconfig.test.json`, and add `test/migrate.integration.test.ts` to that `include` so the new assertions are type-checked. If adding the second path surfaces an error in lines this task did not write, stop and report. Do not refactor them. In `eslint.config.js` add the glob `**/test/*-fixture.ts` to the two existing test-file lists: the `ignores` of the typed block and the `files` of the block that extends `tseslint.configs.recommended`. The existing `migrate-test.ts` entries are the precedent.

In `migrate.integration.test.ts` add two tests that use `freshDatabase(runtime.directUrl)` and drop the database in `finally`.

`applyProductMigrations reports the tags it applied`: read the tags from `meta/_journal.json`. The first run on a fresh database resolves to `{ applied: <the tags in journal order>, total: <journal length> }`. A second run on the same database resolves to `{ applied: [], total: <journal length> }`.

`applyProductMigrations resets the role and frees the lock after a failure`: on a fresh database, with the superuser handle: call `runBootstrap`, then `create schema app authorization migrator` and `create table app.outbox (id int)`. `applyProductMigrations` on that same handle rejects (`0001` fails on `CREATE TABLE`). After the rejection, on the same handle: `select current_user` is not `migrator`, and `identity` and `platform` schemas do not exist. On a second connection to the same database, `select pg_try_advisory_lock(${MIGRATION_LOCK_ID})` returns true (unlock it afterwards). Import `MIGRATION_LOCK_ID` from `../src/migrate.js` in this package's own test.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `pnpm --filter @community-hub/db exec vitest run --config vitest.config.ts test/migrate.integration.test.ts`

Expected: the report test FAILS because `applyProductMigrations` resolves to `undefined`. The role-and-lock test passes already (the runner's `finally` is correct today). That is expected. It is a pin, and Step 4 proves it.

- [ ] **Step 3: Return the report**

In `migrate.ts` add `MigrationReport` and a small `readJournal(folder)` that reads `meta/_journal.json` and returns `{ tag: string; when: number }[]`. Make `preflightFromDb` return the rows it read. After `migrate`, read `created_at` again with `sql.unsafe` (the table name is already checked by `JOURNAL_TABLE`). Return the report from `applyMigrations` and from `applyProductMigrations`. Add the two exports to `index.ts`.

- [ ] **Step 4: Pin the reset and the unlock**

Run the tests again. Expected: PASS. Then delete the `reset role` line in the `finally`. The role assertion fails. Restore it. Delete the `pg_advisory_unlock` line. The lock assertion fails. Restore it. Report both failures.

- [ ] **Step 5: Gate and commit**

`pnpm exec prettier --write` on the files in this task. Then `pnpm gate`.

```bash
git add packages/db/src/migrate.ts packages/db/src/index.ts packages/db/test/database-fixture.ts packages/db/test/migrate.integration.test.ts packages/db/tsconfig.test.json eslint.config.js
git commit -m "$(cat <<'EOF'
feat(db): report the migrations a run applied

applyProductMigrations returns the tags it applied and the journal
length. What it applies, the lock and the order are unchanged.

Refs: docs/plans/2026-10-12-db-migrate-command.md task 1
EOF
)"
```

**Estimate:** about 185 changed lines (migrate.ts 40, index.ts 2, fixture 30, test 110, config 3).

---

### Task 2: Share the ops environment parsing

**Files:**

- Modify: `apps/api/src/env.ts`
- Create: `apps/api/src/db-ops-env.ts`
- Create: `apps/api/src/db-ops-env.test.ts`
- Modify: `apps/api/src/db-bootstrap.ts`

**Interfaces:**

- Produces: `env.ts` exports its existing `text(source, key)` and `portNumber(value)` unchanged. The two private copies in `db-bootstrap.ts` go.
- Produces: `readOpsEnv(source): OpsEnv | undefined` where `OpsEnv = { host, port, database, user, master, app, identity, platform }`, read from `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD_MASTER`, `PGPASSWORD_APP`, `PGPASSWORD_IDENTITY`, `PGPASSWORD_PLATFORM`. A missing or empty value, or a port that is not an integer from 1 to 65535, returns `undefined`.
- Produces: `loadImageCa(read?: (file: string) => string): string | undefined`. It reads `IMAGE_CERT_PATH` as UTF-8 and returns `undefined` when the read throws.

**Rule this must not break:** `db-bootstrap.ts` behaviour. `db-bootstrap.test.ts` and `env.test.ts` are not edited and pass. `readServiceEnv` is not changed.

**Decision:** the CA read has its own function because the spec's `runDbMigrate({ source, pem, connect })` takes a PEM that is already read, so an unreadable bundle cannot be tested inside it. The entry block of the command calls `loadImageCa` and prints `env` when it is `undefined`. `db-bootstrap.ts` does not use `loadImageCa`: the spec changes it only to share parsing.

- [ ] **Step 1: Write the failing test**

`db-ops-env.test.ts`: a full synthetic environment returns the eight values with the port as a number. Each of the eight variables missing, and each empty, returns `undefined`. Ports `0`, `65536`, `abc`, `8e3`, and ` 5432` return `undefined`. `loadImageCa` with a reader that returns a string returns it. With a reader that throws a marker error it returns `undefined`.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @community-hub/api exec vitest run --config vitest.config.ts src/db-ops-env.test.ts`

Expected: FAIL because `./db-ops-env.js` does not exist.

- [ ] **Step 3: Extract**

Export `text` and `portNumber` from `env.ts`. Add `db-ops-env.ts`. In `db-bootstrap.ts` delete the local `text` and `portNumber` and replace the eight reads and the `undefined` check with `readOpsEnv`. Keep the `Failure` type, the stage variable, and the result type as they are.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm --filter @community-hub/api exec vitest run --config vitest.config.ts src/db-ops-env.test.ts src/db-bootstrap.test.ts src/env.test.ts`

Expected: PASS, with `db-bootstrap.test.ts` and `env.test.ts` unedited.

- [ ] **Step 5: Gate and commit**

```bash
git add apps/api/src/env.ts apps/api/src/db-ops-env.ts apps/api/src/db-ops-env.test.ts apps/api/src/db-bootstrap.ts
git commit -m "$(cat <<'EOF'
refactor(api): share the ops environment parsing

db-bootstrap and the migrate command read the same eight variables.
db-bootstrap behaviour is unchanged.

Refs: docs/plans/2026-10-12-db-migrate-command.md task 2
EOF
)"
```

**Estimate:** about 175 changed lines (env.ts 2, db-ops-env.ts 45, test 80, db-bootstrap.ts 50 moved or removed).

---

### Task 3: Reduce an error to a stage word and a SQLSTATE

**Files:**

- Create: `apps/api/src/db-ops-error.ts`
- Create: `apps/api/src/db-ops-error.test.ts`

**Interfaces:**

- Produces: `sqlstate(error: unknown): string | undefined` and `failureLine(stage: "connect" | "migrate", error: unknown): string`. `failureLine` returns `connect\n`, `migrate\n`, `connect 28P01\n`, or `migrate 42501\n`.
- Rule for `sqlstate`: the carrier is `error` when it has a string `code`, else `error.cause` (one level, never deeper). The code is returned only when the carrier is a `PostgresError`, meaning `name === "PostgresError"` or the carrier has a `severity` property (presence only, the value is never read), and the code matches `^[0-9A-Z]{5}$`. When `error` has a `code` that fails the check, nothing falls through to `cause`. Anything that is not an object returns `undefined`.

**Rule this must not break:** nothing else is read from the error. No `message`, `query`, `params`, `stack`, `cause.message`, or `String(error)`.

- [ ] **Step 1: Write the failing test**

Cases, each returning the exact line:

- A flat `PostgresError`-shaped error (`name`, `severity`, `code` `42501`): `migrate 42501\n`. Severity only, no `name`: accepted. Name only, no severity: accepted.
- A `DrizzleQueryError`-shaped wrapper: an `Error` whose `message` is `Failed query: <SQL text> params: <planted password, host, connection string>`, with `query` and `params` properties, no `code`, and a `PostgresError`-shaped `cause` with `code` `42501`: `migrate 42501\n`.
- The same wrapper whose `cause` is a plain `Error` with `code` `EPIPE`: `migrate\n`. A top-level `Error` with `code` `EPIPE`, `EPERM`, or `EBADF`: bare. A code two levels down (`cause.cause`): bare. A lower-case code, a six-character code, and a numeric code: bare.
- A plain `Error` with no code, a string, `null`, `undefined`, and a number: bare.
- A throwing-getter error: an object whose `message`, `query`, `params`, `stack`, and `cause.message` are getters that record the access and throw, with a valid `PostgresError`-shaped `cause`. `failureLine` returns the code line and no getter was accessed.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @community-hub/api exec vitest run --config vitest.config.ts src/db-ops-error.test.ts`

Expected: FAIL because `./db-ops-error.js` does not exist.

- [ ] **Step 3: Implement**

Add `db-ops-error.ts` to the rule above. Read only `name`, `severity` (presence), `code`, and `cause`.

- [ ] **Step 4: Pin the two rules**

Run the test. Expected: PASS. Then return `error.code` without the `PostgresError` check. The `EPIPE` plants fail. Restore it. Then read `error.message` inside `failureLine`. The getter test fails. Restore it. Report both failures.

- [ ] **Step 5: Gate and commit**

```bash
git add apps/api/src/db-ops-error.ts apps/api/src/db-ops-error.test.ts
git commit -m "$(cat <<'EOF'
feat(api): reduce a database error to a stage and a SQLSTATE

A code is read only from a PostgresError, one level down at most.
No message, query, parameter or stack is ever read.

Refs: docs/plans/2026-10-12-db-migrate-command.md task 3
EOF
)"
```

**Estimate:** about 155 changed lines (module 45, test 110).

---

### Task 4: The db-migrate command

**Files:**

- Create: `apps/api/src/db-migrate.ts`
- Create: `apps/api/src/db-migrate.test.ts`

**Interfaces:**

- Consumes: `createDirectSql` and `applyProductMigrations` from `@community-hub/db`, `readOpsEnv` and `loadImageCa` from `./db-ops-env.js`, `failureLine` from `./db-ops-error.js`, `sqlstate` for the role-login check.
- Produces: `runDbMigrate(deps: { source: NodeJS.ProcessEnv; pem: string; connect: typeof createDirectSql }): Promise<{ exitCode: 0 | 1; stdout: string; stderr: string }>`. It never rejects: the whole body is in a `try`/`catch`, and every `end()` call is `.catch(() => undefined)`.
- Produces: the entry block, the only code that touches `process`. It calls `loadImageCa()`. When that is `undefined` it writes `env\n` and exits 1. Otherwise it calls `runDbMigrate({ source: process.env, pem, connect: createDirectSql })`, writes stdout and stderr, and exits with the code. It mirrors the guard in `db-bootstrap.ts`.
- Order inside `runDbMigrate`, with the stage each step reports: (1) `readOpsEnv`, `undefined` is `env`. (2) Stage `connect`: call `connect` for the master with the PEM, host, port, database, user, and master password, and no `servername`. The first query is `select 1 from pg_roles where rolname = 'migrator'`. A rejection is `connect` with `sqlstate`. (3) Stage `not_bootstrapped`: no `migrator` row is `not_bootstrapped`. For each of `app`, `identity`, `platform`, in that order, call `connect` with that role as user and its own password, run `select 1`, and `end()` it. A rejection with `28P01` or `28000` from a `PostgresError` is `not_bootstrapped`. A rejection with any other error is `connect` with `sqlstate`. (4) Stage `migrate`: `applyProductMigrations(sql)`. A rejection is `migrate` with `sqlstate`. (5) Success: one `applied <tag>\n` per tag, then `done applied=<n> total=<m>\n`, exit 0, stderr empty.

**Rule this must not break:** §1 rules 5 and 8. The output is exactly the spec's table. The only SQL in this file is `select 1 from pg_roles where rolname = 'migrator'` and `select 1`. No `SET`, `set_config`, or session statement is written in it, because `check:boundaries` bans that outside `migrate.ts`. The command does not call `runBootstrap`: the runner does, inside the lock.

**Decision:** the unit test replaces `applyProductMigrations` with `vi.mock("@community-hub/db", ...)`, keeping the real `createDirectSql` type, so `runDbMigrate` keeps the spec's three-field contract and gains no injected runner.

- [ ] **Step 1: Write the failing test**

`db-migrate.test.ts` follows `db-bootstrap.test.ts`: a fake `Sql` that records the text of each tagged-template query and answers `pg_roles` and `select 1`. Role-login connections are separate fakes. A `connect` spy records every target. `MARKER` is `planted-password-marker`. Planted errors are shaped like the real ones: a `DrizzleQueryError`-shaped wrapper (message with SQL, a host, a connection string, and the marker, no `code`, a `PostgresError`-shaped `cause`) for the runner, a flat `PostgresError`-shaped error for the driver.

Cases, each asserting `{ exitCode, stdout, stderr }` exactly:

- Each of the eight variables missing, empty, and a bad port: `env\n`, `connect` never called.
- `connect` throws synchronously: `connect\n`. `connect` returns and the `pg_roles` query rejects with `28P01`: `connect 28P01\n`. With a TLS-style error with no code, and with an `EPIPE` errno error: `connect\n`.
- No `migrator` row: `not_bootstrapped\n`, `applyProductMigrations` never called, and the spy saw only the master target.
- A role login rejects with `28P01`, then with `28000`: `not_bootstrapped\n`. With another `PostgresError` code: `connect <code>\n`. With an error with no code: `connect\n`. A role-login `connect` that throws a non-Postgres error whose message and a property carry the marker: `connect\n` and the marker in neither stream.
- The runner rejects with the wrapper (`cause` code `42501`): exactly `migrate 42501\n`. With a wrapper whose `cause` has `EPIPE`: `migrate\n`. With a code two levels down: `migrate\n`. With a flat `PostgresError`-shaped error `42501`: `migrate 42501\n`. With a plain `Error`: `migrate\n`.
- Success: the runner resolves `{ applied: [<two tags>], total: 8 }`. Stdout is two `applied` lines then `done applied=2 total=8\n`, stderr empty, exit 0. With `{ applied: [], total: 8 }`: `done applied=0 total=8\n`.
- Every `end()` rejecting changes no result above.
- The log-content test: for every case above, `stdout + stderr` matches `^(applied [0-9]{4}_[a-z0-9_]+\n)*done applied=[0-9]+ total=[0-9]+\n$`, or `^(env|not_bootstrapped)\n$`, or `^(connect|migrate)( [0-9A-Z]{5})?\n$`. It contains none of the planted values, and none of them is in any statement text the fake driver recorded.
- The factory spy: the first call has the master user, the master password, `ca` equal to the injected PEM, `host` equal to `PGHOST`, and no `servername` key. The next three calls are `app`, `identity`, `platform` in that order, each with its own password and the same `ca` and `host`. The master password appears in no role call, and no role password appears in the master call.
- The migrate stage runs after the role logins: the runner mock's first call is after the third `select 1`.

- [ ] **Step 2: Run the test and watch it fail**

Run: `pnpm --filter @community-hub/api exec vitest run --config vitest.config.ts src/db-migrate.test.ts`

Expected: FAIL because `./db-migrate.js` does not exist.

- [ ] **Step 3: Implement**

Add `db-migrate.ts` to the interfaces above. Keep the stage in a local variable so the outer `catch` reports the stage reached. Open each role connection, run `select 1`, and close it inside its own `try`/`finally`.

- [ ] **Step 4: Run the test and watch it pass**

Run the same command. Expected: PASS, including the log-content test.

- [ ] **Step 5: Pin the four settings**

Make each change in the Security pins table for this task once, run `src/db-migrate.test.ts`, see the named test fail, and restore the file: `String(error)` into stderr, then `ca: ""` for the master, then the bootstrap check deleted, then the master password in a role call. Report the four failures.

- [ ] **Step 6: Gate and commit**

`pnpm gate` includes `check:boundaries`, `lint`, and `typecheck` for the new file.

```bash
git add apps/api/src/db-migrate.ts apps/api/src/db-migrate.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add the db-migrate command

Connect as the master login, refuse to run before db-bootstrap, apply
the product migrations, and print the tags. A failure prints a stage
word and at most a SQLSTATE.

Refs: docs/plans/2026-10-12-db-migrate-command.md task 4
EOF
)"
```

**Estimate:** about 480 changed lines (command 150, test 330).

---

### Task 5: Prove the command on the shared cluster

**Files:**

- Create: `apps/api/src/db-migrate.integration.test.ts`

**Interfaces:**

- Consumes: `runDbMigrate` from `./db-migrate.js`, `MIGRATION_LOCK_ID` from `@community-hub/db`, `freshDatabase` from `../../../packages/db/test/database-fixture.js`, `createPlaintextDirectSql` from `@community-hub/db/plaintext`, and `packages/db/test/.runtime.json` (`directUrl`, `passwords`) the way `access-flow.integration.test.ts` reads it.
- A helper in the file builds `source` for a fresh database: host `127.0.0.1`, port `5432`, the new database name, user `hub`, the master password parsed from `directUrl`, and the three role passwords from `.runtime.json`. A plaintext `connect` maps a target to a `createPlaintextDirectSql` URL. `pem` is the bundle at `apps/api/certs/`, which the fake factory ignores.

**Rule this must not break:** the test never drops a role, never alters a password, and never touches `hub_product_only` or `hub`. Roles are cluster-wide and other suites rely on them. Every case uses its own `freshDatabase` and drops it in `finally`.

**Decision:** the "second concurrent start" in the spec is read as two runs started while the lock is held. The test waits for two ungranted advisory-lock rows, releases, and asserts that exactly one result is `applied=<total>` and the other is `applied=0`. This is stronger than a run after completion and is still not timing-based.

- [ ] **Step 1: Write the tests**

Because the command already exists, the first run is expected to pass. The RED for this task is the pin runs in Step 3.

- Success: stdout lists the journal's tags in order, then `done applied=<n> total=<n>`. `migrator.__drizzle_migrations` has `n` rows. Every `app` table (`pg_class` joined to `pg_namespace`, `relkind` `r` or `p`) has `relrowsecurity` and `relforcerowsecurity` true, and there is at least one. `app`, `identity`, and `platform` are owned by `migrator`.
- Second run: exit 0, `done applied=0 total=<n>`, the same row count, and the same `hash` and `created_at` values as before.
- The record is closed: `has_schema_privilege` for `app`, `identity`, and `platform` on `migrator` with `USAGE` and with `CREATE` is false. `select count(*) from pg_namespace n, aclexplode(n.nspacl) a where n.nspname = 'migrator' and a.grantee = 0` is `0` (no PUBLIC entry).
- Concurrency: a second superuser connection to the fresh database takes `pg_advisory_lock(MIGRATION_LOCK_ID)` and holds it. Start two `runDbMigrate` calls without awaiting. Poll `pg_locks` until two rows exist with `locktype = 'advisory'`, `classid = 0`, `objid = MIGRATION_LOCK_ID`, `granted = false`, and `database` equal to the fresh database's oid from `pg_database`. The poll has a 20-second ceiling and sleeps 100 ms between reads. While the lock is held, `to_regclass('migrator.__drizzle_migrations')` is null or the table has no rows. Release with `pg_advisory_unlock`. Await both. Both exit 0 and exactly one result is `applied=<n>` while the other is `applied=0`. The journal has `n` rows.
- Failure half-way: the roles already exist on this cluster, so as the superuser `create schema app authorization migrator` and `create table app.outbox (id int)` on the fresh database. The run exits 1 with stderr exactly `migrate 42P07\n` and empty stdout. After it: `identity` and `platform` schemas do not exist, and `migrator.__drizzle_migrations` has zero rows. Drop `app.outbox`. A re-run exits 0 with `applied=<n>`.

- [ ] **Step 2: Run the file**

Run: `pnpm --filter @community-hub/api exec vitest run --config vitest.integration.config.ts src/db-migrate.integration.test.ts`

Expected: PASS. If a case fails here, the cause is in the test or in an earlier task. Do not change a migration.

- [ ] **Step 3: Pin three settings**

Add `GRANT USAGE ON SCHEMA migrator TO PUBLIC;` to `packages/db/sql/bootstrap.sql`. "The record is closed" fails. Restore the file. Delete the `FORCE ROW LEVEL SECURITY` line for `app.outbox` in `packages/db/drizzle/0001_fuzzy_ultimatum.sql`. The success test fails on the flag assertion. Restore the file. Delete the `pg_advisory_lock` statement in `applyMigrations` and rebuild with `pnpm --filter @community-hub/db build`. The concurrency test fails. Restore the file and rebuild. Run `git diff --stat -- packages/db` and confirm it is empty. Report the three failures. Report that the one-transaction guard has no repo mutation.

- [ ] **Step 4: Gate and commit**

```bash
git add apps/api/src/db-migrate.integration.test.ts
git commit -m "$(cat <<'EOF'
test(api): run db-migrate on a fresh database

Success, a second run, the closed migration record, two runs behind one
lock, and a failure that rolls back the whole pending set.

Refs: docs/plans/2026-10-12-db-migrate-command.md task 5
EOF
)"
```

**Estimate:** about 260 changed lines.

---

### Task 6: Prove the command over TLS against a non-superuser master

**Files:**

- Create: `packages/db/test/tls-fixture.ts`
- Modify: `packages/db/test/tls.integration.test.ts`
- Create: `apps/api/src/db-migrate-tls.integration.test.ts`
- Modify: `packages/db/tsconfig.test.json`

**Interfaces:**

- Produces in `tls-fixture.ts`: `TLS_SERVER_NAME` (the fixed test name the existing test uses), `createTlsCerts(): { dir: string; signingCa: string; otherCa: string; cleanup(): void }`, and `startTlsPostgres(opts: { certDir: string; superuser: string; password: string; database: string }): Promise<{ name: string; port: number; stop(): void }>`. The openssl steps, the `docker run` with `postgres-tls-entrypoint.sh`, the `docker port` parse, and the readiness wait move out of `tls.integration.test.ts` unchanged. `tls.integration.test.ts` calls them and keeps every test body and assertion as it is. The `**/test/*-fixture.ts` lint glob from Task 1 already covers the new file. Add `test/tls-fixture.ts` to `include` in `packages/db/tsconfig.test.json`.
- Consumes in the new test: `runDbMigrate` from `./db-migrate.js`, `runDbBootstrap` from `./db-bootstrap.js`, `createDirectSql` and `runBootstrap` from `@community-hub/db`, `createPlaintextDirectSql` from `@community-hub/db/plaintext`, and the fixture by the relative path `../../../packages/db/test/tls-fixture.js`, the same reach `access-flow.integration.test.ts` makes for `.runtime.json`.

**Rule this must not break:** `tls.integration.test.ts` keeps all of its tests and assertions. `postgres-tls-entrypoint.sh` is not edited. The fixture is not copied into `apps/api`.

**Decisions:** the refactor and its second user are one commit, so the extraction is proven by the existing TLS tests passing and by the new file using it. The new test calls `runDbMigrate` in-process with a `connect` wrapper `(target) => createDirectSql({ ...target, servername: TLS_SERVER_NAME })`, because `IMAGE_CERT_PATH` has no override and `createDirectSql` needs a `servername` for an IP host. `createDirectSql` still verifies the certificate against the test CA. `runDbBootstrap` runs once, as setup at the start of case 3, to give the roles passwords. The spec lists it at case 5.

- [ ] **Step 1: Write the failing test**

`db-migrate-tls.integration.test.ts`: `beforeAll` (120-second timeout) creates the certificates and starts the container with the image's superuser. Through a plaintext connection as that superuser it creates a master role with `LOGIN CREATEROLE CREATEDB` and a synthetic password, and a database that master owns. It has no `rds_superuser` and is not a superuser. `afterAll` stops the container and cleans up. The six cases run in order on this one cluster, each asserting `{ exitCode, stdout, stderr }`:

1. The empty cluster: exit 1, stderr `not_bootstrapped\n`. Afterwards no role named `migrator`, `app`, `identity`, or `platform`, no schema `migrator`, `app`, `identity`, or `platform`, and no table in the database.
2. After `runBootstrap` as the master (roles with no passwords): exit 1, `not_bootstrapped\n`. Afterwards no `app`, `identity`, or `platform` schema and no table exist.
3. Run `runDbBootstrap` to set the three passwords. Then pass a wrong password for one role: exit 1, `not_bootstrapped\n`, and no `app` table.
4. A wrong master password: exit 1, `connect 28P01\n`.
5. Correct passwords: exit 0, stdout lists the journal tags and `done applied=<n> total=<n>`. This also proves `bootstrap.sql` ran a second time as a non-superuser inside the runner.
6. A second run: `done applied=0 total=<n>`.

- [ ] **Step 2: Run the new file and watch it fail**

Run: `pnpm --filter @community-hub/api exec vitest run --config vitest.integration.config.ts src/db-migrate-tls.integration.test.ts`

Expected: FAIL because `tls-fixture.ts` does not exist.

- [ ] **Step 3: Extract the fixture and refactor the TLS test**

Add `tls-fixture.ts` by moving code. Change `tls.integration.test.ts` to call it. Run `pnpm --filter @community-hub/db exec vitest run --config vitest.config.ts test/tls.integration.test.ts`. Expected: every existing test PASSES unchanged. These existing tests are the characterisation test for the extraction.

- [ ] **Step 4: Run the new file and watch it pass**

Run the Step 2 command. Expected: PASS for all six cases. If case 5 fails on a privilege error that a plain `CREATEROLE` master hits, stop and report with the SQLSTATE. Do not change `bootstrap.sql` or a migration.

- [ ] **Step 5: Pin the bootstrap check**

Delete the bootstrap check in `runDbMigrate`. Case 1 fails because the runner creates the roles and applies. Restore the file. Report the failure.

- [ ] **Step 6: Gate and commit**

`pnpm gate` type-checks the cross-package import in `apps/api`. If `tsc` or `eslint` rejects it, stop and report. Do not copy the fixture.

```bash
git add packages/db/test/tls-fixture.ts packages/db/test/tls.integration.test.ts packages/db/tsconfig.test.json apps/api/src/db-migrate-tls.integration.test.ts
git commit -m "$(cat <<'EOF'
test(api): run db-migrate over TLS as a non-superuser master

A throwaway Postgres with a CREATEROLE master and verify-full TLS hosts
the not_bootstrapped cases and the positive run. The certificate and
container setup is extracted from the TLS test, not copied.

Refs: docs/plans/2026-10-12-db-migrate-command.md task 6
EOF
)"
```

**Estimate:** about 460 changed lines (fixture 130 moved, TLS test 20 net edits, new test 210, config 1).

---

### Task 7: Assert the image ships the command and the migrations

**Files:**

- Modify: `apps/api/src/image.test.ts`

**Interfaces:**

- Adds two tests inside the existing `describe.skipIf(process.env.RUN_IMAGE_TESTS !== "1")` block, each beginning with `ensureImage()`.
- `ships db-migrate and the product migrations`: one `docker run --rm <image> node --input-type=module -e` that exits 0 only when `/app/db-migrate.js` exists, reads `/app/node_modules/@community-hub/db/drizzle/meta/_journal.json`, checks that every `<tag>.sql` it names exists in that `drizzle` directory, and prints the tags as JSON. The test compares that list with the tags in `packages/db/drizzle/meta/_journal.json` in the working tree, in order.
- `runs db-migrate with no environment`: `docker run --rm <image> node /app/db-migrate.js` with no `--entrypoint` and no `-e`. Status 1, stdout empty, stderr `env\n`.
- The existing test that runs the image with no command still starts the server. It is not edited. The existing walk test that forbids `.ts`, test files, and `/test` directories under `node_modules/@community-hub` must still pass.

**Rule this must not break:** the image contract tests. No Dockerfile change.

**CI:** `.github/workflows/ci.yml` already runs this file with `RUN_IMAGE_TESTS=1` in two places. The `build-preview` job runs it on every pull request after building the ARM image. The `publish` job runs it on `main` before it pushes, when the tag is not already in the registry. No workflow change is needed.

- [ ] **Step 1: Write the tests**

Add the two tests. They are not skipped unless `RUN_IMAGE_TESTS` is unset.

- [ ] **Step 2: Run them**

Run: `RUN_IMAGE_TESTS=1 pnpm --filter @community-hub/api exec vitest run --config vitest.config.ts src/image.test.ts`

Expected: PASS. The first run builds the ARM image, which is slow. If the `drizzle` assertion fails on the built image, the migration files are not in the image. **Stop and ask.** The spec's fix is one `COPY` line in `apps/api/Dockerfile`, and a Dockerfile change is outside this plan until the owner approves it.

- [ ] **Step 3: Pin the shipped files**

Remove `"drizzle"` from `files` in `packages/db/package.json`. Delete the local image with `docker image rm community-hub-api:local` so the test rebuilds it. The first new test fails. Restore the file and delete the image again. Report the failure.

- [ ] **Step 4: Gate and commit**

```bash
git add apps/api/src/image.test.ts
git commit -m "$(cat <<'EOF'
test(api): assert the image ships db-migrate and the migrations

The command, the journal and every migration file the journal names are
in the image, and the command with no environment exits 1 with env.

Refs: docs/plans/2026-10-12-db-migrate-command.md task 7
EOF
)"
```

**Estimate:** about 55 changed lines.

---

### Task 8: The runbook section

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`

**Interfaces:**

- Adds a section "Apply product migrations" immediately after "Change a database role" and before "First running task".

**Rule this must not break:** the section records no password, connection string, secret ARN, account id, subnet id, security group id, hostname, or registry host. It uses `${VARIABLE}` placeholders only. In zsh a variable followed by a colon is written `${VAR}:text`. The human runs it. An agent does not. It adds no bastion, no public database, no NAT gateway, and no ECS Exec.

- [ ] **Step 1: Write the section**

It states these, with placeholders:

- Prerequisites. Staging is unparked in a chunk whose approved spec says so. The `db-bootstrap` one-off has exited 0 on this database. The image is the digest from the `publish` job summary on the `main` that contains this command.
- The command. Run the existing ops task definition as a one-off ECS task with the command override `["node", "/app/db-migrate.js"]`. `entryPoint` is not set. Use the task security group, the staging public subnet, and a public address. Show the `aws ecs run-task` call with `${AWS_PROFILE}`, `${CLUSTER}`, `${OPS_TASK_DEFINITION}`, `${SUBNET}`, `${TASK_SECURITY_GROUP}`, and a `--overrides` JSON that sets only `command`. Show reading the exit code with `aws ecs describe-tasks` and the lines with `aws logs get-log-events` on the service log group and the `db-ops` stream prefix, with `${LOG_GROUP}` and `${LOG_STREAM}`.
- Results. A table of the spec's output: exit 0 with `applied` lines and `done applied=<n> total=<m>`, exit 0 with `done applied=0`, and the four stderr words (`env`, `connect`, `not_bootstrapped`, `migrate`) with what each means and what the human does. `connect 28P01` is a wrong master password. `not_bootstrapped` also covers a wrong role password, and the remedy is to run `db-bootstrap`. `migrate` with a SQLSTATE is a database error, and `migrate` alone is one of the runner's own checks. A failed run applies nothing from that run, so the human fixes the cause and runs it again.
- Waiting. A second run waits for the first to release the lock, with no bound. If the first task hangs, the human stops it, which closes its connection and releases the lock.
- Re-park. If the cause cannot be fixed inside the unpark window, re-park. That destroys a staging database that holds no data. There is no down-migration.
- The log stream holds the evidence. The journal table records the file's `when` value, not the time it ran, so the ECS task's stop time and the log stream are the record of a run.

- [ ] **Step 2: Gate and commit**

```bash
git add docs/runbooks/apply-staging-au.md
git commit -m "$(cat <<'EOF'
docs(runbooks): apply the product migrations with db-migrate

The database accepts connections only from the task security group, so
the migrations run as a one-off ops task, as db-bootstrap does.

Refs: docs/plans/2026-10-12-db-migrate-command.md task 8
EOF
)"
```

**Estimate:** about 50 changed lines.

---

### Task 9: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Consumes: the Phase 0 table, the Where we are table, and the repository-state cell, as they are on `main` at `8fc42c0`. Phase 0 is 24 rows (23 done, 1 superseded `api-au-hostname`, 0 not started).
- Produces: a new last Phase 0 row `db-migrate-command`, after `service-image-runtime-base`, status **done**, linking `docs/specs/2026-10-12-db-migrate-command.md`. The row says the image gains `/app/db-migrate.js`, which applies the product migrations as the master login, refuses to run before `db-bootstrap`, and prints the tags it applied, and that it has not been run on staging.
- Where we are: last shipped `db-migrate-command`. Phase 0 becomes `25 rows: 24 done, 1 superseded (`api-au-hostname`), 0 not started`. Next chunk and the sentence under the Phase 0 table (`Next is entitlements-plans.`) and the Next spec section stay as they are.
- `AGENTS.md`: in the repository-state cell, `Phase 0: 25 rows, 24 done, 1 superseded (`api-au-hostname`), 0 not started.` Nothing else in that cell or in the file changes.

**Rule this must not break:** the open item "This image has not run on Fargate" stays for the proof run to replace. `architecture.md` is not edited. Re-derive the counts from `docs/roadmap.md` on `origin/main` before writing: `staging-proof-run` is a draft and adds no row on `main`. If `main` has moved and a Phase 0 row has been added, recompute and say so in the report.

- [ ] **Step 1: Edit the three places**

Add the row, update the two table cells, and update the repository-state cell. Run `pnpm exec prettier --write docs/roadmap.md AGENTS.md`, because the header table cell changes.

- [ ] **Step 2: Clean up the session scratch**

```bash
rm -f docs/plans/*-report.md
git status --short
```

Expected: only `docs/roadmap.md` and `AGENTS.md` are modified. Nothing under `.superpowers/` is staged.

- [ ] **Step 3: Gate and commit**

```bash
git add docs/roadmap.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark the db-migrate command done

Phase 0 is 25 rows: 24 done, 1 superseded, 0 not started. Staging stays
parked and the command has not run there.

Refs: docs/plans/2026-10-12-db-migrate-command.md task 9
EOF
)"
```

**Estimate:** about 6 changed lines.

---

## Task summary

| Task | Commit subject                                                    | Estimate   |
| ---- | ----------------------------------------------------------------- | ---------- |
| 1    | `feat(db): report the migrations a run applied`                   | 185        |
| 2    | `refactor(api): share the ops environment parsing`                | 175        |
| 3    | `feat(api): reduce a database error to a stage and a SQLSTATE`    | 155        |
| 4    | `feat(api): add the db-migrate command`                           | 480        |
| 5    | `test(api): run db-migrate on a fresh database`                   | 260        |
| 6    | `test(api): run db-migrate over TLS as a non-superuser master`    | 460        |
| 7    | `test(api): assert the image ships db-migrate and the migrations` | 55         |
| 8    | `docs(runbooks): apply the product migrations with db-migrate`    | 50         |
| 9    | `docs(roadmap): mark the db-migrate command done`                 | 6          |
|      | **Total**                                                         | **~1,825** |

## What the implementer must stop and ask about

Stop, do not improvise, and report to the reviewer (AGENTS.md §12):

- Any need to edit a migration file, a snapshot, `bootstrap.sql`, the Dockerfile, a workflow, or Terraform. The only allowed edits to the first three are the Task 5 and Task 7 mutations, restored before the commit.
- The image assertion in Task 7 shows `drizzle/` or a `.sql` file missing from the image.
- Any log line that could carry SQL text, a host, a port, a user, a database name, or a driver message. This includes a test that needs `error.message` to pass.
- A privilege error in Task 6 that a plain `CREATEROLE` master hits. Report the SQLSTATE and the statement. Do not widen the stand-in master.
- `tsc` or `eslint` rejects the cross-package fixture import in `apps/api`. Do not copy the fixture.
- A cache or ordering problem that seems to need a `turbo.json` change.
- The spec and the code disagree on something not listed here.
- The gate fails twice on the same thing. Report what you learned instead of a third guess.
- Anything that looks like a security issue, a secret in output, or production data.

## Definition of done

Per task (AGENTS.md §8), before reporting:

- [ ] `pnpm gate`
- [ ] Test written first and proves the behaviour
- [ ] No non-negotiable from §1 touched (or explicitly justified)
- [ ] Manifest updated if keys, permissions or events changed. None change here.
- [ ] Commit message follows §9
- [ ] Commit contains only files named in the task (no `*-report.md`, no `.superpowers/`)

Per chunk, before requesting merge:

- [ ] All plan tasks done or consciously dropped with a note
- [ ] Full CI green (§10)
- [ ] Tenant-isolation and residency suites green. Existing suites only: this chunk adds no table. The Task 5 FORCE ROW LEVEL SECURITY assertion is the new tenancy proof.
- [ ] **Spec's behaviour verified on the staging hostname: deferred.** Staging is parked, the spec says this chunk does not unpark it, and no one runs the command here. The `staging-proof-run` chunk runs `db-migrate` on staging and records the result. This chunk's behaviour is proven by the unit, integration, TLS, and image tests above, and the spec names the one gap (RDS differs from the stand-in).
- [ ] `architecture.md` updated if a documented decision changed. None changes. No ADR.
- [ ] `docs/roadmap.md` updated in the same PR, last commit on this branch: this chunk **done**, snapshot current (Task 9)
- [ ] Reviewer agent sign-off recorded in the PR. The second independent review is required (database, tenancy, the master login) and starts when the pull request opens. The PR's second-review line stays open until it is written.
- [ ] Session scratch cleaned up (§5): no `docs/plans/*-report.md` on disk; nothing under `.superpowers/` staged
