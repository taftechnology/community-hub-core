# Plan: Monorepo skeleton

Slug: `monorepo-skeleton`
Spec: `docs/specs/2026-09-17-monorepo-skeleton.md` (approved 2026-09-17, Abdus Salam)
ADR: `docs/adr/0001-preview-urls-on-global-workers.md`
Status: approved (2026-09-17, Abdus Salam)
Reviewed-by: plan verify 2026-09-17 — nits below incorporated; no remaining blocking findings
Branch: `feat/2026-09-17-monorepo-skeleton` · one PR · 9 tasks, one commit each

---

## Tooling decisions this plan makes

The spec names capabilities; these are the concrete choices. Each is reversible and cheap to revisit while the tree is this small.

| Choice | Decision | Why |
|---|---|---|
| Lint + format | **ESLint 9 flat config + Prettier** | Later chunks need bespoke rules (no adapter imports from modules, no raw pool access, no personal data in log calls, no encrypted column in a query). ESLint can express them; Biome's custom-rule story is still thin. Cost: two tools instead of one. |
| Test runner | **Vitest 3**; `@cloudflare/vitest-pool-workers` for `apps/gateway` only | Spec §Workspace. Kernel, observability and checkers stay on plain Vitest — faster, no workerd boot. |
| Checkers | TypeScript under `tooling/checks/<name>/`, each with a `*.selftest.ts` run by Vitest | Checkers are code with tests, not shell one-liners. They run in Stage 1 *and* in `pnpm test`, so a broken checker fails locally. |
| Node / pnpm | Node **24 LTS** (`.nvmrc`, `engines`), pnpm 10 via `packageManager` + corepack | Spec §Workspace. |
| Task runner | Turborepo: `lint`, `typecheck`, `test`, `build`. Root also has `pnpm check:boundaries` (the T4–T7 checkers). | Spec §Workspace; AGENTS.md §8 local gate. |
| CI | One workflow, `.github/workflows/ci.yml`, three jobs: `static`, `test`, `build-preview` | Spec Stages 1–3. Stage 4 is out of scope. |

**Checker input formats are provisional.** Nothing real exists for the schema, encryption and residency checkers to read, so each defines a minimal input contract and is exercised only by fixtures. When `packages/db` lands, those contracts are expected to change; the checkers and their must-fail fixtures are what must survive, not the parsing details. Recorded as a risk below.

---

## Tasks

Each task is one commit, test-first, independently verifiable, and leaves the tree green. No task depends on a later task.

### T1 — Workspace root and `packages/kernel`

**Commit:** `chore(repo): pnpm workspace, Turborepo and kernel healthPayload`

- **Files:** `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.nvmrc`, `.editorconfig`, `.gitignore`, `eslint.config.js`, `.prettierrc`, `vitest.config.ts`, `packages/kernel/{package.json,tsconfig.json,src/health.ts,src/index.ts,src/health.test.ts}`
- **Test first:** `packages/kernel/src/health.test.ts` imports `healthPayload()` and asserts it returns exactly `{ ok: true }`. RED before `health.ts` exists.
- **Proves:** the workspace resolves, TypeScript project references build, Vitest runs, root scripts (`pnpm lint`, `pnpm typecheck`, `pnpm test`) exit 0 with a real package present.
- **Must not break:** no folder is created that is not a real package (spec §Workspace); kernel gains no DI, outbox or `defineModule` (spec Risks).
- **Done when:** `pnpm lint`, `pnpm typecheck` and `pnpm test` pass and `healthPayload` is exported from `@community-hub/kernel`. (`pnpm check:boundaries` arrives in T4 with the first checker.)

### T2 — `packages/observability` logger

**Commit:** `feat(observability): structured logger that cannot log personal data`

- **Files:** `packages/observability/{package.json,tsconfig.json,src/logger.ts,src/index.ts,src/logger.test.ts,src/logger.types.test.ts}`
- **Test first:**
  - `logger.test.ts` — a payload carrying `name` / `email` (fields tagged personal) produces output containing neither; an extra unknown key (injected at runtime, not via the typed API) is dropped; each drop is counted and the counter is readable.
  - `logger.types.test.ts` — `@ts-expect-error` on a call passing an untyped `Record<string, unknown>`, so a compile-time rejection is asserted by `pnpm typecheck`, not by a runtime throw.
- **Proves:** spec §Logger — type error at compile time, drop-and-count at runtime, never throws.
- **Must not break:** the logger never throws on bad input (an outage caused by the safety mechanism); no free-form object reaches the output.
- **Done when:** both tests pass and removing the `@ts-expect-error` line fails typecheck.

### T3 — `apps/gateway`

**Commit:** `feat(gateway): health route on a global no-PII Worker`

