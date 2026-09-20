# Plan: packages/residency foundations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land `@community-hub/residency` (cell catalog + typed `getCell`) and a `residency-cell` checker that proves the catalog matches Terraform AWS region and that `global-no-pii` Workers cannot reach `@community-hub/db` or `@community-hub/crypto`.

**Architecture:** JSON catalog is the checker-readable source. TypeScript derives `RegionId` from its keys; `EnabledRegionId` is handwritten `"au"` with a lock test. Terraform is the deployed truth; the checker is the mirror. Worker class stays in `worker.meta.json` (ADR 0001). Package scope (`regionalOnlyPackages`) lives in the catalog. The checker keys off class, walks `workspace:` deps, and scans every non-test `.ts` file under the app directory.

**Tech Stack:** Node 24 + workerd (`@cloudflare/vitest-pool-workers`), Vitest, existing `tooling/checks` pattern (`check(root)` + mini-repo fixtures), ESLint `no-restricted-imports`.

**Spec:** `docs/specs/2026-09-20-packages-residency.md` (approved 2026-09-20, Abdus Salam)

Status: approved (2026-09-20, Abdus Salam)

**Branch:** `feat/2026-09-20-packages-residency` · one PR · 6 tasks, one commit each

## Global Constraints

- No Cloudflare SDK, no AWS SDK, no `@community-hub/db`, no `@community-hub/crypto` in `@community-hub/residency` (value or type).
- Catalog holds `enabled`, `cloudflareRegionalServices`, `awsRegion` only. No hostnames, buckets, URLs, account ids, KMS ARNs.
- `catalog.json` is the source. Do not duplicate it as a TypeScript object. If JSON modules fail under the Workers pool: **stop and report**.
- Checker reads `packages/residency/src/catalog.json` from `root`. It does not import the live `@community-hub/residency` package.
- **Missing catalog first:** if that file is absent, return `{ ok: false, violations: [{ file: "packages/residency/src/catalog.json", message: "missing catalog.json" }] }` and do **not** set `notice`. Zero-input runs only after a catalog has been parsed.
- `check(root?: string)` only. No mocked filesystem. Default `process.cwd()`.
- Zero Terraform cell roots, zero enabled cells, or zero Wrangler apps → `notice` and `ok: false` (after a catalog exists).
- Every fixture that is not `empty-tree` or `missing-catalog` includes all three live inputs (enabled catalog cell, `infra/regions/<id>/`, Wrangler app) or it hits the zero-input notice instead of the rule under test.
- Do not follow `devDependencies`. Do not follow npm registry deps.
- Worker class is not owned by residency. Do not export a Worker class enum.
- Do not change `residency-payload`, ADR 0001, or `worker-config` preview/ALS rules.
- `cloudflareRegionalServices` is not cross-checked this chunk.
- Session scratch is never committed.
- Last commit updates `docs/roadmap.md` (`packages-residency` **done**, next `packages-ui`).
- Residency chunk: second independent review on the final diff (AGENTS.md §2).

**Stop and report** (do not work around):

- JSON `import catalog from "./catalog.json" with { type: "json" }` cannot be bundled or imported under `@cloudflare/vitest-pool-workers`.
- The import scan cannot see `import(name)` (non-literal) well enough to fail the fixture.

In either case: **stop**. Do not duplicate the catalog in `.ts`. Do not drop the non-literal dynamic-import rule.

---

## Tooling decisions this plan makes

