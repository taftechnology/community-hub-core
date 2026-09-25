# Spec: packages/ui foundations

Slug: `packages-ui`
Status: draft
Supersedes: —
Architecture refs: §8.1, §8.5, D16; AGENTS.md §6, §10, §14

## Problem

D16 says web UI is shadcn/ui copied into `packages/ui`, mobile uses the same tokens, and WCAG 2.2 AA is a merge gate. None of that exists. There is no React, no Tailwind, and no JSX in the repo, so `lint`, `typecheck`, and `test` would pass on an empty package. The token source is the decision that is expensive to reverse: if tokens land as CSS custom properties inside a React package, `packages/ui-native` either depends on React and Tailwind or copies the tokens, and "the same tokens" becomes two sources.

## Scope

**In**

- `@community-hub/tokens` (`packages/tokens`): platform-neutral `tokens.json`, a pure generator, and generated `tokens.css`. No runtime dependencies.
- `@community-hub/ui` (`packages/ui`): the shadcn Button copied from CLI `4.21.0`, style `base-nova`, plus `src/lib/utils.ts` (`cn`), generated `theme.css`, and source exports. A Node compile test locks the five named utilities to their `--ch-*` tokens and locks `var(--radius-md)` in the arbitrary radius. A class-string test locks the opacity rule. No product screens, no second component.
- `@community-hub/check-tokens` (`tooling/checks/tokens`): wired through `check:boundaries`. Must-fail fixtures for every tree rule below, plus one must-pass tree. Unit tests for `self-reference` and `namespace`.
- Axe on the rendered Button in the UI package's own jsdom Vitest config, with a missing-name fixture.
- ESLint globs gain `tsx`. Root `tsconfig.json` references both packages. The residency catalog test locks `regionalOnlyPackages` with `toEqual`.
- ADR 0007. Architecture §8.1 tree and §8.5 token row amended so the source is `packages/tokens`, token properties are prefixed `--ch-`, and web CSS is generated. AGENTS.md §10: axe is no longer in the omitted list. Roadmap last commit: `packages-ui` **done**, next `audit-log`, Phase 0 `7 / 10`.

**Out** (explicitly)

- `packages/ui-native`, Input, Dialog, product patterns (`Page`, `EntitlementGate`, `DataTable`), any app, the rest of the shadcn catalogue.
- `eslint-plugin-jsx-a11y`. `radix-ui`. Any style other than `base-nova`.
- Font families. Alpha in `tokens.json` (`#rrggbbaa`). Elevation and shadow tokens. §8.5 names elevation; this chunk adds no shadow group.
- A parish palette. Vitest browser mode, Playwright, or any other browser in CI.
- An app root stylesheet. The import order is specified here so the first app does not invent it.

## Behaviour

### Packages

`@community-hub/tokens` has no runtime dependencies. It exports:

| Subpath        | File                    | Role                                      |
| -------------- | ----------------------- | ----------------------------------------- |
| `.`            | token JSON and its type | What a later native package imports       |
| `./tokens.css` | `src/tokens.css`        | Generated custom properties               |
| `./generate`   | `src/generate.ts`       | Pure function from parsed JSON to strings |

`@community-hub/ui` declares `@community-hub/tokens` as a `workspace:*` peer and as a devDependency. `theme.css` is meaningless without `tokens.css`, which is the same reason Tailwind is a peer. The barrel exports `Button` and does not import a stylesheet. The package script that writes `theme.css` imports `./generate` from the tokens package. `package.json` exports `.` (source `./src/index.ts`) and `./theme.css` (`./theme.css` at the package root, so `@source "./src"` is the Button directory). A test resolves `@community-hub/tokens/tokens.css` and `@community-hub/ui/theme.css` with Node's resolver, the way the first app will.

