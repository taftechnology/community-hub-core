# Plan: packages/db foundations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `@community-hub/db` with a privileged bootstrap, a Drizzle-Kit-wrapped runner on a direct connection, and CI proof that tenant scope is transaction-local under PgBouncer — without applying anything to RDS.

**Architecture:** Bootstrap (privileged login, every apply, never destructive) creates four roles and schema `migrator`. The runner takes an advisory lock as the privileged login, then bootstraps, then `SET ROLE migrator` on an unpooled connection and wraps Kit `migrate()`. Already-applied files are checked against Drizzle's own journal `hash`. App-traffic tests go through PgBouncer as the `app` / `identity` / `platform` logins. Runtime never `SET ROLE`.

**Tech Stack:** PostgreSQL 17, PgBouncer ≥ 1.21 transaction mode, `postgres` (postgres.js) 3.4.x, `drizzle-orm` 0.45.x, `drizzle-kit` 0.31.x, Vitest, Docker Compose in CI.

**Spec:** `docs/specs/2026-09-18-packages-db.md` (approved 2026-09-18, Abdus Salam)

Status: approved (2026-09-18, Abdus Salam)

**Branch:** `feat/2026-09-18-packages-db` · one PR · 6 tasks, one commit each

## Global Constraints

- Runner connection: direct to Postgres, `max: 1`. Never PgBouncer, never Hyperdrive.
- Runtime connections: pick a login (`app` / `identity` / `platform`). Never `SET ROLE`.
- Tenant scope: bound `SELECT set_config(..., true)` only. No interpolated `SET` / `SET LOCAL` / `SET SESSION`.
- Bootstrap before every journal apply, **after** the advisory lock. Idempotent. No `DROP`, no `PASSWORD` in SQL, no `CREATE ROLE` in the journal.
- Passwords: pre-computed SCRAM-SHA-256 verifier in `ALTER ROLE`. Plaintext never in SQL or server logs from this helper.
- Product entry point cannot load `drizzle-test/`. `applyTestMigrations` takes `{ mode: 'test' }` only — no environment variable. `migrate-test` is not in the package `exports` map.
- `encrypted-query` stays provisional. `schema-rls` does not.
- No `infra/` change. No Hyperdrive on gateway. No roadmap `done` flip.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Pin at implement time (npm current 2026-09-18 in parentheses; do not float majors): `drizzle-orm` (`0.45.2`), `drizzle-kit` (`0.31.10`), `postgres` (`3.4.9`).

---

## Tooling decisions this plan makes

