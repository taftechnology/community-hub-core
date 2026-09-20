# Spec: packages/residency foundations

Slug: `packages-residency`
Status: approved (2026-09-20, Abdus Salam)
Architecture refs: §7.1–7.5, §8.1, §8.3; D3; ADR 0001; AGENTS.md §1 (1, 7), §6 (Residency), §8, §10
Supersedes: —

## Problem

Cell configuration and the “global Workers cannot import personal-data modules” rule are decided (D3, §7.5, §8.3) and missing in code. There is no `packages/residency`. `worker-config` knows Worker class (`global-no-pii` | `regional`) and preview URLs. Gateway ESLint bans `@community-hub/db` only, by folder name. `@community-hub/crypto` is equally regional and is not banned. A one-hop workspace dependency, a deep specifier, or a relative path into `packages/crypto` would ship personal-data code on a `workers.dev` preview. Nothing fails if a catalog later said the AU cell’s AWS region was `us-east-1` while Terraform stayed in `ap-southeast-2`.

## Scope

**In**

- `@community-hub/residency`: cell catalog, typed `getCell` / `parseRegionId`, `regionalOnlyPackages`. No Cloudflare SDK, no AWS SDK, no `@community-hub/db`, no `@community-hub/crypto`.
- `packages/residency/src/catalog.json`: checker-readable source. TypeScript derives unions from it (no parallel handwritten `RegionId` list).
- `tooling/checks/residency-cell`: `check(root?: string)` (default `process.cwd()`), wired through `check:boundaries`. Two jobs: catalog ↔ Terraform AWS region; `global-no-pii` Workers must not reach a regional-only package (direct, deep, relative, or transitive `workspace:*`).
- ESLint `no-restricted-imports` on `apps/gateway/**`: add `@community-hub/crypto` (fast path). The checker is the fail-closed, class-keyed rule.
- Architecture §8.3 (enforcement sentence) and §7.5 step 3 (catalog + enable + Terraform must agree). AGENTS.md §10 checker list. Root `tsconfig.json` project reference for `packages/residency` (same as `packages/crypto`). Last commit of the branch updates `docs/roadmap.md` (`packages-residency` **done**, next `packages-ui` unless the human picks another remaining Phase 0 row).

**Out** (explicitly)

- Hostnames, endpoint templates, bucket names, database URLs, account ids, KMS ARNs.
- `apps/api-au`, `exec`, `jobs`, `webhooks`, control-plane, ops-console.
- Empty `infra/regions/ca|eu|us/` roots.
- Passing `region_key` from AU tfvars (that is `api-au-skeleton`). Cross-checking `cloudflareRegionalServices` waits on that (known gap below).
- Residency *integration* suite (Hyperdrive, Regional Services hostname, live cell). This chunk is catalog + static guards.
- Changing Worker class vocabulary, ADR 0001, or `worker-config` preview/ALS rules.
- Module-manifest `dataClasses` import bans (no feature modules yet).
- Extending `residency-payload`. dependency-cruiser.
- ADR. D3 and ADR 0001 already hold.

## Behaviour

### Split

| Piece | Owns | Must not |
| ----- | ---- | -------- |
| `@community-hub/residency` | Catalog types, `getCell`, `parseRegionId`, `regionalOnlyPackages` | Import Cloudflare/AWS SDKs, db, or crypto (value or type) |
| `catalog.json` | Cell records and the regional-only package list | Hostnames or secrets |
| `residency-cell` checker | Catalog ↔ `infra/regions/<id>/` AWS region; global Worker import graph | Own the Worker class enum; skip a Worker that has Wrangler and no `worker.meta.json` |
| `worker-config` | Wrangler flags, class allow-list, ALS | Package scope |
| Gateway ESLint | Fast-path ban of db and crypto by folder | Be the only enforcement |

**Worker class stays in `worker.meta.json` / `worker-config` / ADR 0001** (`global-no-pii` | `regional`). Preview policy and package scope are different questions. Residency does not export a Worker class enum. `residency-cell` reads the same `class` field `worker-config` already requires.

### Catalog

Path: `packages/residency/src/catalog.json`. Keys under `cells` are exactly `au`, `ca`, `eu`, `us` (D3). Extra or missing keys fail the package test and the checker.

Each cell record has exactly these fields (no endpoints, buckets, URLs):

