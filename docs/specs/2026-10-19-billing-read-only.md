# Spec: Read-only on non-payment, the billing banner and General Settings → Billing

Slug: billing-read-only
Status: approved (2026-10-19, Abdus)
Architecture refs: §10 (billing state, `architecture.md:657`), §11.3, §11.4, §12.1, §17, §19.1; D16; ADR 0012, ADR 0014; spec `docs/specs/2026-10-17-stripe-billing.md` (state table, D3, D7, D10, D11, D12, D13, D14, D19); AGENTS.md §1 rules 2, 5; §6 Tenancy, API and UI

## Problem

`stripe-billing` computes, stores and reports a billing state for every organisation, but enforces nothing (its Out of scope, "Deferred to chunk `billing-read-only`"). An unpaid `self_serve` organisation keeps writing, and nobody in the admin can see that payment failed, choose a plan, or open the Customer Portal: the admin has only sign-in, Users & Roles and Module Toggles (`apps/admin/src/shell.tsx:41-52`, `apps/admin/src/nav.tsx:17-27`). Until this ships the owner keeps every organisation `invoiced` (stripe-billing Risks, "No enforcement until `billing-read-only` ships").

## Decisions

Decisions taken in `stripe-billing` (D3, D7, D10–D14) are not reopened here. This chunk adds:

| #   | Topic                          | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | By                                        |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| R1  | Which states block writes      | The stripe-billing state table's Writes column, unchanged: writes stop in `none` and `read_only`; they continue in `invoiced`, `ok`, `retrying` and `grace`. `none` (a `self_serve` organisation before Checkout completes) is "read-only except billing" per D12. `architecture.md:657` names only the after-grace and subscription-ended cases and is corrected in this chunk.                                                                                                                                                                                                            | Owner, 2026-10-17                         |
| R2  | One source for the marking     | The marking lives only on the `GateRoute`. The gate passes the matched route's marking to its handler (`handle(request, { billing })`), and each module's `communityScope` (`access-routes.ts:311`, `entitlement-routes.ts:145`, `billing-routes.ts:118`) takes that context and the signed-in `userId` as required arguments, never a literal written in the handler. A route marked `write` that never calls `communityScope` fails test 3a.                                                                                                                                              | Developer                                 |
| R3  | 402 versus 403                 | On a `write` route in a blocking state, a caller who holds an organisation role grant in that organisation, or a community role grant in the named community (`holdsAnyGrant`, `modules/core/access/infrastructure/holds-any-grant.ts:3`), gets **402, empty body**, before the route's permission check. Anyone else continues down the route's normal path and gets its normal answer. The grant check runs **before** the billing read, so a caller without a grant never causes a billing read: no difference in work, timing or outage behaviour between organisations for a stranger. | Owner, 2026-10-17; order: Developer       |
| R4  | Current community in the admin | One community slug for the whole shell, entered once in the shell and kept in `sessionStorage`. The banner, General Settings and the two existing Settings pages read it; the per-page slug inputs are removed. A slug is a tenant identifier, not personal data.                                                                                                                                                                                                                                                                                                                           | Developer, 2026-10-19                     |
| R5  | Plan choices for Checkout      | A new read route, `POST /v1/billing/plans`, lists the keys of plans that have a `stripe_lookup_key`, each with `trialAvailable`: true only when the plan is trial-eligible **and** the organisation has never trialled (the semantics of `trialDaysFor`, `billing-routes.ts:209`, D3). No amounts and no trial length: Stripe Checkout shows both. Plan display names come from a new `planLabels` map in `apps/admin/src/labels.ts`; an unknown key shows the key, so a new plan row (Q8b) appears without a deploy.                                                                       | Developer, 2026-10-19                     |
| R6  | Failure of a guard read        | If either guard read fails (`holdsAnyGrant` or `billing_accounts`), a `write` route answers **503** and writes nothing. A caller without a grant never reaches the billing read (R3). `read` and `exempt` routes never run the guard, so a billing outage does not stop them. This stops writes for every organisation, `invoiced` included, while the platform database is unreachable; `findCommunityBySlug` is on the same database, so writes already stop today in that case.                                                                                                          | Developer; confirmed by owner, 2026-10-19 |
| R7  | Recording a blocked write      | A 402 writes one log line, `billing_write_blocked`, with the route pattern and the organisation id only. No audit row: it is not a permission denial.                                                                                                                                                                                                                                                                                                                                                                                                                                       | Developer                                 |

