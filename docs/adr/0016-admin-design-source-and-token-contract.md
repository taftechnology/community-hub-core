# ADR 0016: Admin design source and token contract

- Status: accepted (2026-11-03, Adnan Bin Hossen)
- Date: 2026-11-03
- Spec: docs/specs/2026-11-03-admin-design-shell.md
- Amends: ADR 0007

## Context

The owner's agreed design (design system version `1793646986-2cfc`, the screens canvas and the Laravel feature decisions, agreed 2 November 2026) lives in claude.ai design artifacts, not in Figma. ADR 0007 fixed JSON tokens, the `--ch-*` prefix and `base-nova`, and left shadows out.

## Decision

1. The design artifacts are the design source. Values come from the design system's `tokens.json` and are carried into `packages/tokens/src/tokens.json` with the design's role names.
2. The token contract now holds `type`, `spacing`, `size`, `shadow` and a `decorative` list. `rgba()` is allowed only for decorative roles.
3. Every text and non-text pairing in the usage notes is a contrast pair, hover states included. The tokens check fails on a missing pair or a bad decorative entry.
4. `--ch-*` stays.
5. Dark values are emitted under `[data-theme="dark"]` and under the `prefers-color-scheme` media query, with no inline script. The CSP forbids one.
6. `base-nova` stays. The copied Button, Input and Table sources change to 36px, 44px under touch, solid hover fills, a solid destructive fill, and a 2px outline with a 2px offset. Opacity modifiers on colour utilities are banned across `packages/ui/src`.
7. Source Sans 3 is self-hosted through `@fontsource/source-sans-3` (OFL-1.1). There is no third-party font request.
8. Lucide icons come through `lucide-react` (ISC).

## Consequences

- Later screens compose `packages/ui` from these components.
- A design value changes by editing the design system and then the token JSON, never the CSS.
- A brief flash of the system theme is accepted when the stored choice differs.

## Alternatives rejected

- **Switching to `base-vega`.** It means a second re-copy of every primitive.
- **Keeping Figma as the source.** The agreed design lives in the claude.ai design artifacts.
- **A Google Fonts link.** Forbidden by D17 and §1 rule 6.
- **An inline theme bootstrap script.** Forbidden by the CSP.
