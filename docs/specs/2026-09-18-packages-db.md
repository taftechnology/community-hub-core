# Spec: packages/db foundations

Slug: `packages-db`
Status: draft
Architecture refs: §6.3, §8.1, §12.1–12.2.1, §23.1–23.3; D2; AGENTS.md §1 (3, 4, 9), §6, §7, §10
Supersedes: —

## Problem

The workspace has checkers that look for `packages/db` and a cell Terraform graph that will one day point Hyperdrive at RDS. There is no Drizzle package, no migration runner, no application roles, and no proof that tenant scope is transaction-local under a pooler. Live Tunnel → Workers VPC → Hyperdrive is not this chunk: CI must prove isolation against Docker Postgres behind PgBouncer.

## Scope

**In**

- `packages/db`: Drizzle Kit **wrapped** by our runner (advisory lock + checksums). Product SQL under Drizzle's layout (`drizzle/` + `meta/_journal.json`).
- Product migrations: schemas `app`, `identity`, `platform`, `migrator`; roles; grants; default privileges; `public` lockdown. **No product tables.**
- Test-only migration set (CI Docker only): one synthetic `app` table with `org_id`, RLS, `FORCE ROW LEVEL SECURITY`. Separate journal and bookkeeping. The product entry point cannot load this set.
- Transaction wrapper: `SELECT set_config('app.org_id', $1, true)` and the same for `app.community_id`. Bind parameters only. No interpolated `SET LOCAL`.
- Role-aware helpers: `SET ROLE migrator` before DDL; identity/platform connections never set `app.org_id`.
- CI: Postgres **17** (matches `infra/modules/aws-rds` `engine_version` default) behind PgBouncer ≥ 1.21, **transaction mode**, `max_prepared_statements` set. Driver `prepare` setting matches Hyperdrive's prepared-statement behaviour.
- Must-fail: session-level `SET` / `set_config(..., false)` bleeds into the next pooled checkout.
- Must-pass: wrapper's `is_local = true` setting does not bleed.
- Fail-closed query **on a reused PgBouncer connection** that just served a wrapped transaction (see Behaviour).
- Static ban (must-fail fixtures): session-level `SET`, `SET SESSION`, `set_config(..., false)`, `RESET` of `app.*`, and `SET ROLE` outside the role-aware helpers / runner.
- De-provisionalise `schema-rls` and `encrypted-query`: scan the real package layout; keep existing must-fail fixtures working. Exempt schema `migrator`.
- Docs: architecture §6.3 sample SQL (application-minted UUIDv7 while the cell is 17); AGENTS.md §1.3 wording (`set_config(..., true)` as the implementation of transaction-local scope). §23.2 note that **how** migrations reach private RDS is later (Out-of-band).

**Out** (explicitly)