| Field | Type | AU (enabled) | Stubs (`ca`, `eu`, `us`) |
| ----- | ---- | ------------ | ------------------------ |
| `enabled` | boolean | `true` | `false` |
| `cloudflareRegionalServices` | string | `au` (Cloudflare `region_key`) | placeholder; not a deploy decision |
| `awsRegion` | string | `ap-southeast-2` | placeholder; not a deploy decision |

Stub AWS / Cloudflare values exist so the record shape is uniform. They must be non-empty strings; this chunk does not pin which strings. The checker does not read them until the cell is `enabled`. Phase 7 + a Terraform root is when they become truth.

`regionalOnlyPackages` is `["@community-hub/db", "@community-hub/crypto"]` (exact names, order not significant). Feature modules are not listed.

Direction: **Terraform is the deployed truth. The catalog is the code-side mirror. The check proves they agree.**

### Types (keep JSON and TypeScript in lockstep)

`catalog.json` is the source. TypeScript does `import catalog from "./catalog.json" with { type: "json" }`.

- `RegionId` = `keyof typeof catalog.cells` (the four keys). Do not also handwrite `"au" | "ca" | "eu" | "us"`.
- `Cell` = the JSON record plus `id: RegionId`.
- `EnabledRegionId` cannot be derived with `enabled extends true`: JSON module types are `boolean`, not the literal `true`. It is `"au"` (the only enabled cell). A package test is the lock: the JSON keys with `enabled: true` must be exactly the `EnabledRegionId` union (today `["au"]`), and every `EnabledRegionId` must be `enabled: true` in JSON. Enabling `ca` is a catalog edit **and** widening that alias in the same PR.

A package test also parses the JSON and asserts: exactly those four keys; every record has the three fields with the right JSON types; `enabled` is a boolean; placeholder strings are non-empty; `regionalOnlyPackages` is a non-empty array of `@community-hub/…` strings that includes db and crypto. That test is what fails if someone edits JSON into a shape the derived types would silently widen (`enabled: "true"` as string, missing `awsRegion`).

`getCell(id: EnabledRegionId)` returns the enabled cell including `id`. `getCell("ca")` is a compile error (`@ts-expect-error` in a test file). `getCell` does not accept `string`.

**Runtime:** `getCell` also throws if the record is missing or `enabled !== true`. `EnabledRegionId` is handwritten (JSON types widen `true` to `boolean`); the package test keeps the alias honest, and the throw is the backstop if the alias is mis-widened (`getCell("ca" as EnabledRegionId)` must throw, not return a stub). Message stays generic: region is not enabled.

`parseRegionId(id: string): EnabledRegionId` is the backstop for dynamic ids. Unknown or stub throws. Same generic message.

### JSON import on a Worker

A global Worker may import `@community-hub/residency`. The package is therefore proven on **workerd**, same pool as crypto (`@cloudflare/vitest-pool-workers` + a harness `wrangler.jsonc` under `packages/residency`, not under `apps/`, so `worker-config` does not treat it as a product Worker).

The workerd test imports the public entry and reads `getCell("au").awsRegion`. That is the proof that `catalog.json` survives a Worker bundle.

If JSON modules cannot be imported under that pool, **stop and report**. Do not duplicate the catalog as a TypeScript object. Do not switch the checker to parse `.ts`.

`packages/residency` tsconfig sets `resolveJsonModule: true`. `catalog.json` lives under `src/` so `rootDir` emit includes it. Public exports stay the package root (`.`); no Cloudflare/AWS `dependencies`. Add `packages/residency` to the root `tsconfig.json` `references` array (next to `packages/crypto`). Omitting it fails `pnpm typecheck` in a way that looks unrelated.

### Checker API

`check(root?: string)` resolves `root` (default `process.cwd()`) and reads **only that tree**. Returns `{ ok, violations, notice? }` (`notice` is set on zero-input, same as `event-names`). Missing `packages/residency/src/catalog.json` fails. Must-fail fixtures are mini-repos (`catalog.json`, `infra/regions/…`, `apps/…`), the same pattern as `sql-session-ban` and `worker-config`. No mocked filesystem.

Self-tests call `check(fixtureRoot)`. CI calls `check()` on the real repo.

### Catalog ↔ Terraform

Scan `infra/regions/*/` directories that look like cell roots (contain `backend/` or `env/`). Ignore `infra/modules/`, `infra/bootstrap/`, `infra/global/`.

