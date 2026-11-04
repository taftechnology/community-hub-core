# Spec: Owner decisions 2026-11-04

Slug: owner-decisions
Status: draft
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

### Decision 3 — GivingJar on Stripe Connect

GivingJar is built on Stripe Connect. Still to confirm with GivingJar: its API offers recurring donations, refunds, per-community onboarding, and signed webhooks. This narrows Q1; it does not close Q1.

### Decision 4 — Tax receipt wording (refined later on 2026-11-04)

Tax receipt wording is not hardcoded. There is a **default** wording set in the ops console. Each parish uses that default or sets its own wording. **Interpretation to confirm with the owner:** where a parish edits its own wording (Giving settings in admin).

### Decision 5 — Shop (interpretation to confirm with the owner)

Shop is in scope: products only. No stock levels and no delivery. Members can buy a product and pay; an order record exists so the purchase and payment are kept. No inventory counts, no shipping or delivery addresses.

### Decision 6 — Pricing (refined later on 2026-11-04)

Two plans: **AUD 200 and AUD 500 per month**, plus a one-off **AUD 1,500 setup fee**. Prices are editable in the ops console. **Listed prices exclude GST**; tax is charged on top. Amounts are stored as integer minor units.

### Decision 7 — Children

- Check-in is not built (no check-in/check-out, no pickup codes, no kiosk).
- A child's details are entered by their parent or guardian through member surfaces (portal / Parish Hub).
- Only that guardian and the Community Admin role (`community_admin`) can see a child's details. Other staff cannot, whatever permission they hold (including `people.restricted.read`). Support operators cannot, even under a support grant or break-glass.
- For a Community Admin, each field is hidden by default and revealed one field at a time by clicking View. Every View needs a fresh second-factor check. Every View is audited (ids only, no values).
- Until the children's data access chunk ships, code on `main` is broader than this rule (for example Family Records and Life events use `people.restricted.read`). That gap must close before any client data is imported.
- **Second factor (refined later on 2026-11-04):** The fresh check uses whatever second factor the Community Admin has set up — authenticator app, passkey, or email code. Tenant users need enrolment for a second factor (**Two-factor for staff** chunk; sensitive). **Interpretation to confirm:** if an admin has no second factor yet, they must set one up before using View. **Interpretation to confirm:** whether other staff can see that a household has a child (count only) or see nothing.

### Decision 8 — Cookie notice

The cookie notice is owned by Jellycube, not core.

### Decision 9 — Backups (refined later on 2026-11-04)

No backup download. Community staff cannot see backups, cannot restore them, and nothing about backups appears in their dashboard. To restore, a parish contacts us; we restore from the ops console. A restore must bring back one community's data without affecting any other community (shared database). Restore is a support action with a ticket reference and audit; the restore tool never shows a minor's details to the operator; restored data stays in `ap-southeast-2`. Backups stay in `ap-southeast-2` only.

### Decision 10 — Client migration

Move all data, then run the client on a preview hostname in the production account so the client and the team can check it. Then switch over, take Laravel offline, and keep Laravel's backup. The preview holds real client data, so it is production under AGENTS.md rule 7: production account, Australia only, never staging. This replaces parallel run on staging and securely deleting the self-hosted database in architecture §24.2. Open: where Laravel's backup is kept and for how long (must stay in Australia; do not invent a retention period).

### Decision 11 — Profile Settings

Profile Settings includes "sign out of all devices", built in the same chunk. That needs a server call that ends every tenant session family of the user (authentication work; sensitive).

### Decision 12 — Sidebar

The sidebar shows the parish name at the bottom. It ships with the Community memberships endpoint chunk.

### Decision 13 — GST (answer A; refines decision 6)

Prices do not include GST or any other tax. Tax is charged on top of the listed price.

### Decision 14 — Second factor (answer B; refines decision 7)

See decision 7 second-factor bullet and ADR 0017 decision 6.

### Decision 15 — Receipt default (answer C; refines decision 4)

See decision 4.

### Decision 16 — Backups and restore (answer D; refines decision 9)

See decision 9.

## Data

No tables or columns change in this chunk.

## Rules touched

Entitlements (`safeguarding.checkin` example in architecture §10.2 should not imply check-in ships). Children's safeguarding (§12.3, §11.3, §11.4). Residency and rule 7 (preview migration). Payments (GivingJar / Stripe Connect). Ops console editable plan prices, setup fee, and receipt wording.

