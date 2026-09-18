# Plan: packages/db foundations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `@community-hub/db` with a privileged bootstrap, a Drizzle-Kit-wrapped runner on a direct connection, and CI proof that tenant scope is transaction-local under PgBouncer — without applying anything to RDS.

**Architecture:** Bootstrap (privileged login, every apply, never destructive) creates four roles and schema `migrator`. The runner then `SET ROLE migrator` on an unpooled connection, wraps Kit `migrate()`, and records checksums. App-traffic tests go through PgBouncer as the `app` / `identity` / `platform` logins. Runtime never `SET ROLE`.

**Tech Stack:** PostgreSQL 17, PgBouncer ≥ 1.21 transaction mode, `postgres` (postgres.js) 3.4.x, `drizzle-orm` 0.45.x, `drizzle-kit` 0.31.x, Vitest, Docker Compose in CI.

**Spec:** `docs/specs/2026-09-18-packages-db.md` (approved 2026-09-18, Abdus Salam)

Status: draft

**Branch:** `feat/2026-09-18-packages-db` · one PR · 6 tasks, one commit each

## Global Constraints

- Runner connection: direct to Postgres, `max: 1`. Never PgBouncer, never Hyperdrive.
- Runtime connections: pick a login (`app` / `identity` / `platform`). Never `SET ROLE`.
- Tenant scope: bound `SELECT set_config(..., true)` only. No interpolated `SET` / `SET LOCAL` / `SET SESSION`.
- Bootstrap before every journal apply. Idempotent. No `DROP`, no `PASSWORD` in SQL, no `CREATE ROLE` in the journal.
- Passwords: pre-computed SCRAM-SHA-256 verifier in `ALTER ROLE`. Plaintext never in SQL or server logs from this helper.
- Product entry point cannot load `drizzle-test/`.
- `encrypted-query` stays provisional. `schema-rls` does not.
- No `infra/` change. No Hyperdrive on gateway. No roadmap `done` flip.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Pin at implement time (npm current 2026-09-18 in parentheses; do not float majors): `drizzle-orm` (`0.45.2`), `drizzle-kit` (`0.31.10`), `postgres` (`3.4.9`).

---

## Tooling decisions this plan makes

