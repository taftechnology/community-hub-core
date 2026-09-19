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
| `SET LOCAL`                                                                                                                               | nowhere (`withAppTransaction` uses bound `set_config(..., true)`) |

## API

`check(root?: string)` — defaults to `process.cwd()`. Returns `{ ok, violations, scannedFileCount }`.
