# ADR 0014: Platform billing state and read-only on non-payment

- Status: accepted
- Date: 2026-10-17
- Spec: `docs/specs/2026-10-17-stripe-billing.md`
- Amends: ADR 0012

## Context

Platform subscriptions require collecting money for Community Hub without compromising tenant isolation, Australian data residency, or child safeguarding. The owner's decisions (B1–B7) established the commercial structure:

- **B1 (Billing unit):** Per community.
- **B2 (Interval):** Monthly.
- **B3 (Currency and tax):** AUD with 10% GST. GST rate and a "prices are GST-inclusive" flag are adjustable at platform-operator level. No Stripe Tax for now.
- **B4 (Trial):** 30-day free trial on Starter, configurable later as a setting.
- **B5 (Sales channel):** Self-serve Stripe Checkout for all at launch. Large deals use existing `entitlement_overrides` plus a manual Stripe invoice.
- **B6 (Non-payment):** Stripe retries for ~2 weeks, then a 7-day grace period with a banner, then read-only. Data is never deleted for non-payment.
- **B7 (Q8 split):** Q8a (billing structure) is decided (B1–B6). Q8b (plan contents and actual prices) remains open as product data; code and database rows refer to Stripe price lookup keys (e.g. `starter_monthly`), never amounts, and neither price changes in Stripe nor plan content updates in `plans` / `plan_entitlements` require a deployment.

To keep delivery reviewable and safe, the work was split across three chunks (spec D19):

- **(a) `stripe-billing` (this chunk):** The `0010` database migration, AWS Secrets Manager secret, `modules/core/billing`, Stripe port and adapter in `apps/api`, the per-route POST body cap in `server.ts`, the webhook route on the Sydney webhooks hostname, tenant Checkout / Customer Portal / status routes, policy permissions, and the `billing-admin` operator one-off. No write guard or admin UI is shipped here, so no organisation can be locked out.
- **(b) `billing-read-only`:** The 402 write guard on `GateRoute`, the shell billing banner, and General Settings → Billing in `apps/admin`.
- **(c) `stripe-billing-proof`:** The unpark and live test-mode proof on staging.

## Decision

1. **Module ownership and platform schema:** `core/billing` owns three `platform` tables (`platform.billing_accounts`, `platform.billing_settings`, `platform.billing_stripe_events`). This amends ADR 0012's module list, which previously permitted only `core/tenancy` and `core/entitlements` to query the `platform` schema. `core/entitlements` does not learn about Stripe.
2. **State derived on read:** Billing state is derived dynamically on read from Stripe's mirrored subscription status and our grace period (`unpaid_since` + `grace_days` from the current settings row). There is no scheduled cron or background worker to mutate state on expiration.
3. **Read-only is a write guard:** Read-only is an API write guard (enforced on `GateRoute` in chunk `billing-read-only`), not an evaluation step in §10.3. Entitlements continue to apply during read-only; only routes marked `write` stop, responding with 402 to callers holding an organisation or community grant. Routes marked `read`, sign-in and session routes, and billing routes remain `exempt`. Data is never deleted for non-payment.
4. **Default mode for missing rows:** A missing row in `platform.billing_accounts` means `invoiced`. This covers every organisation that exists today, every organisation created by `provision-owner`, and contracted enterprise deals. `invoiced` organisations are never read-only from billing and their plans remain operator-managed. An organisation becomes `self_serve` only through explicit operator intervention (`billing-admin mode <slug> self_serve`).
5. **Stripe state re-read under row lock:** When processing webhook events, Apply locks the organisation's `billing_accounts` row (`SELECT ... FOR UPDATE`) and re-reads current subscription state directly from Stripe while holding the lock. This makes webhook arrival order irrelevant; out-of-order or duplicate deliveries converge on the current Stripe truth.
6. **Checkout session linking:** A Checkout session is linked to an organisation only when the subscription's organisation metadata matches `client_reference_id`. If an organisation already holds a different live subscription, duplicate link attempts are ignored, logged (`billing_duplicate_subscription`), and the original link is retained.
7. **Write assertion in background jobs:** Any future background job that performs writes must call `assertWritable(organisationId)` once it exists (built in chunk `billing-read-only`), matching the API write guard rule.

## Consequences

- `core/billing` manages platform tables without tenant RLS, queried via the `platform` role credentials.
- No monetary amounts are stored in code, configuration, or database tables; Stripe lookup keys are used exclusively.
- Webhooks arrive on the Sydney webhooks hostname with signatures verified over the raw payload bytes before any state is written.
- Staging and production Stripe secrets (restricted API key and webhook secret) are managed in AWS Secrets Manager and read lazily.
- Read-only write enforcement is decoupled from entitlement evaluation; when `billing-read-only` ships, tenants in arrears retain full read access to their data and the admin console to settle invoices via the Customer Portal.
- Future background jobs that write must verify writeability via `assertWritable`.

## Alternatives rejected

- **Tables in `core/entitlements`:** Considered to avoid amending ADR 0012, but rejected because it would couple Stripe vendor specifics, webhook processing, and external payment state into the pure entitlement evaluation engine.
- **A separate evaluation step:** Considered adding billing state as a new step in §10.3 evaluation order, but rejected because it would conflate feature entitlement with write capability; organisations remain entitled to their features even when writes are paused for non-payment.
- **A scheduled grace job:** Considered a periodic background cron or queue worker to mark organisations read-only after grace expires, but rejected because it introduces polling overhead, race conditions, and synchronization lag compared to deterministically deriving state on read from `grace_until` and the clock.
