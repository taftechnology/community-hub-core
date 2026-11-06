# Ops console build guide

The Community Hub **ops console** is the SaaS admin surface. SaaS operators sign in on the ops hostname and manage every community and the platform from its dashboard. It is **not being built now**. This document records roadmap rows and a build guide so each part can ship as its own chunk with its own spec, plan and pull request ([`AGENTS.md`](../AGENTS.md) §3).

---

## What exists today

| Piece                     | Path                              | What it does                                                                                                                                          |
| ------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ops UI shell              | `apps/ops`                        | Sign-in with passkeys, enrolment, read-only directory (`docs/specs/2026-10-26-ops-console-ui.md`)                                                     |
| Ops HTTP routes           | `apps/api/src/ops-routes.ts`      | Enrolment, passkeys, session, `GET /v1/ops/me`, `GET /v1/ops/directory`; role → permission map with `ops.directory.view` for all three platform roles |
| Operator cookies          | `apps/api/src/ops-cookies.ts`     | `__Host-ops_at` / `__Host-ops_rt`, Origin check                                                                                                       |
| Static bundle             | `apps/api/src/ops-static.ts`      | Serves `apps/ops` when `OPS_STATIC_DIR` is set                                                                                                        |
| First tenant bootstrap    | `apps/api/src/provision-owner.ts` | One-off: creates an organisation, community and owner user (`docs/runbooks/apply-staging-au.md`, **Provision the first owner**)                       |
| Operator administration   | `apps/api/src/ops-operator.ts`    | One-off: grant, revoke, recover operators (`docs/runbooks/ops-operator.md`)                                                                           |
| Stripe plan / price setup | `apps/api/src/billing-admin.ts`   | One-off: Stripe products, prices, tax rate, billing mode (`docs/runbooks/apply-staging-au.md`, **Stripe billing**)                                    |

Merged specs: `docs/specs/2026-10-22-ops-operator-identity.md`, `docs/specs/2026-10-25-ops-console-api.md`, `docs/specs/2026-10-26-ops-operator-oneoff.md`, `docs/specs/2026-10-26-ops-console-ui.md`, `docs/specs/2026-10-27-ops-console-proof.md`, `docs/specs/2026-10-17-stripe-billing.md`, `docs/specs/2026-10-19-billing-read-only.md`, `docs/specs/2026-10-12-entitlements-plans.md`, `docs/specs/2026-10-28-usage-facts.md`.

---

## Rules every ops chunk keeps

| Rule                                                                                                                                                                  | Source                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Operators sign in with passkeys on the ops hostname; platform roles require passkeys (no email OTP to start or recover a platform session)                            | [`architecture.md`](../architecture.md) §11.4                                                                                                |
| Operator identity actions are recorded in `identity.operator_events` (ids only, no personal data in the payload). Tenant-visible grant reads use the tenant audit log | [`architecture.md`](../architecture.md) §11.4, §19.2; operator identity specs. **Proposed:** new ops-area audit action names in later chunks |
| The `platform` database role has **no** privileges on the `app` schema                                                                                                | [`architecture.md`](../architecture.md) §11.4, §7.2                                                                                          |
| Tenant data is read only under a §11.4 grant, using the `app` role with tenant scope set per transaction                                                              | [`architecture.md`](../architecture.md) §11.4                                                                                                |
| Support grants and break-glass never include a minor's details                                                                                                        | [ADR 0017](adr/0017-childrens-data-access.md); [`architecture.md`](../architecture.md) §11.4                                                 |
| No personal data in URLs, logs, traces, analytics or AI calls                                                                                                         | [`AGENTS.md`](../AGENTS.md) §1 rules 5–6; [`architecture.md`](../architecture.md) §17, D17                                                   |
| Personal data stays in Australia (`ap-southeast-2`); Stripe Billing and webhooks use the Sydney hostname                                                              | [`AGENTS.md`](../AGENTS.md) §1 rule 1; [`architecture.md`](../architecture.md) §7.3, §14                                                     |
| Ops UI composes `packages/ui` and meets WCAG 2.2 AA                                                                                                                   | [`architecture.md`](../architecture.md) §8.5, §21.1; [`AGENTS.md`](../AGENTS.md) §6                                                          |
| Permissions are enforced in the API, not only hidden in the UI                                                                                                        | [`architecture.md`](../architecture.md) §8.5 rule 3; [`AGENTS.md`](../AGENTS.md) §6                                                          |
| Destructive actions ask for confirmation                                                                                                                              | Product convention; each area spec states which actions                                                                                      |