There is no component CSS build and no published JS bundle. `exports` point at TypeScript source so the consumer's compiler and Tailwind see the class strings. Vite transpiles a workspace package from that source. A bundler that does not transpile workspace TypeScript must be configured to, or the import fails. `typecheck` is `tsc --build`, which emits `.d.ts` into `dist` because `tsconfig.base.json` is `composite`. `dist` stays gitignored. That emit is the project-reference artifact. The UI tsconfig sets `"jsx": "react-jsx"`, includes `src/**/*.ts` and `src/**/*.tsx`, and excludes tests. A second `tsconfig.test.json` (`composite: false`, `noEmit: true`, same `jsx`) typechecks the tests. The tokens package is composite, includes its `src/**/*.ts`, and has no JSX.

### Token file

`packages/tokens/src/tokens.json` is the only source. Top-level keys are exactly `space`, `radius`, `fontSize`, `fontWeight`, `modes`, and `pairs`. Any other top-level key is `unknown-group`.

`space` is one non-negative pixel number, the Tailwind v4 base multiplier, not a map of steps. The web value is `4`, so the generated length is `0.25rem`. That single multiplier is what makes `h-8`, `px-2.5`, `gap-1.5`, and `size-3.5` token-driven. A per-step map does not cover those fractional utilities, and a key such as `2.5` is not a valid custom-property name.

`modes` is exactly `{ light, dark }`. Each mode has a `color` object. The two color-key sets are equal. Colors are `#` plus six lowercase hex digits. Eight-digit hex, shorthand, and any other string are `bad-color`. Token values have no alpha. Utility opacity in the copied Button is a separate gap, below. It is not prevented by `bad-color`.

Every key in `radius`, `fontSize`, `fontWeight`, and `color` matches `[a-z0-9-]+`. Anything else is `bad-key`. `bad-key` is only about keys. `space` has no keys, so a bad `space` value is not `bad-key`.

`space`, `radius`, `fontSize`, and `fontWeight` values are non-negative finite numbers. A negative, a string, `NaN`, or any other JSON type is `bad-value`. Font families are absent. The generator dispatches on the group: `space`, `radius`, and `fontSize` become `rem` by dividing by 16, using the shortest decimal that equals that quotient; `fontWeight` is copied as a number; `color` is copied as hex. An unknown group is not treated as a length. `bad-value` runs in validation, so a bad number never becomes `-0.25rem` or `NaNrem` in committed CSS.

Each pair has `id`, `mode` (`light` or `dark`), `purpose` (`text`, `large-text`, or `non-text`), `foreground`, and `background`. The last two are color keys in that mode. A purpose outside that set is `unknown-purpose`. A key that is not a color in that mode is `unknown-key`. Thresholds, compared on the unrounded WCAG ratio: `text` passes only when `ratio >= 4.5`; `large-text` and `non-text` pass when `ratio >= 3`. A ratio of 4.499 fails `text`.

`missing-pair` is a color key that is present in both modes and appears in no pair of that mode. A key that exists in only one mode is `mode-keys`, not `missing-pair`.

The real color keys, taken from the `base-nova` Button's utility classes, are `background`, `border`, `destructive`, `foreground`, `input`, `muted`, `primary`, `primary-foreground`, `ring`, `secondary`, and `secondary-foreground`. Each exists in both modes and appears in at least one pair of that mode.

The real non-colour keys, taken from the same file, are `radius` `md` and `lg`, `fontSize` `xs` and `sm`, and `fontWeight` `medium`. Tailwind v4's default theme already defines `--radius-md`, `--radius-lg`, `--text-sm`, `--text-xs`, and `--font-weight-medium`. Omitting one of these keys would let the Button render on Tailwind's value. The live `tokens.json` includes each of them. The palette is a neutral starter. Every real pair passes. The `valid` fixture, not the live palette, is what proves the 3:1 path: its `non-text` pair has an unrounded ratio `>= 3` and `< 4.5`, and it contains `var(--ch-background)`. `contrast-fail` is a dark `text` pair with an unrounded ratio `< 3`, so a checker that uses 3:1 for every purpose still reports `contrast`.

### Generated CSS

