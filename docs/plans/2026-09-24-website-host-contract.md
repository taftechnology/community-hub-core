# Plan: website host contract

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the revision-19 host widget pack with external collections, host islands and host block packs (ADR 0006). This means the kernel manifest type, the architecture, AGENTS.md and the roadmap. It adds no runtime behaviour.

**Architecture:** The kernel's `ModuleDefinition` drops `websiteWidgets?: string[]` and gains `website?: { collections?; islands?; blocks? }`. The change is type-only: no module declares the field yet, and nothing reads it at runtime. The documents change in the same PR so that code and `architecture.md` agree (AGENTS.md §13).

**Tech Stack:** TypeScript 5.8, Vitest 3 (type tests through `vitest --typecheck`), Prettier.

**Spec:** `docs/specs/2026-09-24-website-host-contract.md` (approved 2026-09-24, Abdus Salam)

**ADR:** `docs/adr/0006-website-collections-islands-blocks.md` (accepted 2026-09-24, Abdus Salam)

Status: approved

**Branch:** `docs/2026-09-24-website-host-contract` · one PR · 4 tasks, one commit each

## Global Constraints

- Type-only kernel change. No runtime validation of manifest keys, no new dependency, no change to `defineModule`'s runtime behaviour or its `/module` export surface.
- `website` keys are plain `string[]` for now. The `<module>.<name>` format is enforced in a later chunk, when the first module declares one and a must-fail fixture exists (AGENTS.md §10: no stubbed checks).
- Do not edit merged specs or plans (`kernel-runtime` and others still mention `websiteWidgets`; they are historical records).
- Do not create `packages/website-blocks`, `packages/web-components`, `packages/contracts` or `adapters/website-jellycube`. The architecture describes them; later journeys create them.
- The architecture §8.2 manifest example must type-check against the new `ModuleDefinition` shape (`website: { collections, islands }`).
- Every in-document anchor in `architecture.md` resolves (check in Task 2).
- Prettier clean on every touched file.
- The last commit updates `docs/roadmap.md` (this chunk **done**, snapshot).
- Session scratch is never committed.

**Stop and report** (do not work around):

- `vitest --typecheck` cannot run under the shared root `vitest.config.ts` without changing how other packages run tests. Do not change the root config for every package, and do not fall back to a runtime-only test. Report it.

---

## File map

| Path                                                  | Role                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| `packages/kernel/src/define-module.ts`                | `website?: { collections?; islands?; blocks? }` replaces `websiteWidgets`     |
| `packages/kernel/src/define-module.test-d.ts`         | Type test: new shape accepted, old field rejected                             |
| `packages/kernel/package.json`                        | `test` script adds `--typecheck`                                              |
| `packages/kernel/tsconfig.json`                       | Excludes `src/**/*.test-d.ts` from the build                                  |
| `eslint.config.js`                                    | Treats `*.test-d.ts` like `*.test.ts` (untyped test block)                    |
| `architecture.md`                                     | Revision 20: D15, §8.1, §8.2, §8.5, §9, §12.3, §15, §21, §23.3, §25, §26, §27 |
| `AGENTS.md`                                           | §4 spec template, §6 Public website rules, §11 checklist, §16 Never list      |
| `docs/roadmap.md`                                     | Phase 2 collections note and freeze row, Phase 4 journeys, Q2/Q13, chunk done |
| `docs/adr/0006-website-collections-islands-blocks.md` | Already committed with the spec (not a task)                                  |

---

## Interfaces (locked for later tasks)

```ts
// @community-hub/kernel/module (packages/kernel/src/define-module.ts)
export type ModuleWebsite = {
  collections?: string[]; // external collections, e.g. "engagement.events"
  islands?: string[]; // host islands, e.g. "giving.donate"
  blocks?: string[]; // host block packs — exceptions only
};

export type ModuleDefinition = {
  key: string;
  version: number;
  requires: string[];
  publishes: string[];
  subscribes: string[];
  ports: string[];
  entitlement?: string;
  features?: string[];
  permissions?: string[];
  website?: ModuleWebsite;
  dataClasses?: Record<string, string>;
};
```