## Scope

In:

- `apps/api/src/gate.ts`: `GateRoute` gains a required `billing: "write" | "read" | "exempt"`; `assertRoutes` (`gate.ts:49-72`) rejects a route without a valid value, so `createGate` refuses to start; the gate passes `{ billing }` to `handle` (`gate.ts:141`).
- Every existing route marked (table below).
- `modules/core/billing/public`: `isWritable(state)` and `assertWritable(sql, organisationId, now)` (ADR 0014 decision 7), reading `billing_accounts` and deriving state with the existing `deriveState` (`modules/core/billing/domain/state.ts`), uncached, on the `platform` role.
- The guard in the three `communityScope` helpers (R2, R3, R6, R7).
- `modules/core/entitlements/public`: `listCheckoutPlans(sql)`: `key` and `trial_eligible` of plans whose `stripe_lookup_key` is not null, sorted by key. `platform.plans` belongs to `core/entitlements` (ADR 0012).
- `POST /v1/billing/plans` (R5), Zod contract in `packages/contracts/src/billing.ts`.
- `apps/admin`: the shell community picker (R4); the billing banner and the `?billing=` return handling in the shell; **Settings → General Settings** at `/settings/general` with one **Billing** section (frozen nav row 16, D7); hiding write controls in Users & Roles and Module Toggles while writes are blocked, with the reason shown (AGENTS.md §6).
- `packages/ui`: the components the banner and Billing section need (Alert, at minimum), shadcn/ui, axe-tested.
- `architecture.md:657` corrected (R1); `docs/roadmap.md` row and snapshot.

Out:

- Any change to state derivation, the webhook, Checkout, Portal or status behaviour (`stripe-billing`).
- Live proof on staging (`stripe-billing-proof`); no unpark in this chunk.
- Jobs that write: none exist. `assertWritable` is exported for them; ADR 0014 already states the rule.
- Export and support-grant routes: do not exist yet; marked `exempt` when they land (D11).
- Add-ons through Checkout (D15). Email Settings (Q9).
- Any database migration, Terraform, Dockerfile, workflow or dependency change.

## Behaviour

### Route marking

| Route                                                                                                                                                 | Marking  | Why                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------- |
| `GET /health`                                                                                                                                         | `exempt` | No tenant                                                                 |
| `/v1/auth/email-otp/start`, `/verify`; `/v1/auth/passkey/register/options`, `/verify`; `/authenticate/options`, `/verify`; `/v1/auth/session/refresh` | `exempt` | Sign-in and session (D11); a user must be able to sign in to pay          |
| `/v1/billing/checkout`, `/portal`, `/status`, `/plans`                                                                                                | `exempt` | Billing must work in read-only (D11)                                      |
| `/v1/stripe/webhook`                                                                                                                                  | `exempt` | Signed Stripe events; stripe-billing names it `exempt`                    |
| `/v1/access/grants/list`, `/v1/entitlements/list`                                                                                                     | `read`   | Reads, though `POST`                                                      |
| `/v1/access/grants`, `/grants/revoke`, `/custom-roles`, `/custom-roles/delete`, `/user-links`, `/user-links/delete`; `/v1/entitlements/toggle`        | `write`  | Every write that exists today: the six access writes and the toggle (D11) |

### The guard, per request

Order inside a handler, unchanged before the scope: foreign host 404, body 400, session 401. Then `communityScope(slug, context, userId)`:

1. Unknown slug → `null` → the route's existing answer, unchanged (403 on access and billing routes, 404 on entitlement routes, `entitlement-routes.ts:197-199`, `:235-237`).
2. Marking `read` or `exempt` → the scope. No guard read.
3. Marking `write` → in one scoped `app` transaction, `holdsAnyGrant(userId)`. False → the scope; the route continues to its normal permission check and answer. Billing is never read.
4. True → read the organisation's state with `assertWritable`.
5. Writable (`invoiced`, `ok`, `retrying`, `grace`) → the scope. Blocking (`none`, `read_only`) → **402, empty body**, nothing written, one log line (R7).

