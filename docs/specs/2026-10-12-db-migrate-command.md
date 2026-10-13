# Spec: Database migrate command

Slug: db-migrate-command
Status: approved (2026-10-12, Abdus)
Architecture refs: §6.3, §7.3, §23.2, ADR 0009. Follows `docs/specs/2026-10-06-db-ops-task.md`, which added the ops task definition and `db-bootstrap.js`. On 2026-10-12 the owner chose a separate chunk that merges before the staging proof run, over putting this work inside the draft `staging-proof-run` spec. That spec depends on this one. This spec is not edited by it and does not edit it.

## Problem

Nothing in the repository applies the product migrations `0000` to `0007` (`packages/db/drizzle`) to a deployed database. The ops task runs `db-bootstrap.js`. That program creates the four roles and the `migrator` schema, constrains the role attributes, sets three passwords, and prints `SHOW max_connections`. It does not create `app`, `identity`, or `platform` tables. `applyProductMigrations` is exported from `@community-hub/db` and is called only from tests. CI Stage 4 (migrate, then deploy) does not exist.

The next staging unpark needs the tables. Without them every sign-in and role route fails on a missing relation. The owner decided that a separate small chunk adds a `db-migrate` command to the service image, merges to `main`, and is in the image that the `publish` job builds before the proof run starts.

The database accepts TCP 5432 only from the task security group. A person cannot run the migrations from a laptop. The only path is a one-off ECS task, as `db-bootstrap.js` already does.

## Scope

**In**

- `apps/api/src/db-migrate.ts`, emitted as `/app/db-migrate.js`. It connects as the master login, refuses to run if `db-bootstrap` has not run, calls `applyProductMigrations`, and prints the migration tags it applied and a count. It reuses the environment and port parsing of `db-bootstrap.ts` (extracted to one shared module, not copied).
- One small change in `packages/db/src/migrate.ts`: `applyProductMigrations` returns the tags it applied and the journal length. It returns nothing today. No change to what it applies, to the lock, to the order, or to the hash checks. See "How the applied tags are computed".
- Test support: a throwaway non-superuser TLS Postgres container, reusing `packages/db/test/postgres-tls-entrypoint.sh` and the certificate generation that `packages/db/test/tls.integration.test.ts` does inline today, extracted to a shared test helper rather than copied.
- Image tests that prove `/app/db-migrate.js`, `drizzle/meta/_journal.json`, and the eight `.sql` files are in the image, and that `node /app/db-migrate.js` with no environment exits 1 with `env`.
- `docs/runbooks/apply-staging-au.md` gains a section "Apply product migrations" that names the command and how the human runs it.
- The catalogue commit, last on the branch.

**Out**

- CI Stage 4. Automatic migrate-then-deploy stays absent.
- Down-migrations. There is no rollback command. See Rollback.
- Any new table or column. Any change to an existing migration file or to a snapshot.
- Any change to `packages/db/sql/bootstrap.sql`, `db-bootstrap.ts` behaviour, or the role model. (`db-bootstrap.ts` changes only to share its parsing helpers.)
- Any Terraform change. See Infra.
- Production. The command is built for `staging`. This spec does not run it against `prod` and adds no production runbook.
- A mail vendor, a first-owner path, and any route.
- A bound on the lock wait. See Decisions.
- Fixing the service's request error logging. The missing error text in the service's request log is fixed in a separate no-spec branch, `fix/2026-10-12-request-error-log`, not here. See Behaviour, "The service against an un-migrated database".
- Running the command. This chunk does not unpark staging and does not apply anything.

## Behaviour

### Who runs it, and as which login

The command connects as the RDS master login, `PGUSER` in the ops task definition. The password is `PGPASSWORD_MASTER`, which ECS injects from the `password` field of the RDS-managed master secret. The program does not call Secrets Manager.

This is the only login that can work. `migrator` is `NOLOGIN` by design, and `assertRoleAttributes` (`packages/db/src/bootstrap.ts`) fails if it gains `LOGIN`. The runner (`packages/db/src/migrate.ts`) needs a login that can create roles and schemas, because it runs `bootstrap.sql`, and then does `SET ROLE migrator` so every migration statement runs as `migrator`. The `app`, `identity`, and `platform` logins have no privilege to create tables in their own schema.

The ops task execution role already reads that secret. `aws_iam_role_policy.db_ops_execution` in `infra/regions/au/main.tf` allows `secretsmanager:GetSecretValue` on `module.rds[0].master_user_secret_arn` and on the three role secrets, and `kms:Decrypt` on the role-secrets key. The master secret uses the AWS-managed key, so it needs no IAM decrypt. The task role has no policy, and this program makes no AWS call. Nothing is added.

### Image contents

The Dockerfile copies `apps/api/dist` to `/app`, so `db-migrate.js` is emitted by the existing `tsc -p tsconfig.emit.json`. Test files are excluded by that config.