`ModuleWebsite` is exported from `@community-hub/kernel/module` next to `ModuleDefinition`.

---

## Task 1: Kernel manifest `website` field

**Files:** `packages/kernel/src/define-module.test-d.ts` (new), `packages/kernel/src/define-module.ts`, `packages/kernel/src/module.ts`, `packages/kernel/package.json`, `packages/kernel/tsconfig.json`, `eslint.config.js`

**Rule it must not break:** kernel never imports `@community-hub/db`, `postgres` or Drizzle. The gateway graph stays free of Zod.

- [ ] **RED.** Add `--typecheck` to the kernel `test` script (`vitest run --typecheck --config ../../vitest.config.ts`). Write `define-module.test-d.ts`:

  ```ts
  import { describe, expectTypeOf, it } from "vitest";
  import { defineModule, type ModuleDefinition, type ModuleWebsite } from "./module";

  describe("ModuleDefinition.website", () => {
    it("accepts collections, islands and blocks", () => {
      expectTypeOf<ModuleDefinition["website"]>().toEqualTypeOf<ModuleWebsite | undefined>();
      expectTypeOf<ModuleWebsite>().toEqualTypeOf<{
        collections?: string[];
        islands?: string[];
        blocks?: string[];
      }>();
    });

    it("rejects the revision-19 websiteWidgets field", () => {
      expectTypeOf<ModuleDefinition>().not.toHaveProperty("websiteWidgets");
    });

    it("type-checks the architecture §8.2 manifest example", () => {
      expectTypeOf(
        defineModule({
          key: "giving",
          version: 1,
          requires: ["core.people", "core.consent"],
          publishes: [],
          subscribes: [],
          ports: ["PaymentProvider"],
          website: {
            collections: ["giving.campaigns"],
            islands: ["giving.donate", "giving.campaign_total"],
          },
        }),
      ).toEqualTypeOf<ModuleDefinition>();
    });
  });
  ```

  Do not use `@ts-expect-error`: `@community-hub/no-ts-ignore` only exempts `*.test.ts`, `test/` and `tests/` paths, not `*.test-d.ts`.

  Add `"src/**/*.test-d.ts"` to `exclude` in `packages/kernel/tsconfig.json` so `tsc --build` does not emit the type test into `dist`. In `eslint.config.js`, add `"**/*.test-d.ts"` next to `"**/*.test.ts"` in both places: the typed block's `ignores` (the file is outside the project service) and the untyped test block's `files`.

  Run `pnpm --filter @community-hub/kernel test`. Expected: FAIL (`ModuleWebsite` is not exported, `website` does not exist, and `websiteWidgets` is still a property).

- [ ] **GREEN.** In `define-module.ts`, add `ModuleWebsite` and replace `websiteWidgets?: string[]` with `website?: ModuleWebsite`. In `module.ts`, export `type ModuleWebsite`. Re-run: PASS. The existing runtime tests still PASS.
- [ ] **Prove the test bites:** temporarily restore `websiteWidgets?: string[]` and confirm the type test fails; then revert.
- [ ] Local gate: `pnpm lint && pnpm typecheck && pnpm test --filter @community-hub/kernel && pnpm check:boundaries`.
- [ ] Commit: `refactor(kernel): replace websiteWidgets with website collections, islands and blocks` with `Refs: docs/plans/2026-09-24-website-host-contract.md task 1`.

## Task 2: Architecture revision 20

**Files:** `architecture.md`

**Rule it must not break:** §1 non-negotiables are restated, never weakened: children never in collections (§12.3 rule 3), no personal data in Durable Objects (§7.3 rule 7), IDs-only notifications.