| Choice                 | Decision                                                                                                | Why                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog path           | `packages/residency/src/catalog.json`                                                                   | `rootDir` emit includes it; checker path is stable                                                                                              |
| Stub AWS/CF strings    | `ca`: `ca-central-1` / `ca`; `eu`: `eu-central-1` / `ee`; `us`: `us-east-1` / `us`                      | Uniform record shape; not cross-checked; not a Phase 7 decision                                                                                 |
| HCL parse              | Small `assignmentValue` + comment-strip copied into this checker (do not import `terraform-invariants`) | Checkers stay independent                                                                                                                       |
| Import scan            | Copy and extend `worker-config`'s comment-strip / specifier walk; do not import that package            | Same reason                                                                                                                                     |
| Non-literal `import()` | Fail unless the specifier is a `"…"` or `'…'` quote immediately inside `import(`                        | Templates and variables are the bypass                                                                                                          |
| Relative path          | Resolved path is inside a directory already mapped from `regionalOnlyPackages` names                    | Do not hard-code `/packages/db/` or `/packages/crypto/`                                                                                         |
| Typecheck tests        | `tsc --build && tsc --noEmit -p tsconfig.test.json`; test tsconfig `types` includes `node`              | Vitest strips types; `@ts-expect-error` is otherwise unenforced. Do not copy crypto's `tsconfig.test.json` include (it misses `test/*.test.ts`) |
| App scan               | Every non-test `.ts` under `apps/<name>/`, not `src/` only                                              | Wrangler `main` is not guaranteed                                                                                                               |
| Wire `run.ts`          | Task 4, after import-graph exists                                                                       | Live tree must pass both jobs                                                                                                                   |
| ESLint crypto          | Task 5; folder glob on gateway; checker remains class-keyed                                             | Fast path vs fail-closed                                                                                                                        |
| Workerd                | Same `src/**/*.test.ts` on a second vitest config, like crypto                                          | Spec: JSON must survive a Worker bundle                                                                                                         |

**Rollback:** revert the PR. No Terraform apply. No RDS. No Worker class change.

---

## File map

| Path                                            | Role                                               |
| ----------------------------------------------- | -------------------------------------------------- |
| `packages/residency/src/catalog.json`           | Cells + `regionalOnlyPackages`                     |
| `packages/residency/src/index.ts`               | `getCell`, `parseRegionId`, types, re-export list  |
| `packages/residency/src/index.test.ts`          | Schema, types lock, runtime throw (Node + workerd) |
| `packages/residency/test/package-graph.test.ts` | No production dependencies (Node only)             |
| `packages/residency/tsconfig.test.json`         | Type-checks tests (`@ts-expect-error` + `node:fs`) |
| `packages/residency/package.json`               | `@community-hub/residency`                         |
| `packages/residency/tsconfig.json`              | `resolveJsonModule`, include JSON                  |
| `packages/residency/wrangler.jsonc`             | Test harness only (not under `apps/`)              |
| `packages/residency/vitest.config.ts`           | Node                                               |
| `packages/residency/vitest.worker.config.ts`    | workerd                                            |
| `tsconfig.json`                                 | Add project reference                              |
| `tooling/checks/residency-cell/check.ts`        | Catalog ↔ Terraform + import graph                 |
| `tooling/checks/residency-cell/selftest.ts`     | Fixture matrix                                     |
| `tooling/checks/residency-cell/fixtures/`       | Mini-repos                                         |
| `tooling/checks/run.ts`                         | Wire the checker                                   |
| `eslint.config.js`                              | Gateway crypto ban                                 |
| `tooling/checks/encrypted-column/`              | Gateway-shaped crypto import fixtures              |
| `architecture.md`                               | §8.3, §7.5                                         |
| `AGENTS.md`                                     | §10 checker list                                   |
| `docs/roadmap.md`                               | Last commit                                        |

Do not edit merged specs/plans. Do not add `infra/regions/ca`.

---

## Interfaces (locked for later tasks)

```ts
export type RegionId = keyof typeof catalog.cells; // "au" | "ca" | "eu" | "us"
export type EnabledRegionId = "au";
export type Cell = (typeof catalog.cells)[RegionId] & { id: RegionId };

export declare function getCell(id: EnabledRegionId): Cell & { id: EnabledRegionId };
export declare function parseRegionId(id: string): EnabledRegionId;
export declare const regionalOnlyPackages: readonly string[];
```

```ts
export type ResidencyCellViolation = { file: string; message: string };
export type CheckResult = {
  ok: boolean;
  violations: ResidencyCellViolation[];
  notice?: string;
};
export declare function check(root?: string): CheckResult;
```

Zero-input notice string (exact, for the empty-tree assertion):

```
residency-cell: zero Terraform cell roots, zero enabled catalog cells, or zero Wrangler apps
```

Use it whenever **any** of those three counts is zero, **after** `catalog.json` has been parsed. Missing catalog uses the violation message `missing catalog.json` and no `notice`.

---

### Task 1: Catalog package (Node)

**Files:** Create `packages/residency/**` as listed above except wrangler / worker vitest (those are task 2). Modify `tsconfig.json` (root references). `pnpm-lock.yaml` via `pnpm install`.

`catalog.json`:

```json
{
  "cells": {
    "au": {
      "enabled": true,
      "cloudflareRegionalServices": "au",
      "awsRegion": "ap-southeast-2"
    },
    "ca": {
      "enabled": false,
      "cloudflareRegionalServices": "ca",
      "awsRegion": "ca-central-1"
    },
    "eu": {
      "enabled": false,
      "cloudflareRegionalServices": "ee",
      "awsRegion": "eu-central-1"
    },
    "us": {
      "enabled": false,
      "cloudflareRegionalServices": "us",
      "awsRegion": "us-east-1"
    }
  },
  "regionalOnlyPackages": ["@community-hub/db", "@community-hub/crypto"]
}
```

`tsconfig.json` (package): extend `tsconfig.base.json`; `resolveJsonModule: true`; `rootDir` `./src`; `outDir` `./dist`; `lib` `ES2022`; `types` `@cloudflare/workers-types` (no `@types/node` in the **build** config — same as crypto); `include` `src/**/*.ts` and `src/**/*.json`; `exclude` `src/**/*.test.ts`.

`tsconfig.test.json` (this is what makes `@ts-expect-error` real). Same pattern as `packages/db` / `packages/crypto`, except **do** include `test/package-graph.test.ts` (crypto's test tsconfig only includes `src/**` and `test/vectors/**`, so `test/dist-absence.test.ts` is a blind spot — do not copy that):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "composite": false,
    "declaration": false,
    "declarationMap": false,
    "rootDir": ".",
    "lib": ["ES2022"],
    "types": ["node", "@cloudflare/workers-types"],
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts", "src/**/*.json", "test/package-graph.test.ts"]
}
```

`package.json`: name `@community-hub/residency`; `exports` `.` → `dist`; scripts `lint` / `typecheck` (`tsc --build && tsc --noEmit -p tsconfig.test.json`) / `test` (`pnpm run build && vitest run --config vitest.config.ts`) / `build`; devDeps typescript, vitest, `@cloudflare/workers-types`, `@types/node` (needed for the test tsconfig). No production `dependencies`.

Root `tsconfig.json` `references`: add `{ "path": "./packages/residency" }` next to crypto.

- [ ] **Step 1: RED** — write `src/index.test.ts` against the public API (file will not compile until Step 3). Import `catalog.json` in the test; do **not** use `node:fs` here — task 2 runs this file on workerd.

```ts
import { describe, expect, it } from "vitest";
import catalog from "./catalog.json" with { type: "json" };
import { getCell, parseRegionId, regionalOnlyPackages, type EnabledRegionId } from "./index.js";

describe("catalog.json", () => {
  it("has exactly au, ca, eu, us with the required fields", () => {
    expect(Object.keys(catalog.cells).sort()).toEqual(["au", "ca", "eu", "us"]);
    for (const cell of Object.values(catalog.cells)) {
      expect(typeof cell.enabled).toBe("boolean");
      expect(cell.cloudflareRegionalServices.length).toBeGreaterThan(0);
      expect(cell.awsRegion.length).toBeGreaterThan(0);
    }
    expect(catalog.regionalOnlyPackages).toEqual(
      expect.arrayContaining(["@community-hub/db", "@community-hub/crypto"]),
    );
    expect(regionalOnlyPackages).toEqual(catalog.regionalOnlyPackages);
  });

  it("locks EnabledRegionId to the JSON enabled set", () => {
    const enabled = Object.entries(catalog.cells)
      .filter(([, c]) => c.enabled)
      .map(([id]) => id);
    expect(enabled).toEqual(["au"] satisfies EnabledRegionId[]);
  });
});

describe("getCell", () => {
  it("returns the AU cell", () => {
    expect(getCell("au")).toEqual({
      id: "au",
      enabled: true,
      cloudflareRegionalServices: "au",
      awsRegion: "ap-southeast-2",
    });
  });

  it("does not compile for a stub", () => {
    // @ts-expect-error stubs are not EnabledRegionId
    getCell("ca");
  });

  it("throws when the alias is mis-widened", () => {
    expect(() => getCell("ca" as EnabledRegionId)).toThrow(/not enabled/i);
  });
});