One pure generator in `@community-hub/tokens` returns two strings. It does not format them and it does not write files. The tokens package script writes `packages/tokens/src/tokens.css`. The UI package script calls the same generator and writes `packages/ui/theme.css`. Both write scripts and the checker format with the same step: Prettier `resolveConfig` for that file's path. A fresh generate therefore matches `prettier --check` and the drift compare.

`tokens.css` is only custom properties. Light colors sit on `:root`. Dark colors sit on `.dark`. Shared length and weight properties sit on `:root`. Every token property starts with `--ch-`, so a later island can include this file on a Jellycube page that already defines `--primary`. The shared variables §8.5 means are these `--ch-` properties. Tailwind theme names (`--color-*`, `--radius-*`, `--spacing`, `--text-*`, `--font-weight-*`) exist only where `theme.css` has been processed. The Button's `var(--radius-md)` is one of those theme names. An island in a later chunk uses `--ch-*`, not `--radius-md`.

Token properties also must not start with a Tailwind v4 theme namespace: `--color-`, `--font-`, `--text-`, `--font-weight-`, `--tracking-`, `--leading-`, `--breakpoint-`, `--container-`, `--spacing-`, `--radius-`, `--shadow-`, `--inset-shadow-`, `--drop-shadow-`, `--blur-`, `--perspective-`, `--aspect-`, `--ease-`, `--animate-`. The `--ch-` prefix makes those prefixes unreachable from valid JSON. `namespace` is therefore a unit test of the classifier, with input `--shadow-sm`, not a tree fixture. The same classifier still runs on every generated token property, so a later generator edit that emits a banned name fails `check:boundaries`.

| Group      | Token property       | Theme mapping                                 |
| ---------- | -------------------- | --------------------------------------------- |
| color      | `--ch-<key>`         | `--color-<key>: var(--ch-<key>)`              |
| space      | `--ch-space-unit`    | `--spacing: var(--ch-space-unit)`             |
| radius     | `--ch-rounded-<key>` | `--radius-<key>: var(--ch-rounded-<key>)`     |
| fontSize   | `--ch-type-<key>`    | `--text-<key>: var(--ch-type-<key>)`          |
| fontWeight | `--ch-weight-<key>`  | `--font-weight-<key>: var(--ch-weight-<key>)` |

`space` is the single multiplier above, not one mapping per step. Every key in the other groups follows that group's row.

`theme.css` contains `@source "./src"`, `@custom-variant dark (&:is(.dark *))`, and `@theme inline` with those mappings. `@theme inline` is what makes `bg-background` follow `.dark` at runtime. The `dark` variant matches descendants of `.dark` and does not match the element that carries the class. That is the shadcn default.

The `base-nova` Button uses `rounded-[min(var(--radius-md),10px)]` on its `xs`, `sm`, and icon sizes, and it uses `rounded-lg`, `text-sm`, `text-xs`, and `font-medium`. `--radius-md` is the theme left-hand side, not the token property `--ch-rounded-md`.

A test in `@community-hub/ui` compiles CSS in Node and reads the compiled text. It does not use jsdom or a browser. The compiler is `compile` from `@tailwindcss/node` (exact `4.3.3`, same pin as `tailwindcss`). `tailwindcss` itself exports `compile`, and that entry does not load stylesheets. `@tailwindcss/node`'s `compile(css, { base, onDependency })` does, which is what resolves `@import "tailwindcss"`. The input stylesheet imports Tailwind, `tokens.css`, and `theme.css`, with `base` set to the UI package. `build` is called with `rounded-md`, `rounded-lg`, `text-sm`, `text-xs`, `font-medium`, and `rounded-[min(var(--radius-md),10px)]`. For the five named utilities, the returned CSS text contains `var(--ch-rounded-md)`, `var(--ch-rounded-lg)`, `var(--ch-type-sm)`, `var(--ch-type-xs)`, and `var(--ch-weight-medium)` respectively. A bare length, including Tailwind's default for that utility, fails the test. For the arbitrary candidate, the compiled CSS uses `var(--radius-md)` in that rule and defines `--radius-md` as `var(--ch-rounded-md)`. That is the check that `xs`, `sm`, and icon sizes can read the theme variable. Inlining `var(--ch-rounded-md)` into `rounded-md` does not by itself prove `--radius-md` is emitted.

