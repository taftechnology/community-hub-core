# sql-session-ban checker

Stage 1 check: tenant scope and role switching in `packages/db` must not use session-level SQL, interpolated `SET LOCAL`, `PASSWORD` in shipped SQL, or `SET ROLE` outside the migrator runner.

## Input contract

Relative to the scan root:

- SQL: `packages/db/sql/**/*.sql`, `packages/db/drizzle/**/*.sql`, `packages/db/drizzle-test/**/*.sql`
- TypeScript: `packages/db/src/**/*.ts` excluding `**/*.test.ts`
- Not scanned: `packages/db/test/` (integration tests may demonstrate bleed with `set_config(..., false)` and `SET ROLE migrator`)

`//` / `/* */` comments are stripped from TypeScript, and `--` / `/* */` from SQL, before matching.

## Rules

| Pattern | Allowed |
| --- | --- |
| `PASSWORD` | nowhere in SQL trees |
| `SET SESSION` / `set_config(..., false)` | nowhere in scanned files |
| `RESET` of `app.*` | nowhere |
| `SET ROLE` / `set_config('role', …)` | only `packages/db/src/migrate.ts` |
| `SET SESSION AUTHORIZATION` | nowhere |
| `SET LOCAL` | nowhere (`withAppTransaction` uses bound `set_config(..., true)`) |

## API

`check(root?: string)` — defaults to `process.cwd()`. Returns `{ ok, violations, scannedFileCount }`.