---

## Areas (build order)

### 1. Communities and first admin

**What operators can do (target).** Create an organisation and its first community; invite or attach the first community owner; view organisation and community directory metadata (ids, slugs, kind, region); suspend or close a community when the spec defines those states.

**What it replaces.** `provision-owner` one-off (`apps/api/src/provision-owner.ts`).

**Data.** `platform.organisations`, `platform.communities` ([`architecture.md`](../architecture.md) §6, tenancy manifest). Identity user and access grants for the first owner (`identity` schema). **Proposed:** needs a table for community lifecycle state (for example active, suspended, closed) if not carried on existing columns — classification in the spec.

**Routes (Proposed).**

- `POST /v1/ops/communities` — create organisation + first community + owner bootstrap
- `GET /v1/ops/communities/{organisationId}` — organisation detail (fields per spec; not narrower than directory unless deliberate)
- `PATCH /v1/ops/communities/{organisationId}/communities/{communityId}` — suspend / close / reactivate per spec

**Permissions (Proposed).**

| Key                         | **Proposed** role holders                                 |
| --------------------------- | --------------------------------------------------------- |
| `ops.communities.create`    | `platform_admin`                                          |
| `ops.communities.view`      | `platform_admin`, `platform_support`, `platform_security` |
| `ops.communities.lifecycle` | `platform_admin`                                          |

**Audit.** Every create and lifecycle change appends to the operator event record (action name and target ids only).

**Sensitive?** Yes — tenancy and billing side-effects when closing.

**Depends on.** Ops sign-in and directory (`ops-console-api`, `ops-console-ui` — done).

**Decided.** Directory today: each organisation returns `id`, `slug`, `kind` and `region`; each community returns `id` and `slug` (`GET /v1/ops/directory`, `listDirectory` in `modules/core/tenancy/infrastructure/directory.ts`; the UI shows slug, kind and region for organisations, not ids). Closing a community follows the **tenant offboarding** resumable job in the regional service ([`architecture.md`](../architecture.md) §18). Billing read-only behaviour when an organisation cannot write is already specified in `docs/specs/2026-10-19-billing-read-only.md` — cite that spec; do not redesign the 402 guard here.

**Open for the spec.** What **suspend** and **close** mean in product terms; whether suspend blocks sign-in, writes, or public surfaces; timing relative to Stripe subscription state; whether the first admin is invited by email or linked to an existing identity user.

---

### 2. Operators and the operator audit view

**What operators can do (target).** Grant, revoke and recover operators and their platform roles from the console; register the operator audit **view** (search and read operator event records — ids only).

**What it replaces.** `ops-operator` one-off (`apps/api/src/ops-operator.ts`, `docs/runbooks/ops-operator.md`).

**Data.** `identity` operator users, grants, passkeys, operator event records (existing identity module). No `app` reads.

**Routes (Proposed).**

- `POST /v1/ops/operators/grant`
- `POST /v1/ops/operators/revoke`
- `POST /v1/ops/operators/recover`
- `GET /v1/ops/operators` — list operator ids and role keys
- `GET /v1/ops/audit/events` — operator audit view (cursor by id or time; filters by action and target id)

**Permissions (Proposed).**

| Key                    | **Proposed** role holders                                 |
| ---------------------- | --------------------------------------------------------- |
| `ops.operators.manage` | `platform_admin`                                          |
| `ops.operators.view`   | `platform_admin`, `platform_security`                     |
| `ops.audit.view`       | `platform_admin`, `platform_support`, `platform_security` |

**Audit.** Grant, revoke and recover are themselves audited. The audit view reads existing operator events only.

**Sensitive?** Yes — authentication and operator identity.

**Depends on.** Area 1 not required; can ship after current ops shell. Two-person `platform_security` recovery ([`architecture.md`](../architecture.md) §11.4) may remain owner-only until a later chunk — spec must say.

**Decided.** Interim owner-only recovery is documented in [ADR 0015](adr/0015-interim-operator-recovery.md). Enrolment uses email code plus owner-issued enrolment code ([`architecture.md`](../architecture.md) §11.4).