The first time that test is written, if `@theme inline` emits a baked length instead of `var(--ch-…)`, or if it does not define `--radius-md` as `var(--ch-rounded-md)` for the arbitrary rule, stop and report. Do not weaken either assertion, do not retarget the Button at `--ch-rounded-md`, and do not remove `inline`, in that same change. After it passes, the test is the gate. A later Tailwind upgrade or a dropped key fails it.

The checker fails when a token property is a name `theme.css` defines (the left-hand side). That is `self-reference`. A correct generator cannot emit `--radius-md: var(--radius-md)` from valid JSON, so this rule is proved by a unit test of the function that scans a CSS string, using that declaration as input. The same function runs on the generated `theme.css` during the generation-dependent pass.

`unknown-var` scans `var(--…)` in `packages/ui` source, including `theme.css`. A name is known when the generator writes it as a custom property in `tokens.css` or as a left-hand side in `theme.css`. `--radius-md` is known because it is a theme left-hand side. A name in neither file fails. The tree fixture uses a name in neither file.

**Known gaps**

- A typo in a utility class (`bg-primry`) is invisible to the `var(--…)` check. Tailwind drops unknown classes, and jsdom does not compute styles.
- Hover opacity and `color-mix` are not inputs to the contrast check. They are transient states. The copied Button may keep them, including `hover:bg-primary/80` and `color-mix(in oklch, …)`. The JSON check measures the opaque token only, so it overstates contrast for those states. Default-state backgrounds and focus rings are not part of this gap.

### Copied Button

`components.json` records CLI version `4.21.0` and style `base-nova`. The same CLI's `new-york-v4` Button imports `Slot` from `radix-ui`. This chunk does not. `base-nova` imports `@base-ui/react/button`.

The registry file has no MIT header. It starts at the import of `ButtonPrimitive`. Each copied file gets a header this repo writes, naming shadcn/ui and the MIT licence. `packages/ui/THIRD_PARTY_NOTICES` carries the licence text, so the licence does not live only in a comment a later CLI refresh can overwrite. After any refresh, the header is put back before commit.

The Button imports `{ cn } from "cn"`. `components.json` aliases that specifier to `packages/ui/src/lib/utils.ts`, which exports `cn` built from `clsx` and `tailwind-merge`. That file is why those two dependencies exist. It is a copied helper, not a second component, and it gets the same header.

The variant API stays the upstream component. Edits beyond the header, `verbatimModuleSyntax`, and ESLint follow one rule: in the copied Button, every focus-ring utility, and every background under text in the default state, carries no opacity modifier, in both modes. That changes these classes:

- `focus-visible:ring-ring/50`
- `focus-visible:ring-destructive/20` and `dark:focus-visible:ring-destructive/40`
- `aria-invalid:ring-destructive/20` and `dark:aria-invalid:ring-destructive/40`
- `focus-visible:border-destructive/40`
- `bg-destructive/10` and `dark:bg-destructive/20`
- `dark:bg-input/30`

Each ring or focus border names an opaque token. Destructive text sits on an opaque background token, and that text and its background are a `text` pair, in both modes.

A unit test in `@community-hub/ui` reads class strings. A utility under `hover:` is allowed, including `dark:hover:`. `color-mix` is outside this scan. Everything else is classified as follows:

- **Focus ring:** any `ring-*`, and any `border-*` or `outline-*` under `focus-visible:`.
- **Default-state background:** `bg-*` with no state variant, or with only `dark:`. `aria-expanded:` and `active:` are not default state.

The test fails when a focus ring or a default-state background carries an opacity modifier (`/N`). The committed `button.tsx` passes. The string `focus-visible:ring-ring/50` fails, which is the must-fail that proves the scanner bites. The string `hover:bg-primary/80` passes, so the known gap stays open. A `shadcn add` that restores an opacity modifier on a guarded class fails this test. Re-editing the class is how the test is made to pass.