| Choice                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Why                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL driver                 | **`postgres` (postgres.js)**, not `pg`                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Tagged templates bind parameters. Cloudflare Hyperdrive documents this driver. Nested `begin` is unused: we do not join Kit's transaction.                                                                                                                                                                                                                                          |
| Pooled `prepare`           | **`prepare: true`** on PgBouncer clients; PgBouncer `max_prepared_statements = 100`                                                                                                                                                                                                                                                                                                                                                                                                            | Matches Hyperdrive's prepared-statement path. A pooler more lenient than Hyperdrive fails the spec.                                                                                                                                                                                                                                                                                 |
| Migrator `prepare`         | **`prepare: false`**, `max: 1`, connection closed after the run                                                                                                                                                                                                                                                                                                                                                                                                                                | `SET ROLE` and `pg_advisory_lock` are session-level. Do not return that connection to any pool.                                                                                                                                                                                                                                                                                     |
| Checksums vs Kit `migrate` | **No extra checksum table, no outer-transaction join.** Kit's journal row already stores `hash` (content SHA-256) and `created_at` (= journal `when`) in the same transaction as the apply. Before applying, recompute each already-applied file the same way 0.45.2's `readMigrationFiles` does and compare to stored `hash`, matching on `created_at`. **T2 confirms this against the pinned source.** If `hash` is not a content digest, stop and report — do not add a side table or join. | Removes the join (`drizzle(tx)` builds a top-level session and calls `client.begin()`; postgres.js transaction handles may not have `begin`, so the join throws rather than committing wrongly). Spec still holds: the hash is recorded in the apply transaction itself.                                                                                                            |
| PgBouncer SCRAM            | **Passthrough, not plaintext in `auth_file`.** Compute the verifier once. `ALTER ROLE … PASSWORD '<verifier>'`. Write the **same** verifier into PgBouncer `userlist.txt`. `auth_type = scram-sha-256`. Database line **has no `user=`**. Clients connect with the env **plaintext** (postgres.js SCRAM). No `auth_user` / `auth_query`.                                                                                                                                                       | PgBouncer can use a SCRAM secret to talk to Postgres only when the client itself authenticated with SCRAM, the DB line has no `user=`, and the secrets are identical (same salt and iterations). A plaintext `auth_file` would reintroduce the log/leak the verifier was meant to avoid for the app roles. The `postgres` superuser used by bootstrap never goes through PgBouncer. |
| Test PgBouncer aliases     | `hub` = shared pool for ordinary tests (no `pool_size=1`). `hub_bleed` and `hub_reuse` = same Postgres db, **`pool_size=1`**, no `user=`. Bleed tests use only `hub_bleed` and teardown with `RESET app.org_id` (not `DISCARD ALL`: with `max_prepared_statements` that can desync PgBouncer's prepared-statement tracking). Fail-closed uses only `hub_reuse`. Production Hyperdrive is unrelated.                                                                                            | One poisoned backend must not be the only backend. Equal-PID still needs `pool_size=1`, but on an alias no other test uses.                                                                                                                                                                                                                                                         |
| UUIDv7                     | Small helper in `packages/db` using `node:crypto`. No `uuid` package. No `DEFAULT uuidv7()` in SQL.                                                                                                                                                                                                                                                                                                                                                                                            | Cell engine is 17.                                                                                                                                                                                                                                                                                                                                                                  |

**Rollback:** revert the PR. Docker data is disposable. Nothing applied to RDS.

---

## File map

| Path                                                 | Role                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `packages/db/package.json`                           | `@community-hub/db`                                          |
| `packages/db/sql/bootstrap.sql`                      | Privileged bootstrap                                         |
| `packages/db/drizzle/`                               | Product journal (schemas + grants; no tables)                |
| `packages/db/drizzle-test/`                          | Test-only synthetic `app` table                              |
| `packages/db/src/scram.ts`                           | SCRAM-SHA-256 verifier                                       |
| `packages/db/src/bootstrap.ts`                       | Run bootstrap + set LOGIN passwords from env                 |
| `packages/db/src/migrate.ts`                         | Unpooled product runner; `applyProductMigrations` only       |
| `packages/db/src/migrate-test.ts`                    | Test-only runner; **not** in `package.json` `exports`        |
| `packages/db/src/app-transaction.ts`                 | `withAppTransaction`                                         |
| `packages/db/src/connections.ts`                     | Direct vs pooled clients by **login**                        |
| `packages/db/src/ids.ts`                             | `newId()` UUIDv7                                             |
| `packages/db/test/docker-compose.yml`                | Postgres 17 + PgBouncer ≥ 1.21                               |
| `packages/db/test/pgbouncer.ini`                     | Transaction mode, SCRAM, `hub` + `hub_bleed` + `hub_reuse`   |
| `packages/db/test/global-setup.ts`                   | Compose up, bootstrap, write `userlist.txt`, start PgBouncer |
| `tooling/checks/schema-rls/`                         | Globs → `drizzle/` + `drizzle-test/`; drop "provisional"     |
| `tooling/checks/sql-session-ban/`                    | `PASSWORD`, session SET, `RESET` of `app.*`, role switches   |
| `docs/adr/0004-four-roles-and-migrator-ownership.md` | ADR 0004                                                     |
| `.github/workflows/ci.yml`                           | Test job starts Compose before `pnpm test`                   |

Do not create `packages/db/migrations/` (old provisional glob).

---

## Tasks

Each task is one commit, test-first, independently verifiable, and leaves the tree green.

### T1 — Package, Compose, SCRAM, bootstrap

**Commit:** `feat(db): bootstrap four roles and revoke TEMPORARY`

**Files:**

- Create: `packages/db/{package.json,tsconfig.json,vitest.config.ts,src/index.ts,src/scram.ts,src/scram.test.ts,src/bootstrap.ts,src/connections.ts,sql/bootstrap.sql}`
- Create: `packages/db/test/{docker-compose.yml,pgbouncer.ini,global-setup.ts,bootstrap.integration.test.ts}`
- Create: `docs/adr/0004-four-roles-and-migrator-ownership.md`
- Modify: root `tsconfig.json` (add reference), `docs/adr` index if one exists (none today)

**Interfaces:**

- Produces: `scramSha256Verifier(password: string, options?: { salt?: Buffer; iterations?: number }): string` — returns `SCRAM-SHA-256$<iterations>:<salt_b64>$<stored_key_b64>:<server_key_b64>` (the `psql` `\password` shape Postgres accepts as `rolpassword`).
- Produces: `runBootstrap(sql: Sql): Promise<void>` — privileged, idempotent, runs `sql/bootstrap.sql`.
- Produces: `setLoginPasswords(sql: Sql, passwords: { app: string; identity: string; platform: string }): Promise<{ verifiers: Record<'app' \| 'identity' \| 'platform', string> }>` — computes verifiers, issues `ALTER ROLE ${role} PASSWORD '${verifier}'` via `sql.unsafe` after quoting the verifier as a **literal** (utility statement; no `$1`). Verifier charset is `[A-Za-z0-9+/=$:]+` so quote by wrapping in single quotes and rejecting any `'` in the string (it cannot appear). Never interpolate the plaintext.
- Produces: `createDirectSql(url: string): Sql` — `postgres(url, { max: 1, prepare: false })`.
- Produces: `createPooledSql(url: string): Sql` — `postgres(url, { prepare: true, max: 4 })`. Used from T4; export now so T1 Compose can smoke-connect as `app` after passwords exist.

**`sql/bootstrap.sql` (exact statements; wrap each `CREATE ROLE` in `IF NOT EXISTS` via `pg_roles`):**

```sql
-- migrator: NOLOGIN, no password. LOGIN roles: no PASSWORD clause.
-- GRANT CREATE ON DATABASE … TO migrator  — migrator never had CREATE (PUBLIC default is CONNECT+TEMPORARY).
-- REVOKE TEMPORARY ON DATABASE … FROM PUBLIC
-- GRANT migrator TO current_user
-- CREATE SCHEMA IF NOT EXISTS migrator AUTHORIZATION migrator
-- optional: REVOKE CREATE ON DATABASE … FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC
-- Use format('%I', current_database()) / current_user. Never DROP.
```

**`test/pgbouncer.ini`:**

```ini
[databases]
hub = host=postgres port=5432 dbname=hub
hub_bleed = host=postgres port=5432 dbname=hub pool_size=1
hub_reuse = host=postgres port=5432 dbname=hub pool_size=1
; no user= on any line — required for SCRAM secret passthrough
; hub_bleed / hub_reuse are test-only: T4 PID match without poisoning hub

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_prepared_statements = 100
ignore_startup_parameters = extra_float_digits
```

**`docker-compose.yml`:** `postgres:17` (user/password/db `hub` for the bootstrap superuser only), PgBouncer image **≥ 1.21** (pin a digest or a 1.23/1.24 tag at implement time). Postgres publishes `5432`. PgBouncer publishes `6432` and is started **after** global-setup has written `userlist.txt` with the three verifiers (`"app" "SCRAM-SHA-256$…"`). Superuser does not go through PgBouncer.

**Must-fail / must-pass tests:**

| Test                                                 | Proves                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `scram.test.ts` round-trip shape                     | Verifier matches `^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$` |
| Bootstrap twice                                      | Second run does not error                                                                 |
| `CREATE TEMP TABLE` as `app`, `identity`, `platform` | Each fails (TEMPORARY revoked)                                                            |
| `app` connects through PgBouncer with env plaintext  | First pooled login works — catches a wrong SCRAM/user= config                             |
| `pg_tables` / `pg_roles`                             | Four roles exist; `migrator` is `NOLOGIN`; schema `migrator` owner is `migrator`          |

- [ ] **Step 1: Write `scram.test.ts` and `bootstrap.integration.test.ts` — RED**
- [ ] **Step 2: Implement helper, SQL, Compose, global-setup — GREEN**
- [ ] **Step 3: ADR 0004** — four roles by privilege (not one role per schema); objects owned by `NOLOGIN` `migrator`; `FORCE RLS` does not apply to superusers; passwords never in git; runtime picks a credential. Alternatives rejected: superuser-owned tables in CI; `CREATE ROLE` in the journal; plaintext `ALTER ROLE` in committed SQL.
- [ ] **Step 4: Commit**

**Must not break:** no secret in git (passwords generated in global-setup, gitignored `test/.userlist.txt`). `encrypted-query` still provisional.

**Done when:** `pnpm test --filter @community-hub/db` is green with Docker; `app` can authenticate through PgBouncer; TEMP is denied.

---

### T2 — Product journal and wrapped runner

**Commit:** `feat(db): wrap Drizzle migrate with lock, order and hash checks`

**Files:**

- Create: `packages/db/drizzle/0000_schemas.sql`, `packages/db/drizzle/meta/_journal.json`
- Create: `packages/db/src/migrate.ts`, `packages/db/src/migrate.test.ts`
- Create: `packages/db/test/migrate.integration.test.ts`
- Modify: `packages/db/src/index.ts` (export `applyProductMigrations` only)
- Modify: `packages/db/package.json` `exports` — only `"."` (and types). No `./migrate-test`.

**Interfaces:**

- Produces: `applyProductMigrations(directSql: Sql): Promise<void>`
- Consumes: unpooled privileged URL. Does not import `drizzle-test/` or `migrate-test.ts`.

**`0000_schemas.sql`** (applied as `migrator`): `CREATE SCHEMA app / identity / platform`; `GRANT USAGE ON SCHEMA app TO app` (and identity/platform analogues); `ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app` (and analogues). No `CREATE ROLE`. No `PASSWORD`. No `CREATE TABLE`.

**Confirm in this task against pinned drizzle-orm 0.45.2 source** (`node_modules/drizzle-orm/...` after install): `readMigrationFiles` / `PgDialect.migrate` store `hash` as a SHA-256 of the migration contents and `created_at` as the journal entry's `when`, inserted inside `session.transaction()` with the apply. Recompute with **that same function**, do not invent a parallel digest. If `hash` is not a content digest, **stop and report** — do not add `migrator.migration_checksums` or an outer-transaction join.

**Runner order (one unpooled connection, privileged login):**

1. `SELECT pg_advisory_lock($id)` (`id` is a constant bigint in `migrate.ts`). Taken as the privileged login, **before** bootstrap — two deploys must not race `CREATE ROLE`.
2. `runBootstrap`
3. `SET ROLE migrator`
4. Fail if any `_journal.json` entry is unapplied but older than the latest applied `created_at` (Kit would skip it).
5. Fail if any already-applied file's digest differs from Kit's stored `hash` (match on `created_at` = `when`).
6. `migrate(db, { migrationsFolder, migrationsSchema: 'migrator', migrationsTable: '__drizzle_migrations' })` on this connection. No outer `sql.begin`. No checksum table.
7. `finally`: `pg_advisory_unlock`; `RESET ROLE`; `sql.end()`.

**Must-fail fixtures** (unit tests against fake journal dirs; detector itself needs no Docker):

| Fixture             | Fails because                                          |
| ------------------- | ------------------------------------------------------ |
| `out-of-order/`     | Unapplied entry older than latest applied `created_at` |
| `checksum-changed/` | Already-applied file contents ≠ stored Kit `hash`      |

**Export-surface tests** (not a string search of `migrate.ts`):

- `package.json` `exports` has no `migrate-test` key; `import.meta.resolve('@community-hub/db/migrate-test')` rejects (or the map is absent).
- After `applyProductMigrations`, `to_regclass('migrator.__drizzle_migrations_test')` is null.

- [ ] **Step 1: Read 0.45.2 migrator source; write detector unit tests — RED then GREEN**
- [ ] **Step 2: Integration: apply product once, apply again (no-op); hash-changed fails before a sabotaged new file would run**
- [ ] **Step 3: Commit**

**Must not break:** runner never uses port 6432. Lock is held across bootstrap.

**Done when:** second apply is a no-op; out-of-order and hash-changed fail **before** a new file would be applied.

---

### T3 — Test-only synthetic table and schema-rls

**Commit:** `feat(db): prove FORCE RLS on a migrator-owned app table`

**Files:**

- Create: `packages/db/src/migrate-test.ts` — `applyTestMigrations({ mode: 'test' }, sql)`, folder `drizzle-test/`, table `migrator.__drizzle_migrations_test`. **Not** listed in `package.json` `exports`.
- Create: `packages/db/drizzle-test/0000_synthetic.sql`, `packages/db/drizzle-test/meta/_journal.json`
- Create: `packages/db/test/rls.integration.test.ts` (under `test/`, not `src/`, so T5 can exclude it)
- Modify: `tooling/checks/schema-rls/{check.ts,README.md,selftest.ts}` — globs `packages/db/drizzle` and `packages/db/drizzle-test`; README drops "provisional"; empty-tree notice text no longer says provisional

**`0000_synthetic.sql`:** `CREATE TABLE app.synthetic (org_id uuid not null, id uuid not null, primary key (org_id, id));` enable RLS; policy `org_id = current_setting('app.org_id')::uuid` **without** `missing_ok`; **hand-added** `ALTER TABLE app.synthetic FORCE ROW LEVEL SECURITY`. Kit will not emit `FORCE`.

**`applyTestMigrations`:** required argument `{ mode: 'test' }`. Any other mode, or a missing argument, throws. No environment variable.

**Tests (no `withAppTransaction` — that is T4):**

| Test                                            | Proves                                                |
| ----------------------------------------------- | ----------------------------------------------------- |
| `relowner` of `app.synthetic` is `migrator`     | Superuser did not own the table                       |
| `SET ROLE migrator` then `SELECT`               | Policy blocks the owner (`FORCE`)                     |
| `applyProductMigrations` after test apply       | Product journal table does not gain the synthetic tag |
| `applyProductMigrations` never creates          | `migrator.__drizzle_migrations_test` stays absent     |
| `schema-rls` on the real tree                   | Finds `app.synthetic`, passes                         |
| Existing fixtures `no-org-id`, `rls-not-forced` | Still fail                                            |

Two-organisation isolation moves to T4.

- [ ] **Step 1: RLS tests RED (table missing)**
- [ ] **Step 2: Test journal + FORCE + schema-rls globs GREEN**
- [ ] **Step 3: Commit**

**Must not break:** `encrypted-query` README still says provisional; its live glob still notices zero files. Package `exports` still omit `migrate-test`.

---

### T4 — Transaction wrapper and pooled bleed

**Commit:** `feat(db): set tenant scope with transaction-local set_config`

**Files:**

- Create: `packages/db/src/app-transaction.ts`, `packages/db/src/ids.ts`, `packages/db/test/pooling.integration.test.ts`
- Modify: `packages/db/vitest.config.ts` — `fileParallelism: false` so integration files do not interleave (T1 created the config)
- Modify: `packages/db/src/connections.ts` — `createAppSql` / `createIdentitySql` / `createPlatformSql` take the **pooled** URL (port 6432) and that login's password; no `SET ROLE`
- Modify: `architecture.md` §6.3 (sample `id uuid not null` with application-minted UUIDv7 while the engine is 17; `set_config(..., true)` instead of `SET LOCAL`); §23.2 one sentence that **how** migrations reach private RDS is a later chunk
- Modify: `AGENTS.md` §1.3 — transaction-local `set_config(..., true)`, never session-level `SET`

**Interfaces:**

```ts
export function newId(): string; // UUIDv7

export async function withAppTransaction<T>(
  sql: Sql, // pooled app login
  scope: { orgId: string; communityId: string },
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T>;
```

Implementation: `sql.begin`, then `select set_config('app.org_id', ${scope.orgId}, true)` and the same for `community_id` (postgres.js binds; third argument boolean `true`). Identity/platform helpers **do not exist** as `SET ROLE` wrappers; they are `createIdentitySql` / `createPlatformSql` only.

**Pooling tests — two clients, isolated aliases, sequential file.** Vitest for `packages/db/test/*.integration.test.ts`: `fileParallelism: false` and no `concurrent` inside the pooling file (a sequential `describe`). Nothing else may interleave between client A and client B.

PgBouncer aliases (T1 ini): ordinary tests use `hub`. Bleed uses **`hub_bleed` only**. Fail-closed uses **`hub_reuse` only**. Two-org uses `hub`. Open client A and client B as two `postgres()` instances (`app` login, port 6432, `prepare: true`, database name = the alias). Assert `SELECT pg_backend_pid()` is **equal** as a **hard precondition**; if the PIDs differ the test **fails** (proved nothing).

| Test                                                                                                                                                                      | Alias       | Proves                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bleed: client A `set_config('app.org_id', id, false)` (session) and returns; client B reads `current_setting('app.org_id')`. Teardown: `RESET app.org_id` on `hub_bleed`. | `hub_bleed` | Next **client** on that server connection **sees** the value                                                                                                   |
| Fail-closed: client A `withAppTransaction` then returns; client B `SELECT` from `app.synthetic` / `current_setting('app.org_id')` with no wrapper                         | `hub_reuse` | Local setting does not leak as a readable tenant id. Accept either `unrecognized configuration parameter` or `invalid input syntax for type uuid` (`''::uuid`) |
| Two orgs via `withAppTransaction`                                                                                                                                         | `hub`       | Org A cannot see org B's row in `app.synthetic`                                                                                                                |
| `createIdentitySql` source                                                                                                                                                | —           | File does not contain `SET ROLE` or `set_config('app.org_id'`                                                                                                  |

Do not use one client for both steps. Do not use a direct Postgres connection. Do not run bleed and fail-closed on the same alias: transaction-mode PgBouncer issues no reset, so session `set_config(..., false)` would make fail-closed return rows. `createPooledSql` may keep `max: 4` on the client side.

- [ ] **Step 1: Pooling + two-org tests RED**
- [ ] **Step 2: Wrapper + docs GREEN**
- [ ] **Step 3: Commit**

**Must not break:** identity/platform still have no `org_id` GUC. Roadmap file untouched.

---

### T5 — Static bans

**Commit:** `feat(tooling): ban PASSWORD, session SET, and SET ROLE in db SQL`

**Files:**

- Create: `tooling/checks/sql-session-ban/{package.json,tsconfig.json,vitest.config.ts,check.ts,selftest.ts,README.md}`
- Create fixtures: `valid/`, `password-in-sql/`, `set-session/`, `reset-app/`, `set-role-in-sql/`, `set-role-in-src-ts/` (production `.ts` under `src/`, **not** a test file), `set-config-role/`, `set-session-authorization/`, `set-local-in-comment/` (must pass)
- Modify: `tooling/checks/run.ts` to run this checker
- Modify: `AGENTS.md` §10 checker list to include `sql-session-ban` (one line; not a decision change)

**Scan:**

- SQL: `packages/db/sql/**/*.sql`, `packages/db/drizzle/**/*.sql`, `packages/db/drizzle-test/**/*.sql`
- TS: `packages/db/src/**/*.ts` **excluding** `**/*.test.ts`. Do **not** scan `packages/db/test/`. That is the exemption: T3's `SET ROLE migrator` and T4's `set_config(..., false)` live in `test/*.integration.test.ts`.
- Strip `//` and `/* */` comments from TypeScript, and `--` / `/* */` from SQL, **before** matching. Fixture `set-local-in-comment/` (only hit is `// not SET LOCAL`) must **pass**. Implementers may document the ban in comments.

**Allow-list:** `packages/db/src/migrate.ts` may contain `SET ROLE` / `set role` (the runner). Nothing else under `src/` may.

**All patterns are case-insensitive** (`sql\`set role migrator\`` must fail). Also ban equivalents:

| Pattern                                           | Where it may appear                 | Elsewhere |
| ------------------------------------------------- | ----------------------------------- | --------- |
| `PASSWORD`                                        | nowhere in SQL trees                | fail      |
| `SET SESSION` / `set_config(..., false)`          | nowhere in scanned files            | fail      |
| `RESET` of `app.*`                                | nowhere                             | fail      |
| `SET ROLE`                                        | only `src/migrate.ts`               | fail      |
| `set_config('role', …)` / `set_config("role", …)` | only `src/migrate.ts`               | fail      |
| `SET SESSION AUTHORIZATION`                       | nowhere                             | fail      |
| `SET LOCAL`                                       | nowhere (wrapper uses `set_config`) | fail      |

`set-role-in-src-ts/` is the fixture that proves production code still fails: a non-test `src/foo.ts` containing `set role` must violate. A `src/foo.test.ts` containing the same string must **not** be scanned.

- [ ] **Step 1: selftest RED**
- [ ] **Step 2: checker + run.ts GREEN on the real tree**
- [ ] **Step 3: Commit**

**Must not break:** bootstrap SQL still has no `PASSWORD`; `migrate.ts` is the only production `SET ROLE`; T3/T4 integration tests still pass `pnpm check:boundaries`.

---

### T6 — CI Compose and full gate

**Commit:** `ci: run packages-db tests against Docker Postgres and PgBouncer`

**Files:**

- Modify: `.github/workflows/ci.yml` test job — before `pnpm test`:

```yaml
- name: Start Postgres and PgBouncer
  run: docker compose -f packages/db/test/docker-compose.yml up -d postgres
  # global-setup of @community-hub/db starts PgBouncer after writing userlist
```

If global-setup already `compose up`s both, the workflow step is `docker compose … up -d postgres` only so the daemon is warm; do not duplicate bootstrap. Document in `packages/db/README.md` (short: how to run tests, which port is direct vs pooled). Add that README in this task.

- Modify: `architecture.md` tooling list under §8.1 if the checker name is listed (add `sql-session-ban`).
- Do **not** edit `docs/roadmap.md`.

- [ ] **Step 1: CI yaml + README**
- [ ] **Step 2: Full local gate (this is the chunk gate)**

```
pnpm format
pnpm lint
pnpm typecheck
pnpm check:boundaries
pnpm test
# every terraform matrix dir still:
#   terraform init -backend=false -lockfile=readonly
#   terraform fmt -check && terraform validate && tflint && terraform test
pnpm exec wrangler deploy --dry-run   # apps/gateway, from apps/gateway after pnpm --filter @community-hub/gateway... build
```

Expected: all exit 0. `schema-rls: ok` (synthetic table). `encrypted-query` still prints a zero-files **notice**. `sql-session-ban: ok`. No AWS/RDS.

- [ ] **Step 3: Commit**

**Must not break:** gateway preview still fail-closed on missing Cloudflare secrets. Roadmap still shows `packages-db` not done.

---

## Self-review (plan vs spec)

| Spec requirement                                                                                                                                           | Task                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Privileged bootstrap; roles without passwords; `GRANT CREATE` to migrator; `REVOKE TEMPORARY`; before every apply; never destructive                       | T1                        |
| SCRAM verifier helper; static `PASSWORD` ban                                                                                                               | T1 + T5                   |
| PgBouncer SCRAM passthrough (client SCRAM, same verifier, no `user=`)                                                                                      | T1                        |
| Product journal as `migrator`; USAGE + default privileges                                                                                                  | T2                        |
| Unpooled runner; lock **then** bootstrap then `SET ROLE`; advisory lock                                                                                    | T2                        |
| Out-of-order fail; already-applied hash check **before** apply using Kit's journal `hash`                                                                  | T2                        |
| Product entry cannot load test set; `mode: 'test'` only; `migrate-test` not exported                                                                       | T2 + T3                   |
| Test-only synthetic; hand-added `FORCE`; owner `migrator`; policy blocks migrator                                                                          | T3                        |
| `schema-rls` de-provisionalised; `encrypted-query` not                                                                                                     | T3                        |
| Two-org isolation via `withAppTransaction`                                                                                                                 | T4                        |
| `set_config(..., true)`; two-client PID match on **isolated** aliases (`hub_bleed` / `hub_reuse`); sequential pooling file; `RESET app.org_id` after bleed | T4                        |
| Runtime picks a login; no `SET ROLE` on pooled connections                                                                                                 | T4                        |
| AGENTS §1.3; architecture §6.3 UUIDv7; §23.2 later RDS path                                                                                                | T4                        |
| ADR 0004                                                                                                                                                   | T1                        |
| Static ban including comment-stripped `SET LOCAL`; tests excluded; `set-local-in-comment` must pass                                                        | T5                        |
| Postgres 17 Compose in CI; no roadmap `done`; no `infra/`                                                                                                  | T6                        |
| Production migrate-from-VPC                                                                                                                                | Out-of-band (not this PR) |
| Identity/platform Hyperdrive                                                                                                                               | Out-of-band (not this PR) |

No placeholders. No third Hyperdrive. No `DEFAULT uuidv7()`.