**Open for the spec.** Whether recover stays owner-only in the console or moves to two `platform_security` operators; retention and pagination for the audit view; which actions appear in the default filter.

---

### 3. Plans, prices and billing

**What operators can do (target).** Edit the two plan prices (AUD 200 and AUD 500 per month), the AUD 1,500 one-off setup fee, and GST handling (listed prices exclude GST; tax charged on top); sync Stripe Billing products and prices from the regional service; view billing mode and account state per organisation.

**What it replaces.** `billing-admin` one-off (`apps/api/src/billing-admin.ts`).

Both plans include `module.engagement` (Mass Times), as Laravel does.

**Data.** `platform.plans`, billing settings and accounts (`core/billing`, `core/entitlements` — see stripe-billing and entitlements-plans specs). Stripe ids stored as internal platform columns.

**Routes (Proposed).**

- `GET /v1/ops/billing/plans`
- `PATCH /v1/ops/billing/plans/{planId}` — integer minor units only
- `PATCH /v1/ops/billing/setup-fee`
- `POST /v1/ops/billing/sync` — re-read from Stripe
- `GET /v1/ops/billing/organisations/{organisationId}` — state and mode (ids only)

**Permissions (Proposed).**

| Key                | **Proposed** role holders            |
| ------------------ | ------------------------------------ |
| `ops.billing.view` | `platform_admin`, `platform_support` |
| `ops.billing.edit` | `platform_admin`                     |

**Audit.** Every price or fee change and every sync.

**Sensitive?** Yes — billing and money.

**Depends on.** Stripe Billing on `main` (`stripe-billing`, `billing-read-only`).

**Decided.** Two plans at **AUD 200 and AUD 500 per month**, **AUD 1,500** one-off setup fee, **excluding GST** with tax on top; integer minor units; editable in the ops console (owner 2026-11-04, [`architecture.md`](../architecture.md) §10). Billing is **Stripe Billing from the regional service**; webhooks on the **Sydney hostname** ([`architecture.md`](../architecture.md) §14, [`AGENTS.md`](../AGENTS.md) §1). Current clients move across with **no loss of features** whatever plan they land on (owner decisions 2026-11-04).

**Open for the spec.** How plan edits propagate to existing Stripe subscriptions; whether sync is automatic on save or explicit; display currency and rounding rules in the UI.

---

### 4. Modules per community

**What operators can do (target).** Assign plan and add-ons at organisation level; allocate entitlements to communities; set organisation or community overrides and feature flags where product allows — mirroring what today is platform-table writes without HTTP.

**What it replaces.** No single one-off today; entitlements admin is API-only for tenants (`entitlements.manage`).

**Data.** `platform.plans`, `platform.add_ons`, `platform.organisation_plans`, `platform.organisation_add_ons`, `platform.community_allocations`, `platform.entitlement_overrides`, `platform.feature_flags` ([`docs/specs/2026-10-12-entitlements-plans.md`](specs/2026-10-12-entitlements-plans.md), [`architecture.md`](../architecture.md) §10.1).

**Routes (Proposed).**

- `GET /v1/ops/entitlements/organisations/{organisationId}`
- `PUT /v1/ops/entitlements/organisations/{organisationId}/plan`
- `PUT /v1/ops/entitlements/communities/{communityId}/allocations`
- `PUT /v1/ops/entitlements/overrides` — scoped override writes per spec

**Permissions (Proposed).**

| Key                       | **Proposed** role holders            |
| ------------------------- | ------------------------------------ |
| `ops.entitlements.view`   | `platform_admin`, `platform_support` |
| `ops.entitlements.manage` | `platform_admin`                     |

**Audit.** Every change to plan assignment, allocation, override or flag.

**Sensitive?** Yes — tenancy and commercial terms.

**Depends on.** Area 3 for plan catalogue; entitlements module on `main`.

**Decided.** Evaluation order and read-only billing guard stay as in [`architecture.md`](../architecture.md) §10.3 and `billing-read-only` spec.

**Open for the spec.** Which overrides operators may set versus parish self-serve toggles; UI for multi-community organisations; validation when disabling a module a parish still uses.

---

### 5. Support access (grants and break-glass)

**What operators can do (target).** Open a time-boxed support grant after ticket reference and in-product tenant approval; read tenant data only through grant-scoped `app` role sessions; run break-glass with two `platform_security` operators; never browse tenant data outside a grant.