Either read failing in steps 3–4 → 503, nothing written (R6).

The 402 comes before the route's permission check, so a member without `access.manage` also gets 402 in a blocking state. That is intended: they hold a grant, the reason the write cannot happen is billing, and they can already read the state from `/v1/billing/status` banner fields.

### Billing banner

Shown at the top of every shell page once a community is chosen, for any signed-in user whose status call succeeds (any grant-holder gets the banner fields; stripe-billing Behaviour, Status). One `POST /v1/billing/status` per community change and per return from Stripe, not per navigation.

| State                | Shown when                                     | Text                                                    | Action (only if `canManage`)                 |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| `invoiced`           | never                                          | —                                                       | —                                            |
| `none`               | always                                         | "Choose a plan to start using Community Hub"            | "Choose a plan" → General Settings → Billing |
| `ok`                 | `trial_end` is in the future and within 7 days | "Your trial ends on <date>"                             | "Manage billing" → Portal                    |
| `retrying`           | always                                         | "Payment failed, update your card"                      | "Update card" → Portal                       |
| `grace`              | always                                         | "Read-only on <grace_until date>, pay the open invoice" | "Pay invoice" → Portal                       |
| `read_only` (unpaid) | always                                         | "Read-only, pay the open invoice"                       | "Pay invoice" → Portal                       |
| `read_only` (ended)  | always                                         | "Subscription ended"                                    | "Choose a plan" → General Settings → Billing |

A caller without `canManage` sees the text plus "Ask an organisation owner or billing contact". Dates are rendered in the browser's locale, date only.

The status response carries the state, not Stripe's status, so two pairs look alike:

- `read_only` unpaid versus ended: `grace_until` is set only while Stripe's status is `unpaid` and is cleared on every other status (`modules/core/billing/domain/transition.ts:18-37`) and on a new subscription (`linkSubscription`, `accounts.ts`). The banner reads `grace_until` present as unpaid and absent as ended.
- `none` versus `incomplete` (stripe-billing state table: "Finish payment" → Portal): no response field tells them apart. Both show the `none` row; General Settings resolves it (below). No contract change.

**Return from Stripe.** Stripe returns to the admin root (`billing-routes.ts:225-226`, `:278`), and deep links cannot be reloaded (roadmap Open items), so the **shell** reads `?billing=` on any route and shows the message in the banner region: `done` → "Payment received, your plan will appear shortly", re-fetch status once after 5 seconds, then stop; `cancelled` → "Checkout was cancelled"; `portal` → re-fetch status. Any other value is ignored. The parameter is removed with `history.replaceState`.

Accessibility: the banner is a `role="status"` region (polite), warning-level for `retrying` and `grace`, `role="alert"` only when it first appears in `read_only`. Contrast and focus follow D16 (WCAG 2.2 AA); axe runs on each state.

### General Settings → Billing

Route `/settings/general`, nav label "General Settings" under Settings, shown to any signed-in user (the section itself enforces permissions). Visible content by permission:

- `canView`: state in words, plan label, quantity, current period end, trial end, grace until (from the full status response). No amounts, cards or addresses (none exist in the response).
- `canManage` adds: "Manage billing" (Portal) when the state is `ok`, `retrying`, `grace` or `read_only`; a plan list from `/v1/billing/plans` with "Start subscription" (Checkout) when the state is `none` or `read_only` without `grace_until`. Each plan shows its label and, when `trialAvailable`, "Includes a free trial".
- `invoiced`: "Billing is handled by invoice." No actions.
- Neither permission: "You do not have access to billing for this organisation."
- Checkout answers 409 while the state is `none` → "Finish payment" → Portal (the `incomplete` case). Checkout answers 409 while the state is `read_only` without `grace_until` → "Contact support" instead of the plan list (a Stripe status `deriveState` maps to `read_only` but Checkout refuses, `state.ts:40-41`, `checkout.ts:14-18`). Portal answers 409 → hide the Portal button and re-fetch status. Any other 409 → re-fetch status. 422 → "This plan is not available yet". 503 → "Billing is unavailable, try again shortly". No raw error text is shown.

### Write controls in a blocking state

