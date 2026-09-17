# Spec: Monorepo skeleton

Slug: `monorepo-skeleton`
Status: approved (2026-09-17, Abdus Salam)
Reviewed-by: Claude Opus 5 (reviewer agent), 2026-09-17 — no blocking findings
Architecture refs: §7.2, §7.3 rule 1, §8.1, §8.3, §19.1, §23.2, §25 Phase 0; D1; ADR 0001; AGENTS.md §1, §8, §10

## Problem

The repository is two markdown files. Nothing can be linted, typechecked, tested or deployed. Later Phase 0 chunks (db, crypto, Terraform, `packages/ui`) have no workspace, no CI graph and no Worker they can attach to. A first deploy that waits for `apps/api` would also be the first chunk that handles personal data.

## Scope

**In**

- pnpm workspaces + Turborepo at the repo root (this repository _is_ the monorepo; the `community-hub/` name in architecture §8.1 is the product, not a nested folder).
- TypeScript project references, format, lint, Vitest.
- GitHub Actions for AGENTS.md §10 Stages 1–3, scoped to what this chunk can honestly run (see Behaviour). Stage 4 is out (see Out).
- `packages/kernel` — one export that `apps/gateway` actually imports (proves the workspace graph, not the presence of folders).
- `packages/observability` — the only logger; used by the gateway so the no-personal-data logging rule exists before anything else logs.
- `apps/gateway` — a global Worker with a health route. `workers_dev = false`, `preview_urls = true`. Class declared in `worker.meta.json`.
- CI checks that cannot yet see real schema or queues, each shipped with a **fixture that must fail**.
- `docs/adr/0001-preview-urls-on-global-workers.md`.
- Architecture and AGENTS.md updates in this PR: preview-URL split; `tooling/` on the tree; Stage 3 preview wording; CI checks land with their first real input **and** a must-fail fixture (never stubbed always-green).

**Out** (explicitly)

- Tenant routing, hostname lookup, KV, D1, login discovery.
- `apps/api`, `exec`, `jobs`, `webhooks`, admin, portal, mobile, ops-console.
- Hyperdrive, Postgres, RLS policies on real tables, KMS, migrations, `packages/db`, `packages/crypto`, `packages/residency`.
- Terraform, Cloudflare account bootstrapping as code, Regional Services hostnames.
- `packages/ui` / `packages/ui-native`, modules, adapters, OpenAPI, entitlements catalogue.
- Full kernel (DI, outbox, `defineModule`, request context). One import is enough.
- Logpush, audit log, product usage facts.
- **Stage 4.** Merge to `main` does not migrate, does not deploy `staging-au` or production, and does not run production smoke tests. There is no regional cell yet. Release-to-staging waits for a later spec that has something regional to deploy.

## Behaviour

### Workspace

- Node **24** LTS (Active, Krypton as of 2026-09-17; Node 22 is maintenance). pnpm 10. TypeScript strict. Versions pinned in `package.json` / `packageManager` and in CI `node-version`.
- `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm check:boundaries` run at the root and succeed on this chunk's packages.
- Gateway depends on `@community-hub/kernel` and `@community-hub/observability`. Removing either import fails typecheck. Folders that are not packages are not created.
- Gateway tests run with `@cloudflare/vitest-pool-workers` so the Worker test runner exists before `apps/api`. Kernel and observability stay on plain Vitest.

### Gateway

- `GET /health` returns `200` and the JSON body produced by the kernel export (see Contracts).
- Any other path returns `404` with no body that looks like a stack trace or internals.
- The Worker logs the request via `packages/observability` (method, path, status, duration, request id). It does not log query strings, headers or bodies.
- Wrangler config is explicit: `workers_dev = false`, `preview_urls = true`. CI asserts those values; it does not assert a Wrangler version number. (Wrangler is pinned in the lockfile like any other dependency.)
- The Worker is deployable: CI Stage 3 always dry-runs the Wrangler deploy. Live preview (`versions upload` + PR comment of the `*.workers.dev` preview URL) is required for merge. Missing GitHub secrets fail the job; they do not skip green. Provisioning those secrets is out-of-band for the human before this PR can merge.

### Preview URLs (this chunk decides it; ADR 0001)

Preview URLs are hosted only on `workers.dev`. Regional Services does not cover `*.workers.dev`. Default is `preview_urls = workers_dev`; with `workers_dev = false`, previews are off unless opted in.

| Worker class (`worker.meta.json`)                                 | When it exists        | `workers_dev` | `preview_urls` | How it is verified                                                                          |
| ----------------------------------------------------------------- | --------------------- | ------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `global-no-pii` (`gateway`, later `control-plane`, `ops-console`) | this chunk: `gateway` | `false`       | `true`         | Per-PR preview URL                                                                          |
| `regional` (`api`, `exec`, `jobs`, `webhooks`, …)                 | later specs           | `false`       | `false`        | `staging-au` or a preview **custom hostname** under Regional Services — never `workers.dev` |

CI reads `apps/<name>/worker.meta.json` (see Contracts). It fails if:

- `workers_dev` is missing or not `false`
- `preview_urls` is omitted (no implicit default)
- class is `global-no-pii` and `preview_urls` is not `true`
- class is `regional` and `preview_urls` is not `false`
- class is missing or not one of the two values above

### Logger