**What it replaces.** No one-off; grants are a future tenant/API feature referenced in [`architecture.md`](../architecture.md) §11.4.

**Data.** **Proposed:** needs tables for grant requests, active grants, break-glass episodes — classification in the spec. Reads use existing `app` tables under RLS with tenant scope.

**Routes (Proposed).**

- `POST /v1/ops/support/grants` — request with ticket reference
- `GET /v1/ops/support/grants/{grantId}`
- `POST /v1/ops/support/grants/{grantId}/end`
- `POST /v1/ops/support/break-glass` — two-operator ceremony per spec
- Grant-scoped read routes reuse tenant module paths with ops session + grant id (ids only in paths)

**Permissions (Proposed).**

| Key                       | **Proposed** role holders        |
| ------------------------- | -------------------------------- |
| `ops.support.grant`       | `platform_support`               |
| `ops.support.break_glass` | `platform_security` (two-person) |

**Audit.** Every grant read is audited and visible to the tenant ([`architecture.md`](../architecture.md) §11.4). Operator events for grant lifecycle.

**Sensitive?** Yes — authentication, tenancy, children's data (excluded), residency.

**Depends on.** Tenant approval flow in admin; Area 2 for operator roles.

**Decided.** Exactly [`architecture.md`](../architecture.md) §11.4: ticket reference, in-product approval, default **4-hour** time-box, scoped to named modules, every read audited; break-glass needs **two** `platform_security` people and the tenant is told afterwards; grants and break-glass **never** include a minor's details ([ADR 0017](adr/0017-childrens-data-access.md)).

**Open for the spec.** Module list for scope; UI for tenant approvers; how operators invoke read APIs without personal data in URLs; break-glass ceremony details.

---

### 6. Default tax receipt wording

**What operators can do (target).** Set and update the platform default tax receipt and DGR wording stored for `giving` to use when a parish has not set its own.

**What it replaces.** No one-off today (wording is configuration to be added).

**Data.** **Proposed:** needs a platform settings row or column for default receipt text — classification in the spec (likely `internal`, not personal).

**Routes (Proposed).**

- `GET /v1/ops/giving/receipt-default`
- `PUT /v1/ops/giving/receipt-default`

**Permissions (Proposed).**

| Key                               | **Proposed** role holders            |
| --------------------------------- | ------------------------------------ |
| `ops.giving.receipt_default.view` | `platform_admin`, `platform_support` |
| `ops.giving.receipt_default.edit` | `platform_admin`                     |

**Audit.** Every change to default wording.

**Sensitive?** No — product copy, not PII.

**Depends on.** `giving` module and receipts behaviour ([`architecture.md`](../architecture.md) §14.3).

**Decided.** Default set in the ops console; a parish that does not use it sets its own in **Giving settings** in admin (owner 2026-11-04, [`architecture.md`](../architecture.md) §14.3, Q18 closed).

**Open for the spec.** Rich text versus plain; versioning; whether parishes see a diff when the default changes; hash or version id in audit, not full text in logs.

---

### 7. Restore one community

**What operators can do (target).** Run a restore for one community from backup or point-in-time, given the parish's ticket reference, without affecting other communities in the shared database; see progress and outcome without any minor's details.

**What it replaces.** Manual runbook steps today (no console).

**Data.** RDS backup / PITR in `ap-southeast-2` only ([`architecture.md`](../architecture.md) §22). **Proposed:** needs a table for restore jobs (community id, ticket reference, status, operator id).

**Routes (Proposed).**

- `POST /v1/ops/restore/communities/{communityId}` — body: ticket reference id only
- `GET /v1/ops/restore/jobs/{jobId}`

**Permissions (Proposed).**

| Key                | **Proposed** role holders             |
| ------------------ | ------------------------------------- |
| `ops.restore.run`  | `platform_admin`                      |
| `ops.restore.view` | `platform_admin`, `platform_security` |

**Audit.** Logged in the **ops audit** and in **that parish's audit log** (owner 2026-11-04).

**Sensitive?** Yes — residency, tenancy, encryption, children's data (tool must not show minors).

**Depends on.** Area 2 audit view; backup design in architecture §22.

**Decided.** Community staff cannot see or restore backups; parish asks with a **ticket reference**; restore **one community** without affecting others; restore tool **never shows a minor's details**; data stays in **`ap-southeast-2`** ([`architecture.md`](../architecture.md) §22, [ADR 0017](adr/0017-childrens-data-access.md)).

