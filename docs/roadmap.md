# Product roadmap

Status: approved (2026-09-18, Abdus Salam) — living companion to [architecture.md](../architecture.md) §25  
Sequence only: no calendar dates, quarters, or deadlines  
First customer: one live Australian parish, full cutover (admin + Parish Hub + public site in one window)

This file is the catalogue later specs are cut from. Architecture §25 stays the eight-row summary. A new spec does not start until a chunk below is pulled into `docs/specs/YYYY-MM-DD-<slug>.md` and approved.

---

## North star

A current Laravel parish leaves self-hosted Community Hub in **one window**: tenant admin, Parish Hub, and the public website all talk only to core ([architecture §24](../architecture.md#24-migrating-from-self-hosted-laravel)).

**Hard gate before any client moves:** on `staging-au`, donate, form submit, and RSVP succeed on the public site (or the Phase 4 fallback renderer). Architecture already forbids splitting a live parish across Laravel and core.

---

## How to read this

| Mark        | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| **Done**    | On `main`. Do not re-spec.                                                               |
| **Chunk**   | One future spec → plan → branch → PR (Phases 0–1).                                       |
| **Journey** | User-visible slice; specs are cut when we enter that phase (Phases 2–7).                 |
| **Hidden**  | Admin nav item exists in the shell but stays entitlement-hidden until its journey ships. |

Update this file in the same PR as a behaviour change that completes, splits, or drops a row. Do not put implementer reports here ([AGENTS.md](../AGENTS.md) §5).

---

## Admin navigation (frozen)

Copied from Laravel `CommunityHubLayout.jsx`, same sequence. Core **hides** by entitlement; it does not reorder. A Phase 2–5 journey is not done until its item appears here (or is explicitly still hidden).

Top bar: **Website** (opens the public site) — live in Phase 4.

Dashboard **Quick Actions** stay in screenshot order once those modules exist: Enquires, Event, Notice, Bulletin, Article/Blog, Send Message, Add Member, Gallery, Team Members, Mass Timings.

| #   | Nav item           | Children                                                                                  | Filled in                                             | Notes                                                                                            |
| --- | ------------------ | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Dashboard          | —                                                                                         | Phase 1 shell; widgets in 2–3                         | Always visible                                                                                   |
| 2   | Enquires           | —                                                                                         | Phase 2 (forms)                                       | Label may become “Enquiries”; order stays                                                        |
| 3   | Engagement         | Bulletins, Events, Notice Board, Mass Timings                                             | Phase 2                                               | Events include paid RSVP, tickets, capacity (staging RSVP gate)                                  |
| 4   | Contacts & Members | All Contacts, Groups                                                                      | Phase 1 people; Phase 2 groups                        | Tags + activity log with people                                                                  |
| 5   | Family Records     | —                                                                                         | Phase 2                                               | Life events live inside this item, not a new top-level row                                       |
| 6   | Membership         | —                                                                                         | Phase 3                                               |                                                                                                  |
| 7   | Records            | —                                                                                         | Phase 3                                               | Compliance docs (due dates, attachments)                                                         |
| 8   | Certifications     | —                                                                                         | Phase 3                                               | Parish certificate requests — own nav row, same module family as records                         |
| 9   | Volunteers         | —                                                                                         | Phase 3                                               | Police verification is a page under this item, not a new row                                     |
| 10  | Forms              | —                                                                                         | Phase 2                                               | Staging form-submit gate                                                                         |
| 11  | Communication      | Broadcast Messages                                                                        | Phase 2                                               |                                                                                                  |
| 12  | Mobile App         | —                                                                                         | Phase 2                                               | Per-community home CMS (cards, nav, ministries, sacraments, mass times)                          |
| 13  | Website & CMS      | Pages, Blog / News, Photo Gallery, Team Members, Media Library, Global Setting, Templates | Content in Phase 2; Pages/Templates/Global in Phase 4 | Header/Footer stay in the website builder, not extra sidebar rows                                |
| 14  | Donations          | —                                                                                         | Phase 3                                               | Campaigns, splits; staging donate gate                                                           |
| 15  | E-commerce         | Products, Orders & Inventory                                                              | Phase 3 or 5                                          | Add-on; only if a pilot uses the shop                                                            |
| 16  | Settings           | General Settings, Email Settings, Users & Roles                                           | Phase 1                                               | Laravel also had URL Scanner, System Update, Backup — **dropped**. Module Toggles → entitlements |

---

## Phase 0 — Foundations

Architecture: monorepo, CI, Terraform, kernel, residency, db with RLS, crypto, observability, audit, `packages/ui`.

### Done

Completed as spec `docs/specs/2026-09-17-monorepo-skeleton.md` (branch `feat/2026-09-17-monorepo-skeleton`, on `main`).

| What                                                                                                          | Where                                                  |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| pnpm 10 / Node 24 workspace, Turborepo, ESLint 9, Prettier, Vitest 3                                          | repo root                                              |
| `@community-hub/kernel` `healthPayload()`                                                                     | `packages/kernel`                                      |
| Structured logger: drop-and-count personal keys, never throws                                                 | `packages/observability`                               |
| Global no-PII Worker: `GET /health`, `workers_dev: false`, `preview_urls: true`                               | `apps/gateway`                                         |
| Checkers with must-fail fixtures: worker-config, schema-rls, encrypted-query, residency-payload, traceability | `tooling/checks/`                                      |
| `pnpm check:boundaries`                                                                                       | root script                                            |
| CI Stages 1–3 (static, test, wrangler dry-run / preview for gateway only)                                     | `.github/workflows/ci.yml`                             |
| Preview URLs only on `global-no-pii`                                                                          | [ADR 0001](adr/0001-preview-urls-on-global-workers.md) |
| Session scratch not committed                                                                                 | `AGENTS.md` §5, `.gitignore`                           |

Kernel is **not** yet `defineModule` / request context / DI / outbox. Observability is the logger only (no product analytics SDK — D17).

### Remaining chunks (next specs, in order)

1. **`terraform-au-cell`** — Cloudflare + AU AWS foundations. No tenant data.
2. **`packages-db`** — Drizzle, Hyperdrive, `SET LOCAL` per transaction, RLS helpers, migration runner.
3. **`packages-crypto`** — AES-256-GCM, KMS wrap, blind indexes. Synthetic data only.
4. **`kernel-runtime`** — `defineModule`, request context, DI, outbox. Replaces health-only kernel without removing `healthPayload`.
5. **`packages-residency`** — cell config; global Workers cannot import personal-data modules.
6. **`packages-ui`** — shadcn copied into the repo + tokens (D16). No product screens.
7. **`audit-log`** — tamper-evident append. First events when identity writes.
8. **`api-au-skeleton`** — regional Worker, `class: regional`, `preview_urls: false`, health through kernel.

---

## Phase 1 — Core platform

Vertical slices. Nav items appear in the frozen order and stay **hidden** until entitled.

1. **`admin-shell`** — `apps/admin` with the sidebar sequence. Dashboard only; everything else hidden.
2. **`tenancy-implicit-org`** — organisation + community. Control-plane directory: IDs, slugs, region — never names.
3. **`identity-otp`** — regional identity, OTP, passkeys path as designed. No email on gateway. Not Laravel’s Contact→User auto-provisioning.
4. **`people-households`** — Person, Household, GuardianLink, `is_minor`. Redesign, not a `Contact` copy. Tags + activity log land here.
5. **`access-roles`** — Settings → Users & Roles.
6. **`entitlements-plans`** — control-plane plans and allocations; community toggles; nav hide/show. Replaces Laravel “any admin can switch paid modules on.”
7. **`stripe-billing`** — our subscriptions. Webhooks on `webhooks-au`; work on `exec`. Not GivingJar.
8. **`ops-console`** — Cloudflare Access. Tenant reads proxy to `api-au`. No decrypt, log, or buffer of personal fields.
9. **`usage-facts`** — `core/usage` skeleton (community × feature × day). Facts grow as modules ship.

Phase 1 does **not** fill Enquires, Engagement, Family Records, Membership, Records, Certifications, Volunteers, Forms, Communication, Mobile App, Website & CMS, Donations, or E-commerce.

---

## Phase 2 — Engagement and mobile

Journeys, not a full backlog. Cut specs when this phase starts. Fill nav in this order where possible. Ship **`verticals/faith-church`** here (Mass times, sacraments, parish wording).

| Journey                      | Nav / surface                             | Must include                                                                                                        |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Groups                       | Contacts & Members → Groups               | Ministries, members, export                                                                                         |
| All Contacts admin           | Contacts & Members → All Contacts         | Built on people/households; no children in public directories                                                       |
| Family Records               | Family Records                            | Household UI; **life events** inside this item                                                                      |
| Mass Timings                 | Engagement → Mass Timings                 | Service times; labels from faith-church                                                                             |
| Notice Board                 | Engagement → Notice Board                 | Pin; **approve / reject**                                                                                           |
| Bulletins                    | Engagement → Bulletins                    | CRUD, PDF as in Laravel if still required                                                                           |
| Events                       | Engagement → Events                       | Free and **paid** RSVP, ticket types, capacity, booking detail, external ticketing URL. Staging **RSVP** gate       |
| Forms + Enquires             | Forms; Enquires                           | Builder, classification on fields, public submit, enquiry inbox. Staging **form submit** gate                       |
| Broadcast Messages           | Communication                             | Email to entitled audiences; IDs in, send from `exec`. No personal data in jobs                                     |
| Content                      | Website & CMS: Blog, Gallery, Team, Media | Public Content API. Our Schools / Our Places as content, not new modules                                            |
| Mobile home CMS + Parish Hub | Mobile App                                | Cards, nav, ministries, sacraments, mass times. App Registry. **`parish-hub-au` only**. Legacy compatibility router |

Laravel has **no check-in**. Do not port it here.

---

## Phase 3 — Money and safeguarding

| Journey                 | Nav / surface  | Must include                                                                                             |
| ----------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| Giving                  | Donations      | Campaigns, splits, GivingJar adapter, ledger, receipts. Staging **donate** gate. Recurring blocked on Q1 |
| Membership              | Membership     | Plans, numbers, renewals via `PaymentProvider`                                                           |
| Records                 | Records        | Compliance documents, due dates                                                                          |
| Certifications          | Certifications | Parish certificate requests (admin + mobile); restricted PDFs; often children’s data                     |
| Volunteers              | Volunteers     | Applications, WWCC / Blue Card, documents, **police verification** page                                  |
| Safeguarding + check-in | (ops / kiosk)  | **New in core.** Incidents, messaging rules, check-in/out. Not a Laravel port                            |
| Commerce                | E-commerce     | Products, orders, inventory — only if a pilot uses the shop                                              |

After this phase, donate + form submit + RSVP can be proven on staging APIs even if the public site is still Laravel (Phase 4 is the public-site gate).

---

## Phase 4 — Public website on core

Journey: Jellycube **host adapter** + host widget pack (events, notices, bulletins, service times, forms, donate), or the thin in-core renderer if the SDK is not frozen (Q2). Same APIs either way.

Fills Website & CMS → Pages, Global Setting, Templates, and the top-bar **Website** button. Header/Footer live in the builder.

**Gate on first client migration:** public donate, form submit, and RSVP on staging against core — not against Laravel.

---

## Phase 5 — Client migration

Journey: Laravel importer; repeatable, idempotent against staging until sign-off. Restricted fields encrypted during import.

**Each client** moves admin, mobile, and public website in one window. No live parish split across Laravel and core.

**Must already be green:** tenant-isolation and residency suites for modules they use; staging donate / form submit / RSVP on the public site.

First success: **one live Australian parish**.

---

## Phase 6 — Growth

Further directory apps (mosques, sports clubs, other store names), white-label apps, organisation features (dioceses, leagues), SSO/SCIM, partner apps on Workers for Platforms, vertical packs for mosques and sports clubs.

---

## Phase 7 — New regions

Legal review and cell rollout. Canada, EU, US are designed for but not deployed until this phase.

---

## Laravel → core (do not re-litigate)

Inventory: `/Users/iamabdus/ai-coding-2/Community-Hub` against architecture §9 (2026-09-18).

- **No missing top-level module.** Eleven Laravel toggles map to the catalogue.
- **Name as journeys, not new modules:** certificate requests, mobile home CMS, Our Schools / Our Places, police verification.
- **Intentionally dropped:** backups, ZIP system update, URL scanner, per-client SMTP, deploy-migrate webhook, in-core visual editor (Jellycube).
- **Core adds that Laravel lacks:** check-in, safeguarding incidents, Person + Household + GuardianLink.

---

## Open questions that block later rows

From architecture §26. Do not invent answers in a spec.

| #   | Blocks                                       |
| --- | -------------------------------------------- |
| Q1  | Recurring giving, refunds, GivingJar onboard |
| Q2  | Phase 4 Jellycube vs thin renderer           |
| Q3  | Identity library (Phase 1 `identity-otp`)    |
| Q8  | Plan contents and pricing (entitlements)     |
| Q9  | EmailProvider (Settings → Email Settings)    |
| Q12 | Feature-flag vendor                          |

---

## Next spec

The next approved chunk on this list is **`terraform-au-cell`**, unless the human picks another remaining Phase 0 row.
