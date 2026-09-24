# Spec: Website host contract (collections, islands, block packs)

Slug: website-host-contract
Status: approved (2026-09-24, Abdus Salam)
Architecture refs: §8.1, §8.2, §8.5, §15, §25, §26 Q2, D15; ADR 0006

## Problem

Architecture revision 19 has core ship a **host widget pack**: finished Astro components for every public list. A parish cannot design its own events list. Core would own public-site markup indefinitely, and the Jellycube SDK contract is too large to freeze before Phase 4 (Q2). It also conflicts with Jellycube v2: adding an npm dependency to a site forces a full re-import, and every content change would rebuild the site.

## Scope

In:

- ADR 0006 (proposed → accepted on approval).
- `architecture.md`: D15, §8.1 tree, §8.2 manifest example, §8.5 surfaces and rules, §15 rewrite, §21/§23 wording, §25 Phase 4, §26 Q2/Q13/R4, §27 glossary.
- `AGENTS.md`: spec template contracts line, §6 website rules, §11 checklist line.
- `docs/roadmap.md`: Phase 2 public projections, Phase 4 journeys, open questions.
- `packages/kernel`: replace `websiteWidgets?: string[]` with `website?: { collections?: string[]; islands?: string[]; blocks?: string[] }` on `ModuleDefinition`. Type-only; a type test proves the old field is rejected and the new one accepted.

Out:

- Any collection, island or block implementation (Phase 2 and Phase 4 journeys).
- The adapter `adapters/website-jellycube` (Phase 4).
- The outbound notification transport (Phase 4 spec).
- Jellycube's own repository and its plan.

## Behaviour

No runtime behaviour changes. After this chunk:

- A module declares public-site participation as `website: { collections, islands, blocks }`.
- Specs for public-facing journeys name their collection keys and JSON Schema, and justify any island or block.

## Data

No tables. Collections are projections of existing module data and return `public` class fields only (§12.1).

## Rules touched

- §12.3 rule 3 (children never in data sources): restated for collections, and enforced by core's projection.
- §7.3 rule 7: Jellycube attributes edits to the OIDC `sub`, never an email.
- Residency: `website.source.changed.v1` carries IDs, source keys and a content version only.

## Contracts

- SDK host interface: `dataSources` (list with JSON Schema, list items, get item), `islands`, `blocks`, `identity.mapRoles`, `provisioning`, `theme.tokens`, `notifications`, `links.editInCore`.
- Notification: `website.source.changed.v1` `{ hostRef, communityId, source, ids, contentVersion }`, signed.
- Manifest: `website.collections` / `website.islands` / `website.blocks` keys, `<module>.<name>`.

## Risks

- Jellycube collections or the extension registry are late → the thin in-core renderer ships on the same data sources (unchanged fallback).
- A projection leaks a non-public field → each projection has a must-fail test with a `restricted` and a minor fixture (Phase 2 specs).
- The Jellycube serving zone needs Regional Services = Australia for community hostnames (Q13) → decision before Phase 4.

## Out-of-band

- Architecture decision change: ADR 0006, human approval required.
- Coordination with the Jellycube v2 plan (host SDK section, collections, extension registry, managed Git).
- No new subprocessor. Jellycube is already listed for editor identity data.