- **Files:** `apps/gateway/{package.json,tsconfig.json,wrangler.jsonc,worker.meta.json,src/index.ts,src/index.test.ts,vitest.config.ts}`
- **Test first:** `index.test.ts` under `@cloudflare/vitest-pool-workers` — `GET /health` → `200` and body deep-equals `healthPayload()` imported from the kernel (not a literal); `GET /anything-else` → `404` with an empty body; a request emits exactly one log line containing method, path, status, duration and request id, and no query string, header or body.
- **Config:** `wrangler.jsonc` sets `workers_dev: false` and `preview_urls: true` explicitly; `worker.meta.json` is `{ "class": "global-no-pii" }`.
- **Proves:** the workspace graph is real — deleting either import fails typecheck (spec §Workspace).
- **Must not break:** non-negotiable 1 — no personal data, no KV, no tenant routing, no hostname lookup (spec Out); nothing logged beyond the five fields.
- **Done when:** tests pass and `wrangler deploy --dry-run` succeeds locally.

### T4 — Worker config checker

**Commit:** `feat(tooling): fail CI on unsafe Worker preview configuration`

- **Files:** `package.json` (root script `check:boundaries`), `tooling/checks/worker-config/{check.ts,selftest.ts}`, `tooling/checks/worker-config/fixtures/{workers-dev-true,regional-preview-true,missing-class,unknown-class,missing-preview-urls,valid-global,valid-regional}/…`
- **Test first:** `selftest.ts` asserts each must-fail fixture **fails** and each valid fixture passes; a fixture that unexpectedly passes fails the task.
- **API:** `check(root: string)` — `root` defaults to the repo root. Self-tests call `check(fixtures/<case>/)`. The live gate calls `check()` with no argument. Hardcoding `apps/*` relative to `process.cwd()` only would make the fixtures un-runnable.
- **Discovery:** under `root`, glob `apps/*/wrangler.jsonc` and `apps/*/wrangler.json`. Then require a sibling `worker.meta.json`. **Do not glob `worker.meta.json` first** — a Worker that shipped Wrangler config and forgot its class would be invisible, and the missing-class fixture would be unenforceable on the real tree.
- **Rules enforced** (spec §Preview URLs, ADR 0001): `workers_dev` missing or not `false`; `preview_urls` omitted; `global-no-pii` without `preview_urls: true`; `regional` without `preview_urls: false`; class missing (no `worker.meta.json` or no `class` field) or unknown (value other than the two allowed).
- **Must not break:** the checker never hardcodes `gateway` (spec Contracts). AGENTS.md §8's local gate must be invocable from this commit on: `pnpm check:boundaries` runs this checker (T5–T7 append theirs).
- **Done when:** the self-test passes; `pnpm check:boundaries` exits 0 on the real tree (`apps/gateway`); pointing `check()` at each must-fail fixture exits non-zero.

### T5 — Schema checker (`org_id`, RLS, FORCE RLS)

**Commit:** `feat(tooling): fail CI on app tables without org_id or forced RLS`

- **Files:** `package.json` (`check:boundaries` now runs worker-config **and** this checker), `tooling/checks/schema-rls/{check.ts,selftest.ts,README.md}`, fixtures: `no-org-id.sql`, `rls-not-forced.sql`, `valid.sql`
- **Test first:** self-test asserts `no-org-id.sql` and `rls-not-forced.sql` fail, `valid.sql` passes.
- **API:** same `check(root: string)` as T4; self-test points `root` at fixture dirs.
- **Input contract:** SQL files under a configured glob (today matches nothing outside fixtures). `README.md` states the contract is provisional until `packages/db` lands.
- **Must not break:** non-negotiable 3. The checker must not be satisfiable by an empty tree — the self-test is what proves that.
- **Done when:** self-test passes; `pnpm check:boundaries` still exits 0 on the real tree; running this checker against the real tree finds zero tables and says so explicitly rather than printing success silently.

### T6 — Encryption-versus-queryability checker

**Commit:** `feat(tooling): fail CI on encrypted columns used in queries`

- **Files:** `package.json` (`check:boundaries` appends this checker), `tooling/checks/encrypted-query/{check.ts,selftest.ts,README.md}`, fixtures: `order-by-encrypted.sql`, `where-encrypted.sql`, `valid.sql`
- **Test first:** self-test asserts both must-fail fixtures fail and `valid.sql` passes.
- **API:** same `check(root: string)` as T4; self-test points `root` at fixture dirs.
- **Input contract:** a column classification map plus SQL; provisional, documented in `README.md`.
- **Must not break:** non-negotiable 4 and architecture §12.2.1 — the `confidential-queryable` and `confidential-blind` classes must pass, only encrypted classes fail.
- **Done when:** self-test passes and `pnpm check:boundaries` still exits 0 on the real tree.

### T7 — Residency payload checker

**Commit:** `feat(tooling): fail CI on personal data in queue and workflow payloads`

- **Files:** `package.json` (`check:boundaries` appends this checker), `tooling/checks/residency-payload/{check.ts,selftest.ts,README.md}`, fixtures: `payload-with-name.json`, `payload-with-email.json`, `valid-ids-only.json`
- **Test first:** self-test asserts both must-fail fixtures fail and the ids-only payload passes.
- **API:** same `check(root: string)` as T4; self-test points `root` at fixture dirs.
- **Must not break:** non-negotiables 1, 2 and 7 — the rule this encodes is "IDs in, status out" (architecture §7.3 rule 2, §18).
- **Done when:** self-test passes and `pnpm check:boundaries` still exits 0 on the real tree.

