# Spec: Owner decisions 2026-11-04

Slug: owner-decisions
Status: approved (2026-11-04, Abdus Salam)
Architecture refs: §7.6, §8.1, §9, §10, §11.3, §11.4, §12.3, §14, §15, §19, §22, §23, §24, §25, §26, §21; ADR 0017, ADR 0018

## Problem

The owner recorded twelve product and policy decisions on 2026-11-04. The living documents still describe check-in, Laravel Email Settings, staging parallel migration, broader minor visibility through `people.restricted.read`, and open pricing. Implementers and reviewers need one authoritative record before the next feature chunks.

## Scope

**In**

- `docs/specs/2026-11-04-owner-decisions.md` and `docs/plans/2026-11-04-owner-decisions.md` (this chunk).
- ADR 0017 (children's data access) and ADR 0018 (client migration through a production preview).
- Updates to `architecture.md`, `AGENTS.md` (two edits only), and `docs/roadmap.md` as listed in the plan coverage table.
- No application code, tests, migrations, or Terraform.

**Out**

- Implementing check-in removal in code, children's UI, ops-console price editors, backup restore, GivingJar adapter, commerce, or migration tooling.
- Changing the "Where we are" snapshot in `docs/roadmap.md`.
- Editing merged specs, plans, or ADRs other than adding 0017 and 0018.

## Behaviour

This chunk changes documentation only. The twelve owner decisions are recorded verbatim in the spec sections below and applied in the files named in the coverage table.

### Decision 1 — Email Settings dropped

Sign-in mail is Amazon SES (ADR 0013). There is no per-parish email configuration screen. The Laravel Email Settings screen is not ported.

### Decision 2 — Bulletins

PDF upload is the default. A parish can also write a bulletin in the app (rich text). Both publish through the bulletins external collection.

### Decision 3 — GivingJar on Stripe Connect (refined later on 2026-11-04)

GivingJar is **our own platform**, built on Stripe Connect. Whatever core needs from it, we build in GivingJar, as far as Stripe Connect offers it. Recurring donations, refunds, per-community onboarding (Stripe Connect connected accounts), and signed webhooks to the Sydney hostname are built in GivingJar; core's `PaymentProvider` adapter uses them. Q1 is closed.

### Decision 4 — Tax receipt wording (refined later on 2026-11-04)

Tax receipt wording is not hardcoded. There is a **default** wording set in the ops console. Each parish uses that default or sets its own wording in **Giving settings** in admin.

### Decision 5 — Shop (refined later on 2026-11-04)

Shop is in scope: products only. Members buy products and pay online. Payments go through GivingJar, the same way as donations (`PaymentProvider` port). Every purchase is recorded in an order record. No stock levels and no delivery.

### Decision 6 — Pricing (refined later on 2026-11-04)

Two plans: **AUD 200 and AUD 500 per month**, plus a one-off **AUD 1,500 setup fee**. Prices are editable in the ops console. **Listed prices exclude GST**; tax is charged on top. Amounts are stored as integer minor units.

### Decision 7 — Children

- Check-in is not built (no check-in/check-out, no pickup codes, no kiosk).
- A child's details are entered by their parent or guardian through member surfaces (portal / Parish Hub).
- Only that guardian and the Community Admin role (`community_admin`) can see a child's details. Other staff cannot, whatever permission they hold (including `people.restricted.read`). Other staff may see that a household has a child, but no information about the child — no name, date of birth, or other field. Support operators cannot, even under a support grant or break-glass.
- For a Community Admin, each field is hidden by default and revealed one field at a time by clicking View. Every View needs a fresh second-factor check. Every View is audited (ids only, no values).
- Until the children's data access chunk ships, code on `main` is broader than this rule (for example Family Records and Life events use `people.restricted.read`). That gap must close before any client data is imported.
- **Second factor (refined later on 2026-11-04):** Every user of the admin app must set up a second factor during sign-up — authenticator app, passkey, or email code — before they can use the admin. Users who already exist or arrive through the Laravel import must set one up at their next sign-in before they can continue. The fresh check when a Community Admin views a child's field uses whichever second factor that admin has enrolled (**Two-factor for staff** chunk; sensitive).

### Decision 8 — Cookie notice and public website (refined later on 2026-11-04)

The cookie notice is owned by Jellycube, not core. Jellycube is ready by Phase 4. Inside Jellycube, the CMS / collection feature adds collections from an external source; Community Hub is that source. Mass times, events, bulletins and notices are separate collections. Jellycube ships Community Hub templates with those collections already bound, so data displays as soon as it arrives; drag-and-drop binding may come later. **The thin in-core renderer fallback is dropped** (owner 2026-11-04).

### Decision 9 — Backups (refined later on 2026-11-04)

No backup download. Community staff cannot see backups, cannot restore them, and nothing about backups appears in their dashboard. To restore, a parish contacts us with a request and ticket reference; we restore from the ops console. A restore must bring back one community's data without affecting any other community (shared database). Each restore is logged in the ops audit and in that parish's audit log; the restore tool never shows a minor's details to the operator; restored data stays in `ap-southeast-2`. Backups stay in `ap-southeast-2` only.

### Decision 10 — Client migration

Move all data, then run the client on a preview hostname in the production account so the client and the team can check it. Then switch over, take Laravel offline, and keep Laravel's backup encrypted in our AWS account in Sydney for 1 year after switch-over, then delete it. The preview holds real client data, so it is production under AGENTS.md rule 7: production account, Australia only, never staging. This replaces parallel run on staging and securely deleting the self-hosted database in architecture §24.2.

### Decision 11 — Profile Settings

Profile Settings includes "sign out of all devices", built in the same chunk. That needs a server call that ends every tenant session family of the user (authentication work; sensitive).

### Decision 12 — Sidebar

The sidebar shows the parish name at the bottom. It ships with the Community memberships endpoint chunk.

### Decision 13 — GST (answer A; refines decision 6)

Prices do not include GST or any other tax. Tax is charged on top of the listed price.

### Decision 14 — Second factor (answer B; refines decision 7)

Mandatory second factor at admin sign-up (or at next sign-in for existing and imported users). See decision 7 second-factor bullet and ADR 0017 decisions 6 and 7.

### Decision 15 — Receipt default (answer C; refines decision 4)

See decision 4.

### Decision 16 — Backups and restore (answer D; refines decision 9)

See decision 9.

### Decision 17 — Laravel backup retention (owner answer A; refines decision 10)

After switch-over, keep Laravel's backup encrypted in our AWS account in Sydney (`ap-southeast-2`) for 1 year, then delete it ([ADR 0018](docs/adr/0018-client-migration-preview.md); Q23 closed).

### Decision 18 — Receipt edit surface (owner answer B; refines decisions 4 and 15)

A parish that does not use the default wording sets its own in Giving settings in admin.

### Decision 19 — Broadcast Messages SMS (owner answer C)

Not built for now. Broadcast Messages sends email only; SMS can be a later chunk of its own. Do not add an SMS provider in this chunk.

### Decision 20 — Existing and imported users two-factor (owner answer D; refines decisions 7 and 14)

Users who already exist or arrive through the Laravel import set up a second factor at their next sign-in before they can continue.

### Decision 21 — Restore audit record (owner answer E; refines decisions 9 and 16)

A restore we run for a parish requires the parish's request with a ticket reference and is logged in the ops audit and in that parish's audit log.

### Decision 22 — Ops console build guide (owner 2026-11-04)

The ops console is the Community Hub SaaS admin. SaaS operators sign in to it and manage every community and the platform from its dashboard. **It is not being built now.** This chunk records roadmap rows and [`docs/ops-console.md`](../ops-console.md), a build guide so whoever builds each part later has everything decided and how to do it. The owner chose all four guide themes: (1) communities and their first admin; (2) plans, prices and billing, including per-community modules — current clients move across with **no loss of features** whatever plan they land on; (3) operators and support access, including an operator audit view; (4) default receipt wording, restoring one community, mobile app listings, and usage views. Each area in the guide is its own future chunk ([`AGENTS.md`](../../AGENTS.md) §3).

## Data

No tables or columns change in this chunk.

## Rules touched

Entitlements (`safeguarding.checkin` example in architecture §10.2 should not imply check-in ships). Children's safeguarding (§12.3, §11.3, §11.4). Residency and rule 7 (preview migration). Payments (GivingJar / Stripe Connect). Ops console editable plan prices, setup fee, and receipt wording.

## Contracts

None in this chunk. Future chunks will change Public Content API bulletins projection, payment adapter, ops routes, and identity session revocation.

## Risks

Documenting stricter children's access while `main` still allows `people.restricted.read` for minors could be read as already enforced. The spec and ADR 0017 state the known gap plainly. Migration on a production preview increases operational care (real data, rule 7).

## Open points

None remain from the 2026-11-04 owner decisions. Q2 is closed in `architecture.md` §26 and `docs/roadmap.md`. Q13 and other platform questions that were open before this chunk stay in `architecture.md` §26 where not closed here.

## Coverage table

| #   | Decision                             | Files and sections                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Email Settings dropped               | `architecture.md` §9 Laravel mapping note; `docs/roadmap.md` nav Settings row, inventory "Intentionally dropped", open questions Q9 closed                                                                                                                                                                |
| 2   | Bulletins                            | `architecture.md` §9 engagement row, §15.5 bulletins collection; `docs/roadmap.md` Phase 2 Bulletins row                                                                                                                                                                                                  |
| 3   | GivingJar Connect                    | `architecture.md` §14 payments, §26 Q1 closed; `docs/roadmap.md` Phase 3 GivingJar capabilities row, Giving row, open questions Q1 closed                                                                                                                                                                 |
| 4   | Receipt wording                      | `architecture.md` §14.3, §19 ops console; `docs/roadmap.md` ops row; `architecture.md` §26 Q18 closed                                                                                                                                                                                                     |
| 5   | Shop products only                   | `architecture.md` §8.1 `commerce/`, §9 ecommerce row, §25 Phase 5; `docs/roadmap.md` Phase 3 Commerce, nav E-commerce, inventory                                                                                                                                                                          |
| 6   | Plan pricing                         | `architecture.md` §10 pricing, §19 ops; `docs/roadmap.md` ops row; `architecture.md` §26 Q8, Q19 closed                                                                                                                                                                                                   |
| 7   | Children                             | `docs/adr/0017-childrens-data-access.md`; `architecture.md` §7.6, §8.1 safeguarding, §9 contacts/family rows, §11.1, §11.3–11.4, §12.3, §21, §23, §25 Phase 3; `AGENTS.md` §1 rule 4, §10 Stage 4; `docs/roadmap.md` Two-factor for staff + children's data access rows; `architecture.md` §26 Q20 closed |
| 8   | Cookie notice; Jellycube public site | `architecture.md` §15 (ADR 0006 amendment by statement), §25 Phase 4, §24, §26 Q2 closed; `docs/roadmap.md` North star, Phase 4, open questions Q2; Website host contract freeze row unchanged in Phase 2                                                                                                 |
| 9   | Backups                              | `architecture.md` §22; `docs/roadmap.md` inventory, Restore one community row; `architecture.md` §26 Q21 requirement, Q22 closed                                                                                                                                                                          |
| 10  | Client migration                     | `docs/adr/0018-client-migration-preview.md`; `architecture.md` §24.2–24.3; `docs/roadmap.md` Phase 5, North star                                                                                                                                                                                          |
| 11  | Sign out all devices                 | `docs/roadmap.md` Phase 2 Profile Settings row                                                                                                                                                                                                                                                            |
| 12  | Sidebar parish name                  | `docs/roadmap.md` Community memberships endpoint row                                                                                                                                                                                                                                                      |
| 13  | GST                                  | `architecture.md` §10, §26 Q19; `docs/roadmap.md` plan prices row, open questions Q19                                                                                                                                                                                                                     |
| 14  | Second factor                        | `docs/adr/0017-childrens-data-access.md`; `architecture.md` §11.1; `docs/roadmap.md` Two-factor for staff; §26 Q20                                                                                                                                                                                        |
| 15  | Receipt default                      | Same as decision 4                                                                                                                                                                                                                                                                                        |
| 16  | Restore                              | Same as decision 9                                                                                                                                                                                                                                                                                        |
| 17  | Laravel backup                       | `docs/adr/0018-client-migration-preview.md`; `architecture.md` §24.2 step 6; `docs/roadmap.md` Laravel importer row; `architecture.md` §26 Q23 closed                                                                                                                                                     |
| 18  | Receipt edit surface                 | `architecture.md` §14.3, §19, §26 Q18; `docs/roadmap.md` open questions Q18; spec decisions 4 and 15                                                                                                                                                                                                      |
| 19  | Broadcast SMS scope                  | `docs/roadmap.md` Broadcast Messages row; spec decision 19                                                                                                                                                                                                                                                |
| 20  | Two-factor at sign-in                | Spec decisions 7 and 14; `docs/adr/0017-childrens-data-access.md`; `architecture.md` §11.1; `docs/roadmap.md` Two-factor for staff                                                                                                                                                                        |
| 21  | Restore audit                        | `architecture.md` §11.4, §22, §19; `docs/roadmap.md` Restore one community row; spec decisions 9 and 16                                                                                                                                                                                                   |
| 22  | Ops console build guide              | `docs/ops-console.md`; `docs/roadmap.md` Ops console (SaaS admin) section; `architecture.md` §8.5 Ops console row, §19.3 Ops console subsection                                                                                                                                                           |
