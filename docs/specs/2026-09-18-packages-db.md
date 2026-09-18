# Spec: packages/db foundations

Slug: `packages-db`
Status: draft
Architecture refs: §6.3, §8.1, §12.1–12.2.1, §23.1–23.3; D2; ADR 0004 (this PR); AGENTS.md §1 (3, 4, 9), §6, §7, §10, §13
Supersedes: —

## Problem

The workspace has checkers that look for `packages/db` and a cell Terraform graph that will one day point Hyperdrive at RDS. There is no Drizzle package, no migration runner, no application roles, and no proof that tenant scope is transaction-local under a pooler. Live Tunnel → Workers VPC → Hyperdrive is not this chunk: CI must prove isolation against Docker Postgres behind PgBouncer.

## Scope

**In**

- `packages/db`: Drizzle Kit **wrapped** by our runner (advisory lock, checksums, out-of-order journal detection). Product SQL under Drizzle's layout (`drizzle/` + `meta/_journal.json`).
- **Privileged bootstrap** (idempotent, not journaled): four roles, schema `migrator` owned by `migrator`, `GRANT migrator TO <runner login>`, database-level privileges. Run by the privileged login (Docker superuser in CI; RDS master in production).
- **Product journal** (append-only, applied as `migrator`): schemas `app`, `identity`, `platform`; grants; default privileges. **No product tables.** No `CREATE ROLE`. No passwords.
- Test-only migration set (CI Docker only): one synthetic `app` table with `org_id`, RLS, `FORCE ROW LEVEL SECURITY`. Separate journal and bookkeeping. The product entry point cannot load this set.
- Transaction wrapper: `SELECT set_config('app.org_id', $1, true)` and the same for `app.community_id`. Bind parameters only. No interpolated `SET LOCAL`.
- Runner: **direct, unpooled** connection; `SET ROLE migrator` before any journaled DDL. Never PgBouncer, never Hyperdrive.
- Runtime connections: pick a **credential** (`app` / `identity` / `platform` login). They never `SET ROLE`.
- CI app-traffic tests: Postgres **17** (matches `infra/modules/aws-rds` `engine_version` default) behind PgBouncer ≥ 1.21, **transaction mode**, `max_prepared_statements` set. Driver `prepare` setting matches Hyperdrive's prepared-statement behaviour.
- Must-fail: session-level `SET` / `set_config(..., false)` bleeds into the next pooled checkout.
- Must-pass: wrapper's `is_local = true` setting does not bleed.
- Fail-closed query **on a reused PgBouncer connection** that just served a wrapped transaction (see Behaviour).
- Static ban (must-fail fixtures): session-level `SET`, `SET SESSION`, `set_config(..., false)`, `RESET` of `app.*`, and `SET ROLE` except inside the runner. `PASSWORD` in any SQL this package ships (bootstrap, `drizzle/`, `drizzle-test/`).
- De-provisionalise **`schema-rls` only**: scan Kit-generated `.sql` (product and test-only trees); keep existing must-fail fixtures; exempt schema `migrator`.
- Wrapper must-fail fixture: a journal entry older than the latest applied entry is unapplied → fail (Drizzle Kit would skip it).
- ADR 0004: four-role model and `migrator` object ownership.
- Docs: architecture §6.3 sample SQL (application-minted UUIDv7 while the cell is 17); AGENTS.md §1.3 wording (`set_config(..., true)` as the implementation of transaction-local scope). §23.2 note that **how** migrations reach private RDS is later (Out-of-band).

**Out** (explicitly)