The migration SQL files and the journal are reached through `@community-hub/db`. `PRODUCT_FOLDER` in `migrate.ts` is `../drizzle` from the compiled file, which is `/app/node_modules/@community-hub/db/drizzle`. `packages/db/package.json` lists `drizzle` in `files`, next to `sql`. `pnpm deploy --prod --legacy` copies the `files` entries, and `sql/bootstrap.sql` already arrives that way (`image.test.ts` asserts it). The reviewer found the migration files present in an existing local image under `node_modules/@community-hub/db/drizzle` (nine files in that directory listing). So no Dockerfile change is expected. No test asserts it today, and the plan adds the assertion. If it fails on the `main` image, the fix is a Dockerfile `COPY` line.

Size: `packages/db/drizzle` is about 280 KB on disk, of which about 230 KB is `meta/*_snapshot.json`. The runner reads only `meta/_journal.json` and the `.sql` files. The snapshots ship because `files` names the directory. This spec does not narrow `files`. The 280 KB is text, adds no package, and does not change the vulnerability scan. `drizzle-orm` and `postgres` are production dependencies of `@community-hub/db` and are in the image now, because `index.js` exports `applyProductMigrations`. Nothing new is installed.

The container runs read-only with `/tmp` writable. The command writes no file.

### Environment

