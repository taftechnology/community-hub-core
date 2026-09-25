# Plan: packages/ui foundations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the web UI pipeline: a platform-neutral token file, generated CSS, one copied Base UI Button, and gates that fail when tokens, contrast, or the Button's opacity rule drift.

**Architecture:** `@community-hub/tokens` owns `tokens.json` and a pure generator. `@community-hub/ui` peers that package, ships the `base-nova` Button as source, and owns `theme.css`. `@community-hub/check-tokens` validates, formats with the repo Prettier config, and compares. Axe and a Tailwind Node compile run in the UI package's tests.

**Tech Stack:** TypeScript 5.8, Vitest 3, React 19.3.0, Tailwind CSS 4.3.3, `@tailwindcss/node` 4.3.3, `@base-ui/react` 1.8.0, axe-core 4.13.0, jsdom 30.1.1.

**Spec:** `docs/specs/2026-09-25-packages-ui.md` (approved 2026-09-25, Abdus Salam)

**ADR:** `docs/adr/0007-token-source-is-json.md` (written in task 5; accepted with this plan's approval)

Status: draft

**Branch:** `feat/2026-09-25-packages-ui` · one PR · 6 tasks, one commit each

## Global Constraints

- Style is `base-nova` and CLI is `4.21.0`. No `radix-ui`. No style other than `base-nova`.
- Token properties start with `--ch-`. Theme left-hand sides use Tailwind namespaces (`--color-*`, `--spacing`, `--radius-*`, `--text-*`, `--font-weight-*`).
- `space` is the number `4`. Lengths are pixel numbers divided by 16 and emitted as the shortest exact `rem`. `fontWeight` is copied as a number.
- Colors are `#` plus six lowercase hex digits. No alpha in JSON.
- Contrast uses the unrounded WCAG ratio. `text` passes only when `ratio >= 4.5`. `large-text` and `non-text` pass when `ratio >= 3`.
- `missing-pair` counts only a color key present in both modes and absent from every pair of that mode.
- The barrel does not import CSS. `exports` point at TypeScript source.
- Peers: `react` `^19`, `react-dom` `^19`, `tailwindcss` `^4`, `@community-hub/tokens` `workspace:*`. Exact devDependency pins are in the spec's Dependencies section. `@tailwindcss/node` is `4.3.3`.
- `@community-hub/ui` and `@community-hub/tokens` stay off `regionalOnlyPackages`.
- Do not add `packages/ui-native`, Input, Dialog, product patterns, an app, elevation, or shadow tokens.
- Prettier clean on every touched file except `tooling/checks/tokens/fixtures/`, which is gitignored by Prettier.
- The last commit updates `docs/roadmap.md`. Session scratch is never committed.

**Stop and report** (do not work around):

- `components.json` schema rejects `version` or `style`. Do not drop either field.
- The shadcn CLI returns a Button that imports `radix-ui`.
- The first Tailwind compile emits a baked length instead of `var(--ch-…)`, or does not define `--radius-md` as `var(--ch-rounded-md)`. Do not weaken the assertion, retarget the Button at `--ch-rounded-md`, or remove `@theme inline` in that change.
- `pnpm install` or the shadcn CLI cannot be reached.

---

## File map

| Path                                    | Role                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/tokens/src/tokens.json`       | Source palette                                                                         |
| `packages/tokens/src/generate.ts`       | `validateTokens`, `generateTokens`, contrast, namespace and self-reference classifiers |
| `packages/tokens/src/generate.test.ts`  | Generator and validation unit tests                                                    |
| `packages/tokens/src/tokens.css`        | Generated custom properties                                                            |
| `packages/tokens/src/index.ts`          | Re-exports the JSON and the generator                                                  |
| `tooling/checks/tokens/`                | `check(root)`, fixtures, self-test                                                     |
| `tooling/checks/run.ts`                 | Wires the checker (task 4, not task 2)                                                 |
| `packages/ui/src/button.tsx`            | Copied `base-nova` Button, opacity edits applied                                       |
| `packages/ui/src/lib/utils.ts`          | `cn`                                                                                   |
| `packages/ui/src/opacity.ts`            | Class-string scanner                                                                   |
| `packages/ui/theme.css`                 | Generated Tailwind map                                                                 |
| `packages/ui/components.json`           | CLI `4.21.0`, style `base-nova`                                                        |
| `packages/ui/THIRD_PARTY_NOTICES`       | MIT text                                                                               |
| `docs/adr/0007-token-source-is-json.md` | Amends the D16 token row                                                               |

## Interfaces (locked)

```ts
export type Violation = { id: string; message: string };

export function validateTokens(value: unknown): Violation[];
export function missingPairViolations(value: unknown): Violation[];
export function contrastViolations(value: unknown): Violation[];
export function generateTokens(value: unknown): { tokensCss: string; themeCss: string };
export function contrastRatio(foreground: string, background: string): number;
export function namespaceViolations(propertyNames: string[]): Violation[];
export function selfReferenceViolations(themeCss: string): Violation[];
```

`validateTokens` does not generate. `generateTokens` is only called after `validateTokens` returned `[]`. `namespaceViolations` returns `{id: "namespace"}` when a name starts with a banned prefix. `selfReferenceViolations` returns `{id: "self-reference"}` when a declaration's left-hand side equals its `var()` target.

Banned prefixes, in this order: `--color-`, `--font-`, `--text-`, `--font-weight-`, `--tracking-`, `--leading-`, `--breakpoint-`, `--container-`, `--spacing-`, `--radius-`, `--shadow-`, `--inset-shadow-`, `--drop-shadow-`, `--blur-`, `--perspective-`, `--aspect-`, `--ease-`, `--animate-`.

Property patterns:

| Group      | Token property       | Theme mapping                                 |
| ---------- | -------------------- | --------------------------------------------- |
| color      | `--ch-<key>`         | `--color-<key>: var(--ch-<key>)`              |
| space      | `--ch-space-unit`    | `--spacing: var(--ch-space-unit)`             |
| radius     | `--ch-rounded-<key>` | `--radius-<key>: var(--ch-rounded-<key>)`     |
| fontSize   | `--ch-type-<key>`    | `--text-<key>: var(--ch-type-<key>)`          |
| fontWeight | `--ch-weight-<key>`  | `--font-weight-<key>: var(--ch-weight-<key>)` |

Checker path constants: `packages/tokens/src/tokens.json`, `packages/tokens/src/tokens.css`, `packages/ui/theme.css`. `check(root = process.cwd())` returns `{ ok: boolean; violations: Violation[] }`.

---

## Task 1: Token package and generator

**Files:** `packages/tokens/**` (package.json, tsconfig.json, src as in the file map), root `tsconfig.json` (add the tokens reference only)

**Rule it must not break:** the package has no runtime dependencies. It does not import React, Tailwind, or Prettier.

**Produces:** the interfaces above, plus committed `tokens.json` and `tokens.css`.

- [ ] **RED.** `packages/tokens/src/generate.test.ts` imports `validateTokens`, `generateTokens`, `contrastRatio`, `namespaceViolations`, and `selfReferenceViolations`. Assert:

  - `contrastRatio("#888888", "#ffffff")` is `>= 3` and `< 4.5`, and `contrastRatio("#171717", "#ffffff")` is `>= 4.5`. A ratio of `4.499` fails a `text` comparison (`>= 4.5` is false).
  - `validateTokens` on the committed JSON returns `[]`. `missingPairViolations` and `contrastViolations` on it return `[]`.
  - A color key `"2.5"` returns `[{ id: "bad-key" }]`. A `space` of `"-1"` or a string returns `[{ id: "bad-value" }]` and does not return `bad-key`.
  - `generateTokens` on the committed JSON includes `--ch-space-unit: 0.25rem`, `--ch-background: #ffffff`, `--spacing: var(--ch-space-unit)`, and `--radius-md: var(--ch-rounded-md)`. It does not include a property whose name starts with a banned prefix.
  - `namespaceViolations(["--shadow-sm"])` is `[{ id: "namespace" }]`. `namespaceViolations(["--ch-background"])` is `[]`.
  - `selfReferenceViolations("--radius-md: var(--radius-md);")` is `[{ id: "self-reference" }]`. `selfReferenceViolations("--radius-md: var(--ch-rounded-md);")` is `[]`.

  Run `pnpm --filter @community-hub/tokens test`. Expected: FAIL (module missing).

- [ ] **GREEN.** Implement `generate.ts` with the WCAG relative-luminance formula (sRGB to linear, then `0.2126 R + 0.7152 G + 0.0722 B`). `validateTokens` runs these seven together and returns every hit, without stopping at the first: `unknown-group` (top-level keys other than `space`, `radius`, `fontSize`, `fontWeight`, `modes`, `pairs`), `bad-color`, `bad-key`, `bad-value`, `mode-keys`, `unknown-key`, `unknown-purpose`. `missingPairViolations` and `contrastViolations` are separate. The checker calls them only after `validateTokens` returned `[]`. Thresholds are in Global Constraints. `missing-pair` ignores a key that exists in only one mode.

  Committed `tokens.json`:

  - `space`: `4`
  - `radius`: `md` `6`, `lg` `8`
  - `fontSize`: `xs` `12`, `sm` `14`
  - `fontWeight`: `medium` `500`
  - Light colors: `background` `#ffffff`, `foreground` `#171717`, `primary` `#171717`, `primary-foreground` `#ffffff`, `secondary` `#f5f5f5`, `secondary-foreground` `#171717`, `muted` `#f5f5f5`, `border` `#171717`, `input` `#171717`, `ring` `#171717`, `destructive` `#991b1b`
  - Dark colors: the same keys, with `background` `#171717`, `foreground` `#ffffff`, `primary` `#ffffff`, `primary-foreground` `#171717`, `secondary` `#262626`, `secondary-foreground` `#ffffff`, `muted` `#262626`, `border` `#ffffff`, `input` `#ffffff`, `ring` `#ffffff`, `destructive` `#f87171`
  - Pairs, both modes: `foreground`/`background` text; `primary-foreground`/`primary` text; `secondary-foreground`/`secondary` text; `foreground`/`muted` text; `destructive`/`background` text; `border`/`background` non-text; `input`/`background` non-text; `ring`/`background` non-text

  `package.json` name `@community-hub/tokens`, `"type": "module"`, no `dependencies`. Exports `.` to `./src/index.ts`, `./tokens.css` to `./src/tokens.css`, `./generate` to `./src/generate.ts`. Scripts: `lint`, `typecheck` (`tsc --build`), `test` (`vitest run --config vitest.config.ts`), `build` (`tsc --build`). A `generate` script writes `src/tokens.css` by running `generateTokens` and then Prettier via `pnpm exec prettier --write` from the repo root (Prettier is not a package dependency). `tsconfig.json` extends `../../tsconfig.base.json`, `rootDir` `./src`, includes `src/**/*.ts` and `src/**/*.json`, excludes tests. Add `{ "path": "./packages/tokens" }` to the root `tsconfig.json` `references`.

  Run the test again. Expected: PASS. Run the generate script, then `pnpm exec prettier --check packages/tokens/src/tokens.css`. Expected: PASS.

- [ ] Local gate: `pnpm --filter @community-hub/tokens lint && pnpm --filter @community-hub/tokens typecheck && pnpm --filter @community-hub/tokens test && pnpm check:boundaries`
- [ ] Commit: `feat(tokens): add the platform-neutral token source` with `Refs: docs/plans/2026-09-25-packages-ui.md task 1`

## Task 2: Token checker fixtures

**Files:** `tooling/checks/tokens/**`, `.prettierignore`

**Consumes:** `validateTokens`, `generateTokens`, `namespaceViolations`, `selfReferenceViolations`

**Rule it must not break:** do not add the checker to `tooling/checks/run.ts` in this task. The live tree has no `theme.css` yet, so a wired check would fail for the wrong reason.

- [ ] **RED.** `selftest.ts` calls `check(fixtureRoot)` and asserts the violation-id set:

  | Fixture           | Ids               |
  | ----------------- | ----------------- |
  | `valid`           | empty             |
  | `drift-tokens`    | `drift-tokens`    |
  | `drift-theme`     | `drift-theme`     |
  | `contrast-fail`   | `contrast`        |
  | `missing-pair`    | `missing-pair`    |
  | `mode-keys`       | `mode-keys`       |
  | `unknown-purpose` | `unknown-purpose` |
  | `unknown-key`     | `unknown-key`     |
  | `unknown-group`   | `unknown-group`   |
  | `unknown-var`     | `unknown-var`     |
  | `bad-color`       | `bad-color`       |
  | `bad-key`         | `bad-key`         |
  | `bad-value`       | `bad-value`       |
  | `missing-tokens`  | `missing-tokens`  |
  | `invalid-tokens`  | `invalid-tokens`  |

  `valid` is the committed JSON shape with one extra non-text pair: foreground `#888888`, background `#ffffff` (ratio `3.545`). Its `packages/ui/src/example.tsx` contains `var(--ch-background)`. Both CSS files are the formatted generator output. Each other fixture copies `valid` and changes one thing: a trailing space in one CSS file; a dark text pair `#991b1b` on `#171717` (ratio `2.157`); a color key in neither of that mode's pairs; light missing `ring`; `purpose: "txt"`; a pair key `nope`; a top-level `lineHeight`; `var(--not-a-token)`; color `#fff`; color key `2.5`; `space: "4"`; no `tokens.json`; `tokens.json` containing `{`. `bad-key` keeps every value valid. `bad-value` keeps every key valid.

  Also assert `missing-tokens` message says the file is absent, and `invalid-tokens` says it is not valid JSON. Both include the path.

  Run `pnpm --filter @community-hub/check-tokens test`. Expected: FAIL.

- [ ] **GREEN.** `check.ts` order:

  1. Missing `packages/tokens/src/tokens.json` → `{missing-tokens}` and stop.
  2. File exists, `JSON.parse` throws → `{invalid-tokens}` and stop.
  3. `validateTokens`. If non-empty, return that set and stop. Do not generate.
  4. Otherwise `generateTokens`, format both strings with Prettier `resolveConfig` for the target path under `root`, compare to the committed files (`drift-tokens`, `drift-theme`), then `contrastViolations`, `missingPairViolations`, `namespaceViolations` on generated token property names, `selfReferenceViolations` on the generated `theme.css`, and `unknown-var`.

  `unknown-var` reads `packages/ui` source under `root`. A name is known if it is a custom property in the generated `tokens.css` or a left-hand side in the generated `theme.css`.

  Package `@community-hub/check-tokens` depends on `@community-hub/tokens` via `workspace:*` and on `prettier` at the same range as the repo root (`^3.5.3`). Add `tooling/checks/tokens/fixtures/` to `.prettierignore`.

  Run the test again. Expected: PASS. `pnpm check:boundaries` still does not mention tokens.

- [ ] Local gate: `pnpm --filter @community-hub/check-tokens lint && pnpm --filter @community-hub/check-tokens typecheck && pnpm --filter @community-hub/check-tokens test && pnpm check:boundaries`
- [ ] Commit: `feat(tooling): check token source against generated CSS` with `Refs: docs/plans/2026-09-25-packages-ui.md task 2`

## Task 3: UI package, Button, opacity gate

**Files:** `packages/ui/**` except the compile test and the axe test, `eslint.config.js`, root `tsconfig.json` (add `./packages/ui`), `.gitignore`

**Consumes:** `generateTokens`

**Rule it must not break:** the barrel does not import a stylesheet. No `radix-ui` dependency.

- [ ] **RED.** `packages/ui/src/opacity.test.ts`:

  ```ts
  import { readFileSync } from "node:fs";
  import { opacityViolations } from "./opacity";

  it("rejects a focus ring opacity modifier", () => {
    expect(opacityViolations("focus-visible:ring-ring/50")).toEqual(["focus-visible:ring-ring/50"]);
  });

  it("allows hover opacity", () => {
    expect(opacityViolations("hover:bg-primary/80")).toEqual([]);
  });

  it("accepts the copied Button", () => {
    const source = readFileSync(new URL("./button.tsx", import.meta.url), "utf8");
    expect(opacityViolations(source)).toEqual([]);
  });
  ```

  Classification, applied after stripping utilities under `hover:` (including `dark:hover:`):

  - Focus ring: any `ring-*`, and any `border-*` or `outline-*` under `focus-visible:`.
  - Default-state background: `bg-*` with no state variant, or with only `dark:`.
  - `aria-expanded:` and `active:` are not default state. `color-mix` is not scanned.

  Run `pnpm --filter @community-hub/ui test`. Expected: FAIL.

- [ ] **GREEN.** Package peers and devDependency pins as in the spec, plus dependencies `@base-ui/react@1.8.0`, `class-variance-authority@0.7.1`, `clsx@2.1.1`, `tailwind-merge@3.7.0`. Do not add `@tailwindcss/node` until task 4. Exports `.` → `./src/index.ts` and `./theme.css` → `./theme.css`. `tsconfig.json` sets `"jsx": "react-jsx"`, includes `src/**/*.ts` and `src/**/*.tsx`, excludes tests. `tsconfig.test.json` sets `composite: false`, `noEmit: true`, the same `jsx`, and includes the tests. `typecheck` runs `tsc --build && tsc --noEmit -p tsconfig.test.json`.

  `components.json`: `"version": "4.21.0"`, `"style": "base-nova"`, Tailwind CSS path `packages/ui/.shadcn.css`, alias `cn` → `src/lib/utils.ts`. Add `packages/ui/.shadcn.css` to `.gitignore`. Script `shadcn` creates that file if missing, then runs `pnpm dlx shadcn@4.21.0` with the arguments it received. README documents `pnpm --filter @community-hub/ui shadcn`.

  Run the script to add the Button. Confirm the import is `@base-ui/react/button` and `{ cn } from "cn"`. Add this header to `button.tsx` and `src/lib/utils.ts`:

  ```ts
  // Copied from shadcn/ui base-nova (CLI 4.21.0). MIT License. See THIRD_PARTY_NOTICES.
  ```

  `THIRD_PARTY_NOTICES` carries the MIT licence text for shadcn/ui. `utils.ts` exports `cn` from `clsx` and `tailwind-merge`.

  Remove the opacity modifier from every class the scanner classifies as a focus ring or a default-state background. The upstream list is `focus-visible:ring-ring/50`, `focus-visible:ring-destructive/20`, `dark:focus-visible:ring-destructive/40`, `aria-invalid:ring-destructive/20`, `dark:aria-invalid:ring-destructive/40`, `focus-visible:border-destructive/40`, `bg-destructive/10`, `dark:bg-destructive/20`, and `dark:bg-input/30`. Leave `hover:` and `color-mix` in place. Destructive text and its background must be a `text` pair already in `tokens.json` (`destructive` on `background`). Do not change the variant API.

  `src/index.ts` exports `Button` and does not import CSS. Add `packages/ui/src/exports.test.ts`:

  ```ts
  import { createRequire } from "node:module";

  const require = createRequire(import.meta.url);

  it("resolves the stylesheets the first app imports", () => {
    expect(require.resolve("@community-hub/tokens/tokens.css")).toMatch(/tokens\.css$/);
    expect(require.resolve("@community-hub/ui/theme.css")).toMatch(/theme\.css$/);
  });
  ```

  UI script `generate` calls `generateTokens` and writes `theme.css` through the repo Prettier. Run it before the resolve test, because the export path must exist. ESLint: typed block `files` become `**/*.{js,ts,tsx}` and its ignores gain `**/*.test.tsx`; the untyped test block's `files` gain `**/*.test.tsx`. Root references gain `./packages/ui`.

  Run the opacity test again. Expected: PASS.

- [ ] Local gate: `pnpm --filter @community-hub/ui lint && pnpm --filter @community-hub/ui typecheck && pnpm --filter @community-hub/ui test && pnpm check:boundaries`
- [ ] Commit: `feat(ui): copy the base-nova Button and lock its opacity rule` with `Refs: docs/plans/2026-09-25-packages-ui.md task 3`

## Task 4: Theme compile test, axe, wire the checker

**Files:** `packages/ui/src/theme.compile.test.ts`, `packages/ui/src/button.a11y.test.tsx`, `packages/ui/src/a11y-fixtures/no-name.tsx` (not exported), `packages/ui/package.json` (add `@tailwindcss/node`), `packages/ui/vitest` config if the compile test must run under Node, `tooling/checks/run.ts`

**Consumes:** `theme.css`, `Button`, `check` from task 2

**Rule it must not break:** axe does not run `color-contrast`. The root Vitest config stays Node and does not gain jsdom.

- [ ] **RED.** Compile test: `compile` from `@tailwindcss/node` at `4.3.3`, input stylesheet `@import "tailwindcss";` then `@import` of `tokens.css` and `theme.css`, `base` the UI package directory. `build` candidates: `rounded-md`, `rounded-lg`, `text-sm`, `text-xs`, `font-medium`, `rounded-[min(var(--radius-md),10px)]`. Assert the five named utilities' CSS contains `var(--ch-rounded-md)`, `var(--ch-rounded-lg)`, `var(--ch-type-sm)`, `var(--ch-type-xs)`, and `var(--ch-weight-medium)`. Assert the arbitrary candidate's CSS uses `var(--radius-md)` in that rule and defines `--radius-md: var(--ch-rounded-md)`. Read the string from `build`. Do not use jsdom.

  Axe test, jsdom, `@testing-library/react` and `axe-core`: render `<Button>Save</Button>`. Disable `color-contrast` with a comment that the JSON check covers opaque tokens. Assert that id is absent from `passes`, `violations`, `incomplete`, and `inapplicable`. Assert `button-name` is in `passes`. Assert at least one id matching `/^aria-/` is in `passes` or `inapplicable`. Render the unexported fixture (a `<button />` with no accessible name) and assert `button-name` is in `violations`.

  Run `pnpm --filter @community-hub/ui test`. Expected: FAIL.

- [ ] **GREEN.** Add the devDependency. If the compile assertions fail because `@theme inline` baked a length or omitted `--radius-md`, stop and report. Do not edit the assertions. On success, append the checker to `tooling/checks/run.ts` after residency-cell, printing `tokens: ok` or the violations, and set `failed`. Run `pnpm check:boundaries`. Expected: `tokens: ok` and exit 0.

- [ ] Local gate: `pnpm --filter @community-hub/ui test && pnpm --filter @community-hub/check-tokens test && pnpm check:boundaries`
- [ ] Commit: `test(ui): compile theme CSS and axe the Button` with `Refs: docs/plans/2026-09-25-packages-ui.md task 4`

## Task 5: Residency lock, architecture, ADR, AGENTS

**Files:** `packages/residency/src/index.test.ts`, `architecture.md`, `docs/adr/0007-token-source-is-json.md`, `AGENTS.md`

**Rule it must not break:** §1 non-negotiables. Do not mark the roadmap done in this commit.

- [ ] Change the catalog expectation from `arrayContaining` to `toEqual(["@community-hub/db", "@community-hub/crypto"])`. Run `pnpm --filter @community-hub/residency test`. Expected: PASS.
- [ ] ADR 0007, status accepted (2026-09-25, Abdus Salam), spec link, amends D16. Decision: token source is `packages/tokens` JSON; properties are `--ch-*`; web theme CSS is generated; the copied primitive is shadcn `base-nova`. Consequences: `packages/ui-native` depends on the tokens package, not on React; Jellycube islands later use `--ch-*`, not Tailwind theme names. Elevation is not in this chunk.
- [ ] Architecture: D16's decision cell gains "Token source is JSON in `packages/tokens` ([ADR 0007](docs/adr/0007-token-source-is-json.md))." §8.1 lists `tokens/` above `ui/`. The §8.5 tokens row says the source is `packages/tokens` JSON (`--ch-*` properties), web consumes generated theme variables, and elevation is not shipped yet. The public-islands row says the shared variables are `--ch-*`. The "Not in this document" list still excludes palettes. Add the first-app import order and the Vite transpile note next to the tokens row:

  ```css
  @import "tailwindcss";
  @import "@community-hub/tokens/tokens.css";
  @import "@community-hub/ui/theme.css";
  ```

- [ ] AGENTS.md §10: remove `accessibility (axe)` from the omitted sentence. State that axe runs in `@community-hub/ui` (Button plus a missing-name fixture) and that `check:boundaries` includes `check-tokens`. §6 design-system sentence stays: web composes `packages/ui`, mobile will compose `packages/ui-native` on these tokens.
- [ ] `pnpm exec prettier --check architecture.md AGENTS.md docs/adr/0007-token-source-is-json.md`
- [ ] Commit: `docs(ui): record the JSON token source in the architecture` with `Refs: docs/plans/2026-09-25-packages-ui.md task 5`

## Task 6: Roadmap and full CI

**Files:** `docs/roadmap.md`

**Rule it must not break:** phase totals. `website-host-contract` stays in the architecture-decisions table and is not counted in the 7.

- [ ] Snapshot: Last shipped `packages-ui`. Next chunk `audit-log`. Phase 0 `7 / 10`. Row `packages-ui` → **done**, spec `2026-09-24` is wrong; the spec is `2026-09-25-packages-ui`. Next-spec paragraph names `audit-log`.
- [ ] `pnpm exec prettier --check docs/roadmap.md`
- [ ] `rm -f docs/plans/*-report.md`
- [ ] Full local CI, in workflow order. Do not skip a step.

  ```bash
  pnpm format
  pnpm lint
  pnpm typecheck
  pnpm check:boundaries
  pnpm audit --audit-level=high
  pnpm test
  ```

  Secret scanning in CI downloads the Linux gitleaks binary (`8.30.1`) and runs `gitleaks detect --source . --config .gitleaks.toml --redact --exit-code 1`. Traceability runs only on pull requests (`pnpm exec tsx tooling/checks/traceability/check.ts` with `TRACEABILITY_BRANCH` and `TRACEABILITY_PR_BODY`). Do not invent a local substitute. Terraform (`fmt -check`, `validate`, `tflint`, `terraform test` per root) and `pnpm exec wrangler deploy --dry-run` from `apps/gateway` run in CI after `pnpm --filter @community-hub/gateway... build`. If Terraform or Wrangler is not installed locally, say so in the task report. Do not skip `pnpm test`.

- [ ] `git status --short` shows nothing unexpected.
- [ ] Commit: `docs: record packages-ui as done` with `Refs: docs/plans/2026-09-25-packages-ui.md task 6`

---

## Rollback

Revert the PR. No data migration. ADR 0007 would then need a superseding ADR to put token authorship back in `packages/ui`.

## After merge (not in this PR)

- `packages/ui-native` reads `@community-hub/tokens` and does not depend on `@community-hub/ui`.
- `admin-shell` adds the root stylesheet in the order above and imports `Button`.
