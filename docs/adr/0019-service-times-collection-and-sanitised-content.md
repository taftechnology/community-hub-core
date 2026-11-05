# ADR 0019: Service times collection and sanitised content

- Status: proposed (2026-11-05, awaiting the project owner's review in the pull request)
- Date: 2026-11-05
- Spec: docs/specs/2026-11-04-mass-times.md

## Context

A parish needs to publish when its Masses and other services are held. In the legacy Laravel application, Mass Times was stored as a single rich-text block per site (`mass_timings` in `website_settings`), rendered on the public website and fetched by the mobile app via `GET /mobile-app/mass-timings`. Core had no engagement module, no service times storage or admin screen, and no external collection for public sites. Implementing service times establishes the first public-facing external collection, introducing rich-text editing, server-side HTML sanitisation, vertical-pack terminology separation, and a bounded body size increase for rich content.

## Decision

1. **Labels come from the vertical pack.** Code, routes, tables and keys use the generic name `service_times`; the visible words ("Mass Time", "Mass Times", the editor field label, hint and placeholder) come from `@community-hub/faith-church` through `terminology(key)`, imported by the admin only. A boundary test fails on the word `mass` in code identifiers, file names, routes, manifest keys and SQL names (architecture §8.4).
2. **The first external collection is a single-block collection.** Mass Times is one rich-text block per community (the Laravel shape), table `app.service_times`, primary key `(org_id, community_id)`. The collection `engagement.service_times` returns exactly one item `{ html }`, `""` when empty; no filters or sorts, `maxLimit` 1, no slug field; the schema marks `html` as sanitised HTML the host renders as markup. This chunk ships the schema, the public-only allow-list projection and its tests; the Public Content API HTTP routes are a separate roadmap row (architecture §15.5).
3. **Sanitise on write.** The server cleans the HTML to an allow-list inside `saveServiceTimes`, so no caller can skip it: tags `p br h1 h2 h3 h4 strong em ul ol li`, `b` and `i` become `strong` and `em`, no attributes of any kind, scripts, styles, frames, svg and math dropped with their content, other tags unwrapped, empty results stored as `""`, and a cap of 20,000 UTF-16 units on the cleaned string. Jellycube and the Parish Hub app render the string, so the allow-list is a public contract: widening it is additive, narrowing it or changing the shape means `/v2`. The importer uses the same function.
4. **A larger request body on one route.** `largeBody: "content"` (128 KiB) is allowed only on `POST /v1/engagement/service-times/save`, and only on the API hostname (never webhooks, auth or ops), enforced by `assertRoutes` and a route-list test; a body over the limit returns 413. Every other POST keeps 4,096 bytes. The body is read before sign-in is checked and the 30-second request timeout still applies.
5. **Libraries.** `sanitize-html` 2.18.1 (MIT) for the cleaner (in `modules/features/engagement/package.json`) and Tiptap 3.32.0 (MIT, on ProseMirror: `@tiptap/core`, `@tiptap/pm`, `@tiptap/react`, `@tiptap/starter-kit` in `packages/ui/package.json`) for the editor, both pinned at exact versions in `pnpm-lock.yaml`; `jsdom` 30.1.1 as a dev dependency for the structural test. The editor is exported from its own subpath (`@community-hub/ui/rich-text-editor`) so the ops bundle does not carry it; `injectCSS` is off because the admin's content security policy has no `unsafe-inline`.

## Consequences

- The allow-list is a public contract relied upon by Jellycube and the mobile app; changing or tightening it after release requires versioning.
- Tiptap re-serialises content, so the editor's own output is the dirty baseline for detecting unsaved changes.
- Numbered lists lose their start number attribute (an `ol` always starts at 1).
- A trailing empty paragraph can follow a final list or heading in the editor output.
- Tenant plans must include the `module.engagement` entitlement before the screen shows for a community.
- Cross-chunk contracts: the Laravel importer and the legacy `/mobile-app/mass-timings` route are later roadmap chunks that must call `sanitiseServiceTimesHtml` and `getPublishedServiceTimes`.

## Alternatives considered

- **Rows per service time with weekday and times.** Rejected: Laravel stores one block per site; the project owner decided on 2026-11-05 to keep Laravel's shape.
- **An in-house sanitiser.** Rejected: high risk of parser discrepancies and XSS bypasses compared to an established library.
- **An in-house editor.** Rejected: unacceptable accessibility and cross-browser maintenance burden compared to Tiptap and ProseMirror.
- **A smaller cap under the 4,096-byte limit.** Rejected: parishes would hit it when entering multi-mass schedules.
- **Sanitising on read instead of on write.** Rejected for now: cost on every public read, and the single write path is guarded by a test; revisit if a second write path appears.