`packages/ui/components.json` points Tailwind's CSS field at `packages/ui/.shadcn.css`. That file is gitignored. `theme.css` is never the CLI target and is never hand-edited, so `drift-theme` means the generator and the committed file disagree.

The package script `shadcn` creates `.shadcn.css` when it is missing, then runs `pnpm dlx shadcn@4.21.0` with the arguments it was given. `packages/ui/README.md` documents that command (`pnpm --filter @community-hub/ui shadcn`). A fresh clone has no `.shadcn.css` until the script runs. Values the CLI writes into the scratch file are copied into `tokens.json`, and the generator is re-run.

If the published components schema rejects the `version` or `style` field, stop and report. Do not drop them to make the CLI start.

### Dependencies

Peers: `react` `^19`, `react-dom` `^19`, `tailwindcss` `^4`, `@community-hub/tokens` `workspace:*`. Exact copies in `devDependencies` are for this package's tests and the lockfile: `react@19.3.0`, `react-dom@19.3.0`, `tailwindcss@4.3.3`, `@tailwindcss/node@4.3.3`, `@community-hub/tokens` `workspace:*`, `@types/react@19.3.0`, `@types/react-dom@19.3.0`, `@testing-library/react@16.3.3`, `@testing-library/dom@10.4.2`, `jsdom@30.1.1`, `axe-core@4.13.0`.

Dependencies, exact: `@base-ui/react@1.8.0`, `class-variance-authority@0.7.1`, `clsx@2.1.1`, `tailwind-merge@3.7.0`. React 19 does not ship its own types. `@testing-library/react@16` does not bundle `@testing-library/dom`. There is no `radix-ui` dependency.

Justification (AGENTS.md §14): React, React DOM, and Tailwind are the web UI runtime D16 already chose. Base UI is the primitive the `base-nova` Button is copied onto, not a second catalogue. `class-variance-authority` is an import in that copied file. `clsx` and `tailwind-merge` are the body of `cn`. `@tailwindcss/node` is the loader that resolves `@import "tailwindcss"` for the theme compile test. The testing libraries are the first UI test runtime in the repo.

### Axe

The UI Vitest config sets `environment: "jsdom"` and includes `src/**/*.test.tsx`. The root Vitest config stays Node and is not given jsdom. `color-contrast` is disabled, with a comment that the JSON contrast check replaces it for opaque tokens, and that rule id appears in no result bucket.

The Button test asserts `button-name` is in `passes`. That is the evidence the control is named. An `aria-*` id in `inapplicable` proves only that the rule loaded. A fixture control with no accessible name, not exported, asserts `button-name` is in `violations`.

### Token checker

`@community-hub/check-tokens` exposes `check(root)` defaulting to the repo. `tooling/checks/run.ts` runs it on the real tree, which must pass. `selftest.ts` runs the same function on fixture trees. The checker package depends on `@community-hub/tokens` via `workspace:*` and imports `@community-hub/tokens/generate`, passing each tree's JSON. It does not read the live repo's tokens when `root` is a fixture.

Prettier: `resolveConfig` for the target path under `root`, so the drift compare uses the repo configuration. `tooling/checks/tokens/fixtures/` is added to `.prettierignore`.

Order:

1. No `tokens.json` under `root`: report `{missing-tokens}` and stop. The message says the file is absent and includes the path.
2. The file exists but is not valid JSON: report `{invalid-tokens}` and stop. The message says the file is not valid JSON and includes the path.
3. Otherwise run these seven together: `unknown-group`, `bad-color`, `bad-key`, `bad-value`, `mode-keys`, `unknown-key`, `unknown-purpose`.
4. If that set is non-empty, stop. Do not generate. Do not run drift, contrast, missing-pair, namespace, self-reference, or unknown-var.
5. Otherwise generate, format both strings, and run `drift-tokens`, `drift-theme`, `contrast`, `missing-pair`, `namespace`, `self-reference`, and `unknown-var`.

Each tree fixture's set of violation ids equals the singleton in the table. A second id fails the self-test. `valid` is empty.