- Organisation, community, people, identity, or platform **tables**. Those are `tenancy-implicit-org`, `people-households`, `identity-otp`.
- Hyperdrive binding on `apps/gateway` (global-no-PII).
- Second or third Hyperdrive configurations (identity / platform logins). Terraform follow-up; this PR does not change `infra/`.
- Live RDS, Tunnel, apply, or any production DSN in CI.
- `DEFAULT uuidv7()` in SQL (Postgres 17). Ids are minted in the application as UUIDv7.
- Production/staging migration **path** (which login, from where — likely a one-off ECS task inside the cell VPC). Named in Out-of-band.
- De-provisionalising **`encrypted-query`**. It parses SQL files; application queries will be Drizzle query-builder TypeScript in module repositories, so it would stay green against a format nobody writes. The lasting guarantee belongs in `packages-crypto` as a column type that Drizzle's `where` and `orderBy` reject at compile time.
- Marking the roadmap row **done** in this PR. `done` means on `main`; `terraform-au-cell` was flipped in a follow-up chore (PR #3). Same here after merge.
- `packages-crypto`, kernel DI/outbox, `api-au-skeleton`.

## Behaviour

### Two steps, two logins

`SET ROLE migrator` cannot run before `migrator` exists. A `NOLOGIN` role without `CREATEROLE` cannot create `app` / `identity` / `platform`. Revoking on the database needs the database owner. Drizzle needs schema `migrator` to exist **before** it applies journal entry 0. Roles are **cluster-wide**, so `CREATE ROLE` in a per-database journal fails on the second database in the same cluster.

Split:

| Step                        | Who                                                             | Connection                                               | What                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Privileged bootstrap** | Privileged login (CI: Docker superuser; production: RDS master) | Direct, unpooled                                         | Idempotent. Create the four roles **without passwords**. `CREATE SCHEMA migrator AUTHORIZATION migrator`. `GRANT migrator TO <runner login>`. `GRANT CREATE ON DATABASE … TO migrator` (so the journal can create `app` / `identity` / `platform` after `PUBLIC` loses `CREATE`). `REVOKE CREATE ON DATABASE … FROM PUBLIC`. `REVOKE CREATE ON SCHEMA public FROM PUBLIC` (`public` is not owned by `migrator`). Not recorded in the Drizzle journal. |
| **2. Journal apply**        | Same runner login, then `SET ROLE migrator`                     | Direct, unpooled. **Not** PgBouncer. **Not** Hyperdrive. | Everything else: `app` / `identity` / `platform` schemas, `GRANT USAGE`, default privileges, product (and, in test mode, test-only) SQL.                                                                                                                                                                                                                                                                                                              |

`pg_advisory_lock` and `SET ROLE migrator` are session-level. Under transaction pooling the lock can be held on one server connection while the migration runs on another, and the role change can leak to the next client — the bleed this chunk exists to rule out. Production migrations do not go through Hyperdrive either, so CI and production agree: **the runner never uses a pooler**.

App-traffic tests still go through PgBouncer as the `app` (and, in CI, `identity` / `platform`) logins.

### Roles

Privilege, not one role per schema. Superusers bypass RLS even with `FORCE ROW LEVEL SECURITY`. After bootstrap, every journaled object is owned by the non-superuser, `NOLOGIN` `migrator`.

| Role         | LOGIN | DDL | DML                        | Used by                                         |
| ------------ | ----- | --- | -------------------------- | ----------------------------------------------- |
| **migrator** | no    | yes | none in app traffic        | Runner after `SET ROLE`; never Hyperdrive       |
| **app**      | yes   | no  | `app` only; no `BYPASSRLS` | Cell Hyperdrive (existing Terraform config)     |
| **identity** | yes   | no  | `identity` only            | Follow-up Hyperdrive; CI connects as this login |
| **platform** | yes   | no  | `platform` only            | Follow-up Hyperdrive; CI connects as this login |

`FORCE ROW LEVEL SECURITY` applies to `migrator` (the owner). It never applies to a superuser — which is why CI must not leave objects owned by the bootstrap superuser. Tests: every `app` table is owned by `migrator`; `migrator` itself is blocked by the policy.

Ownership (architecture §6.3, AGENTS §6): `identity` schema → `core/identity` + identity role; `platform` schema → `core/tenancy` + platform role; `app` tables → the module that owns them, reached as `app`.

Runtime code **picks a credential**: a different login, and later a different Hyperdrive configuration. It never `SET ROLE` on a pooled connection. Identity and platform helpers are DSN/connection factories, not role switches. The only `SET ROLE` in this package is inside the runner, on the unpooled connection, after bootstrap.

### Passwords

`LOGIN` roles need passwords in order to connect. `CREATE ROLE app LOGIN PASSWORD '…'` in a committed file puts a secret in git — the same credential the cell spec feeds to Hyperdrive.

- Bootstrap `CREATE ROLE` statements have **no** `PASSWORD` clause.
- CI sets passwords from environment variables after bootstrap (`ALTER ROLE … PASSWORD` with a bound parameter, not a committed SQL file).
- Staging and production set them from Secrets Manager in the operations step (same later chunk as the production migration path).
- A static check fails CI if `PASSWORD` appears in bootstrap SQL, `drizzle/`, or `drizzle-test/`.

### Product journal (append-only, as `migrator`)

Create:

- Schemas: `app`, `identity`, `platform` (owned by `migrator`). Schema `migrator` already exists from bootstrap.
- `GRANT USAGE ON SCHEMA app TO app` (and `identity` → identity, `platform` → platform). Default privileges cover tables, not schemas; without `USAGE` the runtime roles see nothing.
- `ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app` (and the analogue for `identity` → identity, `platform` → platform). Sequences/functions as required for DML.
- No grants on `migrator` schema to `app`, `identity`, or `platform`.
- No `CREATE ROLE`. No `PASSWORD`.

**`FORCE ROW LEVEL SECURITY` is not emitted by Drizzle Kit.** Kit can emit `ENABLE ROW LEVEL SECURITY` and policies; every `app` table migration must add `ALTER TABLE … FORCE ROW LEVEL SECURITY` by hand after generate. `schema-rls` is the backstop that fails a missing `FORCE`.

### Test-only set

Lives beside product migrations, **not** in the product journal. The runner refuses this set unless `mode = test` (or equivalent explicit flag). Bookkeeping is a **separate table** in `migrator` (not the product journal table). A unit test: the product entry point cannot load or apply the test set.

The synthetic table is `app`-schema, has `org_id`, RLS, a hand-added `FORCE ROW LEVEL SECURITY`, owned by `migrator`. It is the only `CREATE TABLE app.*` this chunk applies in CI. It never ships to staging or production because the product glob/journal cannot see it.

### Bookkeeping

Schema `migrator`, owned by role `migrator`, created in bootstrap so Kit can create `migrator.<journal>` before journal entry 0. No grants to runtime roles.

- Product journal: Drizzle Kit's table, relocated via config to `migrator` (not the default `drizzle.__drizzle_migrations` in `app` or `public`).
- Test journal: a second table in `migrator`, used only in test mode.

`schema-rls` ignores `migrator` (and continues to ignore `identity` / `platform` for the org_id/FORCE rules).

**Runner decision:** wrap **Drizzle Kit's migrator**. We do not write a from-scratch SQL runner. The wrapper, on the unpooled connection:

1. `SET ROLE migrator`
2. `pg_advisory_lock` for the run
3. Fail if any journal entry is **unapplied** but **older** than the latest applied entry (Kit's Postgres migrator applies only entries newer than the last applied timestamp; two branches that each generate a migration will silently skip the older file if it merges second). Must-fail fixture required. Checksums of applied files do not catch this.
4. Kit apply
5. Fail if a previously applied file's checksum changed

Forward-only: no down migrations. Expand → migrate → contract (AGENTS §7).

Layout:

- Product SQL: `packages/db/drizzle/*.sql` plus `packages/db/drizzle/meta/_journal.json`
- Test-only SQL: `packages/db/drizzle-test/*.sql` plus its own `meta/_journal.json`
- `schema-rls` scans **both** SQL trees (plus existing must-fail fixtures) and is no longer provisional
- `encrypted-query` stays **provisional**. Its input is SQL query files; this codebase will write Drizzle query-builder TypeScript, so pointing the glob at `packages/db` would not give it real input. Fixtures remain. The compile-time column type lands in `packages-crypto`.

### Transaction wrapper

Organisation-scoped work (pooled `app` connections):

```sql
SELECT set_config('app.org_id', $1, true);
SELECT set_config('app.community_id', $2, true);
```

`$1` / `$2` are bound. Policies use `current_setting('app.org_id')` **without** `missing_ok` so an unset name errors.

Identity-schema and platform-schema helpers never set `app.org_id`. They connect as those logins; they do not `SET ROLE`.

After a transaction that set `app.org_id` locally, the GUC **stays defined** on that server connection with an empty value. A later query outside the wrapper then fails on `''::uuid`, not "unrecognized configuration parameter". Both errors are fail-closed. The test **must** run through PgBouncer on a connection that has just served a wrapped transaction. A fresh connection is not that test.

### Pooling

PgBouncer is for **application traffic tests only**. Transaction pooling + named prepared statements: PgBouncer ≥ 1.21 with `max_prepared_statements` > 0. The TypeScript driver (postgres.js or `pg`, chosen in the plan) has its `prepare` setting documented to match Hyperdrive. CI using a pooler that is more lenient than Hyperdrive is a failed spec.

The runner's connection string does not go through PgBouncer.

### Ids

Cell engine is PostgreSQL **17**. `uuidv7()` is not in 17. Columns are `uuid not null`; the application mints UUIDv7. No `DEFAULT uuidv7()` in this chunk's SQL. Architecture §6.3 sample is updated to say that while the engine is 17.

## Data

No product tables, no classified columns, no tenant data. The synthetic CI table is disposable schema for checker and RLS tests; fixtures remain synthetic.

The `migrator` schema holds runner metadata only (file names, checksums, apply timestamps). Not personal data.

## Rules touched

- Entitlements: none.
- Permissions: none.
- Consent / minors / encryption of fields: none (`packages-crypto` is next; that chunk should also replace `encrypted-query`'s SQL scanner with a typed column).
- Residency: no Hyperdrive on gateway; no personal data in CI; Docker only.
- Tenancy: `set_config(..., true)` only; `FORCE RLS`; non-superuser ownership; four roles as above.
- Secrets: no `PASSWORD` in committed SQL; CI/ops set passwords from env / Secrets Manager.
- AGENTS §1.3: replace the `SET LOCAL` wording with transaction-local `set_config(..., true)` in the same implementation PR.
- AGENTS §7: forward-only migrations.
- AGENTS §13: ADR 0004 (four roles + migrator ownership). Hard to undo once objects exist in production.

## Contracts

- Package `@community-hub/db`: `withAppTransaction`; product vs test migrator entry points; bootstrap entry point; connection factories that select the `app` / `identity` / `platform` **login** (DSN), not `SET ROLE`.
- No API routes. No events. No widget keys.
- Hyperdrive: documented mapping only (`app` role → existing cell config). Identity and platform Hyperdrive configs are a later Terraform chunk.
- `schema-rls` input contract: no longer "provisional until packages/db". `encrypted-query` remains provisional.

## Risks

| Risk                                                                   | Mitigation                                                                                                      |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Superuser-owned tables in CI, RLS tests lie                            | Bootstrap then `SET ROLE migrator` before journaled DDL; assert owner; assert migrator is blocked by the policy |
| `SET ROLE migrator` / `CREATE ROLE` / database `REVOKE` in the journal | Privileged bootstrap is a separate, idempotent step; journal has no `CREATE ROLE`                               |
| `PASSWORD` in git                                                      | Roles created without passwords; static ban; CI/ops set passwords from env / Secrets Manager                    |
| Test-only SQL applied to staging/prod                                  | Separate journal; runner refuses test set unless test mode; product entry cannot load it                        |
| Bookkeeping table in `app` fails schema-rls or needs fake `org_id`     | Schema `migrator` from bootstrap, exempt from schema-rls                                                        |
| Fail-closed test on a fresh connection                                 | Reused PgBouncer connection after a wrapped transaction; accept empty-uuid or unset-GUC errors                  |
| Session `SET` / `SET ROLE` bleeds under Hyperdrive-like pooling        | Runner unpooled; app tests through PgBouncer; must-fail bleed; static ban; runtime never `SET ROLE`             |
| Advisory lock held on a different pooled backend than the migration    | Runner does not use PgBouncer or Hyperdrive                                                                     |
| Out-of-order Drizzle journal silently skipped                          | Wrapper fails unapplied entries older than the latest applied; must-fail fixture                                |
| `encrypted-query` declared non-provisional with no real SQL queries    | Leave it provisional; typed encrypted column in `packages-crypto`                                               |
| Missing `FORCE` because Kit does not emit it                           | Hand-added `ALTER TABLE … FORCE`; `schema-rls` must-fail                                                        |
| Runtime roles can see no objects                                       | `GRANT USAGE ON SCHEMA` plus default table privileges                                                           |
| `PUBLIC` still has `CREATE`                                            | Bootstrap revokes database and `public` schema `CREATE` from `PUBLIC`                                           |
| Roadmap `done` before merge                                            | Do not flip the row in this PR                                                                                  |
| Interpolating tenant ids into `SET LOCAL`                              | Wrapper uses bound `set_config` only; static ban                                                                |

## Out-of-band

- **Production migration path** (login, network path to private RDS — probably a one-off ECS task in the cell VPC) is a later chunk. That chunk also sets `LOGIN` role passwords from Secrets Manager. Architecture §23.2 says migrations run before deployment; it does not yet say how they reach RDS. Do not invent a bastion in this spec.
- **Identity and platform Hyperdrive configurations** (one credential per Hyperdrive config) are a Terraform follow-up. This chunk creates the LOGIN roles; it does not change `infra/`.
- Legal: none. New subprocessor: none (Docker Postgres in CI). Architecture change: §6.3 sample SQL + AGENTS §1.3 wording, plus **ADR 0004**, in the implementation PR.

## Next spec after this lands

`packages-crypto`, unless the human picks another remaining Phase 0 row. That spec should include the compile-time encrypted column type that supersedes `encrypted-query`. Roadmap snapshot is updated in a **follow-up chore** after this PR merges (`done` = on `main`).