| Situation | Result |
| --------- | ------ |
| Enabled catalog cell, no `infra/regions/<id>/` | fail |
| Enabled catalog cell: root has no `env/*.tfvars` or no `backend/*.hcl` | fail |
| Enabled catalog cell: `awsRegion` ≠ any `env/*.tfvars` `aws_region` | fail |
| Enabled catalog cell: `awsRegion` ≠ any `backend/*.hcl` `region` | fail |
| Enabled catalog cell: tfvars and backend disagree with each other (even if the catalog matches one) | fail |
| `infra/regions/<id>/` exists, `<id>` not a key in `catalog.cells` | fail |
| Disabled catalog cell, no Terraform root | pass |
| Disabled catalog cell **with** a Terraform root | **pass** (`ca` / `eu` / `us` roots may land before the catalog flag flips) |
| Live AU catalog `ap-southeast-2` vs live `infra/regions/au/` tfvars + backends | pass (day-one live input) |
| Zero Terraform cell roots in the scanned tree | fail with a notice (not a silent pass) |
| Zero enabled cells in the catalog | fail with a notice |
| Zero apps with a Wrangler config in the scanned tree | fail with a notice |

Parse tfvars / HCL with comment-stripping (quoted strings left intact), same idea as `terraform-invariants`. A commented-out correct `region` must not hide a wrong one.

Zero-input (same idea as `event-names`): if the checker finds no Terraform cell roots, or no enabled catalog cells, or no Wrangler apps, it sets `notice` **and** `ok: false`. An empty-tree fixture is a must-fail, not a must-pass. A refactor that moved `apps/` or `infra/regions/` must not report ok.

Every other fixture therefore includes all three live inputs: a catalog with at least one enabled cell, at least one `infra/regions/<id>/`, and at least one app with Wrangler. Otherwise it trips the zero-input notice instead of the rule under test.

`cloudflareRegionalServices` is **not** cross-checked this chunk. AU Terraform does not take `region_key` at the cell root; it defaults to `"au"` on `infra/modules/cf-regional-hostname` (`variables.tf` validation `region_key == "au"`, must-fail test `"ee"`). **Retirement:** when `api-au-skeleton` passes `region_key` from `infra/regions/au` tfvars, this checker extends to `cloudflareRegionalServices`. Until then the field is on the catalog for application use and is pinned in the module, not at the cell root.

### Global Worker import graph

For each `apps/<name>/` that has `wrangler.json` or `wrangler.jsonc`:

1. **Missing `worker.meta.json` fails.** Do not skip, do not treat as regional. Deleting the meta file is otherwise the bypass. `worker-config` already fails this (`missing worker.meta.json`; fixture `missing-class` includes `apps/orphan` with Wrangler and no meta file). This checker **also** fails; it does not assume the other job ran.
2. Missing or unknown `class` fails (same fail-closed reason). `worker-config` already rejects those; this checker does not skip them either.
3. `class === "regional"`: import rule does not apply (regional Workers may import db/crypto). **No live regional app exists yet.** The must-pass fixture is the only coverage until `api-au-skeleton`.
4. `class === "global-no-pii"`: the app must not **reach** a `regionalOnlyPackages` name.

**Scan set.** Every non-test TypeScript file under the **app directory** (not only `src/`). Skip `node_modules`, `dist`, `coverage`, `test`, `tests`, `.turbo`, `fixtures`, and `*.test.ts`. Wrangler `main` is not assumed to be `src/index.ts`; a Worker with `main: "worker/entry.ts"` must still be scanned. Reached workspace packages use the same scan set under that package directory.

**Reach** means any of:

**A. Direct specifier** (value or `import type`, static `import` / `export … from`, and `import("literal")`): exact `@community-hub/db` or `@community-hub/crypto`.

**B. Deep specifier:** `@community-hub/db/…` or `@community-hub/crypto/…` (prefix `name + "/"`). Exact-name matching is not enough.

**C. Relative path:** resolve against the importing file. If the resolved path is inside that package’s directory (`packages/db/**`, `packages/crypto/**`), fail. `../../packages/crypto/src/index.ts` is the bypass this clause exists for.

