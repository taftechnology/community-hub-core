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

### Decision 4 — Tax receipt wording

Tax receipt wording is not hardcoded. It is editable in the SaaS admin (ops console). Open: one global wording, or wording per parish.

### Decision 5 — Shop (interpretation to confirm with the owner)

Shop is in scope: products only. No stock levels and no delivery. Members can buy a product and pay; an order record exists so the purchase and payment are kept. No inventory counts, no shipping or delivery addresses.

### Decision 6 — Pricing

Two plans: USD 200 and USD 500 per month, plus a one-off USD 1,500 setup fee. Prices are editable in the ops console. Open: whether prices include GST. Amounts are stored as integer minor units.

### Decision 7 — Children

- Check-in is not built (no check-in/check-out, no pickup codes, no kiosk).
- A child's details are entered by their parent or guardian through member surfaces (portal / Parish Hub).
- Only that guardian and the Community Admin role (`community_admin`) can see a child's details. Other staff cannot, whatever permission they hold (including `people.restricted.read`). Support operators cannot, even under a support grant or break-glass.
- For a Community Admin, each field is hidden by default and revealed one field at a time by clicking View. Every View needs a fresh second-factor check. Every View is audited (ids only, no values).
- Until the children's data access chunk ships, code on `main` is broader than this rule (for example Family Records and Life events use `people.restricted.read`). That gap must close before any client data is imported.
- Open: second-factor method (authenticator app or email code).

### Decision 8 — Cookie notice

The cookie notice is owned by Jellycube, not core.

### Decision 9 — Backups

No backup download. Admins can see that backups exist and can restore them. All parishes share one database; restoring one parish without touching others needs its own design (open). Open: support-run restore or a self-service button. Backups stay in `ap-southeast-2` only.

### Decision 10 — Client migration

Move all data, then run the client on a preview hostname in the production account so the client and the team can check it. Then switch over, take Laravel offline, and keep Laravel's backup. The preview holds real client data, so it is production under AGENTS.md rule 7: production account, Australia only, never staging. This replaces parallel run on staging and securely deleting the self-hosted database in architecture §24.2. Open: where Laravel's backup is kept and for how long (must stay in Australia; do not invent a retention period).

### Decision 11 — Profile Settings

Profile Settings includes "sign out of all devices", built in the same chunk. That needs a server call that ends every tenant session family of the user (authentication work; sensitive).

### Decision 12 — Sidebar

The sidebar shows the parish name at the bottom. It ships with the Community memberships endpoint chunk.

## Data

No tables or columns change in this chunk.

## Rules touched

Entitlements (`safeguarding.checkin` example in architecture §10.2 should not imply check-in ships). Children's safeguarding (§12.3, §11.3, §11.4). Residency and rule 7 (preview migration). Payments (GivingJar / Stripe Connect). Ops console editable plan prices, setup fee, and receipt wording.

## Contracts

None in this chunk. Future chunks will change Public Content API bulletins projection, payment adapter, ops routes, and identity session revocation.

## Risks

Documenting stricter children's access while `main` still allows `people.restricted.read` for minors could be read as already enforced. The spec and ADR 0017 state the known gap plainly. Migration on a production preview increases operational care (real data, rule 7).

## Out-of-band

GST on listed prices needs product or finance confirmation (Q19). Shop interpretation (decision 5) needs owner confirmation. GivingJar API confirmation (Q1) remains with the vendor.

## Open points

| Topic                        | Status                                                          |
| ---------------------------- | --------------------------------------------------------------- |
| Receipt wording scope        | Global vs per parish (Q18)                                      |
| GST on plan and setup prices | Open (Q19)                                                      |
| Second factor for minor View | Authenticator vs email code (Q20)                               |
| Per-parish restore           | Design for one parish in a shared database (Q21)                |
| Restore operator             | Support-run vs self-service button (Q22)                        |
| Laravel backup after cutover | Location and retention, Australia only (Q23)                    |
| GivingJar API                | Q1 narrowed; four capabilities still to confirm                 |
| Shop delivery interpretation | Confirm with owner (decision 5 wording in architecture/roadmap) |

## Coverage table

| #   | Decision               | Files and sections                                                                                                                                                                                                                                                         |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Email Settings dropped | `architecture.md` §9 Laravel mapping note; `docs/roadmap.md` nav Settings row, inventory "Intentionally dropped", open questions Q9 closed                                                                                                                                 |
| 2   | Bulletins              | `architecture.md` §9 engagement row, §15.5 bulletins collection; `docs/roadmap.md` Phase 2 Bulletins row                                                                                                                                                                   |
| 3   | GivingJar Connect      | `architecture.md` §14 payments, §26 Q1; `docs/roadmap.md` Phase 3 Giving row, open questions Q1                                                                                                                                                                            |
| 4   | Receipt wording        | `architecture.md` §14.3, §19 ops console; `docs/roadmap.md` new ops row; `architecture.md` §26 Q18                                                                                                                                                                         |
| 5   | Shop products only     | `architecture.md` §8.1 `commerce/`, §9 ecommerce row, §25 Phase 5; `docs/roadmap.md` Phase 3 Commerce, nav E-commerce, inventory                                                                                                                                           |
| 6   | Plan pricing           | `architecture.md` §10 pricing, §19 ops; `docs/roadmap.md` new ops row; `architecture.md` §26 Q8, Q19                                                                                                                                                                       |
| 7   | Children               | `docs/adr/0017-childrens-data-access.md`; `architecture.md` §7.6, §8.1 safeguarding, §9 contacts/family rows, §11.3–11.4, §12.3, §21, §23, §25 Phase 3; `AGENTS.md` §1 rule 4, §10 Stage 4; `docs/roadmap.md` new sensitive row, Phase 3 Safeguarding, line 167, inventory |
| 8   | Cookie notice          | `architecture.md` §15 public website; `docs/roadmap.md` Phase 4 note                                                                                                                                                                                                       |
| 9   | Backups                | `architecture.md` §22; `docs/roadmap.md` inventory, new backups row; `architecture.md` §26 Q21, Q22                                                                                                                                                                        |
| 10  | Client migration       | `docs/adr/0018-client-migration-preview.md`; `architecture.md` §24.2–24.3; `docs/roadmap.md` Phase 5, North star                                                                                                                                                           |
| 11  | Sign out all devices   | `docs/roadmap.md` Phase 2 Profile Settings row                                                                                                                                                                                                                             |
| 12  | Sidebar parish name    | `docs/roadmap.md` Community memberships endpoint row                                                                                                                                                                                                                       |
