# sql-session-ban checker

Stage 1 check: tenant scope and role switching must not use session-level SQL, interpolated `SET LOCAL`, `PASSWORD` in shipped SQL, or `SET ROLE` outside the migrator runner.

## Input contract

Relative to the scan root:

- SQL: `packages/db/sql/**/*.sql`, `packages/db/drizzle/**/*.sql`, `packages/db/drizzle-test/**/*.sql`
- TypeScript: `packages/*/src/**/*.ts`, `apps/*/src/**/*.ts`, `modules/**/*.ts`, excluding `**/*.test.ts` and `test/` directories
- Not scanned: `packages/db/test/` (integration tests may demonstrate bleed with `set_config(..., false)` and `SET ROLE migrator`)

`//` / `/* */` comments are stripped from TypeScript, and `--` / `/* */` from SQL, before matching.

## Rules

| Pattern                                                                                                                                   | Allowed                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `PASSWORD`                                                                                                                                | nowhere in SQL trees                                              |
| `SET` of `app.*` (`=` or `TO`, bare or `"app".`)                                                                                          | nowhere in scanned files                                          |
| `SET SESSION` / `set_config(..., false)`                                                                                                  | nowhere in scanned files                                          |
| `RESET` of `app.*`                                                                                                                        | nowhere                                                           |
| `SET ROLE` / `set_config('role', …)`                                                                                                      | only `packages/db/src/migrate.ts`                                 |
| Plain session `SET <name> =` / `SET <name> TO` as the first word of a statement, inside TypeScript strings/templates (and SQL statements) | only `packages/db/src/migrate.ts`                                 |
| `SET SESSION AUTHORIZATION`                                                                                                               | nowhere                                                           |
| `SET LOCAL lock_timeout` / `SET LOCAL statement_timeout` (`=` or `TO`)                                                                    | only `packages/db/drizzle/**/*.sql` and `packages/db/drizzle-test/**/*.sql` |
| `SET LOCAL` of any other GUC                                                                                                              | nowhere (`withAppTransaction` uses bound `set_config(..., true)`)           |

Migration timeout exception (path + statement):

| Statement                                                                | Where                                                                 | Result  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ------- |
| `SET LOCAL lock_timeout = …` / `SET LOCAL statement_timeout = …`         | `packages/db/drizzle/**/*.sql`, `packages/db/drizzle-test/**/*.sql`   | allowed |
| Same `SET LOCAL`                                                         | `packages/db/src/**` or any other scanned TS/SQL                      | fail    |
| `SET LOCAL` of any other GUC (e.g. `work_mem`)                           | migration SQL                                                         | fail    |
| Session `SET lock_timeout` (no `LOCAL`)                                  | anywhere scanned                                                      | fail    |

## API

`check(root?: string)` — defaults to `process.cwd()`. Returns `{ ok, violations, scannedFileCount }`.