The same eight variables as `db-bootstrap.js`, all already in `aws_ecs_task_definition.db_ops`: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD_MASTER`, `PGPASSWORD_APP`, `PGPASSWORD_IDENTITY`, `PGPASSWORD_PLATFORM`. `PGHOST` is the RDS instance address. There is no pooler in `infra`, so the connection is direct, which the runner requires (advisory lock and `SET ROLE` are session state).

The program connects with `createDirectSql` and the image's RDS CA bundle. That factory is verify-full, and `rds.force_ssl` is 1. `createDirectSql` takes a `servername` but the command has no input for one: the server name is `PGHOST`. Reading the CA bundle is inside the guarded path (an unreadable bundle prints `env`, not a stack).

### Order with `db-bootstrap`

The runner calls `runBootstrap(sql)` itself, inside the lock, before `SET ROLE migrator`. That function creates any missing role and the `migrator` schema. It does not set a password. So if `db-migrate` ran first against an empty database, it would create `app`, `identity`, and `platform` with no password, apply all migrations, and exit 0. The service would then fail to log in until `db-bootstrap` ran. That is a silent wrong order.

Before the runner is called, the command checks that bootstrap has run and refuses if it has not:

1. As the master, read `pg_roles` for `migrator`. `migrator` is `NOLOGIN`, so it cannot be tested by a login. A missing row fails the check. This read is the master connection's first query.
2. For each of `app`, `identity`, and `platform`, open a direct connection with that role's password from the environment and run `select 1`. A refused login (`28P01` or `28000`) fails the check. The same SQLSTATE is returned for a role that does not exist, a role with no password, and a role with a different password. So `not_bootstrapped` also covers a wrong role password. The remedy is the same in every case: run `db-bootstrap`.

Either step failing exits 1 with `not_bootstrapped`. The runner is not called. Nothing is created. A login attempt that fails for any other reason is a `connect` failure (see below), not `not_bootstrapped`.

`db-bootstrap` is not re-run by the human between migrate runs. After the check passes, the runner runs `bootstrap.sql` again as the master. Every statement in it is idempotent. The first run on RDS is recorded in the runbook under `first-running-task` (exit 0), and `bootstrap.sql`, `bootstrap.ts`, and `migrate.ts` have not changed since 2026-10-04, before that run. The second execution of those statements on RDS has not been observed. The reviewer ran it twice on a stand-in (see Risks). The proof run will be the first on RDS.

### The connect stage

`createDirectSql` connects lazily. Nothing is sent when the factory returns. A wrong master password, a security-group block, a DNS failure, or a TLS name mismatch surfaces on the first query, not when the factory is called. (This is inferred from the `postgres` driver's behaviour, not from a test against RDS.)

So the `connect` stage is defined as everything up to and including the first successful query, which is the `pg_roles` read. A failure anywhere in it, whether the factory throws or the first query rejects, prints `connect`. When the failing error carries a SQLSTATE (for example `28P01` for a wrong master password), it prints `connect <SQLSTATE>`. TLS and network failures (a certificate name mismatch, a refused connection, a timeout) have no SQLSTATE. They print the bare word `connect`. A failed role login attempt that is not `28P01` or `28000` is also `connect`, with its SQLSTATE if it has one.

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

### How the applied tags are computed

`readMigrationFiles` returns `MigrationMeta` entries (`sql`, `hash`, `folderMillis`, `bitMask`) with no tag, so the returned tags are not computed from `MigrationMeta`. `applyProductMigrations` reads `meta/_journal.json` for the `tag` and `when` of each entry. Under the lock, in the `migrator` session, it reads the `created_at` values in `migrator.__drizzle_migrations` before calling Drizzle `migrate` (an empty set when the table does not exist, which the preflight already distinguishes with `to_regclass`) and again after it returns. `applied` is the journal tags whose `when` is in the second set and not in the first, in journal order. `total` is the number of journal entries. The before and after comparison reports what the database now says rather than re-deriving Drizzle's own rule. When `migrate` throws, nothing is returned and nothing is printed as applied.

### Idempotency and concurrency

A second run applies nothing. Step 4 passes, step 6 finds nothing newer than the newest applied `created_at`, and the command prints `done applied=0 total=8` and exits 0.

Two runs at the same time do not both apply. The second blocks at step 1 until the first releases the lock (it commits, or its connection closes). It then runs steps 2 to 6 against a journal that is now complete and applies nothing. The lock is the runner's own. This spec adds none.

The wait has no bound. If the first task hangs, the second waits. The human stops the first task, which closes its connection and releases the lock. See Decisions, item 6.

### Failure half-way

The pending set is one transaction. A failing statement rolls back every pending migration and every journal insert from that run. Migrations committed by an earlier run stay. There is no state in which `0004` is applied and `0005` is not, from one run.

What a failed run does leave: any role or schema created by `bootstrap.sql` (they commit before the transaction), and an empty `migrator.__drizzle_migrations` table if it did not exist (`CREATE TABLE IF NOT EXISTS` runs before the transaction). Both are harmless and are what a successful run would also have created. The session ends, so `SET ROLE` and the advisory lock are gone.

The failing migration is not identified. The owner's decision is that the SQLSTATE is the only evidence of which statement failed. With one transaction, no tag is printed on failure, because a tag would suggest that migration was the one that failed, and the runner does not know. The human reads the log stream, which has one word and, for a database error, a five-character SQLSTATE. The human fixes the cause and runs the command again. A re-run is safe because nothing from the failed run is applied. If the cause cannot be fixed inside the unpark window, the human re-parks. Re-parking destroys the staging database, which holds no data.

### Invocation, exit codes, output

The human runs the existing ops task definition (`aws_ecs_task_definition.db_ops`) as a one-off ECS task, as the runbook does for `db-bootstrap.js`. The command override is `["node", "/app/db-migrate.js"]`. `entryPoint` is not set. The task uses the task security group, the staging public subnet, and a public address. The image must be the one built from the `main` that contains this chunk.

| Result                                | Exit | Stdout                                                                            | Stderr                                                                   |
| ------------------------------------- | ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Applied some or all                   | 0    | One line `applied <tag>` per migration applied, then `done applied=<n> total=<m>` | empty                                                                    |
| Nothing to apply                      | 0    | `done applied=0 total=<m>`                                                        | empty                                                                    |
| Environment missing or malformed      | 1    | empty                                                                             | `env`                                                                    |
| Master connection failed              | 1    | empty                                                                             | `connect`, then ` <SQLSTATE>` when the failing error is a Postgres error |
| Roles missing or a role login refused | 1    | empty                                                                             | `not_bootstrapped`                                                       |
| Runner or migration failed            | 1    | empty                                                                             | `migrate`, then ` <SQLSTATE>` when the failing error is a Postgres error |

`<tag>` is a name from `meta/_journal.json`, for example `0003_complex_leech`. `total` is the number of journal entries in the image, 8 today. Every line ends in one newline. On success stderr is empty. On failure stdout is empty, so a partial list of tags is never printed for a run that rolled back.

A `migrate` failure from the runner's own checks (a hash mismatch, a journal entry older than an applied one, a lost session) is a plain `Error` with no SQLSTATE. It prints `migrate` alone. The human then needs the message. The message text is not printed (see Logging). A typed error that would let the runner's own checks say which one failed is not in this chunk (see Decisions, item 3).

### Logging

The command writes only the lines in the table. Stdout and stderr go to the log stream with prefix `db-ops` in the service log group.

It never writes a connection string, a host, a port, a database name, a user, a password, an ARN, a driver message, a stack, or SQL text. The master password goes only to `createDirectSql`. The three role passwords go only to the login checks.

How a caught error is reduced to a code:

- The SQLSTATE is read from `error.code`. When `error.code` is absent, it is read from `error.cause?.code`, one level only. Never deeper.
- drizzle-orm 0.45.2 wraps every failure from `migrate` in `DrizzleQueryError` (`drizzle-orm/pg-core/session.js`). That wrapper has no `code`. The SQLSTATE is on its `cause`. The reviewer confirmed this by running it against a stand-in Postgres. Errors thrown by the runner's own `postgres` calls (the advisory lock, `bootstrap.sql`, `SET ROLE`) carry `.code` at the top level.
- A code is accepted only when the error carrying it is a `PostgresError`, by `name === "PostgresError"` or by the presence of a `severity` property (presence only; its value is never read). The pattern `^[0-9A-Z]{5}$` alone is not enough, because it also matches Node errno codes such as `EPIPE`, `EPERM`, and `EBADF`. Those would otherwise print as if they were SQLSTATEs.
- Nothing else from the error is read. In particular `message` is never read, logged, or interpolated. The wrapper's `message` is `Failed query: <SQL> params: ...`, so it carries SQL text and bound parameters, and a Postgres error message can quote data. The wrapper's `query` and `params` properties are never read either.

Every await in the program sits inside a staged `try`/`catch`. That includes each role-login check and every `end()` call. A top-level `.catch` is the last backstop. It prints the stage word the program had reached, with no error text, and exits 1.

A migration tag is a file name from the repository. A SQLSTATE is a fixed code. Neither is personal data (§1 rule 5). No secret is in either (§1 rule 8).

### The service against an un-migrated or half-migrated database

Described from the code and from the reviewer's run. This chunk changes none of it.

- Startup does not check the database. `GET /health` opens no connection (`roadmap.md`, Open items). A service started against an empty database is healthy.
- A route that needs a table runs a query. Against a missing relation Postgres raises `42P01`. The sign-in and role routes map only their own domain errors (`statusFor` in `auth-routes.ts`, `AccessError` in `access-routes.ts`) and rethrow the rest. The kernel handler (`packages/kernel/src/request-handler.ts`) catches the thrown error and returns an empty 500. It writes one request log line (method, route pattern, status 500, duration, request id) and no error text. The reviewer reproduced this for a missing table. So the person running the service sees a 500 and no cause.
- The 400 branch in `apps/api/src/server.ts` is not reached by a route error. It is reached only when something throws outside the kernel handler: building the `Request`, a body-stream error, `writeResponse` failing, or the logger throwing.
- The missing error text in that request log line is a separate fix, in the no-spec branch `fix/2026-10-12-request-error-log`. It is not in this chunk.
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

The schema `migrator` is owned by `migrator`, and the journal table is owned by `migrator`. `bootstrap.sql` grants `CREATE` on the database to `migrator` and nothing on the `migrator` schema to anyone else. The default privileges in `0000_schemas.sql` cover only `app`, `identity`, and `platform`. So `app`, `identity`, `platform`, and `PUBLIC` have no `USAGE` on `migrator`. The plan adds a test that asserts this with `has_schema_privilege`.

The master login can read `migrator.__drizzle_migrations` without `SET ROLE`. `GRANT migrator TO current_user` in `bootstrap.sql` gives the master a membership with the inherit and set options, and the master has the default `INHERIT` attribute (the reviewer confirmed this by running it). The master is the operator's own login and is not one of the roles the test covers.

## Rules touched

Residency (§1 rule 1). The task, the database, and the logs are in `ap-southeast-2`. The command carries no personal data. It creates empty tables.

Tenancy (§1 rule 2). The command applies the migrations that create the `app` tables with `ENABLE` and `FORCE ROW LEVEL SECURITY`. It does not weaken any of them. Migrations run as `migrator`, the owner, so `FORCE` is what makes the policies apply to the owner. The plan's test checks that every `app` table has both flags set after the command. The command never sets `app.org_id` and never reads an `app` row.

Children (§1 rule 4). No new path. No row.

Secrets (§1 rule 8) and logs (§1 rule 5). See Logging. The master secret is not given to the service task. The execution role is unchanged.

Permissions and entitlements. None. No route, no event, no manifest key.

Retention and safeguarding. None.

## Contracts

| Contract                             | Value                                                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program                              | `/app/db-migrate.js`, run as `node /app/db-migrate.js` through an ECS command override. `ENTRYPOINT` stays empty.                                                    |
| Environment                          | The eight variables listed above. All already set in `aws_ecs_task_definition.db_ops`.                                                                               |
| Exit code                            | 0 on success or nothing to apply. 1 on any failure.                                                                                                                  |
| Stdout, stderr                       | Exactly the table in Behaviour. Nothing else.                                                                                                                        |
| Login                                | Master only. `migrator` stays `NOLOGIN`.                                                                                                                             |
| Journal record                       | `migrator.__drizzle_migrations`. No grant to any other role.                                                                                                         |
| `applyProductMigrations`             | Returns `{ applied: string[]; total: number }`, built as in "How the applied tags are computed". Same arguments and same effect. Existing callers ignore the result. |
| `runDbMigrate` (exported for tests)  | Takes `{ source, pem, connect }`, as `runDbBootstrap` does, except that `pem` is `string                                                                             | undefined`: `undefined`(an unreadable CA bundle) gives the stage word`env`, stderr `env\n`, exit 1. Returns `{ exitCode, stdout, stderr }`. The module's entry block is the only code that touches `process`. |
| Ops task definition, IAM, secrets    | Unchanged. The service task definition, its roles, and its secrets are unchanged.                                                                                    |
| API routes, events, ports            | None.                                                                                                                                                                |
| Website collections, islands, blocks | None.                                                                                                                                                                |

## Infra

No Terraform change is needed. I checked each part.

- The ops task definition already has the eight variables and the command is a runtime override.
- The execution role already reads the master secret and the three role secrets. The task role makes no AWS call.
- The security groups already allow the task to reach 5432 and the registry. The command uses the same network path as `db-bootstrap.js`.
- The image is built by the existing `publish` job. The Dockerfile is not expected to change. If the image assertion in Tests shows `drizzle/` is missing, the fix is one `COPY` line, which the plan then names.

This chunk therefore leaves staging parked, needs no apply, and adds no `*.tftest.hcl` case. The existing cell test for the ops task definition keeps passing.

## Cost

No new hourly or monthly resource. No Terraform change, so no NAT gateway, load balancer, interface endpoint, or other billed resource appears. The run is a one-off Fargate task on the existing ops task definition (256 CPU, 512 MB, ARM64), billed per second. It is part of the unpark window priced in the `staging-proof-run` draft. This chunk adds no figure to that window. The test container runs locally in Docker and costs nothing to operate.

## Risks

**RDS privileges (I cannot test this against RDS).** The existing tests run on Docker Postgres 17 as a superuser. The RDS master is a member of `rds_superuser`, which is not a superuser. This is what each statement needs, read from the files.

| Statement                                                                                                                                                                                              | Where                                                        | Needs                                                                    | Held after `db-bootstrap`                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CREATE ROLE`, `GRANT CREATE ON DATABASE`, `REVOKE ... FROM PUBLIC`, `GRANT migrator TO current_user`, `CREATE SCHEMA migrator AUTHORIZATION migrator`, `REVOKE CREATE ON SCHEMA public`, `ALTER ROLE` | `bootstrap.sql`, `bootstrap.ts`, run by the runner each time | `CREATEROLE`, database owner, `ADMIN` on `migrator`, `SET` on `migrator` | Yes. The same code exited 0 on RDS 17.9 in `first-running-task`. A repeat `GRANT migrator TO current_user` is a NOTICE, not an error (the reviewer observed this on the stand-in).                                                                          |
| `SET ROLE migrator`                                                                                                                                                                                    | runner                                                       | Membership of `migrator` with the `SET` option                           | Yes, on the evidence. `CREATE SCHEMA ... AUTHORIZATION migrator` needs the same `SET` option, and `first-running-task` ran that statement on RDS with exit 0. The reviewer's stand-in also ran `SET ROLE migrator` as a non-superuser master without error. |
| `CREATE SCHEMA app, identity, platform`                                                                                                                                                                | `0000`                                                       | `CREATE` on the database                                                 | Granted to `migrator` by `bootstrap.sql`.                                                                                                                                                                                                                   |
| `GRANT USAGE ON SCHEMA`, `ALTER DEFAULT PRIVILEGES FOR ROLE migrator`                                                                                                                                  | `0000`                                                       | Schema owner, and being `migrator` itself                                | Yes, `migrator` owns the schemas.                                                                                                                                                                                                                           |
| `CREATE TABLE`, `ALTER TABLE ... ENABLE` and `FORCE ROW LEVEL SECURITY`, `CREATE POLICY`, `CREATE INDEX`, foreign keys, `ADD` and `DROP CONSTRAINT`                                                    | `0001`, `0003` to `0007`                                     | Table owner; `REFERENCES` on parents                                     | Yes, `migrator` creates and owns every table.                                                                                                                                                                                                               |
| `REVOKE ... ON TABLE ... FROM app`                                                                                                                                                                     | `0002`, `0005`, `0007`                                       | Table owner                                                              | Yes.                                                                                                                                                                                                                                                        |
| `CREATE FUNCTION` (`plpgsql`), `CREATE TRIGGER`, `REVOKE ALL` and `GRANT EXECUTE ON FUNCTION`                                                                                                          | `0002`                                                       | `USAGE` on `plpgsql`, table owner, function owner                        | Yes. `plpgsql` usage is granted to `PUBLIC` by default.                                                                                                                                                                                                     |
| `SET LOCAL lock_timeout = '5s'`                                                                                                                                                                        | `0001`                                                       | Nothing                                                                  | Yes.                                                                                                                                                                                                                                                        |