describe("parseRegionId", () => {
  it("accepts au", () => {
    expect(parseRegionId("au")).toBe("au");
  });

  it.each(["ca", "us", "", "nope"])("throws for %j", (id) => {
    expect(() => parseRegionId(id)).toThrow(/not enabled/i);
  });
});
```

Node-only `src/package-graph.test.ts` is **not** created in this task if it would be picked up by the worker include glob. Put the production-deps assertion in `test/package-graph.test.ts` (outside `src/`) and include it only from `vitest.config.ts` (`include: ["src/**/*.test.ts", "test/package-graph.test.ts"]`). Worker config (task 2) includes `src/**/*.test.ts` only.

- [ ] **Step 2:** Run `pnpm test --filter @community-hub/residency`. Expected: FAIL (package missing or exports missing).

- [ ] **Step 3: GREEN** — `index.ts`:

```ts
import catalog from "./catalog.json" with { type: "json" };

export type RegionId = keyof typeof catalog.cells;
export type EnabledRegionId = "au";
export type Cell = (typeof catalog.cells)[RegionId] & { id: RegionId };

export const regionalOnlyPackages: readonly string[] = catalog.regionalOnlyPackages;

const NOT_ENABLED = "region is not enabled";

export function parseRegionId(id: string): EnabledRegionId {
  if (id === "au" && catalog.cells.au.enabled === true) {
    return "au";
  }
  throw new Error(NOT_ENABLED);
}