- [ ] Header revision 20 (website-host-contract, ADR 0006).
- [ ] D15 amended; references ADR 0006.
- [ ] §8.1 tree: `web-components/` = host islands; `website-blocks/` = exception-only block packs; `website-widgets/` removed.
- [ ] §8.2 manifest example uses `website: { collections: ["giving.campaigns"], islands: ["giving.donate", "giving.campaign_total"] }`, which matches the Task 1 type.
- [ ] §8.5 surfaces table, design-system rows, enforcement bullets and UI rule 8 name collections and host islands.
- [ ] §9 content row, §12.3 rule 3 and the §5 diagram say collections.
- [ ] §15 rewritten: 15.1 contract (`dataSources`, `islands`, `blocks`, `links.editInCore`, `notifications`), 15.2 integration, 15.3 rationale, 15.4 privacy (OIDC `sub` only), 15.5 host website pack (8 collections, 5 islands, no blocks), 15.6 SDK requirements (10), 15.7 freshness.
- [ ] §21 and §23.3 say "host islands"; the contract tests row requires a must-fail minor fixture for projections.
- [ ] §25 Phase 2 and Phase 4 rows; §26 Q2 rewritten, Q13 and R4 added; §27 glossary has External collection, Host island, Host block pack and Host website pack (Host widget pack removed).
- [ ] **Verify:** no `widget` wording is left except the historical references in §15.3 and the revision-20 header line; the anchor check prints `missing anchors: []`:

  ```bash
  python3 -c "import re;s=open('architecture.md').read();h={re.sub(r'[^\w\- ]','',x.strip().lower()).replace(' ','-') for x in re.findall(r'^#{1,6} (.+)$',s,re.M)};print('missing anchors:',sorted({a for a in re.findall(r'\]\(#([^)]+)\)',s) if a not in h}))"
  pnpm exec prettier --check architecture.md
  ```

- [ ] Commit: `docs(architecture): replace the widget pack with collections, islands and blocks` with `Refs: … task 2`.

## Task 3: AGENTS.md website rules

**Files:** `AGENTS.md`

- [ ] §4 spec template Contracts line: "website collection / island / block keys (architecture §15.5)".
- [ ] §6 Modules manifest line names `website: { collections, islands, blocks }`.
- [ ] §6 new **Public website** block, with 7 rules: collection by default; island only for a write or a live value; block only with a written reason; allow-list projections with a must-fail minor test; nothing in the site's `package.json`; IDs-only notifications and deep links; island POST, PCI, Turnstile and WCAG.
- [ ] §11 checklist line for public website surfaces; §16 Never list: "a non-public field or a minor in a website collection".
- [ ] `pnpm exec prettier --check AGENTS.md`.
- [ ] Commit: `docs(agents): add public website rules for collections, islands and blocks` with `Refs: … task 3`.

## Task 4: Roadmap (last commit)

**Files:** `docs/roadmap.md`

- [ ] Phase 2: a paragraph requiring each public-facing journey to ship its external collection; the Content row names its collections; new row **Website host contract freeze** (Q2).
- [ ] Phase 4: four journeys (Jellycube host adapter, Host islands, Freshness notification, Embedded editor + parish template) and the fallback paragraph (thin renderer on the same data sources).
- [ ] Open questions: Q2 row updated, Q13 added.
- [ ] Record this chunk: add an **Architecture decisions** table after "How to read this" with `done | website-host-contract | Collections, islands and block packs replace the widget pack. ADR 0006. Spec 2026-09-24-website-host-contract.` Snapshot: Last shipped `website-host-contract`. Phase 0 count and Next chunk (`packages-ui`) are unchanged.
- [ ] `pnpm exec prettier --check docs/roadmap.md`; `rm -f docs/plans/*-report.md`; `git status --short` shows nothing unexpected.
- [ ] Commit: `docs: record website-host-contract as done` with `Refs: … task 4`.

---

## Rollback

Revert the PR. The kernel change is type-only and no module declares `website` or `websiteWidgets`, so there is no runtime or data impact. ADR 0006 would then need a superseding ADR to restore D15 revision 19.

## After merge (not in this PR)

- The Jellycube v2 plan adds the host SDK, collections, the extension registry and Jellycube-managed Git, matching §15.6.
- The first Phase 2 public journey adds `packages/contracts` collection schemas and the `<module>.<name>` key check with a must-fail fixture.
