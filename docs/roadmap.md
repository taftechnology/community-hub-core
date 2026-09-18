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

## Where we are

|              |                                 |
| ------------ | ------------------------------- |
| Phase        | 0 — Foundations                 |
| Last shipped | `terraform-au-cell` (on `main`) |
| Next chunk   | `packages-db`                   |
| Phase 0      | 2 / 9 done                      |
| Later phases | not started                     |

Update the snapshot and the row in the **same PR** that completes, splits, or drops a chunk. Do not put implementer reports here ([AGENTS.md](../AGENTS.md) §5).

---

## How to read this

| Status          | Meaning                    |
| --------------- | -------------------------- |
| **done**        | On `main`. Do not re-spec. |
| **in progress** | Spec approved or PR open.  |
| **not started** | No approved spec yet.      |

Phase 0–1 rows are **chunks** (one spec → plan → branch → PR). Phase 2–7 rows are **journeys**; specs are cut when we enter that phase.

---

## Phase 0 — Foundations

Architecture: monorepo, CI, Terraform, kernel, residency, db with RLS, crypto, observability, audit, `packages/ui`.

| Status      | Chunk                | What                                                                                        |
| ----------- | -------------------- | ------------------------------------------------------------------------------------------- |
| done        | `monorepo-skeleton`  | Workspace, gateway `/health`, checkers, CI Stages 1–3. Spec `2026-09-17-monorepo-skeleton`. |
| done        | `terraform-au-cell`  | Cloudflare + AU AWS foundations. No tenant data. Spec `2026-09-18-terraform-au-cell`.       |
| not started | `packages-db`        | Drizzle, Hyperdrive, `SET LOCAL` per transaction, RLS helpers, migration runner.            |
| not started | `packages-crypto`    | AES-256-GCM, KMS wrap, blind indexes. Synthetic data only.                                  |
| not started | `kernel-runtime`     | `defineModule`, request context, DI, outbox. Keeps `healthPayload`.                         |
| not started | `packages-residency` | Cell config; global Workers cannot import personal-data modules.                            |
| not started | `packages-ui`        | shadcn copied into the repo + tokens (D16). No product screens.                             |
| not started | `audit-log`          | Tamper-evident append. First events when identity writes.                                   |
| not started | `api-au-skeleton`    | Regional Worker, `class: regional`, `preview_urls: false`, health through kernel.           |

Kernel is **not** yet `defineModule` / request context / DI / outbox. Observability is the logger only (no product analytics SDK — D17).

Shipped with the skeleton (not separate chunks): `@community-hub/kernel` `healthPayload()`, structured logger, `apps/gateway`, `tooling/checks/`, ADR 0001 preview URLs, session-scratch gitignore.

---

## Phase 1 — Core platform