- Organisation, community, people, identity, or platform **tables**. Those are `tenancy-implicit-org`, `people-households`, `identity-otp`.
- Hyperdrive binding on `apps/gateway` (global-no-PII).
- Second or third Hyperdrive configurations (identity / platform logins). Terraform follow-up; this PR does not change `infra/`.
- Live RDS, Tunnel, apply, or any production DSN in CI.
- `DEFAULT uuidv7()` in SQL (Postgres 17). Ids are minted in the application as UUIDv7.
- Production/staging migration **path** (which login, from where — likely a one-off ECS task inside the cell VPC). Named in Out-of-band.
- Marking the roadmap row **done** in this PR. `done` means on `main`; `terraform-au-cell` was flipped in a follow-up chore (PR #3). Same here after merge.
- `packages-crypto`, kernel DI/outbox, `api-au-skeleton`.

## Behaviour

### Roles

Privilege, not one role per schema. Superusers bypass RLS even with `FORCE ROW LEVEL SECURITY`. The runner therefore connects with whatever login it has, then **`SET ROLE migrator` before any DDL**, so every object is owned by the non-superuser, `NOLOGIN` migrator in CI and (later) production.

| Role         | LOGIN | DDL | DML                        | Used by                                     |
| ------------ | ----- | --- | -------------------------- | ------------------------------------------- |
| **migrator** | no    | yes | none in app traffic        | Runner after `SET ROLE`; never Hyperdrive   |
| **app**      | yes   | no  | `app` only; no `BYPASSRLS` | Cell Hyperdrive (existing Terraform config) |
| **identity** | yes   | no  | `identity` only            | Follow-up Hyperdrive; CI connects directly  |
| **platform** | yes   | no  | `platform` only            | Follow-up Hyperdrive; CI connects directly  |

`FORCE ROW LEVEL SECURITY` applies to `migrator` (the owner). It never applies to a superuser — which is why CI must not leave objects owned by the bootstrap superuser.

Ownership (architecture §6.3, AGENTS §6): `identity` schema → `core/identity` + identity role; `platform` schema → `core/tenancy` + platform role; `app` tables → the module that owns them, reached as `app`.

### Product migrations (append-only)

Create:

- Schemas: `app`, `identity`, `platform`, `migrator`.
- Roles as above. `migrator` is `NOLOGIN`.
- `ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app` (and the analogue for `identity` → identity, `platform` → platform). Sequences/functions as required for DML.
- `REVOKE CREATE ON SCHEMA public FROM PUBLIC`; `REVOKE CREATE ON DATABASE … FROM PUBLIC`. Runtime roles have no DDL.
- No grants on `migrator` schema to `app`, `identity`, or `platform`.

### Test-only set

Lives beside product migrations, **not** in the product journal. The runner refuses this set unless `mode = test` (or equivalent explicit flag). Bookkeeping is a **separate table** in `migrator` (not the product journal table). A unit test: the product entry point cannot load or apply the test set.

The synthetic table is `app`-schema, has `org_id`, RLS, `FORCE ROW LEVEL SECURITY`, owned by `migrator`. It is the only `CREATE TABLE app.*` this chunk applies in CI. It never ships to staging or production because the product glob/journal cannot see it.

### Bookkeeping

Schema `migrator`, owned by role `migrator`, no grants to runtime roles.

- Product journal: Drizzle Kit's table, relocated via config to `migrator` (not the default `drizzle.__drizzle_migrations` in `app` or `public`).
- Test journal: a second table in `migrator`, used only in test mode.

`schema-rls` ignores `migrator` (and continues to ignore `identity` / `platform` for the org_id/FORCE rules).

**Runner decision:** wrap **Drizzle Kit's migrator**. We do not write a from-scratch SQL runner. The wrapper: `pg_advisory_lock` for the run, then Kit apply, then **checksum** of each applied file recorded alongside (Kit records hashes; we fail if a previously applied file's checksum changed). Forward-only: no down migrations. Expand → migrate → contract (AGENTS §7).

Layout the de-provisionalised checkers scan:

- Product SQL: `packages/db/drizzle/*.sql` plus `packages/db/drizzle/meta/_journal.json`
- Test-only SQL: `packages/db/drizzle-test/*.sql` plus its own `meta/_journal.json`
- `schema-rls` scans **both** SQL trees (plus existing must-fail fixtures)
- `encrypted-query` keeps scanning query SQL + classification map; live globs point at `packages/db` once queries exist. Zero query files still emit a notice, not a silent pass. Fixtures remain the durable must-fail contract.

### Transaction wrapper

Organisation-scoped work:

```sql
SELECT set_config('app.org_id', $1, true);
SELECT set_config('app.community_id', $2, true);
```

`$1` / `$2` are bound. Policies use `current_setting('app.org_id')` **without** `missing_ok` so an unset name errors.

Identity-schema and platform-schema helpers never set `app.org_id`.

