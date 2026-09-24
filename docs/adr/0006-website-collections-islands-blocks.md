# ADR 0006: Public website through external collections, host islands and block packs

- Status: accepted (2026-09-24, Abdus Salam)
- Date: 2026-09-24
- Spec: `docs/specs/2026-09-24-website-host-contract.md`
- Amends: D15, architecture §15 (revision 19). Supersedes the "host widget pack" design in §15.1, §15.5 and §15.6.

## Context

D15 keeps Jellycube generic: Community Hub features on the public site are registered through the Jellycube SDK, not built into Jellycube. Revision 19 did that with a **host widget pack**: core ships finished Astro components (`@community-hub/website-widgets`) for events, notices, bulletins, service times, articles, gallery, team and campaigns. Jellycube inserts them as npm package exports into each site's Astro project and rebuilds the site on `content.*` events.

That design has four problems:

1. **Parishes cannot design their own content.** The events list looks like core's markup. Visual design, which is what Jellycube is for, does not reach the content that matters most on a parish site.
2. **Core becomes a front-end shop.** Every layout request ("cards", "two columns", "hide the time") is a core widget release.
3. **The contract is large and slow to freeze.** Palette registry, inspector schemas, npm inserts and render modes all have to freeze before Phase 4. Q2 is the Phase 4 risk because of this.
4. **It does not fit Jellycube v2.** Jellycube v2 treats `package.json` as layout code: changing it triggers a full container re-import, and a newly inserted npm component cannot be previewed until the site bundle is rebuilt. Rebuilding every site on every content event is slow and expensive.

## Decision

Core exposes public-site features in three tiers, in order of preference.

| Tier                       | Core provides                                                                                                        | Jellycube does                                                                                                                                                           | Default for                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **1. External collection** | A read-only data source: JSON Schema (from `packages/contracts`), a `public`-class projection, list and item fetch   | Shows it as a CMS collection. Generic Collection List and Collection Page blocks bind to it. Designers style it visually. Dynamic routes (`/events/[slug]`) come from it | Events, notices, bulletins, service times, articles, gallery, team, campaigns |
| **2. Host island**         | A small web component from `packages/web-components` that reads or writes core at request time                       | Places it like any block. The wrapper is designed in Jellycube; the island uses host theme tokens                                                                        | Form, donate, RSVP / tickets, membership join, live campaign total            |
| **3. Host block pack**     | Astro components in `packages/website-blocks`, published as a versioned pack. Jellycube compiles it once per version | Renders it in a sandbox with no bindings; egress only to core's public API                                                                                               | Exceptions only: display logic that a collection binding cannot express       |

Rules:

- A new public surface is a **collection** unless the spec explains why it cannot be. An island exists only for a write or a live value. A block pack needs a written reason in the spec.
- Collections return `public` class data only. Children never appear (§12.3 rule 3). Core enforces this in the projection; Jellycube is never trusted with it.
- Content is still edited in one place. On the canvas, a bound item opens "Edit in Community Hub" through an opaque deep link. Jellycube never writes core content.
- Freshness: core sends a signed, IDs-only `website.source.changed.v1` notification (community, source key, item IDs, content version). Jellycube re-renders only the routes that use that source. It is debounced, and a content change never needs a full site build.
- Nothing is added to the site's `package.json`. Collections and islands need no host code in the site project. Block packs are loaded by Jellycube from its extension registry.
- The editor is embedded in the core admin under **Website & CMS**, signed in with core OIDC. Core roles map to Jellycube capabilities through `identity.mapRoles`.
- Parish sites are provisioned from vertical templates (`faith-church`) into Jellycube-managed Git. No GitHub account is needed; an organisation or agency may connect one later.
- Jellycube records editor actions against the OIDC `sub`, never an email, because Durable Objects have no Australian jurisdiction (§7.3 rule 7).

## Consequences

- Parishes and agencies design every list and detail page. Core no longer owns list markup.
- Core's Phase 4 work shrinks to: collection schemas and projections (which Phase 2 already needs for the Public Content API and mobile), about five islands, the notification, lifecycle and role mapping.
- The SDK contract is small: `dataSources`, `islands`, `blocks`, `identity`, `provisioning`, `theme`, `notifications`. It can be frozen during Phase 2, so Q2 should resolve well before Phase 4.
- Detail pages become real routes with their own titles and meta tags, which is better for SEO than a list widget.
- Jellycube must ship collections (binding, filter, sort, pagination, dynamic routes) and the extension registry before Phase 4. It needs these for its own users anyway. If they are late, the thin in-core renderer remains the fallback and uses the same data sources.
- `defineModule`'s `websiteWidgets?: string[]` is replaced by `website?: { collections?, islands?, blocks? }`. That is a type-only change; no module declares widgets yet.
- A vertical detail that data binding cannot express (for example a recurring Mass-times grid) can still ship as a block, which keeps the escape hatch.

## Alternatives rejected

- **Keep the widget pack.** This has the four problems above, and it fights the Jellycube v2 build model.
- **Make the thin in-core renderer permanent.** Parishes get no design tool, and core duplicates Jellycube.
- **Copy core content into Jellycube's own CMS.** Content would then be edited in two places, which is the Laravel coupling we are leaving (§15.3).
- **Render core data at request time on Jellycube's router.** This puts the core API in the path of every public page view, costs more, and weakens the degraded mode in §22. Targeted re-render keeps pages static.
- **Iframe the member portal.** No SEO, and it does not look like the parish site. It stays a last resort (§15.3).