| Choice                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                               | Why                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQL driver                 | **`postgres` (postgres.js)**, not `pg`                                                                                                                                                                                                                                                                                                                                                                                                 | Tagged templates bind parameters; nested `begin` is a savepoint; Cloudflare Hyperdrive documents this driver.                                                                                                                                                                                                                                                                       |
| Pooled `prepare`           | **`prepare: true`** on PgBouncer clients; PgBouncer `max_prepared_statements = 100`                                                                                                                                                                                                                                                                                                                                                    | Matches Hyperdrive's prepared-statement path. A pooler more lenient than Hyperdrive fails the spec.                                                                                                                                                                                                                                                                                 |
| Migrator `prepare`         | **`prepare: false`**, `max: 1`, connection closed after the run                                                                                                                                                                                                                                                                                                                                                                        | `SET ROLE` and `pg_advisory_lock` are session-level. Do not return that connection to any pool.                                                                                                                                                                                                                                                                                     |
| Checksums vs Kit `migrate` | **Join via outer `sql.begin`.** Construct `drizzle(tx)` on the transaction client, then `migrate()`. Kit's `session.transaction()` becomes a postgres.js **savepoint**. Insert checksum rows on `tx` before the outer callback returns. **Proof test in T2.** If it fails on the pinned versions, do not drive SQL files yourself: fail closed when any row in Kit's journal table lacks a checksum row (spec's equivalent guarantee). | `PgDialect.migrate` (drizzle-orm 0.45.2) always calls `session.transaction()`. It does not accept an outer handle. Driving files ourselves would violate "wrap Kit".                                                                                                                                                                                                                |
| PgBouncer SCRAM            | **Passthrough, not plaintext in `auth_file`.** Compute the verifier once. `ALTER ROLE … PASSWORD '<verifier>'`. Write the **same** verifier into PgBouncer `userlist.txt`. `auth_type = scram-sha-256`. Database line **has no `user=`**. Clients connect with the env **plaintext** (postgres.js SCRAM). No `auth_user` / `auth_query`.                                                                                               | PgBouncer can use a SCRAM secret to talk to Postgres only when the client itself authenticated with SCRAM, the DB line has no `user=`, and the secrets are identical (same salt and iterations). A plaintext `auth_file` would reintroduce the log/leak the verifier was meant to avoid for the app roles. The `postgres` superuser used by bootstrap never goes through PgBouncer. |
| UUIDv7                     | Small helper in `packages/db` using `node:crypto`. No `uuid` package. No `DEFAULT uuidv7()` in SQL.                                                                                                                                                                                                                                                                                                                                    | Cell engine is 17.                                                                                                                                                                                                                                                                                                                                                                  |

**Rollback:** revert the PR. Docker data is disposable. Nothing applied to RDS.

---

## File map

| Path                                                 | Role                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `packages/db/package.json`                           | `@community-hub/db`                                                            |
| `packages/db/sql/bootstrap.sql`                      | Privileged bootstrap                                                           |
| `packages/db/drizzle/`                               | Product journal (schemas + grants; no tables)                                  |
| `packages/db/drizzle-test/`                          | Test-only synthetic `app` table                                                |
| `packages/db/src/scram.ts`                           | SCRAM-SHA-256 verifier                                                         |
| `packages/db/src/bootstrap.ts`                       | Run bootstrap + set LOGIN passwords from env                                   |
| `packages/db/src/migrate.ts`                         | Unpooled runner; `applyProductMigrations` / `applyTestMigrations`              |
| `packages/db/src/app-transaction.ts`                 | `withAppTransaction`                                                           |
| `packages/db/src/connections.ts`                     | Direct vs pooled clients by **login**                                          |
| `packages/db/src/ids.ts`                             | `newId()` UUIDv7                                                               |
| `packages/db/test/docker-compose.yml`                | Postgres 17 + PgBouncer ≥ 1.21                                                 |
| `packages/db/test/pgbouncer.ini`                     | Transaction mode, SCRAM, `max_prepared_statements`                             |
| `packages/db/test/global-setup.ts`                   | Compose up, bootstrap, write `userlist.txt`, start PgBouncer                   |
| `tooling/checks/schema-rls/`                         | Globs → `drizzle/` + `drizzle-test/`; drop "provisional"                       |
| `tooling/checks/sql-session-ban/`                    | `PASSWORD`, `SET SESSION`, `RESET` of `app.*`, `SET ROLE` outside `migrate.ts` |
| `docs/adr/0004-four-roles-and-migrator-ownership.md` | ADR 0004                                                                       |
| `.github/workflows/ci.yml`                           | Test job starts Compose before `pnpm test`                                     |

Do not create `packages/db/migrations/` (old provisional glob).

---

## Tasks

Each task is one commit, test-first, independently verifiable, and leaves the tree green.

### T1 — Package, Compose, SCRAM, bootstrap

**Commit:** `feat(db): bootstrap four roles and revoke TEMPORARY`

**Files:**

- Create: `packages/db/{package.json,tsconfig.json,src/index.ts,src/scram.ts,src/scram.test.ts,src/bootstrap.ts,src/connections.ts,sql/bootstrap.sql}`
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
; no user=  — required for SCRAM secret passthrough

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

**Commit:** `feat(db): wrap Drizzle migrate with lock, order and checksums`

**Files:**

- Create: `packages/db/drizzle/0000_schemas.sql`, `packages/db/drizzle/meta/_journal.json`
- Create: `packages/db/src/migrate.ts`, `packages/db/src/migrate.test.ts`, `packages/db/src/migrate.integration.test.ts`
- Modify: `packages/db/src/index.ts` (export product apply only)

**Interfaces:**

- Produces: `applyProductMigrations(directSql: Sql): Promise<void>`
- Produces: `applyTestMigrations(directSql: Sql): Promise<void>` — implemented in T3; in T2 export a function whose `migrationsFolder` is a **different module** (`migrate-test.ts` created in T3). T2's `applyProductMigrations` must not import `drizzle-test/`.
- Consumes: `runBootstrap` then `SET ROLE migrator` on `directSql` (same privileged URL, unpooled).

**`0000_schemas.sql`** (applied as `migrator`): `CREATE SCHEMA app / identity / platform`; `GRANT USAGE ON SCHEMA app TO app` (and identity/platform analogues); `ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app` (and analogues). No `CREATE ROLE`. No `PASSWORD`. No `CREATE TABLE`.

**Runner order (one unpooled connection):**

1. `runBootstrap` as the privileged login (no `SET ROLE` yet).
2. `SET ROLE migrator`
3. `SELECT pg_advisory_lock($id)` (`id` is a constant bigint in `migrate.ts`)
4. Fail if any `_journal.json` entry is unapplied but older than the latest applied `created_at` (Kit would skip it).
5. Fail if any already-applied file's SHA-256 differs from `migrator.migration_checksums`.
6. `sql.begin`: `drizzle(tx)` → `migrate(db, { migrationsFolder, migrationsSchema: 'migrator', migrationsTable })` → insert checksums for newly applied files on `tx`.
7. `finally`: `pg_advisory_unlock`; `RESET ROLE`; `sql.end()`.

Create `migrator.migration_checksums (tag text primary key, sha256 text not null)` with `CREATE TABLE IF NOT EXISTS` after `SET ROLE` and before step 4.

**Proof test (join vs fallback):**

```ts
it("rolls back Kit journal rows when the outer transaction aborts", async () => {
  await expect(
    direct.begin(async (tx) => {
      await applyProductMigrationsOn(tx); // inner migrate + checksum insert
      throw new Error("forced-rollback");
    }),
  ).rejects.toThrow(/forced-rollback/);
  const rows = await direct`select hash from migrator.__drizzle_migrations`;
  expect(rows).toHaveLength(0);
});
```

If this **fails** on the pinned drizzle-orm (Kit committed despite outer abort): keep wrapping `migrate()`, and after it returns fail the run when any `__drizzle_migrations` hash has no `migration_checksums` row. Record that outcome in the T2 commit message. Do **not** switch to driving SQL files.

**Must-fail fixtures** (unit tests against fake journal dirs, no Docker required for the detector itself):

| Fixture                        | Fails because                                                 |
| ------------------------------ | ------------------------------------------------------------- |
| `out-of-order/`                | Unapplied entry older than latest applied `created_at`        |
| `checksum-changed/`            | Already-applied file bytes ≠ stored sha256                    |
| `product-imports-test-folder/` | `applyProductMigrations` module graph includes `drizzle-test` |

The third is a unit test: `readFileSync` the compiled or source `migrate.ts` and assert it does not contain the string `drizzle-test`.

- [ ] **Step 1: Detector unit tests RED, then GREEN**
- [ ] **Step 2: Integration: apply product once, apply again (no-op), abort proof or checksum-gap fallback**
- [ ] **Step 3: Commit**

**Must not break:** bootstrap still runs first; runner never uses port 6432.

**Done when:** second apply is a no-op; out-of-order and checksum-changed fail **before** a new file would be applied (assert by making the new file throw if executed).

---

### T3 — Test-only synthetic table and schema-rls

**Commit:** `feat(db): prove FORCE RLS on a migrator-owned app table`

**Files:**

- Create: `packages/db/src/migrate-test.ts` — `applyTestMigrations`, folder `drizzle-test/`, table `migrator.__drizzle_migrations_test`
- Create: `packages/db/drizzle-test/0000_synthetic.sql`, `packages/db/drizzle-test/meta/_journal.json`
- Create: `packages/db/src/rls.integration.test.ts`
- Modify: `tooling/checks/schema-rls/{check.ts,README.md,selftest.ts}` — globs `packages/db/drizzle` and `packages/db/drizzle-test`; README drops "provisional"; empty-tree notice text no longer says provisional
- Modify: `packages/db/src/migrate.ts` — `applyTestMigrations` is **not** re-exported from the product path; `src/index.ts` exports only `applyProductMigrations`

**`0000_synthetic.sql`:** `CREATE TABLE app.synthetic (org_id uuid not null, id uuid not null, primary key (org_id, id));` enable RLS; policy `org_id = current_setting('app.org_id')::uuid` **without** `missing_ok`; **hand-added** `ALTER TABLE app.synthetic FORCE ROW LEVEL SECURITY`. Kit will not emit `FORCE`.

**Tests:**

| Test                                                                                                                    | Proves                                                |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `relowner` of `app.synthetic` is `migrator`                                                                             | Superuser did not own the table                       |
| `SET ROLE migrator` then `SELECT`                                                                                       | Policy blocks the owner (`FORCE`)                     |
| Two orgs via `withAppTransaction` (use T4 if needed; otherwise inline `set_config` here and delete the duplicate in T4) | Org A cannot see org B's row                          |
| `applyProductMigrations` after test apply                                                                               | Product journal table does not gain the synthetic tag |
| `schema-rls` on the real tree                                                                                           | Finds `app.synthetic`, passes                         |
| Existing fixtures `no-org-id`, `rls-not-forced`                                                                         | Still fail                                            |

`applyTestMigrations` refuses unless `options.mode === 'test'` (or `process.env.COMMUNITY_HUB_DB_TEST_MIGRATIONS === '1'` set only by global-setup / integration tests). Product apply does not read that env.

- [ ] **Step 1: RLS tests RED (table missing)**
- [ ] **Step 2: Test journal + FORCE + schema-rls globs GREEN**
- [ ] **Step 3: Commit**

**Must not break:** `encrypted-query` README still says provisional; its live glob still notices zero files.

---

### T4 — Transaction wrapper and pooled bleed

**Commit:** `feat(db): set tenant scope with transaction-local set_config`

**Files:**

- Create: `packages/db/src/app-transaction.ts`, `packages/db/src/ids.ts`, `packages/db/src/pooling.integration.test.ts`
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

**Pooling tests (port 6432, `app` login, `prepare: true`):**

| Test                                                                                                | Proves                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session `set_config('app.org_id', id, false)` then checkout                                         | Next client on that server connection **sees** the value (must-fail fixture of the spec: session SET bleeds)                                                                                                                                                                                                                                                                                                                                   |
| `withAppTransaction` then a new checkout on a **reused** connection (same PgBouncer server backend) | Wrapper's local setting does **not** leak as a readable tenant id; a query without the wrapper fail-closes. Accept either `unrecognized configuration parameter` or `invalid input syntax for type uuid` (`''::uuid`). Do **not** use a fresh Postgres connection. Hold one pooled client, run a wrapped tx, then `SELECT current_setting('app.org_id')` / `SELECT COUNT(*) FROM app.synthetic` **on that same client** outside a transaction. |
| `createIdentitySql` source                                                                          | File does not contain `SET ROLE` or `set_config('app.org_id'`                                                                                                                                                                                                                                                                                                                                                                                  |

Getting a reused backend: `max_client_conn` small, `default_pool_size = 1` for the `app` user in a test-only pgbouncer.ini override **or** issue two consecutive queries on one `postgres.js` client (one connection). Prefer one client: first `begin`/`commit` wrapped, then a query on the same client. That is the pooled case that matters (Hyperdrive/PgBouncer reuse the server connection under one client session in transaction mode after COMMIT). Confirm with `SELECT pg_backend_pid()` stable across the two queries.

- [ ] **Step 1: Pooling tests RED**
- [ ] **Step 2: Wrapper + docs GREEN**
- [ ] **Step 3: Commit**

**Must not break:** identity/platform still have no `org_id` GUC. Roadmap file untouched.

---

### T5 — Static bans

**Commit:** `feat(tooling): ban PASSWORD, session SET, and SET ROLE in db SQL`

**Files:**

- Create: `tooling/checks/sql-session-ban/{package.json,tsconfig.json,vitest.config.ts,check.ts,selftest.ts,README.md}`
- Create fixtures: `valid/`, `password-in-sql/`, `set-session/`, `reset-app/`, `set-role-in-sql/`
- Modify: `tooling/checks/run.ts` to run this checker
- Modify: `AGENTS.md` §10 checker list to include `sql-session-ban` (one line; not a decision change)

**Rules (scan `packages/db/sql/**/*.sql`, `packages/db/drizzle/**/*.sql`, `packages/db/drizzle-test/**/*.sql`, and `packages/db/src/**/*.ts`):**

| Pattern                                             | Where it may appear                 | Elsewhere |
| --------------------------------------------------- | ----------------------------------- | --------- |
| `\bPASSWORD\b`                                      | nowhere in SQL trees                | fail      |
| `SET\s+SESSION` / `set_config\([^)]*,\s*false\s*\)` | nowhere                             | fail      |
| `RESET\s+app\.`                                     | nowhere                             | fail      |
| `SET\s+ROLE`                                        | only `packages/db/src/migrate.ts`   | fail      |
| `SET\s+LOCAL`                                       | nowhere (wrapper uses `set_config`) | fail      |

Must-fail fixtures live under `tooling/checks/sql-session-ban/fixtures/` as mini trees, same `check(root)` pattern as schema-rls.

- [ ] **Step 1: selftest RED**
- [ ] **Step 2: checker + run.ts GREEN on the real tree**
- [ ] **Step 3: Commit**

**Must not break:** bootstrap SQL still has no `PASSWORD`; `migrate.ts` is the only `SET ROLE`.

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

| Spec requirement                                                                                                                     | Task                      |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| Privileged bootstrap; roles without passwords; `GRANT CREATE` to migrator; `REVOKE TEMPORARY`; before every apply; never destructive | T1                        |
| SCRAM verifier helper; static `PASSWORD` ban                                                                                         | T1 + T5                   |
| PgBouncer SCRAM passthrough (client SCRAM, same verifier, no `user=`)                                                                | T1                        |
| Product journal as `migrator`; USAGE + default privileges                                                                            | T2                        |
| Unpooled runner; `SET ROLE` only there; advisory lock                                                                                | T2                        |
| Out-of-order fail; checksum **before** apply; join outer tx or journal-without-checksum fallback                                     | T2                        |
| Product entry cannot load test set                                                                                                   | T2 + T3                   |
| Test-only synthetic; hand-added `FORCE`; owner `migrator`; policy blocks migrator                                                    | T3                        |
| `schema-rls` de-provisionalised; `encrypted-query` not                                                                               | T3                        |
| `set_config(..., true)`; reused pooled fail-closed; session SET bleed                                                                | T4                        |
| Runtime picks a login; no `SET ROLE` on pooled connections                                                                           | T4                        |
| AGENTS §1.3; architecture §6.3 UUIDv7; §23.2 later RDS path                                                                          | T4                        |
| ADR 0004                                                                                                                             | T1                        |
| Static ban `SET SESSION` / `RESET app.*` / `SET ROLE`                                                                                | T5                        |
| Postgres 17 Compose in CI; no roadmap `done`; no `infra/`                                                                            | T6                        |
| Production migrate-from-VPC                                                                                                          | Out-of-band (not this PR) |
| Identity/platform Hyperdrive                                                                                                         | Out-of-band (not this PR) |

No placeholders. No third Hyperdrive. No `DEFAULT uuidv7()`.