Users & Roles and Module Toggles hide every write control (grant, revoke, custom role create/delete, user links, toggle) when the state is `none` or `read_only`, and show "Read-only until billing is settled" with a link to General Settings → Billing. If a write still answers 402 (stale state), the page shows the same message and re-fetches status. No control renders that can only 402 or 403.

### Empty, error and offline states

No community chosen: the banner is absent and pages show the picker. Status 403 (stranger to that community): no banner; pages show their existing 403 copy. Status network failure or 5xx: no banner, a non-blocking "Billing status unavailable" line in General Settings; write controls stay as the API decides (the API is authoritative).

## Data

No new tables or columns; no migration. Reads only: `platform.billing_accounts` (mode, stripe status, `grace_until`, `trial_end`, `trial_used_at`) via `assertWritable` and the plans route; `platform.plans` (`key`, `stripe_lookup_key` presence, `trial_eligible`) via `listCheckoutPlans`, all classified `internal` already (`modules/core/entitlements/module.manifest.ts:14-16`). The admin stores one value in `sessionStorage`: the chosen community slug (`internal`, not personal).

## Rules touched

- Permissions: `billing.view`, `billing.manage` (existing). `/v1/billing/plans` needs `billing.manage`; others get 403 plus the existing `billing.permission.denied` audit row.
- Tenancy: the guard derives organisation and community from `findCommunityBySlug` only, never from request input (roadmap Open items). `holdsAnyGrant` runs in a transaction scoped by `set_config(..., true)`. `platform.billing_accounts` has no RLS, so the organisation filter in `readAccount` is the only tenancy control on the billing read; tests 5 and 11 pin it.
- Residency: no new outbound call; Checkout and Portal remain regional.
- Personal data: none in the 402, the log line, the plans response, or URLs (the `?billing=` value is a fixed word).
- Entitlements: unchanged; read-only does not change evaluation (ADR 0014 decision 3).

## Contracts

- `GateRoute.billing: "write" | "read" | "exempt"` (required); `handle(request, { billing })`.
- New HTTP status on every `write` route: 402, empty body, to grant-holders in a blocking state. 503 on `write` routes when a guard read fails.
- `POST /v1/billing/plans`, body `{ communitySlug }` (strict), api hostname, `surface: "tenant"`, `billing: "exempt"`, `billing.manage`. Response `{ plans: [{ key: string, trialAvailable: boolean }] }`, sorted by key.
- `modules/core/billing/public`: `isWritable(state)`, `assertWritable(sql, organisationId, now)`. `modules/core/entitlements/public`: `listCheckoutPlans(sql)`.
- Admin route `/settings/general`. No new event, entitlement key, permission, audit action or website surface. Manifests unchanged.

## Tests that define done

1. `assertRoutes` rejects a route with no `billing` and with an unknown value; `createGate` refuses to build.
2. The set of `METHOD pattern` keys in `productionRoutes` equals the marking table exactly (a route added or removed fails), and each has the marking in the table.
3. Guard, per state: a grant-holder's `write` request answers 402 in `none` and `read_only`, and reaches the handler in `invoiced`, `ok`, `retrying`, `grace` (including the `grace_until` boundary, and a missing `billing_accounts` row as `invoiced`).
   3a. For every route in `productionRoutes` marked `write` (iterated over the route list, not hand-picked), a grant-holder's well-formed request against a `read_only` organisation answers 402 and leaves row counts unchanged.