**Open for the spec.** PITR versus snapshot; dry-run; communication to the parish; technical isolation mechanism in a shared database (Q21 requirement closed — design in this chunk).

---

### 8. Mobile app listings

**What operators can do (target).** Create and edit App Registry rows; attach community listings to an app; enforce entitlement prerequisites (`mobile.listing`, `mobile.whitelabel`).

**What it replaces.** Manual platform-table writes.

**Data.** App Registry tables ([`architecture.md`](../architecture.md) §13): app rows and listings on `platform`.

**Routes (Proposed).**

- `GET /v1/ops/apps`
- `POST /v1/ops/apps`
- `PUT /v1/ops/apps/{appId}`
- `PUT /v1/ops/apps/{appId}/listings/{communityId}`

**Permissions (Proposed).**

| Key               | **Proposed** role holders            |
| ----------------- | ------------------------------------ |
| `ops.apps.view`   | `platform_admin`, `platform_support` |
| `ops.apps.manage` | `platform_admin`                     |

**Audit.** Every app or listing change.

**Sensitive?** No — directory metadata.

**Depends on.** App Registry schema from Mobile App phase; entitlements keys on `main`.

**Decided.** Operators create app rows and listings in the ops console; entitlement is necessary but **nothing appears in an app until an operator lists the community** ([`architecture.md`](../architecture.md) §13).

**Open for the spec.** Store listing metadata fields; validation when entitlement missing; whitelabel versus directory apps.

---

### 9. Usage views

**What operators can do (target).** See platform product intelligence: feature adoption (entitled / toggled / used), idle communities, surface mix, adoption lag — as described in [`architecture.md`](../architecture.md) §19.3 ops console bullets. Not tenant billing dashboards and not user-level analytics.

**What it replaces.** No one-off; `core/usage` writes `app.usage_facts_daily` today (`docs/specs/2026-10-28-usage-facts.md`).

**Data.** `app.usage_facts_daily` (regional) and, **Proposed**, a `platform` copy table filled by a scheduled job (allow-list of count columns only — leaning in architecture, not decided).

**Routes (Proposed).**

- `GET /v1/ops/usage/summary` — query: date range and feature keys only (no personal data in query strings)
- `GET /v1/ops/usage/communities/{communityId}` — aggregate counts only

**Permissions (Proposed).**

| Key              | **Proposed** role holders            |
| ---------------- | ------------------------------------ |
| `ops.usage.view` | `platform_admin`, `platform_support` |

**Audit.** Read-only views; optional log of exports if added later.

**Sensitive?** Yes — residency (aggregates derived from tenant data); small-count suppression required.

**Depends on.** `usage-facts` on `main`; optional platform copy job (Q17).

**Decided.** Views match [`architecture.md`](../architecture.md) §19.3 ops console subsection. **Where counts are read is Q17 (open)** — leaning: scheduled job under tenant scope writes allow-listed columns to `platform`; `platform` role still has no privileges on `app`.

**Open for the spec.** Q17 resolution; suppression rules for small communities; refresh cadence; whether operators can export CSV.

---

## Build order and dependencies

1. **Communities and first admin** — replaces `provision-owner`; foundation for every other area that targets a tenant.
2. **Operators and audit view** — replaces `ops-operator`; needed before sensitive actions are delegated away from the owner.
3. **Plans, prices and billing** — replaces `billing-admin`; commercial truth for entitlements and read-only billing.
4. **Modules per community** — uses plan catalogue from area 3; entitlements already on `main`.
5. **Support access** — needs operator roles and tenant approval flows; must not ship before ADR 0017 rules are clear in UI.
6. **Default receipt wording** — independent; small surface.
7. **Restore one community** — needs audit view and §22 design; highest operational risk.
8. **Mobile app listings** — needs App Registry from Phase 2 mobile work.
9. **Usage views** — needs usage facts and Q17 decided; read-only analytics last.

---

## Not in the ops console

From owner decisions:

- **No tenant data browsing** outside an §11.4 grant ([`architecture.md`](../architecture.md) §11.4).
- **No minors' details ever**, including under break-glass ([ADR 0017](adr/0017-childrens-data-access.md)).
- **No backup download** for anyone ([`architecture.md`](../architecture.md) §22).