No migration creates an extension, creates a role, changes an owner, uses `CREATE INDEX CONCURRENTLY`, or needs a superuser. `sha256`, `uuid_send`, and `int4send` are built in.

What the reviewer observed on a stand-in: a throwaway Postgres 17 with a non-superuser `CREATEROLE CREATEDB` master. `bootstrap.sql` ran twice and all eight migrations applied with no failing statement. The stand-in is not RDS. It differs in these ways: the master has no `rds_superuser` privilege set; there is no RDS-managed master secret; there is no `rds.force_ssl`; the connection was plaintext, not verify-full; and the server is a newer 17.x minor than RDS 17.9. The container this spec adds (Tests, "Non-superuser TLS container") closes the plaintext gap and leaves the other differences.

What could still fail on RDS: anything about privileges or default privileges that the `rds_superuser` set changes relative to a plain `CREATEROLE` master. If one fails, the transaction has not started, nothing is applied, and the stderr is `migrate <SQLSTATE>`. The cost of finding out is one unpark task run.

**A wrong order silently succeeds.** Fixed by the bootstrap check. Without it, roles with no password would exist and the service would not log in.

**A failing migration is not named.** With one transaction, the command cannot say which migration failed and prints no tag on failure. The SQLSTATE is the only evidence of which statement failed (owner's decision). The human learns the cause from the SQLSTATE and from the migration files. For a plain `Error` from the runner's own checks (hash mismatch, ordering, lost session), there is no SQLSTATE at all and the output is `migrate` alone.

**An unbounded lock wait.** A hung first run blocks a second. Mitigation: the human stops the first task. See Decisions, item 6.

**A driver message in the log.** A Postgres error can quote data, and the Drizzle wrapper's message carries SQL and bound parameters. The command reads only a code from a `PostgresError`. The must-fail tests plant markers in the driver error and in the wrapper.

**A non-Postgres error read as a SQLSTATE.** A Node errno code such as `EPIPE` matches the SQLSTATE pattern. Mitigation: a code is accepted only from a `PostgresError`. A unit test plants `EPIPE` and expects the bare stage word.

**An uncaught exception printing a stack.** An await outside the staged `try`/`catch` would print a stack with a host, a path, or a message. Mitigation: every await is inside the staged `try`/`catch`, and a top-level `.catch` prints a stage word only. A must-fail unit test covers a role-login check that throws.

**Role left set on the session.** If `SET ROLE migrator` were not undone, later statements on that connection would run as `migrator`. The runner resets it in `finally`, and the command closes the connection right after. A named test pins the reset.

**A journal older than the database.** An image older than the database fails the preflight with `migrate`. That is correct and the human gets no detail beyond the word.

**Image size and scan.** Negligible. See Image contents.

## Out-of-band

- The second fresh-context review is required. This chunk touches the database, tenancy (it applies the RLS migrations), and the master login. The owner's assistant starts it when the pull request opens. The pull request's second-review line stays open until it is written. The review that checked this spec does not count.
- No new subprocessor, no legal question, no architecture change, no ADR. §23.2 already says migrations run before deployment. This chunk supplies a way to run them on staging by hand.
- The missing error text in the service's request log is fixed in a separate no-spec branch, `fix/2026-10-12-request-error-log`, not here.
- No password, account id, hostname, registry host, ARN, or email in this spec, the plan, the tests, or the runbook.
- The staging-proof-run spec stays draft until this is on `main` and its `publish` job has passed. It is being corrected separately, including its statement about how a failing migration is identified. This spec does not edit it.

## Decisions (owner, 2026-10-12)

1. **Bootstrap check.** A `pg_roles` read for `migrator`, and a real login attempt for each of `app`, `identity`, and `platform`.
2. **Failure output.** The stage word plus the five-character SQLSTATE, read as in Logging.
3. **Success output.** Tags and counts. `applyProductMigrations` returns a report built as in "How the applied tags are computed". No typed error in this chunk.
4. **Test fixture for the RDS gap.** Add the throwaway non-superuser TLS container. It is regression coverage for the path RDS uses, and it hosts the `not_bootstrapped` cases. Tests run in-process.
5. **Roadmap.** The new row is the last Phase 0 row.
6. **Lock wait.** Left unbounded. A bound is possible (`lock_timeout` applies to advisory-lock waits and could live in `migrate.ts`), but it is an extra `packages/db` change. A human runs this one-off, and stopping the task releases the lock.
7. **Test lines corrected after approval.** Three test lines were corrected after this spec was approved, on the plan review's evidence: `runDbMigrate` takes `pem: string | undefined` so the unreadable-bundle case is testable; the concurrency test starts two runs behind the held lock and expects exactly one to apply; and in the non-superuser TLS cases `runDbBootstrap` runs before case 3 and case 5 uses the correct passwords.

## Tests

Each test uses a planted marker or a synthetic value. No test uses a real account id, hostname, or password.

**Unit, `apps/api/src/db-migrate.test.ts`** (fake driver, in the style of `db-bootstrap.test.ts`). Planted driver errors are shaped like the real ones. A migrate failure is `DrizzleQueryError`-shaped: an `Error` whose `message` is `Failed query: <SQL> params: <values>`, with `code` undefined and a `cause` that is a `PostgresError`-shaped error (`name`, `severity`, `code`). A runner-level failure is a flat `PostgresError`-shaped error with `code`. A flat error with only a `code` is not a faithful plant for the migrate path.

- Each env variable missing, empty, or a bad port: stdout empty, stderr `env\n`, exit 1. An unreadable CA bundle: `env\n`.
- The connection factory throws synchronously: stderr `connect\n`.
- The factory returns, and the first query (the `pg_roles` read) rejects with a `PostgresError`-shaped `28P01`: stderr `connect 28P01\n`. With a TLS-style error (no code) or an `EPIPE` errno code: stderr `connect\n`.
- The role query returns no `migrator` row: stderr `not_bootstrapped\n`, and the runner is never called.
- A role login rejects with `28P01` or `28000`: stderr `not_bootstrapped\n`. A rejection with another `PostgresError` code: `connect <code>\n`. A rejection with no code: `connect\n`.
- Role-login `connect` throws a non-Postgres error whose message and a property carry a marker: stderr is `connect\n`, and the marker appears nowhere in stdout or stderr. Source change that must fail it: move the role-login check outside the staged `try`/`catch`.
- The runner rejects with a `DrizzleQueryError`-shaped error whose `message` carries a planted password, a host name, a connection string, and SQL text, and whose `cause` is a `PostgresError`-shaped error with `code` `42501`: stderr is exactly `migrate 42501\n`. The same wrapper with a `cause` that is not a `PostgresError` but has `code` `EPIPE`: `migrate\n`. A code two levels down: `migrate\n`. A flat `PostgresError`-shaped error with `code` `42501`: `migrate 42501\n`. A plain `Error` with no code: `migrate\n`.
- The log-content test: for every case above, `stdout + stderr` matches one of the allowed forms, `^(applied [0-9]{4}_[a-z0-9_]+\n)*done applied=[0-9]+ total=[0-9]+\n$`, `^(env|not_bootstrapped)\n$`, or `^(connect|migrate)( [0-9A-Z]{5})?\n$`, and contains none of the planted values. The same planted values do not appear in any SQL text handed to the fake driver.
- The master password is passed only to the connection factory call for the master, and each role password only to its own login check. A spy on the factory asserts that.

Source changes that must fail the log-content test: write `error.message` or `String(error)` into stderr; read the code from the wrapper without the `PostgresError` check (the `EPIPE` plant then prints a code).

**Security pins** (AGENTS.md §4, the plan rule for security-relevant settings). The plan lists each test below with its failing source change. The implementer runs the change once, sees the test fail, restores the source, and reports the failure. The weakened tree is never committed.

| Setting                                    | Test                                                                                                                                                                                                                                                                            | Source change that must fail it                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| TLS verify-full to the master              | Unit: the factory spy receives `ca` equal to the injected PEM, and the host from `PGHOST`, for the master and for each role login. `createDirectSql` supplies verify-full.                                                                                                      | Pass an empty `ca` (or omit it) when the command calls the factory.                                      |
| Secrets stay out of the output             | The log-content test above.                                                                                                                                                                                                                                                     | Write `error.message` or `String(error)` to stderr.                                                      |
| Role and lock released after a failure     | `packages/db` migrate integration test, named `applyProductMigrations resets the role and frees the lock after a failure`: on a kept handle after a failed run, `current_user` is not `migrator`, and a second connection's `pg_try_advisory_lock(MIGRATION_LOCK_ID)` succeeds. | Delete `reset role` from `finally` in `migrate.ts` (role assertion); delete the unlock (lock assertion). |
| Migration record closed to other roles     | Integration: `has_schema_privilege` is false for `app`, `identity`, `platform`, and `PUBLIC` on `migrator`.                                                                                                                                                                     | Add `GRANT USAGE ON SCHEMA migrator TO PUBLIC` to `bootstrap.sql`.                                       |
| `FORCE ROW LEVEL SECURITY` on `app` tables | Integration: every `app` table has `relrowsecurity` and `relforcerowsecurity` true after the command.                                                                                                                                                                           | Edit the real migration file under `packages/db/drizzle`: remove one `FORCE ROW LEVEL SECURITY` line.    |
| Bootstrap check before the runner          | Integration (non-superuser container): no bootstrap gives exit 1, `not_bootstrapped`, and nothing created.                                                                                                                                                                      | Delete the bootstrap check, so the runner creates roles and applies.                                     |

The `FORCE ROW LEVEL SECURITY` mutation edits the real migration file because the migrations folder is fixed relative to `migrate.js`; a copy cannot be substituted. It is run once, the test is seen to fail, the file is restored, and it is never committed.

**Where the integration cases run.** Roles are cluster-global. `packages/db/test/global-setup.ts` bootstraps the roles and sets their passwords once for the whole shared cluster, and other suites rely on them. So a case that needs "no roles exist" or "roles exist with no password" cannot be built there, and a test must not drop roles. Two hosts, both in-process:

- **Shared container** (plaintext, and its login is a superuser). Cases run on a fresh database the test creates. The test calls `runDbMigrate({ pem, connect, source })` with an injected plaintext factory that adapts the target to a plaintext connection. The role-login checks use the cluster passwords that `global-setup.ts` records. It hosts the cases that need roles to exist: success and RLS flags, the second run, the closed record, concurrency, and failure half-way. It does not exercise TLS, the `ADMIN` and `SET` membership rules, or a non-superuser master.
- **Non-superuser TLS container** (see below). It hosts the `not_bootstrapped` cases and the positive case.

**Integration on the shared container, `apps/api/src/db-migrate.integration.test.ts`:**

- After the roles exist (they do on this cluster): exit 0, stdout lists the eight tags in journal order and `done applied=8 total=8`. `migrator.__drizzle_migrations` has eight rows. Every `app` table has `relrowsecurity` and `relforcerowsecurity` true. Schemas `app`, `identity`, `platform` are owned by `migrator`.
- Second run: exit 0, `done applied=0 total=8`, still eight rows, same `hash` and `created_at` values.
- The record is closed: `has_schema_privilege` is false for `app`, `identity`, `platform`, and `PUBLIC` on `migrator`.
- Concurrency, not timing-based: a second connection takes `pg_advisory_lock(MIGRATION_LOCK_ID)` and holds it. The test starts the command twice in-process. The test then polls `pg_locks` until two rows exist with `locktype = 'advisory'`, `classid = 0`, `objid` equal to the runner's key, `granted = false`, and `database` equal to the test database's oid. The `database` filter matters because advisory locks are per database and the cluster is shared. That is a state, not a delay. The reviewer observed, with one run, exactly one waiter, no journal table while it waited, and success after the release. While the lock is held, the test asserts `migrator.__drizzle_migrations` does not exist or has no rows. Two runs started while the lock is held wait behind it; after the release exactly one applies and the other applies 0. The key is taken from `MIGRATION_LOCK_ID` in `packages/db/src/migrate.ts`, not typed into the test. That constant is not exported from the package today, so the plan either exports it or imports it by relative path in the test. Source change that must fail it: remove `pg_advisory_lock` from the runner, since the command would then apply while the lock is held.
- Failure half-way: before the run, the test creates schema `app` and a table `app.outbox` as `migrator`, so `0001` fails on `CREATE TABLE` (`42P07`) after `0000` has run. Exit 1, stderr `migrate 42P07`. After: `identity` and `platform` schemas do not exist, the journal has zero rows, and a re-run after the test drops the stray table applies all eight. The mutation "run migration statements outside the single transaction" is a change inside `drizzle-orm`, not repo code, so there is no repo source change that fails this test. The real guard is the pinned `drizzle-orm` version (`0.45.2`, an exact pin in `packages/db/package.json`). The test pins the observable behaviour, so a Drizzle upgrade that changes it fails here.
- The role-reset test in the security pins table lives in the existing `packages/db/test/migrate.integration.test.ts`, which also gains an assertion that `applyProductMigrations` returns the eight tags in journal order on a fresh database and `applied: []` with `total: 8` on the second run.

**Non-superuser TLS container** (apps/api integration, in the style of `packages/db/test/tls.integration.test.ts`):

- One throwaway container started from `packages/db/test/postgres-tls-entrypoint.sh`, with a server certificate whose name is a fixed test name. The certificate generation is extracted from `tls.integration.test.ts` into a shared helper under `packages/db/test`, and that test is changed to use it. It is not copied.
- The image's superuser creates the master: a non-superuser with `CREATEROLE` and `CREATEDB`, with no `rds_superuser`, and a database it owns. This is a stand-in for the RDS master, not RDS.
- `IMAGE_CERT_PATH` in `apps/api/src/env.ts` is a hard-coded constant with no override, and `createDirectSql` throws if `PGHOST` is an IP address and no `servername` is given. The command has no `servername` input. So these tests do not spawn `node /app/db-migrate.js`. They call `runDbMigrate({ pem, connect, source })` in-process, with the test's CA as `pem` and a `connect` wrapper that adds the certificate's name as `servername`, so `createDirectSql` still verifies the certificate. The compiled program as a child process is covered by the image test (below).
- Cases, in one file, in order, on this one cluster: (1) the empty cluster: exit 1, `not_bootstrapped`, and no role, no schema, and no table was created; (2) roles created by `runBootstrap` only, with no passwords: exit 1, `not_bootstrapped`, and no `app`, `identity`, or `platform` schema or table exists afterwards; (3) after `runDbBootstrap` has set the three passwords, a wrong password for one role: exit 1, `not_bootstrapped`; (4) a wrong master password: exit 1, `connect 28P01`; (5) correct passwords: exit 0, `done applied=8 total=8`, and the second execution of `bootstrap.sql` (it runs inside the runner) succeeded as a non-superuser; (6) a second run: `done applied=0 total=8`.
- Source change that must fail case 1: delete the bootstrap check.

**Image, gated by `RUN_IMAGE_TESTS=1`, in `apps/api/src/image.test.ts`:**

- `/app/db-migrate.js`, `/app/node_modules/@community-hub/db/drizzle/meta/_journal.json`, and every `.sql` file the journal names exist. The walk test that forbids `.ts`, test files, and `/test` directories under `node_modules/@community-hub` still passes.
- `docker run <image> node /app/db-migrate.js`, with no `--entrypoint` and no environment: exit 1, stdout empty, stderr `env\n`.
- `docker run <image>` with no command still starts the server. That test exists.

**Existing suites:** the `packages/db` migrate tests still pass with the return-value change. The Terraform tests are untouched.

## Rollback

Revert the commit. The command disappears from the next image. The image already published stays in the registry and is harmless, since nothing runs it unless a human overrides the command.

There is no down-migration and none is added. A migration applied to staging is undone by the re-park, which destroys the staging database. That database holds no data. A bad migration on a database that holds data is fixed forward, as AGENTS.md §7 says. That is a production concern and is out of this spec.

## Catalogue

The last commit on the branch updates `docs/roadmap.md` and the repository-state line in `AGENTS.md`. The new Phase 0 row is `db-migrate-command`. It is appended as the last Phase 0 row, after `service-image-runtime-base`, and it is **done**. Phase 0 goes from 24 rows (23 done, 1 superseded, 0 not started) to 25 rows: 24 done, 1 superseded, 0 not started. The plan recomputes these counts against `main` when it is written, because `staging-proof-run` also adds a Phase 0 row. The snapshot's last shipped chunk is `db-migrate-command`. The next chunk stays as the owner sets it. The roadmap open item "This image has not run on Fargate" is left for the proof run to replace.
