# Spec: Database migrate command

Slug: db-migrate-command
Status: draft
Architecture refs: §6.3, §7.3, §23.2, ADR 0009. Follows `docs/specs/2026-10-06-db-ops-task.md`, which added the ops task definition and `db-bootstrap.js`. This is option A of open question 1 in the draft `staging-proof-run` spec. That spec depends on this one. This spec is not edited by it and does not edit it.

## Problem

Nothing in the repository applies the product migrations `0000` to `0007` (`packages/db/drizzle`) to a deployed database. The ops task runs `db-bootstrap.js`. That program creates the four roles and the `migrator` schema, constrains the role attributes, sets three passwords, and prints `SHOW max_connections`. It does not create `app`, `identity`, or `platform` tables. `applyProductMigrations` is exported from `@community-hub/db` and is called only from tests. CI Stage 4 (migrate, then deploy) does not exist.

The next staging unpark needs the tables. Without them every sign-in and role route fails on a missing relation. The owner decided that a separate small chunk adds a `db-migrate` command to the service image, merges to `main`, and is in the image that the `publish` job builds before the proof run starts.

The database accepts TCP 5432 only from the task security group. A person cannot run the migrations from a laptop. The only path is a one-off ECS task, as `db-bootstrap.js` already does.

## Scope

**In**

- `apps/api/src/db-migrate.ts`, emitted as `/app/db-migrate.js`. It connects as the master login, refuses to run if `db-bootstrap` has not run, calls `applyProductMigrations`, and prints the migration tags it applied and a count.
- One small change in `packages/db/src/migrate.ts`: `applyProductMigrations` returns the tags it applied and the journal length. It returns nothing today. No change to what it applies, to the lock, to the order, or to the hash checks. See open question 3.
- Image tests that prove `/app/db-migrate.js`, `drizzle/meta/_journal.json`, and the eight `.sql` files are in the image, and that `node /app/db-migrate.js` with no environment exits 1 with `env`.
- `docs/runbooks/apply-staging-au.md` gains a section "Apply product migrations" that names the command and how the human runs it.
- The catalogue commit, last on the branch.

**Out**

- CI Stage 4. Automatic migrate-then-deploy stays absent.
- Down-migrations. There is no rollback command. See Rollback.
- Any new table or column. Any change to an existing migration file or to a snapshot.
- Any change to `packages/db/sql/bootstrap.sql`, `db-bootstrap.ts`, or the role model.
- Any Terraform change. See Infra.
- Production. The command is built for `staging`. This spec does not run it against `prod` and adds no production runbook.
- A mail vendor, a first-owner path, and any route.
- Fixing the service's error logging. See Behaviour, "The service against an un-migrated database".
- Running the command. This chunk does not unpark staging and does not apply anything.

## Behaviour

### Who runs it, and as which login

The command connects as the RDS master login, `PGUSER` in the ops task definition. The password is `PGPASSWORD_MASTER`, which ECS injects from the `password` field of the RDS-managed master secret. The program does not call Secrets Manager.

This is the only login that can work. `migrator` is `NOLOGIN` by design, and `assertRoleAttributes` (`packages/db/src/bootstrap.ts`) fails if it gains `LOGIN`. The runner (`packages/db/src/migrate.ts`) needs a login that can create roles and schemas, because it runs `bootstrap.sql`, and then does `SET ROLE migrator` so every migration statement runs as `migrator`. The `app`, `identity`, and `platform` logins have no privilege to create tables in their own schema.

The ops task execution role already reads that secret. `aws_iam_role_policy.db_ops_execution` in `infra/regions/au/main.tf` allows `secretsmanager:GetSecretValue` on `module.rds[0].master_user_secret_arn` and on the three role secrets, and `kms:Decrypt` on the role-secrets key. The master secret uses the AWS-managed key, so it needs no IAM decrypt. The task role has no policy, and this program makes no AWS call. Nothing is added.

### Image contents

The Dockerfile copies `apps/api/dist` to `/app`, so `db-migrate.js` is emitted by the existing `tsc -p tsconfig.emit.json`. Test files are excluded by that config.

