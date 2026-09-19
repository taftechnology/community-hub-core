# ADR 0004: Four roles and migrator object ownership

- Status: accepted
- Date: 2026-09-18
- Spec: `docs/specs/2026-09-18-packages-db.md`

## Context

Application tables need row-level security that the table owner cannot bypass (`FORCE ROW LEVEL SECURITY`). Superusers bypass RLS even with `FORCE`. If CI (or production) creates objects as a superuser, isolation tests pass for the wrong reason and production ownership diverges.

Roles are cluster-wide. Putting `CREATE ROLE` in a per-database, forward-only journal fails on the second database in the same cluster and cannot run as `NOLOGIN` `migrator`. `LOGIN` roles need passwords; a password in a committed migration is the Hyperdrive credential.

## Decision

- Four roles by **privilege**, not one role per schema: `migrator` (`NOLOGIN`, DDL), `app`, `identity`, `platform` (LOGIN, DML on their schema only, no `BYPASSRLS`).
- A privileged, idempotent, never-destructive **bootstrap** (CI: Docker superuser; production: RDS master) creates the roles without passwords, schema `migrator` owned by `migrator`, `GRANT migrator TO <runner login>`, `GRANT CREATE ON DATABASE … TO migrator`, and `REVOKE TEMPORARY ON DATABASE … FROM PUBLIC`. It runs before every journal apply, after an advisory lock taken as the privileged login.
- Journaled DDL runs as `migrator` via `SET ROLE` on a **direct, unpooled** connection. Runtime code picks a login credential and never `SET ROLE`.
- Passwords are set with a client-computed SCRAM-SHA-256 verifier, never a plaintext `PASSWORD` clause in SQL this package ships.

## Consequences

- Every `app` table is owned by `migrator`, so `FORCE RLS` applies to the owner. CI object ownership matches production.
- Adding a role later is an edit to the bootstrap script, not a journaled `CREATE ROLE`.
- Bootstrap **asserts** on every run that none of the four roles has `SUPERUSER`, `BYPASSRLS`, `CREATEROLE` or `CREATEDB`, and that `migrator` cannot log in. It `ALTER ROLE`s those attributes when the privileged login is allowed to (Docker superuser can clear `BYPASSRLS`/`SUPERUSER`; the RDS master cannot, so leftover `BYPASSRLS` fails the apply).
- Identity and platform Hyperdrive configurations remain a later Terraform chunk; this decision only creates the LOGIN roles.

## Alternatives rejected

- **Superuser-owned tables in CI.** RLS tests would not apply to the owner; production would differ.
- **`CREATE ROLE` in the Drizzle journal.** Cluster-wide, races the first apply, cannot run as `migrator`.
- **Plaintext `ALTER ROLE … PASSWORD` in committed SQL.** Secret in git; the same credential Hyperdrive uses.
