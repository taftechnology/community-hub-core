# residency-cell checker

Stage 1 check (task 3): residency catalog cells must match Terraform AWS regions under `infra/regions/<id>/`. Task 4 adds the global Worker import graph.

## Input contract

Relative to the scan root:

- Catalog: `packages/residency/src/catalog.json` (read from disk; do not import `@community-hub/residency`)
- Terraform cell roots: `infra/regions/<id>/` when `backend/` or `env/` exists
- Wrangler apps: `apps/*/wrangler.json` or `wrangler.jsonc`

Self-tests use mini-trees under `fixtures/` calling the same `check(root)` entry point as CI will use once wired.

## Rules

| Finding                                                                                  | Result                     |
| ---------------------------------------------------------------------------------------- | -------------------------- |
| Enabled catalog cell with no matching Terraform root                                     | fail                       |
| Enabled cell root missing `env/*.tfvars` or `backend/*.hcl`                              | fail                       |
| Catalog `awsRegion` ≠ any tfvars `aws_region` or backend `region`                        | fail                       |
| tfvars `aws_region` values disagree, or backends disagree, or tfvars vs backend disagree | fail                       |
| Terraform root with no catalog key                                                       | fail                       |
| Disabled cell with or without a Terraform root                                           | pass                       |
| Zero Terraform roots, zero enabled cells, or zero Wrangler apps                          | notice **and** `ok: false` |
| Missing or invalid catalog JSON                                                          | fail (no notice)           |

## API

`check(root?: string)` — defaults to `process.cwd()`. Returns `{ ok, violations, notice? }`.