**D. Transitive workspace graph.** Start from workspace packages those files actually import. Resolve `@community-hub/<pkg>` to `packages/<pkg>` or `apps/<pkg>` under `root` when that directory exists and `package.json` `"name"` matches. Fixtures do not need `pnpm-workspace.yaml` or an install. Follow each reached package’s `package.json` `dependencies` and `peerDependencies` whose version is the `workspace:` protocol, transitively. `devDependencies` are not followed (not what Wrangler ships). If a reached package’s `name` is in `regionalOnlyPackages`, fail. Then scan each reached **workspace** package with A–C and E as well, so a helper that relative-imports crypto without declaring it still fails.

**E. Non-literal dynamic import.** `import(name)` where the specifier is not a string literal (variable, concatenation, template with substitution) fails inside a `global-no-pii` app and inside every workspace package it reaches. Literal `import("@community-hub/kernel")` is fine and is handled by A–D. Nothing in the repo does this today; it is the one-line bypass if left open.

Do not follow npm registry dependencies (`zod`, `drizzle-orm`, …).

Gateway today imports kernel and observability only; neither depends on db/crypto. That is the live pass. A fixture app that imports a workspace helper whose `package.json` depends on `@community-hub/crypto` is the live **must-fail** for D — one hop, no direct crypto specifier on the app.

### ESLint

`apps/gateway/**` `no-restricted-imports` already bans `@community-hub/db` (including `import type`) and `@community-hub/kernel/module`. Add `@community-hub/crypto` (value and type). Encrypted-column fixture ESLint config used for the gateway-shaped must-fail files gets the same crypto path.

ESLint stays folder-based (it cannot read `worker.meta.json`). A new `apps/control-plane` with `class: global-no-pii` is caught by `residency-cell` even if nobody updates the ESLint glob.

### Gateway contract

`GET /health` still `200` `{ ok: true }`. This chunk does not require gateway to import residency. The workerd test in `packages/residency` is the Worker-bundle proof.

## Data

No tables, no migrations, no personal data. Catalog values are region codes and AWS region names (`internal` / config). Synthetic fixture trees only.

## Tests

Consolidated. Each item is independently testable; the plan maps one commit to a subset.

**Package (Node + workerd)**

- JSON schema test: four cell keys, required fields, non-empty placeholders, `regionalOnlyPackages` includes db and crypto.
- Enabled JSON keys are exactly `["au"]` and match `EnabledRegionId`.
- `getCell("au")` returns `awsRegion: "ap-southeast-2"`, `enabled: true`, `id: "au"`.
- `getCell("ca")` is a type error (`@ts-expect-error`).
- `getCell("ca" as EnabledRegionId)` throws at runtime.
- `parseRegionId("au")` returns `"au"`; `parseRegionId("ca")`, `parseRegionId("us")`, `parseRegionId("")`, `parseRegionId("nope")` throw.
- Workerd: import public entry, `getCell("au").awsRegion === "ap-southeast-2"`. Stop and report if JSON import fails in the pool.
- `package.json` production `dependencies` do not include Cloudflare or AWS SDKs, db, or crypto.

**`residency-cell` fixtures (`check(fixtureRoot)`)**

Must-fail:

- Catalog AU `awsRegion` is `us-east-1` against AU Terraform that says `ap-southeast-2`.
- Enabled cell with no `infra/regions/<id>/`.
- Enabled cell whose Terraform root exists, tfvars say `ap-southeast-2`, `backend/*.hcl` say something else (or the reverse).
- Terraform cell root `infra/regions/<id>/` with no catalog key for `<id>`.
- `global-no-pii` app imports `@community-hub/db`.
- `global-no-pii` app imports `@community-hub/crypto`.
- `global-no-pii` app `import type` of crypto (or db).
- `global-no-pii` app imports `@community-hub/db/anything` (deep).
- `global-no-pii` app relative-imports `../../packages/crypto/src/…`.
- `global-no-pii` app imports a workspace helper whose `package.json` `dependencies` include `@community-hub/crypto` (indirect).
- App with Wrangler and **no** `worker.meta.json`.
- Empty tree (no `infra/regions/`, no enabled cells, and/or no Wrangler apps) — honest notice, `ok: false`.
- `global-no-pii` app (or a reached workspace package) uses `import(name)` with a non-literal specifier.
- `global-no-pii` app whose only TypeScript is outside `src/` (e.g. `worker/entry.ts`) imports crypto — proves the scan is not `src/`-only.

Must-pass:

- Live-shaped AU catalog matching tfvars + both backends `ap-southeast-2`.
- Disabled cell with a Terraform root.
- Disabled cell with no Terraform root.
- `regional` Worker that imports db or crypto (fixture-only until `api-au-skeleton`; no live regional app).
- `global-no-pii` app that imports kernel / observability / residency only.

**ESLint**

- Gateway-shaped must-fail: `import` / `import type` of `@community-hub/crypto` (alongside existing db fixtures).

**Gateway contract**

- `GET /health` still `200` `{ ok: true }`.

## Rules touched

- §1.1 / §1.7: personal-data packages must not land on a global Worker (including preview on `workers.dev`). Catalog holds region codes and AWS region names only.
- D3: `au` enabled; `ca`, `eu`, `us` stubs.
- §7.3 rule 1 / ADR 0001: Worker class unchanged; this chunk uses it as the import-rule key.
- §7.5: adding a region is catalog + enable + Terraform root, then this checker.
- §8.3: replace the sentence that only mentions db-from-gateway with catalog-marked regional-only packages, class-keyed checker, transitive workspace graph.

## Contracts

- `@community-hub/residency`: `getCell`, `parseRegionId`, derived types, `regionalOnlyPackages` (and/or the catalog object). No HTTP API, no events, no widgets.
- `catalog.json` shape as above.
- `check(root?: string)` on the new checker.
- Worker class strings unchanged.

## Risks

| Risk | Mitigation |
| ---- | ---------- |
| Direct-import scan misses a bundled dependency | Transitive `workspace:*` walk from app imports; must-fail indirect fixture |
| Deep specifier or relative path bypasses exact name | Prefix `name/` and resolved-path-inside-package; fixture each |
| Deleting `worker.meta.json` skips the rule | Missing meta fails; cite `worker-config`; own must-fail fixture |
| Checker reads the live repo inside fixtures | `check(root)` only; mini-trees |
| Handwritten `RegionId` drifts from JSON | `RegionId` is `keyof typeof catalog.cells` |
| `EnabledRegionId` drifts from JSON `enabled` flags | JSON types `enabled` as `boolean`; test that enabled keys === the union; `getCell` throws if the record is not enabled |
| Empty `apps/` or `infra/regions/` after a refactor | Zero cell roots / zero enabled cells / zero Wrangler apps → notice and fail; empty-tree fixture |
| `import(name)` bypasses specifier scan | Non-literal dynamic import fails on `global-no-pii` apps and reached packages; must-fail fixture |
| Scan `src/` only; `main` is `worker/entry.ts` | Scan every non-test `.ts` under the app directory; fixture with crypto import outside `src/` |
| JSON import fails in workerd; catalog duplicated in TS | Stop and report; no TS duplicate |
| Catalog AU region `us-east-1` while Terraform stays Sydney | Cross-check tfvars **and** backend; mismatch fixture including tfvars-vs-backend |
| Enabling `ca` in JSON without a cell root | Enabled-without-root must-fail |
| Stub Terraform landing blocked by the checker | Disabled + Terraform root is an explicit pass |
| `cloudflareRegionalServices` never contradicted | Known gap; retire when `api-au-skeleton` passes `region_key` from tfvars. Module validation + `"ee"` test pin AU today |
| ESLint glob forgets a new global app | Checker keys off class, not folder |
| Checker imports `@community-hub/residency` and cannot see fixture catalogs | Read `packages/residency/src/catalog.json` from `root`; do not import the live package for the scan |
| `devDependencies` on crypto fail a global app | Do not follow `devDependencies` |
| Kernel later adds a crypto dependency | Transitive walk fails gateway on the next CI run |
| Residency harness Wrangler scanned as a product Worker | Harness lives under `packages/residency`, not `apps/` |

## Out-of-band

- **`api-au-skeleton`:** pass `region_key` from `infra/regions/au` tfvars into `cf-regional-hostname`; extend `residency-cell` to `cloudflareRegionalServices`.
- **`tenancy-implicit-org` / control-plane:** first product consumers of `getCell` / `parseRegionId`.
- **Feature modules:** extend `regionalOnlyPackages` or add a manifest `dataClasses` walk when those modules exist; not this PR.
- Legal: none. New subprocessor: none. Architecture: §8.3, §7.5 step 3. ADR: none.

## Next spec after this lands

`packages-ui`, unless the human picks another remaining Phase 0 row.