| Fixture           | Violation set       |
| ----------------- | ------------------- |
| `valid`           | empty               |
| `drift-tokens`    | `{drift-tokens}`    |
| `drift-theme`     | `{drift-theme}`     |
| `contrast-fail`   | `{contrast}`        |
| `missing-pair`    | `{missing-pair}`    |
| `mode-keys`       | `{mode-keys}`       |
| `unknown-purpose` | `{unknown-purpose}` |
| `unknown-key`     | `{unknown-key}`     |
| `unknown-group`   | `{unknown-group}`   |
| `unknown-var`     | `{unknown-var}`     |
| `bad-color`       | `{bad-color}`       |
| `bad-key`         | `{bad-key}`         |
| `bad-value`       | `{bad-value}`       |
| `missing-tokens`  | `{missing-tokens}`  |
| `invalid-tokens`  | `{invalid-tokens}`  |

`self-reference` and `namespace` are the unit tests described above, not rows in this table. `bad-key`'s fixture is a color key outside `[a-z0-9-]+`, with every value left valid, so the singleton stays that one id. `bad-value`'s fixture is a non-colour value that is not a non-negative finite number (a negative `radius`, or a `space` that is not a number), with every key left valid.

### Residency and lint

`packages/residency/src/index.test.ts` expects `catalog.regionalOnlyPackages` to equal `["@community-hub/db", "@community-hub/crypto"]`. `@community-hub/ui` and `@community-hub/tokens` are not added. The catalog test today uses `arrayContaining`, which stays green when a name is inserted. `toEqual` fails on an addition and on a removal.

The typed ESLint block's `files` become `**/*.{js,ts,tsx}`. Its `ignores` gain `**/*.test.tsx`. The untyped test block's `files` gain `**/*.test.tsx`. Kernel and gateway import bans stay on `*.{js,ts}` because those trees have no JSX.

## Data

No tables, columns, or personal data. Tokens are color, length, and weight. Both packages stay off `regionalOnlyPackages` and remain importable from a `global-no-pii` Worker.

## Rules touched

- D16 and §8.5: the token source becomes `packages/tokens` JSON. Token properties are `--ch-*`. Web theme variables are generated from them. The Button is the `base-nova` shadcn primitive. WCAG contrast for opaque colors is the JSON check; the component gate is axe in jsdom with `color-contrast` disabled.
- §8.1: add `packages/tokens`. `packages/ui` stays the web catalogue and peers the tokens package.
- §1 rules 1 and 7: nothing in these packages is personal data, and nothing is logged.
- AGENTS.md §10: drop axe from the "omitted until first real input" sentence. The input is the Button test and the missing-name fixture. `check:boundaries` gains `check-tokens`.
- AGENTS.md §14: the new dependencies are justified above.

## Contracts

- `@community-hub/tokens` subpaths `.`, `./tokens.css`, `./generate`.
- `@community-hub/ui` subpaths `.`, `./theme.css`. `Button` export. Peer on `@community-hub/tokens`.
- `tokens.json` shape, `--ch-` property names, and theme mappings above.
- `check(root?: string)` on `@community-hub/check-tokens`, violation ids above.
- First-app stylesheet order above. The app's bundler transpiles the TypeScript source (Vite does). No HTTP API, no events, no module manifest keys.

## Risks