4. A stranger's `write` request in `read_only` answers the same as the same request in `ok` (status and body), writes the same audit row, and never reads `billing_accounts` (spy).
5. Two organisations, run in both orders: (i) A `read_only`, B `ok`; (ii) A `ok`, B `read_only`. In each, a grant-holder writes in the `ok` organisation (200) and is refused in the blocking one (402), and a grant-holder of one writing to the other's community gets 403, not 402.
6. A `member` without `access.manage` gets 402 on a `write` in `read_only` and 403 in `ok`.
7. `read` and `exempt` routes answer normally in `read_only` (grants list, entitlements list, status, portal, plans, sign-in refresh), and do not read `billing_accounts` (spy).
8. Guard read failure: a failing `billing_accounts` read and a failing `holdsAnyGrant` each make a `write` route answer 503 and write nothing; a `read` route answers normally.
9. The 402 path writes nothing (row count before and after) and logs only the route pattern and organisation id: no user id, slug or email.
10. `/v1/billing/plans`: `billing.manage` gets only plans with a lookup key, no amount field; a trial-eligible plan reads `trialAvailable: false` once `trial_used_at` is set; a `billing.view`-only caller gets 403 plus audit; a stranger gets 403.
11. `assertWritable` unit tests per state and at the `grace_until` boundary, plus an integration test with three organisations' rows where the target is neither the first nor the last inserted.
12. `listCheckoutPlans` integration test: plans without a lookup key are excluded; order is by key.
13. Admin shell: banner text and action per row of the banner table, `canManage` on and off; trial banner absent at 8 days, present at 7; `read_only` unpaid versus ended by `grace_until`; axe clean per state; `?billing=done|cancelled|portal` handled on `/` and on a Settings route, unknown value ignored, parameter removed.
14. Admin General Settings: per permission (manage, view, neither, `invoiced`); Checkout 409 in `none` offers the Portal; Checkout 409 in ended `read_only` shows "Contact support"; Portal 409 hides the button; 422 and 503 copy; `trialAvailable` copy.
15. Admin: write controls hidden in `none` and `read_only` with the reason; a 402 answer shows the message and re-fetches status.
16. Admin: the community picker persists across navigation within the tab and is read by all four pages.

## Cost

None. No new AWS resource, no unpark. Staging stays parked.

## Risks

- **Locking out a paying organisation** through a wrong state or a wrong marking. Mitigations: `invoiced` default for a missing row; markings pinned as an exact set (test 2) and enforced per route (test 3a); state per row tested (test 3); the owner still sets no organisation `self_serve` until `stripe-billing-proof` passes.
- **A new write route marked `read`.** The type and `assertRoutes` force a choice but cannot check it is right. Mitigation: test 2 fails until the route is added to the table, which puts the marking in front of the reviewer.
- **Billing state as a cross-tenant oracle.** Mitigation: R3's order (strangers never cause a billing read) and tests 4–5.
- **A platform database outage stopping writes for everyone.** Accepted for `write` routes (R6, fail closed, confirmed by owner 2026-10-19); reads and sign-in unaffected (test 8).
- **Extra latency on writes**: one `app` transaction plus, for grant-holders, one platform read per `write` request. Writes are rare in the admin; no cache (D10 says uncached).
- **The admin hides controls on stale state.** The API is authoritative; a 402 re-fetches state (test 15).
- **Time of check to time of use**: the state is read in a separate transaction from the write. The window is milliseconds and the decision is per request. Accepted.

## Out-of-band

- **Size (decided: one pull request, owner, 2026-10-19).** Estimated 1,800–2,200 changed lines with tests: about 900 in the API (gate, 22 markings, guard in three helpers, `assertWritable`, `listCheckoutPlans`, the plans route and contract) and about 1,000 in the admin and `packages/ui` (picker, banner, General Settings, control hiding, Alert). It touches `apps/api`, `core/billing`, `core/entitlements`, `packages/contracts`, `apps/admin` and `packages/ui`. AGENTS.md §3 aims for under ~800 lines and says to split past two modules. D19 approved this as one chunk. Options: (a) one pull request, as D19 approved; (b) split into `billing-read-only` (guard, markings, `/plans`) and `billing-admin-ui` (picker, banner, General Settings, control hiding). Developer's recommendation: (a), because the 402 and the copy explaining it ship together, and no organisation is `self_serve` until `stripe-billing-proof` either way.
- **Staging verification (decided: deferred to `stripe-billing-proof`; staging stays parked; owner, 2026-10-19).** AGENTS.md §8 asks for the spec's behaviour on the staging hostname. Staging is parked and no organisation is `self_serve` there; this chunk proposes that the staging verification is done in `stripe-billing-proof`, which unparks anyway.
- **Plan display names (confirmed by owner, 2026-10-19).** Labels live in `planLabels` in `apps/admin/src/labels.ts`, with fallback to the plan key; the label text itself stays product content under Q8b.
- No legal sign-off, no new subprocessor, no new ADR (ADR 0014 already decides read-only as a write guard). `architecture.md:657` gets a one-line correction for `none` (R1).