Vertical slices. Nav items appear in the frozen order (see [Admin navigation](#admin-navigation-frozen)) and stay **hidden** until entitled.

| Status      | Chunk                  | What                                                                                              |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------------- |
| not started | `admin-shell`          | `apps/admin` with the sidebar sequence. Dashboard only; everything else hidden.                   |
| not started | `tenancy-implicit-org` | Organisation + community. Control-plane directory: IDs, slugs, region — never names.              |
| not started | `identity-otp`         | Regional identity, OTP, passkeys path as designed. No email on gateway.                           |
| not started | `people-households`    | Person, Household, GuardianLink, `is_minor`. Tags + activity log land here.                       |
| not started | `access-roles`         | Settings → Users & Roles.                                                                         |
| not started | `entitlements-plans`   | Control-plane plans and allocations; community toggles; nav hide/show.                            |
| not started | `stripe-billing`       | Our subscriptions. Webhooks on `webhooks-au`; work on `exec`. Not GivingJar.                      |
| not started | `ops-console`          | Cloudflare Access. Tenant reads proxy to `api-au`. No decrypt, log, or buffer of personal fields. |
| not started | `usage-facts`          | `core/usage` skeleton (community × feature × day). Facts grow as modules ship.                    |

Phase 1 does **not** fill Enquires, Engagement, Family Records, Membership, Records, Certifications, Volunteers, Forms, Communication, Mobile App, Website & CMS, Donations, or E-commerce.

---

## Phase 2 — Engagement and mobile

Journeys, not a full backlog. Cut specs when this phase starts. Fill nav in this order where possible. Ship **`verticals/faith-church`** here (Mass times, sacraments, parish wording).

| Status      | Journey                      | Nav / surface                             | Must include                                                                                                        |
| ----------- | ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| not started | Groups                       | Contacts & Members → Groups               | Ministries, members, export                                                                                         |
| not started | All Contacts admin           | Contacts & Members → All Contacts         | Built on people/households; no children in public directories                                                       |
| not started | Family Records               | Family Records                            | Household UI; **life events** inside this item                                                                      |
| not started | Mass Timings                 | Engagement → Mass Timings                 | Service times; labels from faith-church                                                                             |
| not started | Notice Board                 | Engagement → Notice Board                 | Pin; **approve / reject**                                                                                           |
| not started | Bulletins                    | Engagement → Bulletins                    | CRUD, PDF as in Laravel if still required                                                                           |
| not started | Events                       | Engagement → Events                       | Free and **paid** RSVP, ticket types, capacity, booking detail, external ticketing URL. Staging **RSVP** gate       |
| not started | Forms + Enquires             | Forms; Enquires                           | Builder, classification on fields, public submit, enquiry inbox. Staging **form submit** gate                       |
| not started | Broadcast Messages           | Communication                             | Email to entitled audiences; IDs in, send from `exec`. No personal data in jobs                                     |
| not started | Content                      | Website & CMS: Blog, Gallery, Team, Media | Public Content API. Our Schools / Our Places as content, not new modules                                            |
| not started | Mobile home CMS + Parish Hub | Mobile App                                | Cards, nav, ministries, sacraments, mass times. App Registry. **`parish-hub-au` only**. Legacy compatibility router |

Laravel has **no check-in**. Do not port it here.

---

## Phase 3 — Money and safeguarding

| Status      | Journey                 | Nav / surface  | Must include                                                                                             |
| ----------- | ----------------------- | -------------- | -------------------------------------------------------------------------------------------------------- |
| not started | Giving                  | Donations      | Campaigns, splits, GivingJar adapter, ledger, receipts. Staging **donate** gate. Recurring blocked on Q1 |
| not started | Membership              | Membership     | Plans, numbers, renewals via `PaymentProvider`                                                           |
| not started | Records                 | Records        | Compliance documents, due dates                                                                          |
| not started | Certifications          | Certifications | Parish certificate requests (admin + mobile); restricted PDFs; often children’s data                     |
| not started | Volunteers              | Volunteers     | Applications, WWCC / Blue Card, documents, **police verification** page                                  |
| not started | Safeguarding + check-in | (ops / kiosk)  | **New in core.** Incidents, messaging rules, check-in/out. Not a Laravel port                            |
| not started | Commerce                | E-commerce     | Products, orders, inventory — only if a pilot uses the shop                                              |

After this phase, donate + form submit + RSVP can be proven on staging APIs even if the public site is still Laravel (Phase 4 is the public-site gate).

---

## Phase 4 — Public website on core

| Status      | Journey                                   | Must include                                                                                                                                 |
| ----------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| not started | Jellycube host adapter + host widget pack | Events, notices, bulletins, service times, forms, donate — or the thin in-core renderer if the SDK is not frozen (Q2). Same APIs either way. |

Fills Website & CMS → Pages, Global Setting, Templates, and the top-bar **Website** button. Header/Footer live in the builder.

**Gate on first client migration:** public donate, form submit, and RSVP on staging against core — not against Laravel.

---

## Phase 5 — Client migration

| Status      | Journey          | Must include                                                                                      |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| not started | Laravel importer | Repeatable, idempotent against staging until sign-off. Restricted fields encrypted during import. |

**Each client** moves admin, mobile, and public website in one window. No live parish split across Laravel and core.

**Must already be green:** tenant-isolation and residency suites for modules they use; staging donate / form submit / RSVP on the public site.

First success: **one live Australian parish**.

---

## Phase 6 — Growth

| Status      | Journey                | Must include                             |
| ----------- | ---------------------- | ---------------------------------------- |
| not started | Further directory apps | Mosques, sports clubs, other store names |
| not started | White-label apps       | Additional branded mobile apps           |
| not started | Organisation features  | Dioceses, leagues                        |
| not started | SSO / SCIM             | Enterprise identity                      |
| not started | Partner apps           | Workers for Platforms                    |
| not started | Vertical packs         | Mosques and sports clubs                 |

---

## Phase 7 — New regions

| Status      | Journey              | Must include                                                       |
| ----------- | -------------------- | ------------------------------------------------------------------ |
| not started | Legal review + cells | Canada, EU, US are designed for but not deployed until this phase. |

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

The next approved chunk on this list is **`packages-db`**, unless the human picks another remaining Phase 0 row.

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