export function getCell(id: EnabledRegionId): Cell & { id: EnabledRegionId } {
  const rec = catalog.cells[id];
  if (rec === undefined || rec.enabled !== true) {
    throw new Error(NOT_ENABLED);
  }
  return { ...rec, id };
}
```

Wire package.json, tsconfig, root reference, `pnpm install` (lockfile). Node vitest `include` is `src/**/*.test.ts` and `test/package-graph.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("package graph", () => {
  it("has no production deps", () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});
```

`pnpm test --filter @community-hub/residency` and `pnpm typecheck` pass. `tsc --noEmit -p packages/residency/tsconfig.test.json` must error if the `@ts-expect-error` on `getCell("ca")` becomes unused (that is the compile-time half of the test).

- [ ] **Step 4: Commit**

```
feat(residency): add cell catalog and typed getCell

AU is the only enabled region. Stubs exist so the record shape is
uniform. getCell throws if the handwritten EnabledRegionId drifts.

Refs: docs/plans/2026-09-20-packages-residency.md task 1
```

---

### Task 2: JSON import on workerd

**Files:** Create `packages/residency/wrangler.jsonc` (copy crypto harness: `name` `residency-harness`, `main` `test/workerd-entry.ts`, `compatibility_date` `2026-03-10`, `workers_dev: false`, `preview_urls: false`). Create `test/workerd-entry.ts` (same fetch stub as crypto). Create `vitest.worker.config.ts` via `defineWorkersConfig`, `include: ["src/**/*.test.ts"]`. Create `test/tsconfig.json` if crypto's pattern is required for the entry file. Modify `package.json` `test` to `pnpm run build && vitest run --config vitest.config.ts && vitest run --config vitest.worker.config.ts`. Add devDeps `@cloudflare/vitest-pool-workers` and `wrangler` at the same versions as crypto (`^0.12.21`, `^4.134.0`). `pnpm-lock.yaml`.

Do **not** put this wrangler config under `apps/`.

- [ ] **Step 1: RED** — add the worker config and run `pnpm test --filter @community-hub/residency`. Expected: FAIL (worker config missing or JSON import error in the pool).

- [ ] **Step 2: GREEN** — harness files as above. Re-run. Expected: both Node and workerd pass, including `getCell("au").awsRegion === "ap-southeast-2"`.

If the pool cannot import `catalog.json`: **stop and report**. Do not inline the catalog in TypeScript.

- [ ] **Step 3: Commit**

```
test(residency): prove catalog.json loads on workerd

A global Worker may import this package; the JSON module has to
survive the same pool crypto already uses.

Refs: docs/plans/2026-09-20-packages-residency.md task 2
```

---

### Task 3: Catalog ↔ Terraform checker (zero-input)

**Files:** Create `tooling/checks/residency-cell/{package.json,tsconfig.json,vitest.config.ts,check.ts,selftest.ts,README.md}` mirroring `@community-hub/check-event-names` (`check(root?: string)`, vitest `include: ["selftest.ts"]`). Create fixtures below. **Do not** wire `run.ts` yet (import graph is task 4; a live `check()` that only does Terraform would still need the import job before CI grows a silent hole).

`package.json` name: `@community-hub/check-residency-cell`.

**Terraform job.** Read `packages/residency/src/catalog.json` from `root`. If the file is missing, return immediately with a violation `{ file: "packages/residency/src/catalog.json", message: "missing catalog.json" }`, `ok: false`, **no** `notice`. Invalid JSON is the same shape with message `catalog.json is not valid JSON`. Only after a catalog object exists: discover `infra/regions/<id>/` directories that contain `backend/` or `env/`. Ignore `infra/modules`, `infra/bootstrap`, `infra/global`.

Comment-strip HCL/tfvars (quoted strings intact). Collect `aws_region` from every `env/*.tfvars` and `region` from every `backend/*.hcl`.

Apply the spec table. Enabled cell with no matching root fails even when another region's root exists (see `enabled-without-root` below). Disabled cell with a root passes. tfvars vs backend disagreement fails even if the catalog matches one side.

**Zero-input.** Evaluated only after a catalog has been parsed. If Terraform cell root count is 0, **or** enabled catalog cells is 0, **or** Wrangler app count is 0: set `notice` to the locked string above and `ok: false`. Count Wrangler apps the same way as `worker-config` (`apps/*/wrangler.json` or `wrangler.jsonc`) so this job has a real input on the live tree before task 4 scans their source.

**Fixtures:**

| Fixture                    | Tree                                                                                                                                           | Expect                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `empty-tree/`              | Catalog present, **every** cell `enabled: false`; no `infra/regions/`; no `apps/`                                                              | fail, `notice` matches `/zero/i`, no missing-catalog violation     |
| `missing-catalog/`         | No `packages/residency/src/catalog.json`; **has** matching AU terraform + a Wrangler app (so zero-input would not fire if the catalog existed) | fail, violation message `missing catalog.json`, `notice` undefined |
| `aws-mismatch/`            | AU catalog `us-east-1`, tfvars+backend `ap-southeast-2` + Wrangler                                                                             | fail                                                               |
| `tfvars-backend-disagree/` | tfvars `ap-southeast-2`, backend `us-east-1` + Wrangler                                                                                        | fail                                                               |
| `enabled-without-root/`    | au enabled, only `infra/regions/ca/` present + Wrangler                                                                                        | fail                                                               |
| `unknown-root/`            | `infra/regions/jp/` and no catalog key `jp` (still include au enabled + matching `infra/regions/au/` + Wrangler)                               | fail                                                               |
| `valid-au/`                | Mini copy of live AU (`ap-southeast-2` in both tfvars and both backends) + disabled `ca` with no terraform + Wrangler                          | pass                                                               |
| `disabled-with-root/`      | au matching + `infra/regions/ca/` present, catalog `ca.enabled: false` + Wrangler                                                              | pass                                                               |

- [ ] **Step 1: RED** — `selftest.ts` loops must-fail / must-pass names calling `check(path.join(fixturesDir, name))`. Run `pnpm test --filter @community-hub/check-residency-cell`. Expected: FAIL.

- [ ] **Step 2: GREEN** — implement Terraform + zero-input only. Missing catalog returns immediately (no `notice`). Import-graph function may be a no-op that still counts Wrangler apps. Empty-tree notice assertion required (`notice` matches `/zero/i`). `missing-catalog` asserts message `missing catalog.json` and `notice` undefined. `valid-au` passes.

- [ ] **Step 3: Commit**

```
feat(tooling): cross-check residency catalog against Terraform

AU awsRegion must match every tfvars aws_region and backend region.
An empty tree fails with a notice instead of a silent pass.

Refs: docs/plans/2026-09-20-packages-residency.md task 3
```

---

### Task 4: Global Worker import graph + wire `check:boundaries`

**Files:** Modify `tooling/checks/residency-cell/check.ts` (import graph). Add fixtures. Modify `selftest.ts`. Modify `tooling/checks/run.ts` (call `check()` with no args; print `notice`; fail on `!ok`).

**Scan set.** Under each Wrangler app dir, and under each reached workspace package dir: every `.ts` file except skip-dirs `node_modules`, `dist`, `coverage`, `test`, `tests`, `.turbo`, `fixtures`, and except `*.test.ts`.

**Missing meta / class.** Wrangler without `worker.meta.json`, or missing/unknown `class`: violation. Do not skip.

**`regional`:** do not apply reach rules. Fixture-only until `api-au-skeleton`.

**`global-no-pii` reach (A–E)** as the spec. Resolve `@community-hub/<pkg>` to `packages/<pkg>` or `apps/<pkg>` when that directory exists and `package.json` `name` matches. Build a `Map<packageName, absDir>` from `regionalOnlyPackages` using that same resolver (fail the check if a listed name cannot be resolved under `root`). Follow `dependencies` and `peerDependencies` with a `workspace:` version. `devDependencies` ignored.

Relative specifier: `path.resolve(dirname(file), specifier)` without the query string. Fail if the resolved path is **inside** any mapped regional-only directory (`path.relative(absDir, resolved)` is empty or does not start with `..` and is not an absolute escape). Do **not** string-match `/packages/db/` or `/packages/crypto/`.

Non-literal `import(`: after stripping comments, `import` + `(` + not a quoted string → violation. A quoted `import("@community-hub/kernel")` is a literal and is handled by A–D (kernel is not regional-only → pass). The substring `import(` inside a string literal or a remaining JSDoc/prose comment after strip must not fire.

**New fixtures** (each includes the valid AU terraform trio + catalog with au enabled):

| Fixture                                                                                                                                      | Expect |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `import-db/`                                                                                                                                 | fail   |
| `import-crypto/`                                                                                                                             | fail   |
| `import-type-crypto/`                                                                                                                        | fail   |
| `import-deep-db/` `from "@community-hub/db/foo"`                                                                                             | fail   |
| `import-relative-crypto/` file at `apps/edge/worker/entry.ts` importing `../../../packages/crypto/src/index.ts`                              | fail   |
| `import-transitive-crypto/` app imports `@community-hub/helper`; `packages/helper/package.json` has `"@community-hub/crypto": "workspace:*"` | fail   |
| `missing-meta/` Wrangler, no `worker.meta.json`                                                                                              | fail   |
| `dynamic-nonliteral/` `const name = "@community-hub/kernel"; await import(name);`                                                            | fail   |
| `entry-outside-src/` `worker/entry.ts` imports crypto, no `src/`                                                                             | fail   |
| `regional-imports-db/` `class: regional`, imports db                                                                                         | pass   |
| `global-safe/` imports only a stub `@community-hub/kernel` (fixture-local package, no crypto dep)                                            | pass   |
| `dynamic-literal/` `await import("@community-hub/kernel")`                                                                                   | pass   |
| `import-call-in-string/` source contains the characters `import(` only inside a string and a JSDoc block, no real `import(` call             | pass   |

Live `check()` with no args must pass on this repo (gateway + `infra/regions/au/` + real catalog).

- [ ] **Step 1: RED** — add fixtures + selftest rows. Run checker tests. Expected: FAIL (rules not implemented).

- [ ] **Step 2: GREEN** — implement A–E. Wire `run.ts`. `pnpm test --filter @community-hub/check-residency-cell` green. `pnpm check:boundaries` green on the live tree.

- [ ] **Step 3: Commit**

```
feat(tooling): ban regional packages from global-no-pii Workers

Direct, deep, relative, transitive workspace, and non-literal
dynamic imports all fail. The scan is the whole app directory.

Refs: docs/plans/2026-09-20-packages-residency.md task 4
```

---

### Task 5: Gateway ESLint crypto ban

**Files:** Modify `eslint.config.js` gateway `no-restricted-imports` paths — add `@community-hub/crypto` with message `gateway must not import @community-hub/crypto (including import type).` Modify `tooling/checks/encrypted-column/selftest.ts` gateway rule block to the same three paths (db, kernel/module, crypto). Create `tooling/checks/encrypted-column/fixtures/fail/apps/gateway/src/import-crypto.ts` and `import-type-crypto.ts` (mirror `import-db.ts` / `import-type-db.ts`). Add those files to `mustFail` with `RESTRICTED` count 1.

- [ ] **Step 1: RED** — add the two fixtures and mustFail rows. `pnpm test --filter @community-hub/check-encrypted-column`. Expected: FAIL (0 hits for crypto; ESLint does not yet ban it).

- [ ] **Step 2: GREEN** — update both ESLint configs. Re-run. Expected: PASS. `pnpm lint` still green on live gateway.

- [ ] **Step 3: Commit**

```
chore(eslint): ban crypto on the gateway fast path

The residency-cell checker remains the class-keyed rule. This glob
catches the only live global-no-pii app at lint time.

Refs: docs/plans/2026-09-20-packages-residency.md task 5
```

---

### Task 6: Architecture, AGENTS, roadmap, full gate

**Files:** `architecture.md` (header last-updated; §7.5 step 3; §8.3 last two bullets). `AGENTS.md` §10 Stage 1 checker list (add `residency-cell`). `docs/roadmap.md` snapshot + Phase 0 row.

§7.5 step 3 replacement (exact intent): add the region to `packages/residency/src/catalog.json`, set `enabled: true`, provision `infra/regions/<id>/`, and pass `residency-cell` (catalog `awsRegion` matches that root's tfvars and backends). Control-plane enablement stays a later chunk.

§8.3 replacement (exact intent):

- Global apps (`gateway`, later `control-plane`, `ops-console`) cannot import packages the residency catalog marks `regionalOnlyPackages` (`@community-hub/db` and `@community-hub/crypto` today), including `import type`, deep specifiers, relative paths, transitive `workspace:` dependencies, and non-literal `import()`. Enforcement is `residency-cell` keyed off `worker.meta.json` `class: global-no-pii`, plus ESLint `no-restricted-imports` on `apps/gateway` as a fast path. Worker class vocabulary stays in `worker.meta.json` / `worker-config` (ADR 0001).
- Also still: kernel must not import `@community-hub/db`; checkers worker-config, schema-rls, event-names, sql-session-ban, residency-payload, residency-cell. dependency-cruiser omitted until it has a real input and a must-fail fixture.

Roadmap snapshot: Last shipped `packages-residency`; Next chunk `packages-ui`; Phase 0 `6 / 10 done`. Row `packages-residency` → **done**, spec `2026-09-20-packages-residency`. Next spec blurb: `packages-ui`.

- [ ] **Step 1:** Apply doc edits. Roadmap last.

- [ ] **Step 2:** Full gate, uncached, matching CI Stage 1–2 commands:

```
pnpm exec prettier --check .
pnpm lint --force
pnpm typecheck --force
pnpm check:boundaries
pnpm test --force
```

Expected: all green. Gateway tests still `{ ok: true }`. `pnpm exec wrangler deploy --dry-run` in `apps/gateway` succeeds.

Then the CI terraform job is unchanged (this chunk does not edit `infra/`). Do not run live `terraform apply`.

- [ ] **Step 3: Commit** (roadmap is this commit — last on the branch)

```
docs: record packages-residency as done

§8.3 names the class-keyed import graph. Catalog AWS region is
checked against the AU cell root.

Refs: docs/plans/2026-09-20-packages-residency.md task 6
```

---

## Spec coverage

| Spec item                                                                                                     | Task             |
| ------------------------------------------------------------------------------------------------------------- | ---------------- |
| `catalog.json`, derived `RegionId`, handwritten `EnabledRegionId` + lock test                                 | 1                |
| `getCell` / `parseRegionId`; runtime throw on stub                                                            | 1                |
| `@ts-expect-error` via `tsconfig.test.json` two-part typecheck                                                | 1                |
| Root `tsconfig.json` reference                                                                                | 1                |
| No Cloudflare/AWS/db/crypto deps (`test/package-graph.test.ts` under test tsconfig with `types: ["node", …]`) | 1                |
| Workerd JSON import; stop-and-report                                                                          | 2                |
| Catalog ↔ Terraform AWS region; tfvars vs backend                                                             | 3                |
| Zero-input notice; empty-tree (all cells disabled)                                                            | 3                |
| Missing `catalog.json` (separate fixture, no notice)                                                          | 3                |
| Disabled cell with Terraform root allowed                                                                     | 3                |
| Direct / type / deep / relative / transitive imports                                                          | 4                |
| Relative path uses resolved package dirs, not `/packages/db/` strings                                         | 4                |
| Non-literal `import()`; must-pass literal `import("…")` and `import(` in a string                             | 4                |
| Scan whole app directory (`worker/entry.ts`)                                                                  | 4                |
| Missing `worker.meta.json` fails                                                                              | 4                |
| `regional` fixture-only pass                                                                                  | 4                |
| Wire `check:boundaries`                                                                                       | 4                |
| Gateway ESLint crypto                                                                                         | 5                |
| Architecture §8.3 / §7.5, AGENTS §10, roadmap                                                                 | 6                |
| Gateway `/health` unchanged                                                                                   | 6 (re-run)       |
| `cloudflareRegionalServices` not cross-checked                                                                | out (documented) |
