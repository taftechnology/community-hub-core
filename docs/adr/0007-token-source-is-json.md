# ADR 0007: Token source is JSON in `packages/tokens`

- Status: accepted (2026-09-25, Abdus Salam)
- Date: 2026-09-25
- Spec: `docs/specs/2026-09-25-packages-ui.md`
- Amends: D16

## Context

D16 adopts shadcn/ui copied into `packages/ui` and React Native Reusables on the same token names for mobile. Host islands on Jellycube pages and a future `packages/ui-native` package both need those values without importing React or the web catalogue. Tailwind theme names on a parish site can clash with Jellycube's own CSS variables if token properties reuse generic names like `--primary`.

The first UI chunk must prove the pipeline — JSON validation, generated CSS, one copied primitive, and CI gates — before product screens or elevation tokens ship.

## Decision

- The token source is `packages/tokens` JSON.
- Token custom properties are prefixed `--ch-*`.
- Web theme CSS (`packages/ui/theme.css`) is generated from that JSON.
- The copied shadcn primitive for this chunk is style **`base-nova`**.

## Consequences

- `packages/ui-native` will depend on `@community-hub/tokens`, not on React, when it is added.
- Jellycube host islands in a later chunk consume the shared `--ch-*` variables, not Tailwind theme names such as `--radius-md`.
- Elevation and shadow tokens are not in this chunk.

## Alternatives rejected

- **Keep tokens only inside `packages/ui`.** Mobile and islands would depend on the web catalogue or duplicate values; parish theme clashes are harder to avoid.
- **Use Tailwind theme names as the shared cross-surface contract.** Jellycube pages already define theme variables; `--ch-*` keeps core tokens distinct.
