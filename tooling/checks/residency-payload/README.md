# residency-payload checker

Provisional Stage 1 check for non-negotiables 1, 2 and 7: queue and workflow payloads must follow **IDs in, status out** (architecture §7.3 rule 2, §18). Personal data such as names and email addresses must not appear in messages consumed by global or unregionalised Workers.

## Input contract (provisional)

Until `apps/jobs` and formal payload schemas exist, the checker reads **`.json` files** under these paths relative to the scan root:

- `apps/jobs/queue-payloads/**`
- `apps/jobs/workflow-payloads/**`

Self-tests use mini-trees (for example `fixtures/payload-with-name/apps/jobs/queue-payloads/payload-with-name.json`) so they exercise the same `check(root)` entry point as CI.

When real job definitions land, these paths and the parser are expected to change; the must-fail fixtures in `fixtures/` are the durable contract.

## Rules

For each payload JSON file, recursively inspect object keys. If any key is `name` or `email`, the check fails. Nested objects and arrays are scanned.

Allowed payloads contain identifiers (`orgId`, `communityId`, entity ids), job types, versions and status fields only.

## API

`check(root?: string)` — defaults to `process.cwd()`. Returns `{ ok, violations, payloadFileCount, notice? }`. When no payload JSON files are found, `notice` explains that explicitly so an empty repository is not a silent pass in CI (fixtures in `selftest.ts` still prove the rules fire).