| Risk                                                                             | Mitigation                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two Reacts in one bundle                                                         | `react` and `react-dom` are peers (`^19`); exact versions are devDependencies                                                                                                                                                                         |
| UI installed without the token CSS                                               | `@community-hub/tokens` is a peer of `@community-hub/ui`                                                                                                                                                                                              |
| Native package depends on React to read tokens                                   | Tokens live in a package with no runtime dependencies                                                                                                                                                                                                 |
| CLI returns the Radix Button                                                     | `components.json` pins style `base-nova` with CLI `4.21.0`; no `radix-ui` dependency                                                                                                                                                                  |
| Parish `--primary` clashes with island tokens                                    | Token properties are `--ch-*`; Tailwind names stay in `theme.css`                                                                                                                                                                                     |
| A theme variable resolves to Tailwind's default, or `--radius-md` is not emitted | Node compile test: the five utilities contain their `var(--ch-…)` tokens, and `rounded-[min(var(--radius-md),10px)]` both uses `var(--radius-md)` and defines `--radius-md` as `var(--ch-rounded-md)`. First run that misses either stops and reports |
| `var(--radius-md)` fails `unknown-var`                                           | Theme left-hand sides count as known names                                                                                                                                                                                                            |
| Fractional spacing keys (`2.5`)                                                  | One `--ch-space-unit` mapped to `--spacing`; `bad-key` rejects keys outside `[a-z0-9-]+`                                                                                                                                                              |
| A negative length or `NaN` is written into CSS                                   | `bad-value` covers `space`, `radius`, `fontSize`, and `fontWeight`, and it stops before generation                                                                                                                                                    |
| A CLI refresh restores `ring-ring/50` or a translucent default background        | Unit test scans Button class strings. `focus-visible:ring-ring/50` fails. `hover:bg-primary/80` passes. Hover and `color-mix` stay a known gap                                                                                                        |
| CSS units in JSON                                                                | Lengths are pixel numbers; the generator appends `rem` by group                                                                                                                                                                                       |
| `--radius-md: var(--radius-md)`                                                  | Token names stay outside Tailwind namespaces; self-reference scan on the generated theme; unit test on the bad declaration                                                                                                                            |
| Token name overrides a Tailwind default (`--shadow-sm`)                          | Prefix ban, plus the `--ch-` prefix; `namespace` unit test                                                                                                                                                                                            |
| CLI writes into `theme.css` and drift fails                                      | CLI target is gitignored `.shadcn.css`; the `shadcn` script creates it                                                                                                                                                                                |
| Fresh clone has no scratch file                                                  | The script creates `.shadcn.css` before the CLI runs                                                                                                                                                                                                  |
| Drift check and `prettier --check` disagree                                      | `resolveConfig` for the path under `root`; fixtures directory in `.prettierignore`                                                                                                                                                                    |
| Malformed JSON cascades into drift                                               | Validation stops before generation; each fixture expects one id                                                                                                                                                                                       |
| `missing-pair` and `mode-keys` both fire                                         | `missing-pair` counts only keys present in both modes, and `mode-keys` stops generation                                                                                                                                                               |
| Empty `violations` from a misconfigured axe run                                  | `button-name` must appear in `passes`; the missing-name fixture must put it in `violations`; `color-contrast` is absent from every bucket                                                                                                             |
| jsdom cannot compute contrast                                                    | Contrast is the JSON check, unrounded `>=`, for opaque tokens                                                                                                                                                                                         |
| Tailwind never scans `packages/ui/src`                                           | `@source "./src"` in `theme.css`, documented for the first app                                                                                                                                                                                        |
| Bundler serves `.ts` source as JavaScript                                        | Vite transpiles it; any other tool must be configured to                                                                                                                                                                                              |
| `tsc --noEmit` skips TSX                                                         | `jsx: react-jsx` and `.tsx` in `include`                                                                                                                                                                                                              |
| `regionalOnlyPackages` grows unnoticed                                           | `toEqual` the two-name list                                                                                                                                                                                                                           |
| Utility class typo (`bg-primry`)                                                 | Known gap, listed, not half-fixed                                                                                                                                                                                                                     |

## Out-of-band

- Legal: none. New subprocessor: none.
- ADR 0007 amends the D16 token row: JSON in `packages/tokens`, token properties prefixed `--ch-`, generated CSS for web, style `base-nova`. Accepted when this spec is approved.
- `packages/ui-native` is the first consumer of the JSON. It is not this chunk. `packages/web-components` later uses the `--ch-*` properties, not the Tailwind theme names.
- The first app (`admin-shell`) writes the root stylesheet in the order above, transpiles the workspace source, and imports `Button` from `@community-hub/ui`.

## Next spec after this lands

`audit-log`, unless the human picks another remaining Phase 0 row.
