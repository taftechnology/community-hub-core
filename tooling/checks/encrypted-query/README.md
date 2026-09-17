# encrypted-query checker

Provisional Stage 1 check for non-negotiable 4 and architecture §12.2.1: columns stored with field encryption (`confidential`, `restricted`) must not appear in SQL `WHERE`, `ORDER BY`, `GROUP BY`, or aggregates.

## Input contract (provisional)

Until `packages/db` exists, the checker reads:

1. **Column classification map** — `packages/db/column-classifications.json` relative to the scan root. Keys are `schema.table.column` (for example `app.donations.donor_note`); values are architecture §12.1 class names.
2. **Query SQL** — `.sql` files under `packages/db/queries/**`.

Self-tests use mini-trees (for example `fixtures/where-encrypted/packages/db/queries/where-encrypted.sql`) so they exercise the same `check(root)` entry point as CI.

When `packages/db` lands, these paths and the parser are expected to change; the must-fail fixtures in `fixtures/` are the durable contract.

## Rules

For each query SQL file, resolve column references in:

- `WHERE` (left-hand side of comparisons)
- `ORDER BY` and `GROUP BY` lists
- `SUM`, `COUNT`, `AVG`, `MIN`, `MAX` arguments (except `COUNT(*)`)

If the resolved column’s class is `confidential` or `restricted`, the check fails. Classes such as `confidential-queryable` and `confidential-blind` are allowed — they are not field-encrypted for queryability purposes.

## API

`check(root?: string)` — defaults to `process.cwd()`. Returns `{ ok, violations, queryFileCount, notice? }`. When no query SQL files are found, `notice` explains that explicitly so an empty repository is not a silent pass in CI (fixtures in `selftest.ts` still prove the rules fire).