- **Compile time:** the logger API accepts only a declared field type (method, path, status, duration, request id, and similarly explicit fields later). `Record<string, unknown>` and untyped rest objects do not typecheck.
- **Runtime:** unknown keys and personal-data-tagged keys are **dropped**, never thrown. Each drop increments a counter (so a mis-tag is visible in metrics, not as an outage). Dropped values never appear in the output string or structured log.
- A test proves that a payload containing a name or email does not survive the logger, and that the drop counter increases.

### Checks that have no real input yet

Land the checkers anyway. Each checker is tested against a fixture that **must fail**; a check that passes because the tree is empty is treated as a broken check.

| Check                                  | Must-fail fixture (this chunk)                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app` table `org_id` + RLS + FORCE RLS | A table with no `org_id` (and a table with `org_id` but RLS not forced)                                                                                               |
| Encryption vs queryability             | An encrypted column used in `ORDER BY` (and one in `WHERE`)                                                                                                           |
| Residency / queue payload              | A queue payload JSON containing a `name` (and one containing an `email`)                                                                                              |
| Wrangler residency                     | A Worker config with `workers_dev = true`; a `regional` Worker with `preview_urls = true`; a Worker with **no class** (missing `worker.meta.json` or missing `class`) |

Fixtures live under `tooling/checks/` and are not deployable packages. The checker self-test fails the chunk if any fixture unexpectedly passes.

Stage 1 items with nothing to inspect (module manifests, plan catalogue, OpenAPI diff, Terraform plan, tenant-isolation suite, contract tests, axe) are **not** stubbed as always-green. They are omitted from the workflow until a later spec adds the first real input **and** a must-fail fixture. Traceability runs on this PR: branch `feat/2026-09-17-monorepo-skeleton`, this spec, and its plan, both `approved`.

## Data

None. This chunk introduces no tables and no classified columns. There is no blind index and no derived-clear column. The must-fail schema fixtures are not migrations and are not applied to any database.

## Rules touched

- Residency: `workers_dev = false` on the only Worker; personal data must not appear in logs; preview URLs on `workers.dev` are allowed only because this Worker is `global-no-pii`.
- No entitlements, permissions, consent, retention or safeguarding keys.
- Children: no children's data, no public content, no directories.

## Contracts

- `GET /health` → `200` `{ "ok": true }`. Body is the return value of `@community-hub/kernel`'s `healthPayload()`. Gateway imports that function; it does not rebuild the object.
- **Worker class (every Worker from this chunk on).** Each deployable Worker app has `apps/<name>/worker.meta.json`:

  ```json
  { "class": "global-no-pii" }
  ```

  or `{ "class": "regional" }`. No other values. The checker fails if the file is absent, `class` is absent, or `class` is unknown. Gateway's file is `global-no-pii`. Future Workers inherit this file; CI must not hardcode `gateway`.

- No other public routes. No events published or consumed. No ports. No widget keys.
- Package names: `@community-hub/kernel`, `@community-hub/observability`.

## Risks

| Risk                                                            | Mitigation                                                                                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per-PR preview on `workers.dev` processes personal data         | Only `global-no-pii` Workers set `preview_urls = true`. CI fails `regional` + `preview_urls = true`, missing class, and omitted `preview_urls`. ADR 0001.          |
| CI infers class from the folder name `gateway`                  | Class lives in `worker.meta.json`. A Worker with no class is a must-fail fixture.                                                                                  |
| AGENTS.md §10 Stage 3 currently promises a preview for every PR | This PR rewrites Stage 3: preview URLs for `global-no-pii` Workers; regional Workers are not previewed on `workers.dev`.                                           |
| Logger ships too loose and later routes log emails              | Untyped objects do not compile. Runtime drops unknown and personal-data-tagged keys and counts the drop. Gateway logs method/path/status/duration/request id only. |
| Logger throws in production when a bad field appears            | Runtime never throws for extra or tagged keys; it drops and counts.                                                                                                |
| Checkers that always pass                                       | Must-fail fixtures are merge-blocking. AGENTS.md forbids always-green stubs.                                                                                       |
| Cloudflare credentials missing, Stage 3 looks green             | Missing secrets fail the job. Human provisions GitHub Actions secrets before merge.                                                                                |
| Kernel grows into a framework in this chunk                     | One export used by `/health`. DI, outbox and manifests wait.                                                                                                       |
| Empty `apps/api` created "for later"                            | Forbidden. The next spec adds `api` with `packages/db` and Regional Services together.                                                                             |
| Merge to `main` is treated as a production/staging deploy       | Stage 4 is out of this chunk. No `staging-au` exists.                                                                                                              |

## Out-of-band

- **Architecture change needed (same PR):** record the preview-URL split in §7.2 / §7.3; add `tooling/` to the §8.1 tree; note in §28 that Preview URLs are `workers.dev` only (already implied by §7.3 rule 1). ADR 0001 in `docs/adr/`.
- **AGENTS.md change (same PR):** Stage 3 preview wording; Residency implementation rule (`preview_urls = true` only on `global-no-pii`, else `false`; omit neither; class declared in `worker.meta.json`); CI process rule: a check is omitted until it has a real input **and** a must-fail fixture — never stubbed always-green.
- **Not this chunk:** Cloudflare account as Terraform, DNS, Regional Services, legal sign-off, new subprocessor, Stage 4 deploy.
- **Human:** put Cloudflare API credentials in GitHub Actions secrets before this PR can go green. Plan is the next artefact; no scaffold until the plan is `approved`.
