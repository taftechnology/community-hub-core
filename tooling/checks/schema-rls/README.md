# schema-rls checker

Stage 1 check for non-negotiable 2: every `app`-schema table must define `org_id`, row-level security, and `FORCE ROW LEVEL SECURITY`.

## Input contract

The checker reads **`.sql` files** under these paths relative to the scan root:

- `packages/db/drizzle/**`
- `packages/db/drizzle-test/**`

Self-tests use mini-trees (for example `fixtures/no-org-id/packages/db/drizzle/no-org-id.sql`) so they exercise the same `check(root)` entry point as CI.

## Rules

For each `CREATE TABLE app.<name>` (quoted identifiers allowed):

1. The column list must include `org_id`.
2. The file must contain `ALTER TABLE app.<name> FORCE ROW LEVEL SECURITY` (same table name, quoted form allowed).

`identity` and `platform` schema tables are ignored.

## API

`check(root?: string)` — defaults to `process.cwd()`. Returns `{ ok, violations, appTableCount, notice? }`. When no app tables are found, `notice` explains that explicitly so an empty tree is not a silent pass in CI (fixtures in `selftest.ts` still prove the rules fire).