The migration SQL files and the journal are reached through `@community-hub/db`. `PRODUCT_FOLDER` in `migrate.ts` is `../drizzle` from the compiled file, which is `/app/node_modules/@community-hub/db/drizzle`. `packages/db/package.json` lists `drizzle` in `files`, next to `sql`. `pnpm deploy --prod --legacy` copies the `files` entries, and `sql/bootstrap.sql` already arrives that way (`image.test.ts` asserts it). So I expect `drizzle/` to be in the image today. No test asserts it. I have not built the image. The plan adds the assertion, and if it fails, the fix is a Dockerfile `COPY` line.

Size: `packages/db/drizzle` is about 280 KB on disk, of which about 230 KB is `meta/*_snapshot.json`. The runner reads only `meta/_journal.json` and the `.sql` files. The snapshots ship because `files` names the directory. This spec does not narrow `files`. The 280 KB is text, adds no package, and does not change the vulnerability scan. `drizzle-orm` and `postgres` are production dependencies of `@community-hub/db` and are in the image now, because `index.js` exports `applyProductMigrations`. Nothing new is installed.

The container runs read-only with `/tmp` writable. The command writes no file.

### Environment

The same eight variables as `db-bootstrap.js`, all already in `aws_ecs_task_definition.db_ops`: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD_MASTER`, `PGPASSWORD_APP`, `PGPASSWORD_IDENTITY`, `PGPASSWORD_PLATFORM`. `PGHOST` is the RDS instance address. There is no pooler in `infra`, so the connection is direct, which the runner requires (advisory lock and `SET ROLE` are session state).

The program connects with `createDirectSql` and the image's RDS CA bundle. That factory is verify-full, and `rds.force_ssl` is 1.

### Order with `db-bootstrap`

The runner calls `runBootstrap(sql)` itself, inside the lock, before `SET ROLE migrator`. That function creates any missing role and the `migrator` schema. It does not set a password. So if `db-migrate` ran first against an empty database, it would create `app`, `identity`, and `platform` with no password, apply all migrations, and exit 0. The service would then fail to log in until `db-bootstrap` ran. That is a silent wrong order.

Before the runner is called, the command checks that bootstrap has run and refuses if it has not (open question 1 sets the depth). My recommendation:

1. As the master, read `pg_roles` and require all four of `migrator`, `app`, `identity`, `platform`.
2. For each of `app`, `identity`, `platform`, open a direct connection with the password from the environment and run `select 1`. A refused login (`28P01` or `28000`) means `db-bootstrap` has not set that password.

Either check failing exits 1 with `not_bootstrapped`. The runner is not called. Nothing is created.

`db-bootstrap` is not re-run by the human between migrate runs. After the check passes, the runner runs `bootstrap.sql` again as the master. Every statement in it is idempotent. The first run on RDS is recorded in the runbook under `first-running-task` (exit 0), and `bootstrap.sql`, `bootstrap.ts`, and `migrate.ts` have not changed since 2026-10-04, before that run. The second execution of those statements on RDS has not been observed. The proof run will be the first.

### Applying

The runner, `applyMigrations` in `packages/db/src/migrate.ts`, does this in order. All of it is read from the code:

1. `pg_advisory_lock(MIGRATION_LOCK_ID)`. This is a session lock, taken as the master. It blocks until it is free.
2. `runBootstrap(sql)`.
3. `SET ROLE migrator`.
4. Preflight against `migrator.__drizzle_migrations`. Every applied hash must match the journal file's hash. Every applied `created_at` must exist in the journal. No unapplied entry may be older than the newest applied one.
5. Check that the backend pid is the one that took the lock and that `current_user` is `migrator`.
6. Drizzle `migrate`. It creates the `migrator` schema and the journal table with `IF NOT EXISTS`, reads the newest applied `created_at`, and applies every newer migration inside one transaction.
7. `RESET ROLE` and `pg_advisory_unlock`, in `finally`.

Drizzle's `migrate` (`drizzle-orm/pg-core/dialect.js`, 0.45.2) wraps the whole pending set in one `BEGIN ... COMMIT`. Each migration's statements run one at a time, then one `insert` into the journal table. I read that source. Postgres DDL is transactional.

### Idempotency and concurrency

A second run applies nothing. Step 4 passes, step 6 finds nothing newer than the newest applied `created_at`, and the command prints `done applied=0 total=8` and exits 0.

Two runs at the same time do not both apply. The second blocks at step 1 until the first releases the lock (it commits, or its connection closes). It then runs steps 2 to 6 against a journal that is now complete and applies nothing. The lock is the runner's own. This spec adds none.

The wait has no bound. If the first task hangs, the second waits. The human stops the first task, which closes its connection and releases the lock. See open question 6.

### Failure half-way

The pending set is one transaction. A failing statement rolls back every pending migration and every journal insert from that run. Migrations committed by an earlier run stay. There is no state in which `0004` is applied and `0005` is not, from one run.

What a failed run does leave: any role or schema created by `bootstrap.sql` (they commit before the transaction), and an empty `migrator.__drizzle_migrations` table if it did not exist (`CREATE TABLE IF NOT EXISTS` runs before the transaction). Both are harmless and are what a successful run would also have created. The session ends, so `SET ROLE` and the advisory lock are gone.

The human reads the log stream. The log has one word, and for a driver error a five-character SQLSTATE. The human fixes the cause and runs the command again. A re-run is safe because nothing from the failed run is applied. If the cause cannot be fixed inside the unpark window, the human re-parks. Re-parking destroys the staging database, which holds no data.

### Invocation, exit codes, output

The human runs the existing ops task definition (`aws_ecs_task_definition.db_ops`) as a one-off ECS task, as the runbook does for `db-bootstrap.js`. The command override is `["node", "/app/db-migrate.js"]`. `entryPoint` is not set. The task uses the task security group, the staging public subnet, and a public address. The image must be the one built from the `main` that contains this chunk.

| Result                                | Exit | Stdout                                                                            | Stderr                                                 |
| ------------------------------------- | ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Applied some or all                   | 0    | One line `applied <tag>` per migration applied, then `done applied=<n> total=<m>` | empty                                                  |
| Nothing to apply                      | 0    | `done applied=0 total=<m>`                                                        | empty                                                  |
| Environment missing or malformed      | 1    | empty                                                                             | `env`                                                  |
| Master connection failed              | 1    | empty                                                                             | `connect`                                              |
| Roles missing or a role login refused | 1    | empty                                                                             | `not_bootstrapped`                                     |
| Runner or migration failed            | 1    | empty                                                                             | `migrate`, then ` <SQLSTATE>` when the driver gave one |

`<tag>` is a name from `meta/_journal.json`, for example `0003_complex_leech`. `total` is the number of journal entries in the image, 8 today. Every line ends in one newline. On success stderr is empty. On failure stdout is empty, so a partial list of tags is never printed for a run that rolled back.

A `migrate` failure from the runner's own checks (a hash mismatch, a journal entry older than an applied one, a lost session) is a plain `Error` with no SQLSTATE. It prints `migrate` alone. The human then needs the message. The message text is not printed (see Logging). Open question 3 notes the option of a typed error.

### Logging

The command writes only the lines in the table. Stdout and stderr go to the log stream with prefix `db-ops` in the service log group.

It never writes a connection string, a host, a port, a database name, a user, a password, an ARN, a driver message, a stack, or SQL text. The master password goes only to `createDirectSql`. The three role passwords go only to the login checks. A caught error is reduced to its stage word and, when `error.code` matches `^[0-9A-Z]{5}$`, that code. Nothing else from the error is read.

A migration tag is a file name from the repository. A SQLSTATE class is a fixed code. Neither is personal data (§1 rule 5). No secret is in either (§1 rule 8).

### The service against an un-migrated or half-migrated database

Described from the code. This chunk changes none of it.

- Startup does not check the database. `GET /health` opens no connection (`roadmap.md`, Open items). A service started against an empty database is healthy.
- A route that needs a table runs a query. Against a missing relation Postgres raises `42P01`. The sign-in and role routes map only their own domain errors (`statusFor` in `auth-routes.ts`, `AccessError` in `access-routes.ts`) and rethrow the rest. The outer catch in `apps/api/src/server.ts` answers 400 with an empty body and writes no log line. I read the catch in `server.ts` and the two mapping sites. I did not trace every route.
- A half-migrated database cannot come from one run of this command (see Failure half-way). It can exist if the image's journal is older than the database's. The service has no check for that either. Migrations are expand-first (AGENTS.md §7) so the older service keeps working.

## Data

No new table and no new column. The command creates, through the existing migrations, the `app`, `identity`, and `platform` tables already specified and classified in earlier specs. It adds no row to any of them. All are empty on a new staging database.

The one table that holds migration state is created by Drizzle, not by a migration file:

| Table                           | Columns                    | Classification |
| ------------------------------- | -------------------------- | -------------- |
| `migrator.__drizzle_migrations` | `id`, `hash`, `created_at` | all `internal` |

`hash` is a digest of a migration file. `created_at` is that file's `when` value from the journal, in milliseconds. It is not the time the migration ran, so the table cannot say when a migration was applied. The evidence of a run is the ECS task's stop time and the log stream.

The table is not encrypted and no SQL filters on an encrypted column. No blind index. No minors' data.

### Where the record lives, and who can read it

The schema `migrator` is owned by `migrator`, and the journal table is owned by `migrator`. `bootstrap.sql` grants `CREATE` on the database to `migrator` and nothing on the `migrator` schema to anyone else. The default privileges in `0000_schemas.sql` cover only `app`, `identity`, and `platform`. So `app`, `identity`, `platform`, and `PUBLIC` have no `USAGE` on `migrator`. The master login is not a superuser on RDS. It reads or writes the table only after `SET ROLE migrator`, which the runner does. The plan adds a test that asserts this with `has_schema_privilege`.

## Rules touched

Residency (§1 rule 1). The task, the database, and the logs are in `ap-southeast-2`. The command carries no personal data. It creates empty tables.

Tenancy (§1 rule 2). The command applies the migrations that create the `app` tables with `ENABLE` and `FORCE ROW LEVEL SECURITY`. It does not weaken any of them. Migrations run as `migrator`, the owner, so `FORCE` is what makes the policies apply to the owner. The plan's test checks that every `app` table has both flags set after the command. The command never sets `app.org_id` and never reads an `app` row.

Children (§1 rule 4). No new path. No row.

Secrets (§1 rule 8) and logs (§1 rule 5). See Logging. The master secret is not given to the service task. The execution role is unchanged.

Permissions and entitlements. None. No route, no event, no manifest key.

Retention and safeguarding. None.

## Contracts

| Contract                             | Value                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Program                              | `/app/db-migrate.js`, run as `node /app/db-migrate.js` through an ECS command override. `ENTRYPOINT` stays empty.   |
| Environment                          | The eight variables listed above. All already set in `aws_ecs_task_definition.db_ops`.                              |
| Exit code                            | 0 on success or nothing to apply. 1 on any failure.                                                                 |
| Stdout, stderr                       | Exactly the table in Behaviour. Nothing else.                                                                       |
| Login                                | Master only. `migrator` stays `NOLOGIN`.                                                                            |
| Journal record                       | `migrator.__drizzle_migrations`. No grant to any other role.                                                        |
| `applyProductMigrations`             | Returns `{ applied: string[]; total: number }`. Same arguments and same effect. Existing callers ignore the result. |
| Ops task definition, IAM, secrets    | Unchanged. The service task definition, its roles, and its secrets are unchanged.                                   |
| API routes, events, ports            | None.                                                                                                               |
| Website collections, islands, blocks | None.                                                                                                               |

## Infra

No Terraform change is needed. I checked each part.

- The ops task definition already has the eight variables and the command is a runtime override.
- The execution role already reads the master secret and the three role secrets. The task role makes no AWS call.
- The security groups already allow the task to reach 5432 and the registry. The command uses the same network path as `db-bootstrap.js`.
- The image is built by the existing `publish` job. The Dockerfile is not expected to change. If the image assertion in Tests shows `drizzle/` is missing, the fix is one `COPY` line, which the plan then names.

This chunk therefore leaves staging parked, needs no apply, and adds no `*.tftest.hcl` case. The existing cell test for the ops task definition keeps passing.

## Cost

No new hourly or monthly resource. No Terraform change, so no NAT gateway, load balancer, interface endpoint, or other billed resource appears. The run is a one-off Fargate task on the existing ops task definition (256 CPU, 512 MB, ARM64), billed per second. It is part of the unpark window priced in the `staging-proof-run` draft. This chunk adds no figure to that window.

## Risks

**RDS privileges (I cannot test this against RDS).** The tests run on Docker Postgres 17 as a superuser. The RDS master is a member of `rds_superuser`, which is not a superuser. This is what each statement needs, read from the files.

| Statement                                                                                                                                                                                              | Where                                                        | Needs                                                                    | Held after `db-bootstrap`                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `CREATE ROLE`, `GRANT CREATE ON DATABASE`, `REVOKE ... FROM PUBLIC`, `GRANT migrator TO current_user`, `CREATE SCHEMA migrator AUTHORIZATION migrator`, `REVOKE CREATE ON SCHEMA public`, `ALTER ROLE` | `bootstrap.sql`, `bootstrap.ts`, run by the runner each time | `CREATEROLE`, database owner, `ADMIN` on `migrator`, `SET` on `migrator` | Yes. The same code exited 0 on RDS 17.9 in `first-running-task`.                                                                          |
| `SET ROLE migrator`                                                                                                                                                                                    | runner                                                       | Membership of `migrator` with the `SET` option                           | Probably. I infer it from the `AUTHORIZATION migrator` clause above, which needs the same check in PostgreSQL 16 and later. Not observed. |
| `CREATE SCHEMA app, identity, platform`                                                                                                                                                                | `0000`                                                       | `CREATE` on the database                                                 | Granted to `migrator` by `bootstrap.sql`.                                                                                                 |
| `GRANT USAGE ON SCHEMA`, `ALTER DEFAULT PRIVILEGES FOR ROLE migrator`                                                                                                                                  | `0000`                                                       | Schema owner, and being `migrator` itself                                | Yes, `migrator` owns the schemas.                                                                                                         |
| `CREATE TABLE`, `ALTER TABLE ... ENABLE` and `FORCE ROW LEVEL SECURITY`, `CREATE POLICY`, `CREATE INDEX`, foreign keys, `ADD` and `DROP CONSTRAINT`                                                    | `0001`, `0003` to `0007`                                     | Table owner; `REFERENCES` on parents                                     | Yes, `migrator` creates and owns every table.                                                                                             |
| `REVOKE ... ON TABLE ... FROM app`                                                                                                                                                                     | `0002`, `0005`, `0007`                                       | Table owner                                                              | Yes.                                                                                                                                      |
| `CREATE FUNCTION` (`plpgsql`), `CREATE TRIGGER`, `REVOKE ALL` and `GRANT EXECUTE ON FUNCTION`                                                                                                          | `0002`                                                       | `USAGE` on `plpgsql`, table owner, function owner                        | Yes. `plpgsql` usage is granted to `PUBLIC` by default.                                                                                   |
| `SET LOCAL lock_timeout = '5s'`                                                                                                                                                                        | `0001`                                                       | Nothing                                                                  | Yes.                                                                                                                                      |

No migration creates an extension, creates a role, changes an owner, uses `CREATE INDEX CONCURRENTLY`, or needs a superuser. `sha256`, `uuid_send`, and `int4send` are built in.

What looks most likely to fail on RDS, in order: `SET ROLE migrator` for the master (SQLSTATE `42501`); a repeat of `GRANT migrator TO current_user` in the second execution of `bootstrap.sql` (`0LP01` or `42501`); and anything about default privileges that differs from Docker. If one fails, the transaction has not started, nothing is applied, and the stderr is `migrate 42501` or similar. The cost of finding out is one unpark task run. The Tests section's non-superuser container narrows the gap but does not close it.

**A wrong order silently succeeds.** Fixed by the bootstrap check. Without it, roles with no password would exist and the service would not log in.

**An unbounded lock wait.** A hung first run blocks a second. Mitigation: the human stops the first task. See open question 6.

**A driver message in the log.** A Postgres error can quote data. The command reads only `error.code`. The must-fail test plants a marker in the driver error.

**Role left set on the session.** If `SET ROLE migrator` were not undone, later statements on that connection would run as `migrator`. The runner resets it in `finally`, and the command closes the connection right after.

**A journal older than the database.** An image older than the database fails the preflight with `migrate`. That is correct and the human gets no detail beyond the word.

**Image size and scan.** Negligible. See Image contents.

## Out-of-band

- The second fresh-context review is required. This chunk touches the database, tenancy (it applies the RLS migrations), and the master login. The owner's assistant starts it when the pull request opens. The pull request's second-review line stays open until it is written. The review that writes this spec does not count.
- No new subprocessor, no legal question, no architecture change, no ADR. §23.2 already says migrations run before deployment. This chunk supplies a way to run them on staging by hand.
- No password, account id, hostname, registry host, ARN, or email in this spec, the plan, the tests, or the runbook.
- The staging-proof-run spec stays draft until this is on `main` and its `publish` job has passed.

### Open questions for the owner

Each can be answered in one line.

1. **Depth of the bootstrap check.** (A) The four roles exist. (B) The four roles exist and each of `app`, `identity`, `platform` can log in with the injected password. Recommendation: B. A passes when `db-bootstrap` failed after creating the roles and before `ALTER ROLE`, which is the state a half-run leaves. B costs three short connections and also proves the passwords the service will use.
2. **Failure detail.** (A) Print the stage word only, as `db-bootstrap` does. (B) Print the stage word and the five-character SQLSTATE. Recommendation: B. On RDS the likely failure is `42501`, and a bare `migrate` would cost another unpark run to learn that. A SQLSTATE is a fixed code and carries no data.
3. **What stdout reports.** (A) Tags and counts, which needs the small return-value change in `packages/db/src/migrate.ts`, and optionally a typed error so the runner's own failures say which check failed. (B) Counts only, with no change to `packages/db`. Recommendation: A for the return value, and no typed error in this chunk.
4. **Test fixture for the RDS gap.** (A) Add a throwaway TLS Postgres container whose master is a non-superuser with `CREATEROLE` that owns the database and creates the roles itself, and run `db-bootstrap` then the compiled `db-migrate.js` against it as a child process. (B) Use the existing superuser container only. Recommendation: A. It exercises the verify-full connection, the `ADMIN` and `SET` membership rules, and the second `bootstrap.sql` run, none of which the current tests reach. It is one container in the style of `packages/db/test/tls.integration.test.ts`. It is not RDS.
5. **Where the catalogue row goes.** (A) Phase 0, after `kms-mrk-replica`, as `db-ops-task` was. (B) The Architecture decisions or Process tables. Recommendation: A. Counts are in Catalogue.
6. **Lock wait bound.** (A) Leave the runner's blocking advisory lock. (B) Add a wait limit. Recommendation: A. A limit needs a session-level `SET` or a timer, and the `sql-session-ban` check allows session `SET` only in `migrate.ts`. A hung run is a person's problem on a short staging window, and stopping the task releases the lock.

## Tests

Each test uses a planted marker or a synthetic value. No test uses a real account id, hostname, or password.

**Unit, `apps/api/src/db-migrate.test.ts`** (fake driver, in the style of `db-bootstrap.test.ts`):

- Each env variable missing, empty, or a bad port: stdout empty, stderr `env\n`, exit 1.
- The connection factory throws: stderr `connect\n`.
- The role query returns fewer than four roles: stderr `not_bootstrapped\n`, and the runner is never called.
- A role login rejects with SQLSTATE `28P01` (if question 1 is B): stderr `not_bootstrapped\n`. A rejection with another code: stderr `connect\n`.
- The runner rejects with a driver-shaped error whose message carries a planted password, a host name, and a connection string, and whose `code` is `42501`: stderr is exactly `migrate 42501\n`. With no code: `migrate\n`.
- The log-content test: for every case above, `stdout + stderr` matches one of the allowed forms, `^(applied [0-9]{4}_[a-z0-9_]+\n)*done applied=[0-9]+ total=[0-9]+\n$` or `^(env|connect|not_bootstrapped|migrate)( [0-9A-Z]{5})?\n$`, and contains none of the planted values. The same planted values do not appear in any SQL text handed to the fake driver.
- The master password is passed only to the connection factory, and each role password only to its own login check. A spy on the factory asserts that.

Source change that must fail the log-content test: write `error.message` or `String(error)` into stderr.

**Integration, Docker Postgres, `apps/api/src/db-migrate.integration.test.ts`**, each case on a fresh database created in the test:

- Empty database, no bootstrap: exit 1, `not_bootstrapped`, and no role, no schema, and no table was created. Source change that must fail it: delete the check, so the runner creates roles and applies.
- After `runDbBootstrap`: exit 0, stdout lists the eight tags in journal order and `done applied=8 total=8`. `migrator.__drizzle_migrations` has eight rows. Every `app` table has `relrowsecurity` and `relforcerowsecurity` true. Schemas `app`, `identity`, `platform` are owned by `migrator`. Source change that must fail it: drop a `FORCE ROW LEVEL SECURITY` line from a migration copy used by the test, or drop `set role migrator` from the runner.
- Second run: exit 0, `done applied=0 total=8`, still eight rows, same `hash` and `created_at` values.
- The record is closed: `has_schema_privilege` is false for `app`, `identity`, `platform`, and `PUBLIC` on `migrator`. Source change that must fail it: add `GRANT USAGE ON SCHEMA migrator TO PUBLIC` to `bootstrap.sql`.
- Concurrency, not timing-based: a second connection takes `pg_advisory_lock(MIGRATION_LOCK_ID)` and holds it. The test starts the command. The test then polls `pg_locks` until a row with `locktype = 'advisory'`, the lock's `objid`, and `granted = false` exists. That is a state, not a delay. While the lock is held, it asserts `migrator.__drizzle_migrations` does not exist or has no rows. It releases the lock, waits for exit, and asserts exit 0, eight rows, and `applied=8`. A second concurrent start after that applies 0. Source change that must fail it: remove `pg_advisory_lock` from the runner, since the command would then apply while the lock is held.
- Failure half-way: before the run, the test creates schema `app` and a table `app.outbox` as `migrator`, so `0001` fails on `CREATE TABLE` (`42P07`) after `0000` has run. Exit 1, stderr `migrate 42P07`. After: `identity` and `platform` schemas do not exist, the journal has zero rows, and a re-run after the test drops the stray table applies all eight. Source change that must fail it: run migration statements outside the single transaction.
- Not a superuser path: with question 4 as A, the success case also runs against the non-superuser TLS container as a child process (`node` on the emitted `db-migrate.js`, environment set, CA file passed), with the same assertions.

**Image, gated by `RUN_IMAGE_TESTS=1`, in `apps/api/src/image.test.ts`:**

- `/app/db-migrate.js`, `/app/node_modules/@community-hub/db/drizzle/meta/_journal.json`, and every `.sql` file the journal names exist. The walk test that forbids `.ts`, test files, and `/test` directories under `node_modules/@community-hub` still passes.
- `docker run <image> node /app/db-migrate.js`, with no `--entrypoint` and no environment: exit 1, stdout empty, stderr `env\n`.
- `docker run <image>` with no command still starts the server. That test exists.

**Existing suites:** the `packages/db` migrate tests still pass with the return-value change. The Terraform tests are untouched.

## Rollback

Revert the commit. The command disappears from the next image. The image already published stays in the registry and is harmless, since nothing runs it unless a human overrides the command.

There is no down-migration and none is added. A migration applied to staging is undone by the re-park, which destroys the staging database. That database holds no data. A bad migration on a database that holds data is fixed forward, as AGENTS.md §7 says. That is a production concern and is out of this spec.

## Catalogue

The last commit on the branch updates `docs/roadmap.md` and the repository-state line in `AGENTS.md`. The new Phase 0 row is `db-migrate-command`, placed after `kms-mrk-replica`, and it is **done**. Phase 0 goes from 24 rows (23 done, 1 superseded, 0 not started) to 25 rows: 24 done, 1 superseded, 0 not started. The plan recomputes these counts against `main` when it is written, because `staging-proof-run` also adds a Phase 0 row. The snapshot's last shipped chunk is `db-migrate-command`. The next chunk stays as the owner sets it. The roadmap open item "This image has not run on Fargate" is left for the proof run to replace.