## Contracts

None in this chunk. Future chunks will change Public Content API bulletins projection, payment adapter, ops routes, and identity session revocation.

## Risks

Documenting stricter children's access while `main` still allows `people.restricted.read` for minors could be read as already enforced. The spec and ADR 0017 state the known gap plainly. Migration on a production preview increases operational care (real data, rule 7).

## Out-of-band

Shop interpretation (decision 5) needs owner confirmation. Receipt wording edit surface (decision 4) and children's staff visibility (decision 7) need owner confirmation. GivingJar API confirmation (Q1) remains with the vendor.

## Open points

| Topic                        | Status                                                          |
| ---------------------------- | --------------------------------------------------------------- |
| Receipt wording edit surface | Interpretation: Giving settings vs ops only (decision 4)        |
| Other staff and child count  | Interpretation: count vs nothing (decision 7)                   |
| No second factor yet         | Interpretation: must enrol before View (decision 7)             |
| Laravel backup after cutover | Location and retention, Australia only (Q23)                    |
| GivingJar API                | Q1 narrowed; four capabilities still to confirm                 |
| Shop delivery interpretation | Confirm with owner (decision 5 wording in architecture/roadmap) |

## Coverage table

| #   | Decision               | Files and sections                                                                                                                                                                                                                                                                                        |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Email Settings dropped | `architecture.md` §9 Laravel mapping note; `docs/roadmap.md` nav Settings row, inventory "Intentionally dropped", open questions Q9 closed                                                                                                                                                                |
| 2   | Bulletins              | `architecture.md` §9 engagement row, §15.5 bulletins collection; `docs/roadmap.md` Phase 2 Bulletins row                                                                                                                                                                                                  |
| 3   | GivingJar Connect      | `architecture.md` §14 payments, §26 Q1; `docs/roadmap.md` Phase 3 Giving row, open questions Q1                                                                                                                                                                                                           |
| 4   | Receipt wording        | `architecture.md` §14.3, §19 ops console; `docs/roadmap.md` ops row; `architecture.md` §26 Q18 closed                                                                                                                                                                                                     |
| 5   | Shop products only     | `architecture.md` §8.1 `commerce/`, §9 ecommerce row, §25 Phase 5; `docs/roadmap.md` Phase 3 Commerce, nav E-commerce, inventory                                                                                                                                                                          |
| 6   | Plan pricing           | `architecture.md` §10 pricing, §19 ops; `docs/roadmap.md` ops row; `architecture.md` §26 Q8, Q19 closed                                                                                                                                                                                                   |
| 7   | Children               | `docs/adr/0017-childrens-data-access.md`; `architecture.md` §7.6, §8.1 safeguarding, §9 contacts/family rows, §11.1, §11.3–11.4, §12.3, §21, §23, §25 Phase 3; `AGENTS.md` §1 rule 4, §10 Stage 4; `docs/roadmap.md` Two-factor for staff + children's data access rows; `architecture.md` §26 Q20 closed |
| 8   | Cookie notice          | `architecture.md` §15 public website; `docs/roadmap.md` Phase 4 note                                                                                                                                                                                                                                      |
| 9   | Backups                | `architecture.md` §22; `docs/roadmap.md` inventory, Restore one community row; `architecture.md` §26 Q21 requirement, Q22 closed                                                                                                                                                                          |
| 10  | Client migration       | `docs/adr/0018-client-migration-preview.md`; `architecture.md` §24.2–24.3; `docs/roadmap.md` Phase 5, North star                                                                                                                                                                                          |
| 11  | Sign out all devices   | `docs/roadmap.md` Phase 2 Profile Settings row                                                                                                                                                                                                                                                            |
| 12  | Sidebar parish name    | `docs/roadmap.md` Community memberships endpoint row                                                                                                                                                                                                                                                      |
| 13  | GST                    | `architecture.md` §10, §26 Q19; `docs/roadmap.md` plan prices row, open questions Q19                                                                                                                                                                                                                     |
| 14  | Second factor          | `docs/adr/0017-childrens-data-access.md`; `architecture.md` §11.1; `docs/roadmap.md` Two-factor for staff; §26 Q20                                                                                                                                                                                        |
| 15  | Receipt default        | Same as decision 4                                                                                                                                                                                                                                                                                        |
| 16  | Restore                | Same as decision 9                                                                                                                                                                                                                                                                                        |