After a transaction that set `app.org_id` locally, the GUC **stays defined** on that server connection with an empty value. A later query outside the wrapper then fails on `''::uuid`, not "unrecognized configuration parameter". Both errors are fail-closed. The test **must** run through PgBouncer on a connection that has just served a wrapped transaction. A fresh connection is not that test.

### Pooling

PgBouncer transaction pooling + named prepared statements: use PgBouncer ≥ 1.21 with `max_prepared_statements` > 0. The TypeScript driver (postgres.js or `pg`, chosen in the plan) has its `prepare` setting documented to match Hyperdrive. CI using a pooler that is more lenient than Hyperdrive is a failed spec.

### Ids

Cell engine is PostgreSQL **17**. `uuidv7()` is not in 17. Columns are `uuid not null`; the application mints UUIDv7. No `DEFAULT uuidv7()` in this chunk's SQL. Architecture §6.3 sample is updated to say that while the engine is 17.

## Data

No product tables, no classified columns, no tenant data. The synthetic CI table is disposable schema for checker and RLS tests; fixtures remain synthetic.

The `migrator` schema holds runner metadata only (file names, checksums, apply timestamps). Not personal data.

## Rules touched

- Entitlements: none.
- Permissions: none.
- Consent / minors / encryption of fields: none (`packages-crypto` is next).
- Residency: no Hyperdrive on gateway; no personal data in CI; Docker only.
- Tenancy: `set_config(..., true)` only; `FORCE RLS`; non-superuser ownership; four roles as above.
- AGENTS §1.3: replace the `SET LOCAL` wording with transaction-local `set_config(..., true)` in the same implementation PR.
- AGENTS §7: forward-only migrations.

## Contracts

- Package `@community-hub/db`: `withAppTransaction`, migrator entry points (`product` vs `test`), role-aware connection helpers.
- No API routes. No events. No widget keys.
- Hyperdrive: documented mapping only (`app` role → existing cell config). Identity and platform Hyperdrive configs are a later Terraform chunk.
- Checker input contracts: no longer "provisional until packages/db".

## Risks

| Risk                                                               | Mitigation                                                                                               |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Superuser-owned tables in CI, RLS tests lie                        | `SET ROLE migrator` before DDL; assert owner; assert migrator is blocked by the policy                   |
| Test-only SQL applied to staging/prod                              | Separate journal; runner refuses test set unless test mode; product entry cannot load it                 |
| Bookkeeping table in `app` fails schema-rls or needs fake `org_id` | Schema `migrator`, exempt from schema-rls                                                                |
| Fail-closed test on a fresh connection                             | Reused PgBouncer connection after a wrapped transaction; accept empty-uuid or unset-GUC errors           |
| Session `SET` / `SET ROLE` bleeds under Hyperdrive-like pooling    | PgBouncer transaction mode + must-fail bleed + static ban including `SET SESSION` / `RESET` / `SET ROLE` |
| `PUBLIC` still has `CREATE` on `public`                            | Revoke; default privileges for future tables                                                             |
| Roadmap `done` before merge                                        | Do not flip the row in this PR                                                                           |
| Interpolating tenant ids into `SET LOCAL`                          | Wrapper uses bound `set_config` only; static ban                                                         |

## Out-of-band

- **Production migration path** (login, network path to private RDS — probably a one-off ECS task in the cell VPC) is a later chunk. Architecture §23.2 says migrations run before deployment; it does not yet say how they reach RDS. Do not invent a bastion in this spec.
- **Identity and platform Hyperdrive configurations** (one credential per Hyperdrive config) are a Terraform follow-up. This chunk creates the LOGIN roles; it does not change `infra/`.
- Legal: none. New subprocessor: none (Docker Postgres in CI). Architecture change: §6.3 sample SQL + AGENTS §1.3 wording in the implementation PR, not a new ADR.

## Next spec after this lands

`packages-crypto`, unless the human picks another remaining Phase 0 row. Roadmap snapshot is updated in a **follow-up chore** after this PR merges (`done` = on `main`).