### T8 — CI: Stages 1–3

**Commit:** `ci: static, test and preview stages for the skeleton`

- **Files:** `.github/workflows/ci.yml`, `tooling/checks/traceability/check.ts`
- **Jobs:**
  - `static` — format check, ESLint, `tsc --build`, `pnpm check:boundaries` (T4–T7 live scan of the real tree), secret scanning, `pnpm audit` (fail on high/critical), traceability.
  - `test` — `pnpm test` (kernel, observability, gateway, **checker self-tests**). The self-tests are what make an empty live tree acceptable: a checker that exits 0 on zero real tables is not a pass unless its fixtures still fail in this job.
  - `build-preview` — `wrangler deploy --dry-run` always; then `wrangler versions upload` and a PR comment with the `*.workers.dev` preview URL.
- **Secrets:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. **Missing secrets fail the job**; there is no conditional skip (spec §Gateway). Live preview is merge-blocking; the T8 *commit* may land locally before secrets exist.
- **Traceability:** branch matches `<type>/<YYYY-MM-DD>-<slug>`; the PR body links one spec and one plan; both share the slug; both are `approved`. Verified on this PR itself. Runs on `pull_request` only.
- **Omitted deliberately:** module manifests, plan catalogue, OpenAPI diff, Terraform plan, tenant isolation, contract tests, axe, **dependency-cruiser** — no real input yet, and per spec they are not stubbed green. Stage 4 (deploy) is out of scope.
- **Must not break:** non-negotiable 1 on the preview URL (only `global-no-pii`). T8 does not create `check:boundaries`; it only invokes the script T4 introduced.
- **Done when:** the workflow is green on this PR with a preview URL posted, and removing a secret turns the job red rather than green.

### T9 — Documentation updates

**Commit:** `docs: record the preview-URL split and the tooling tree`

- **Files:** `architecture.md`, `AGENTS.md`
- **architecture.md:** preview-URL split in §7.2 / §7.3 rule 1 with a pointer to ADR 0001; `tooling/` added to the §8.1 tree; §28 notes Preview URLs are `workers.dev`-only.
- **AGENTS.md:** §10 Stage 3 reworded (previews for global no-PII Workers; regional Workers verified on `staging-au` or a Regional Services hostname); §6 Residency gains the explicit-`preview_urls` / `worker.meta.json` rule; §10 Stage 1 list matches what T8 actually runs (no claim of dependency-cruiser, manifests, OpenAPI or Terraform until those checks exist); §10 gains the rule that a check lands only with a real input **and** a must-fail fixture.
- **Must not break:** architecture is an approved baseline — ADR 0001 already covers the decision, so this task records it rather than deciding it (AGENTS.md §13). AGENTS.md must not describe a CI check this PR does not run.
- **Done when:** both documents match the shipped behaviour, with no reference to a check that does not exist.

---

## Migration wave

**None.** This chunk creates no tables and applies no SQL to any database. The `.sql` files under `tooling/checks/` are checker fixtures, never migrations, and live outside any migrations glob.

## Rollback

- **Before merge:** close the PR and delete the branch. Nothing persists.
- **After merge:** `git revert` the squash commit. Then, in Cloudflare, delete the `gateway` Worker and any uploaded versions — a `versions upload` from CI leaves a Worker and preview versions in the account even though nothing was promoted. No DNS record, no database, no KMS key, no Terraform state exists to unwind.
- **Secrets:** repository secrets stay; they are not created by this chunk.

## Risks carried by this plan

| Risk | Handling |
|---|---|
| Checker input formats are invented before the real inputs exist (T5–T7) | Minimal contracts, documented as provisional in each `README.md`. The must-fail fixtures are the durable part. Expect rewrites when `packages/db` lands; that is cheaper than shipping no check. |
| `versions upload` needs account credentials a human must provision | Spec Out-of-band. CI fails loudly if absent; the PR cannot go green until then. |
| Traceability check needs PR context | It runs on `pull_request` events only; a bare branch push skips it by design, and merge requires the PR. |
| ESLint + Prettier over a single-tool setup | Revisit before the tree grows past ~10 packages; migration cost now is minutes. |
| Scaffolding tempts scope creep (an empty `apps/api`, a fuller kernel) | Spec Out and Risks are explicit; T3 and T1 state what must not appear. Reviewer rejects extra packages. |

## Definition of done for the chunk

- [ ] T1–T9 complete, each reviewed as its own commit
- [ ] Stages 1–3 green on the PR, preview URL posted
- [ ] Every checker demonstrably fails its fixtures (self-tests green)
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm check:boundaries` green from a clean clone
- [ ] `architecture.md` and `AGENTS.md` match what shipped; ADR 0001 referenced
- [ ] PR body links this plan and the spec; review record filled in (AGENTS.md §9)
