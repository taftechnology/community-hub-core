# Spec: Platform subscriptions through Stripe Billing

Slug: stripe-billing
Status: approved (2026-10-17, Abdus)
Architecture refs: D7, §5, §6.1 (Platform subscription row), §6.3, §7.3, §10.1–§10.4, §11.3, §11.4, §12.1, §12.2.1, §14.1, §14.3–§14.5, §17, §19.1, §21.1 (APP 8), §26 Q8; ADR 0004, ADR 0009, ADR 0012; AGENTS.md §1 rules 1, 2, 3, 5, 8; §6 Cost, Residency, API and UI

## Problem

No organisation can pay for Community Hub. A plan reaches an organisation only when an operator assigns it (`assignPlan`, `modules/core/entitlements/infrastructure/writes.ts:111`), and nothing ties that to money. There is no Stripe customer, no subscription, no webhook route, and no way to stop an unpaid organisation from writing. The webhooks hostname is routed to the service (`infra/modules/aws-ingress/main.tf:125,131`), but no route answers on it, and the server would refuse a Stripe event anyway: every POST body is capped at 4096 bytes before routing (`apps/api/src/server.ts:18,99-108`). Q8 used to block this chunk. The owner split it on 2026-10-16: Q8a (billing structure) is decided below; Q8b (plan contents and real prices) stays open as product data that needs no deploy.

## Decisions

### Owner's decisions, 2026-10-16 (verbatim)

| #   | Decision         | Answer                                                                                                                                                                                                                                                                                                        | Source            |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| B1  | Billing unit     | Per community.                                                                                                                                                                                                                                                                                                | Owner, 2026-10-16 |
| B2  | Interval         | Monthly.                                                                                                                                                                                                                                                                                                      | Owner, 2026-10-16 |
| B3  | Currency and tax | Currency AUD with 10% GST. The GST rate and a "prices are GST-inclusive" setting must be adjustable in an admin panel at platform-operator level. No Stripe Tax for now.                                                                                                                                      | Owner, 2026-10-16 |
| B4  | Trial            | 30-day free trial on Starter. The trial length must be changeable later (a setting, not code).                                                                                                                                                                                                                | Owner, 2026-10-16 |
| B5  | Sales channel    | Self-serve Stripe Checkout for all at launch. Large deals use the existing entitlement_overrides (contracted exceptions with expiry) plus a manual Stripe invoice.                                                                                                                                            | Owner, 2026-10-16 |
| B6  | Non-payment      | Stripe retries for about 2 weeks, then a 7-day grace period with a banner, then read-only. Data is never deleted for non-payment.                                                                                                                                                                             | Owner, 2026-10-16 |
| B7  | Q8 split         | Q8a, billing structure: decided (B1–B6). Q8b, plan contents and actual prices: still open, as product data. Code refers to Stripe lookup keys (for example starter_monthly), never to amounts. Prices are changed in Stripe, and plan contents are rows in plans / plan_entitlements. Neither needs a deploy. | Owner, 2026-10-16 |

### Design decisions (developer recommendations; confirmed by the owner 2026-10-17 where marked)

| #   | Question                      | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Status            |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| D1  | Subscription shape            | One Stripe customer and **one subscription per organisation**, with one item: the plan's price at `quantity` = the number of rows in `platform.communities` for that organisation. Matches §6.1 ("Organisation (usage reported per community)"). Every community in an organisation shares one plan at launch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Owner, 2026-10-17 |
| D2  | Community added or removed    | Today no path adds a community to an existing organisation: `provision-owner` creates both or neither (`apps/api/src/provision-owner.ts:174-188`), so quantity is 1 at launch. This chunk adds `syncQuantity(organisationId)`, which sets the item quantity to the current community count with `proration_behavior = create_prorations` (Stripe's default: charged or credited on the next invoice). The operator can run it through the one-off (D9, `sync`); the future community-create and community-remove paths call the same function, and that chunk names who may trigger it.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Owner, 2026-10-17 |
| D3  | Trial                         | **Per organisation, once.** Checkout collects a card up front. `subscription_data.trial_period_days` is read from the current settings row when the Checkout session is created, and set only when the chosen plan has `trial_eligible = true` (Starter only at launch, as data) and the organisation has never trialled (`billing_accounts.trial_used_at` is null). An organisation that cancels and returns pays from day one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Owner, 2026-10-17 |
| D4  | GST mapped onto Stripe        | A Stripe TaxRate's percentage and inclusive flag cannot change after creation. Each settings change inserts a new `billing_settings` row and creates a new TaxRate (`percentage`, `inclusive`, `country = AU`, `display_name = GST`), idempotency key derived from the row id. New Checkout sessions use the newest row's TaxRate as the subscription's default tax rate. **Existing subscriptions keep theirs**; the one-off's `apply-tax-rate` command moves one organisation to the newest rate, effective from its next invoice. No automatic move at renewal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Owner, 2026-10-17 |
| D5  | Default GST settings          | Seed row: 10.00% (1000 basis points), prices **inclusive** of GST, trial 30 days, grace 7 days. Inclusive is recommended so the price shown on Checkout is the price paid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Owner, 2026-10-17 |
| D6  | Operator settings surface     | **No platform-operator UI or identity exists.** `ops` is a hostname and a gate surface with no routes (`apps/api/src/gate.ts:3`, `index.ts:182-190`); there is no operator login, role check or platform audit path (`appendAuditEvent` accepts only an organisation or app transaction, `packages/db/src/audit-append.ts:63`). Operator authentication is `ops-console`'s work. Recommended: settings live in `platform.billing_settings` (append-only, enforced by privilege; the history is the change record), changed only through the operator one-off (D9), which the owner runs as he runs `provision-owner`. `ops-console` adds the route and screen over the same table. This meets B3's "adjustable at platform-operator level" now and its "admin panel" in `ops-console`.                                                                                                                                                                                                                                                  | Owner, 2026-10-17 |
| D7  | Tenant admin surface          | The admin has only sign-in, Users & Roles and Module Toggles (`apps/admin/src/shell.tsx:47-49`, `nav.tsx:21-22`). **Built in chunk `billing-read-only`:** it creates **Settings → General Settings** (a frozen-nav row, `docs/roadmap.md` Admin navigation row 16) with one **Billing** section, and a **billing banner** in the shell. No new nav row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Owner, 2026-10-17 |
| D8  | Module                        | A new module `modules/core/billing` owns the new `platform` billing tables, the Stripe port and the state rules. §6.3 names only `core/tenancy` and `core/entitlements` as platform-schema owners (`architecture.md:233`), and ADR 0012 says "No other module may" (`docs/adr/0012-entitlement-visibility.md:13`); both are amended, and ADR 0014 says it amends ADR 0012 on this point. `core/entitlements` does not learn about Stripe. Alternative: put the tables in `core/entitlements`, avoiding both amendments but mixing a vendor into the evaluation module.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Owner, 2026-10-17 |
| D9  | Operator one-off              | `/app/billing-admin.js`, run as an ECS one-off like `provision-owner` (`docs/runbooks/apply-staging-au.md:231`). Commands: `settings` (GST bps, inclusive flag, trial days, grace days, a change note; creates the TaxRate), `sync <organisation slug>` (D2), `apply-tax-rate <organisation slug>` (D4), `mode <organisation slug> self_serve\|invoiced` (D12, with guards), `seed-test-catalogue` (refuses a key that is not test mode; creates the §10.2 placeholder products and prices by lookup key; idempotent). Prints the ids it created, never a key or an address.                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Developer         |
| D10 | Read-only enforcement         | **Built in chunk `billing-read-only`; recorded here because this chunk's states feed it.** A **write guard in `apps/api`**, not a new step in the §10.3 evaluation order: entitlements keep applying in read-only, only writes stop. Every `GateRoute` gains a required `billing: "write" \| "read" \| "exempt"` field and `assertRoutes` rejects a route without one, so a new route fails closed. Marking is per route because several reads are `POST` (`/v1/access/grants/list`, `apps/api/src/access-routes.ts:362`). Each module's shared `communityScope` helper (`access-routes.ts:300-306`, `entitlement-routes.ts:145-151`) takes the marking, so a `write` route cannot get a scope without the check. The check reads `billing_accounts` uncached on the `platform` role. When the state is `read_only` it answers **402** (empty body) only to a caller who holds an organisation or community role grant in that organisation; anyone else gets the route's normal 403, so billing state is not an oracle across tenants. | Owner, 2026-10-17 |
| D11 | What still works in read-only | **Built in chunk `billing-read-only`.** Sign-in and session routes (`exempt`); every route marked `read`; the billing routes (`exempt`); export and support access under a grant, which **do not exist yet** and are marked `exempt` when they land. Blocked: every `write` route, which today is the six access writes and `/v1/entitlements/toggle`. The admin hides write controls in read-only and says why (AGENTS.md §6). A job that writes, added later, calls the same `assertWritable(organisationId)`; ADR 0014 states that rule for later chunks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Owner, 2026-10-17 |
| D12 | Billing mode                  | **A missing `billing_accounts` row means `invoiced`**: every organisation that exists today, every organisation `provision-owner` creates, and every contracted deal (B5). `invoiced` is never read-only from billing and its plan stays operator-set. An organisation becomes `self_serve` only through `billing-admin mode <slug> self_serve` (or a later sign-up chunk). `mode invoiced` refuses while the Stripe status is live, unless `--subscription-cancelled-in-stripe` is given; `mode self_serve` prints the resulting state, which is `none` (read-only except billing) until Checkout completes.                                                                                                                                                                                                                                                                                                                                                                                                                           | Owner, 2026-10-17 |
| D13 | When Stripe gives up          | Stripe's "if all retries fail" setting is **mark the subscription unpaid** (dashboard, Out-of-band), not cancel, so the open invoice stays payable in the Portal. On the transition into `unpaid` the service records `unpaid_since` and `grace_until = now + grace days` (from the current settings row). The banner shows from `past_due` onward. After `grace_until` the state is `read_only`, computed on read; no scheduled job. Paying moves Stripe back to `active` and clears both columns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Owner, 2026-10-17 |
| D14 | Voluntary cancellation        | The Portal allows cancel at period end only. When the subscription ends (`customer.subscription.deleted`), a `self_serve` organisation goes straight to `read_only` with no grace. Data is kept (B6). It may start a new Checkout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Owner, 2026-10-17 |
| D15 | Add-ons                       | Not sold through Checkout in this chunk. The §10.2 add-on prices are seeded in test mode so the catalogue is complete, but add-ons reach an organisation through `organisation_add_ons` or an override, as today. Selling them as extra subscription items is a later chunk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Owner, 2026-10-17 |
| D16 | Webhooks hostname CORS        | **Left open.** The webhooks hostname shares the tenant API and its CORS block (`aws-ingress/main.tf:125-131`, `:188-204`). Stripe sends no preflight and no credentials, and the webhook accepts nothing without a valid signature, so an allowed preflight grants nothing. Separating it needs a third HTTP API. Kept in the roadmap open items.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Developer         |
| D17 | Stripe client and key         | The official `stripe` npm package in `apps/api` only (new dependency, justified in the PR: replaces hand-written form encoding, signature verification and retries; MIT; maintained by Stripe), with a pinned API version. Signature verification uses `constructEvent` on the raw bytes with a 300-second tolerance. A **restricted key** per environment: write on Checkout Sessions, Customer Portal sessions, Subscriptions and Tax Rates; read on Prices, Products, Invoices and Customers. The staging (test-mode) key also has write on Products and Prices for `seed-test-catalogue`; the production key does not.                                                                                                                                                                                                                                                                                                                                                                                                              | Developer         |
| D18 | Live proof                    | Not in this chunk. This chunk applies the new secret while parked (Apply 0) and merges parked. The live proof in Stripe test mode runs in follow-up chunk `stripe-billing-proof`, after merge, on the image `main` publishes for the merge commit (images publish only on push to `main`; same reason as `email-provider` O6). That chunk names its window and unpark cost.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Owner, 2026-10-17 |
| D19 | Size and split                | About 2,500–3,000 changed lines with tests, across `core/billing`, `core/entitlements` (columns only), `packages/policy`, `apps/api`, `apps/admin` and `infra`. AGENTS.md §3 aims for under ~800 lines and says to split a chunk that spans more than two modules; AGENTS.md takes precedence over the handover's preference for one pull request. **Split approved:** (a) this spec, `stripe-billing` — the migration, the Secrets Manager secret, `modules/core/billing`, the Stripe port and adapter, the body cap in `server.ts`, the webhook, the Checkout / Portal / status routes, permissions, the `billing-admin` one-off; no write guard and no admin UI, so nothing can be locked out. (b) `billing-read-only` — the 402 write guard on `GateRoute`, the shell billing banner, General Settings → Billing. (c) `stripe-billing-proof` — the live test-mode proof on staging. (b) and (c) get their own specs.                                                                                                                | Owner, 2026-10-17 |

## Scope

In:

- `modules/core/billing`: schema factories, domain (state rules, quantity, trial eligibility), Stripe port, repository, manifest (with `dataClasses` for every new column).
- `modules/core/entitlements/module.manifest.ts`: `dataClasses` gains `"plans.stripe_lookup_key": "internal"` and `"plans.trial_eligible": "internal"`; the schema factory gains the two columns.
- `modules/core/access/public/`: exports a grant-check helper, `holdsAnyGrant(tx, userId)`, true when the user holds any organisation role grant in the transaction's organisation or any community role grant in its community. The status route needs it because `holdsPermission` (`modules/core/access/infrastructure/holds-permission.ts:4`) answers only for a permission, and `member` holds an empty bundle (`packages/policy/src/decide.ts:24`).
- One migration in `packages/db` (expand only, `0010`): three billing tables, two columns on `platform.plans`, the seed settings row, and the revoke that makes `billing_settings` append-only.
- `apps/api`:
  - `server.ts`: the POST body cap becomes per route. `POST /v1/stripe/webhook` on the webhooks hostname reads up to 256 KiB and answers 413 above it; every other route keeps 4096 bytes and 400.
  - The Stripe adapter (`apps/api/src/billing/`), the webhook route, the three tenant billing routes, the `billing-admin` one-off.
  - `Dockerfile:8`: add the new billing package to the build filter. `tsc -p tsconfig.emit.json` already emits `billing-admin.js`; the image test asserts it ships.
  - `env.ts`: `ADMIN_ORIGIN` (return URLs) and the name of the Stripe secret, validated in `readServiceEnv`.
- `packages/policy`: `billing.view` and `billing.manage`, outside `CATALOGUE`.
- `packages/contracts`: Zod schemas for the billing routes.
- `infra/`: one Secrets Manager secret for the Stripe values, encrypted with the existing secrets key (`infra/modules/aws-db-secrets/main.tf:58`); task-role read on that secret only; `ADMIN_ORIGIN` and the secret name in the task definition's environment (not its `secrets` block, see Rule 8). No Stripe Terraform provider.
- `architecture.md`: §6.3 and the ADR 0012 module list (D8); §7.3 and §21.1 (Stripe as subprocessor); §10 (billing state, read-only); §14.1; §14.4's stale "Q14 … not a decision" line (closed by ADR 0012). ADR 0014, "Platform billing state and read-only on non-payment".
- `docs/runbooks/apply-staging-au.md`: Apply 0 for the secret; the owner's steps to put the test-mode values.
- `docs/roadmap.md`: this row done; rows added for `billing-read-only` (next) and `stripe-billing-proof`; the CORS open item updated.

Out:

- **Deferred to chunk `billing-read-only`:** the required `billing` marking on `GateRoute` and every existing route; the 402 write guard in `communityScope` (D10, D11); the shell billing banner; Settings → General Settings with the Billing section; hiding write controls in read-only. Until it ships, every state is stored and reported by the status route but nothing is enforced, so no organisation can be locked out.
- **Deferred to chunk `stripe-billing-proof`:** the unpark and the live test-mode proof (D18).

- Operator login, the ops route and the settings screen (`ops-console`).
- Selling add-ons through Checkout (D15). Usage-based prices. Stripe Tax, other currencies, annual billing.
- Real prices and plan contents (Q8b).
- Export and support grants (later chunks; `exempt` when they land).
- A community create or remove route (D2).
- Community payments and donations (GivingJar, Phase 3).
- Production keys and the live proof (D18).

## Behaviour

**States.** Billing state is derived per organisation from `billing_accounts` and the clock:

| Mode                   | Stripe status                    | State       | Entitled | Writes (enforced in `billing-read-only`) | Banner (`billing-read-only`)                         |
| ---------------------- | -------------------------------- | ----------- | -------- | ---------------------------------------- | ---------------------------------------------------- |
| `invoiced` (or no row) | any or none                      | `invoiced`  | as today | yes                                      | none                                                 |
| `self_serve`           | no subscription yet              | `none`      | as today | no                                       | "Choose a plan" → Checkout                           |
| `self_serve`           | `incomplete`                     | `none`      | as today | no                                       | "Finish payment" → Portal                            |
| `self_serve`           | `trialing`, `active`             | `ok`        | yes      | yes                                      | only when the trial ends within 7 days               |
| `self_serve`           | `past_due`                       | `retrying`  | yes      | yes                                      | "Payment failed, update your card" → Portal          |
| `self_serve`           | `unpaid`, now < `grace_until`    | `grace`     | yes      | yes                                      | "Read-only on <date>, pay the open invoice" → Portal |
| `self_serve`           | `unpaid`, now ≥ `grace_until`    | `read_only` | yes      | no                                       | "Read-only, pay the open invoice" → Portal           |
| `self_serve`           | `canceled`, `incomplete_expired` | `read_only` | yes      | no                                       | "Subscription ended" → Checkout                      |

"Writes: no" means routes marked `write` answer 402 to a caller with a grant in the organisation (D10). Reads, sign-in and billing routes answer as normal (D11). Data is never deleted. This chunk computes, stores and reports the state; the Writes and Banner columns are the contract `billing-read-only` enforces and renders.

**Who can call the billing routes.** All three take `{ communitySlug }` and derive both ids from `findCommunityBySlug`; neither id is taken from input. A slug that is not found answers 403, the same as a denial, so the route does not reveal whether a slug exists. Permission is read from organisation role grants in an `app` transaction scoped by that lookup (`modules/core/access/infrastructure/holds-permission.ts:4-51`); the billing rows are read on the `platform` role. A denial writes an audit event, as the access routes do (`access-routes.ts:316-325`).

**Checkout.** `POST /v1/billing/checkout` with `{ communitySlug, planKey }`, api hostname, needs `billing.manage`. It answers 409 unless the mode is `self_serve` **and** the organisation holds no subscription, or its stored subscription's status is `canceled` or `incomplete_expired`. So `invoiced`, `ok`, `retrying`, `grace`, `unpaid` / `read_only` and `incomplete` all answer 409, and the client opens the Portal, or for `invoiced` shows "Billing is handled by invoice". 422 if the plan has no `stripe_lookup_key`. 503 if no settings row has a TaxRate yet, the Stripe secret is unavailable (Rule 8) or Stripe is unreachable. Otherwise it creates a Checkout session in subscription mode with:

- the price found by lookup key, at quantity = community count;
- the newest TaxRate;
- the trial, when D3 allows;
- the existing Stripe customer, if there is one;
- `client_reference_id`, `metadata.organisation_id` and `subscription_data.metadata.organisation_id` = the organisation id;
- success and cancel URLs: `ADMIN_ORIGIN` plus `?billing=done` or `?billing=cancelled`, and nothing else (no slug, no session id).

It answers `{ url }`. The URLs point at the admin root because reloading a deep link returns 403 from CloudFront (roadmap open item).

**Portal.** `POST /v1/billing/portal` with `{ communitySlug }`, `billing.manage`. 409 if the organisation has no Stripe customer. Answers `{ url }`. Return URL is `ADMIN_ORIGIN` plus `?billing=portal`.

**Status.** `POST /v1/billing/status` with `{ communitySlug }`. A caller holding `billing.view` gets the state, plan key, quantity, `current_period_end`, `trial_end` and `grace_until`. A caller with any organisation role grant in the organisation, or any community role grant (including `member`) in the named community, gets the banner fields only: state, `trial_end` and `grace_until`. That check is `holdsAnyGrant` from `modules/core/access/public/` (Scope), run in the same scoped `app` transaction. Anyone else gets 403. Every response carries `canView` and `canManage`, because the admin learns permissions through `callerPermissions`, which filters on `catalogue()` (`access-routes.ts:253-255`), and billing is outside it. The response never contains an amount, a card, a name or an address.

**Webhook.** `POST /v1/stripe/webhook` answers on the **webhooks hostname only** (404 elsewhere). Surface `tenant`, `billing: "exempt"`, no session.

1. It reads the raw body, up to 256 KiB (413 above that), and passes the bytes unchanged to signature verification. A missing or bad signature, or a timestamp outside 300 seconds, answers 400 and records nothing.
2. It upserts the event id into `billing_stripe_events` as `received` and commits that on its own. A row already `processed` or `ignored` answers 200 and does nothing (replay). A row still `received` is processed again.
3. **Apply** locks the organisation's `billing_accounts` row (`select … for update`), re-reads the subscription from Stripe while holding the lock, writes Stripe's current status, price lookup key, quantity, period end and trial end, computes the transitions into and out of `unpaid` against the locked row, commits, and marks the event `processed`.

Re-reading under the lock makes order irrelevant. An old event processed late, or two events processed at once, both write the current truth.

| Event                           | Action                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout.session.completed`    | Links the customer and subscription to the organisation in `client_reference_id`, then applies. Recorded `ignored` if the organisation does not exist or is `invoiced`. If the organisation already holds a different live subscription, it is also recorded `ignored`, logged `billing_duplicate_subscription`, and the first link is kept. Sets `trial_used_at` if the subscription trials. |
| `customer.subscription.created` | Apply, if the subscription is linked. If it is not linked yet, recorded `ignored`: the completed event links and applies.                                                                                                                                                                                                                                                                     |
| `customer.subscription.updated` | Same.                                                                                                                                                                                                                                                                                                                                                                                         |
| `customer.subscription.deleted` | Same (the status becomes `canceled`).                                                                                                                                                                                                                                                                                                                                                         |
| `invoice.paid`                  | Apply the invoice's subscription, if it is linked.                                                                                                                                                                                                                                                                                                                                            |
| `invoice.payment_failed`        | Same.                                                                                                                                                                                                                                                                                                                                                                                         |
| any other type                  | Recorded `ignored`, 200.                                                                                                                                                                                                                                                                                                                                                                      |

**Plan change.** After Apply commits, and only when the mode is `self_serve` **and** the plan whose `stripe_lookup_key` matches differs from the organisation's current plan, billing calls the existing `assignPlan` (`modules/core/entitlements/public/index.ts`). That function rebuilds every community's allocations (`writes.ts:158-163`), so it runs only on a real plan change, never on a renewal, retry or quantity change. An `invoiced` organisation's plan and allocations are never written by billing. A lookup key that matches no plan leaves the plan unchanged and is logged `billing_unknown_price`. If `assignPlan` fails, the event stays `received` and answers 500, so Stripe retries and the retry converges. Another task's entitlement snapshot cache can show the old plan for up to 60 seconds (ADR 0012); the admin says "your plan will appear shortly".

**Webhook failures.** A processing failure answers 500 and leaves the event `received`, so Stripe retries. An unavailable Stripe secret answers 503 (Stripe retries). The webhook shares the tenant write throttle (Risks).

**Errors and logs.** Responses have empty bodies and carry only a status, like the existing routes (`access-routes.ts:92`). Logs carry the event type, the Stripe event id, the organisation id, the outcome and one of the fixed codes named in this spec. They never carry the payload, a name, email or address, an amount, or a Stripe error message: the adapter maps every Stripe error to a code.

**Admin.** No admin change in this chunk. The banner, the Billing section, the `?billing=` return handling and the "your plan will appear shortly" copy are `billing-read-only`'s. Until then, Checkout and Portal can be exercised through the API, which is how `stripe-billing-proof` drives them if it runs first.

**One-off.** `billing-admin settings --gst-bps <n> --inclusive <bool> --trial-days <n> --grace-days <n> --note <text>` writes a new row only after Stripe has created the TaxRate; a Stripe failure writes nothing.

- Bounds: GST 0–5000 bps, trial 0–90 days, grace 0–30 days.
- The note is at most 200 printable ASCII characters. The runbook says it is a change note and never a name or address, because one-off arguments appear in ECS task descriptions and CloudTrail.

## Data

All new tables are in the `platform` schema: region-scoped, no `org_id`, no RLS (§6.3, AGENTS.md §1 rule 2), and reached only through the `platform` role. Nothing is encrypted, because every column is either filtered on or not personal (rule 3). No Stripe customer name, email, address or card is stored.

**`platform.billing_accounts`** (one row per organisation that has been given a mode; a missing row means `invoiced`)

| Column                   | Type             | Class    | Note                                  |
| ------------------------ | ---------------- | -------- | ------------------------------------- |
| `organisation_id`        | uuid PK, FK      | internal | `platform.organisations.id`, restrict |
| `mode`                   | text             | internal | `self_serve` or `invoiced` (check)    |
| `stripe_customer_id`     | text null        | internal | unique; filtered on by the webhook    |
| `stripe_subscription_id` | text null        | internal | unique; filtered on by the webhook    |
| `stripe_status`          | text null        | internal | Stripe's status, mirrored             |
| `plan_lookup_key`        | text null        | internal | price lookup key last seen            |
| `quantity`               | integer null     | internal | billed communities last seen          |
| `current_period_end`     | timestamptz null | internal |                                       |
| `trial_end`              | timestamptz null | internal |                                       |
| `trial_used_at`          | timestamptz null | internal | D3                                    |
| `unpaid_since`           | timestamptz null | internal | D13                                   |
| `grace_until`            | timestamptz null | internal | D13                                   |
| `tax_rate_id`            | text null        | internal | Stripe TaxRate on the subscription    |
| `synced_at`              | timestamptz null | internal | last apply                            |

**`platform.billing_settings`** (append-only: the migration revokes UPDATE and DELETE from `platform`, overriding the default grant in `packages/db/drizzle/0000_schemas.sql:17`; the newest row is current)

| Column               | Type        | Class    | Note                                                    |
| -------------------- | ----------- | -------- | ------------------------------------------------------- |
| `id`                 | uuid PK     | internal |                                                         |
| `gst_rate_bps`       | integer     | internal | check 0–5000                                            |
| `prices_include_gst` | boolean     | internal |                                                         |
| `trial_days`         | integer     | internal | check 0–90                                              |
| `grace_days`         | integer     | internal | check 0–30                                              |
| `stripe_tax_rate_id` | text null   | internal | null only on the seed row                               |
| `note`               | text        | internal | check length ≤ 200, printable ASCII; a change note only |
| `created_at`         | timestamptz | internal |                                                         |

The seed row (D5) has no TaxRate, so Checkout answers 503 until the owner runs `billing-admin settings` once per environment.

**`platform.billing_stripe_events`** (idempotency)

| Column         | Type             | Class    | Note                               |
| -------------- | ---------------- | -------- | ---------------------------------- |
| `event_id`     | text PK          | internal | Stripe event id                    |
| `type`         | text             | internal |                                    |
| `outcome`      | text             | internal | `received`, `processed`, `ignored` |
| `received_at`  | timestamptz      | internal |                                    |
| `processed_at` | timestamptz null | internal |                                    |

Retention: kept. The table holds no personal data; pruning is a later decision.

**`platform.plans`** gains two columns:

- `stripe_lookup_key text null unique` (internal);
- `trial_eligible boolean not null default false` (internal).

The seed marks `starter` trial-eligible and sets the lookup keys `starter_monthly` and `growth_monthly`. No amount is stored anywhere.

Migration wave: expand only, one migration. Rollback: once the code is reverted, nothing uses the tables and columns; a later contract PR can drop them.

## Rules touched

- **Rule 1, residency.** Stripe becomes a **named subprocessor** (§7.3 and §21.1 amended).
  - Every Stripe call comes from the regional service in `ap-southeast-2`, and webhooks arrive on the Sydney hostname.
  - What we send to Stripe: the organisation id (an opaque UUID), as `client_reference_id`, as session and subscription metadata, and inside the idempotency keys; the price; the quantity (a count); the TaxRate; the trial days; the Stripe customer id; and the return URLs.
  - What we never send: the organisation's slug, or any user, member, household or child data.
  - The payer types the billing contact's name, email, address and card directly into Stripe's hosted Checkout and Portal pages. That data goes to Stripe and is held by Stripe outside Australia; we never store it.
  - Which billing-address and tax-ID fields Checkout collects is a Stripe setting (Out-of-band).
  - Webhook payloads carry that contact data into the service. The handler reads ids and status only, and never stores or logs the payload.
- **Rule 2, tenancy.** Billing tables are `platform` rows with no `org_id`. Billing routes derive the organisation from `findCommunityBySlug` and check `billing.*` against organisation role grants. The webhook trusts only the signed event and what it re-reads from Stripe. The organisation it links is the one the service itself put in `client_reference_id`.
- **Rule 3.** Nothing new is encrypted.
- **Rule 5.** No personal data in URLs (return URLs carry a fixed flag only), logs, traces or audit. What is logged: event type, event id, organisation id, outcome and fixed codes.
- **Rule 8, secrets.**
  - One Secrets Manager secret per environment holds a JSON object with two named fields: the restricted key and the webhook signing secret. Terraform creates it with no value, and the owner puts the value by hand.
  - The adapter reads the secret lazily through `secretsManagerReader` (`apps/api/src/secrets.ts:5`), not through the task definition's `secrets` block (the database passwords use that block, `aws-ingress/main.tf:497-499`). So a missing value never stops the task from starting.
  - A missing or unparseable secret answers 503 on the billing routes and the webhook, logged `billing_key_unavailable`. So does a key whose mode does not match `COMMUNITY_HUB_ENVIRONMENT` (`apps/api/src/env.ts:36`), logged `billing_key_mode_mismatch`: test mode is required in staging, live mode in production. Boot and every other route are unaffected.
  - The values never go in a var file, the repo or a log.
- **Money.**
  - No amount in code, configuration or our database. The GST rate is an integer in basis points.
  - Every Stripe write carries an idempotency key:

    | Write            | Key                                             |
    | ---------------- | ----------------------------------------------- |
    | Checkout         | `checkout:<organisation id>:<request id>`       |
    | Portal           | `portal:<organisation id>:<request id>`         |
    | TaxRate          | `taxrate:<settings row id>`                     |
    | Quantity         | `qty:<subscription id>:<quantity>:<request id>` |
    | TaxRate move     | `taxmove:<subscription id>:<settings row id>`   |
    | Seeded catalogue | `seed:<lookup key>`                             |
- **Permissions.**
  - New `billing.view` and `billing.manage` in `packages/policy`, outside `CATALOGUE` (`packages/policy/src/decide.ts:1-24`).
  - `org_owner` and `org_admin` get `CATALOGUE` plus both; `org_billing` gets both; `org_auditor` gets `billing.view`.
  - Community roles, including `community_admin`, get neither.
  - Custom roles cannot hold them: the `app.custom_role_permissions` check is unchanged, so this chunk changes no `app` table.
  - **Owner to confirm.**
- **Entitlements.** No new entitlement key. §10.3 order is unchanged. Billing writes plans only through `assignPlan`, on a real plan change for a `self_serve` organisation.
- **Children, consent, safeguarding.** Untouched. No person data is read.

## Contracts

- **Routes.** On the api hostname, tenant surface: `POST /v1/billing/checkout`, `POST /v1/billing/portal`, `POST /v1/billing/status`. On the webhooks hostname: `POST /v1/stripe/webhook`. Zod request and response schemas in `packages/contracts`.
- **OpenAPI.** The repo has no OpenAPI generation, so nothing is regenerated; AGENTS.md §10 lists the OpenAPI diff as omitted until it exists.
- **Access public API.** `modules/core/access/public/` exports `holdsAnyGrant(tx, userId): Promise<boolean>` (Scope).
- **Manifest.** `modules/core/billing/module.manifest.ts`: permissions `billing.view` and `billing.manage`, and the audit action for a billing denial. No event at launch; `billing.state.changed.v1` waits for its first consumer.
- **Environment.** `ADMIN_ORIGIN` and the Stripe secret's name. Task-role read on that secret only.

## Tests that define done

1. Signature: a missing header, a bad signature, or a timestamp outside 300 seconds each answer 400, and nothing is recorded.
2. Replay: a `processed` event answers 200 with no Stripe call. A `received` event is processed again.
3. Out of order and concurrent: an older `subscription.updated` processed after a newer one leaves the newer state. Two concurrent applies on one organisation end in Stripe's current state, with `grace_until` set once.
4. An unknown type is recorded `ignored` and answers 200.
5. A subscription event before `checkout.session.completed` is `ignored`, and the completed event then links and applies.
6. A duplicate subscription is `ignored` and logged `billing_duplicate_subscription`, and the first link is kept.
7. Two organisations:
   - a Checkout for organisation A can link only to A;
   - status, Checkout and Portal for organisation B called by a user of A answer 403;
   - an unknown slug answers 403.
8. Checkout answers 409 in `invoiced`, `ok`, `retrying`, `grace`, `unpaid` / `read_only` and `incomplete`, and goes ahead in `none` (no subscription), `canceled` and `incomplete_expired`.
9. Plans:
   - webhook events never change an `invoiced` organisation's plan or allocations;
   - a renewal event leaves a custom allocation intact;
   - a real plan change calls `assignPlan` once.
10. Status: a `billing.view` caller gets the full fields; a `member` gets the banner fields only; a stranger gets 403; `canView` and `canManage` are correct for each role in the Permissions bundle list.
11. Body caps: a 10 KiB signed event is accepted; 256 KiB + 1 on the webhook answers 413; 4097 bytes on an access route still answers 400.
12. The webhook answers 404 on the api, auth and ops hostnames.
13. Leakage: inject a Stripe error that contains an email address, and check that no log line or response body holds the payload, an email, a name, an address, an amount or the Stripe message.
14. Every Stripe write carries its named idempotency key.
15. Secret: a missing secret, a live key in staging, and a test key in production each answer 503 with the fixed code, and boot still succeeds.
16. `billing-admin`:
    - `settings` writes nothing when Stripe fails, and enforces its bounds and the note limit;
    - `seed-test-catalogue` refuses a live key;
    - the `mode` guards hold (D12).
17. Privileges: `platform` cannot UPDATE or DELETE `billing_settings`.
18. Terraform:
    - the task-role statement names the one secret, not `*`;
    - the secret uses the existing secrets key;
    - `ADMIN_ORIGIN` and the secret name are in the environment, not `secrets`;
    - no Stripe provider.
19. The image test shows `/app/billing-admin.js` and the billing package ship.
20. State derivation: a unit test per row of the state table, including the boundary at `grace_until` and a missing `billing_accounts` row reading as `invoiced`.
21. `holdsAnyGrant`: true for an organisation grant, a community grant and a `member` grant; false for a user with grants only in another organisation (two-organisation test).
22. Manifests: the entitlements manifest test (`modules/core/entitlements/domain/manifest.test.ts`) gains the two `plans` entries, and a new billing manifest test pins every new billing column's class and both permissions. These are equality tests on the manifest; nothing in the repo compares a manifest with the schema, and this chunk does not add that check.

## Cost

| Line                                | Monthly USD | Method                                                                                                                                                          |
| ----------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets Manager secret (staging)    | 0.40        | One secret at USD 0.40 a month; calls cost cents. Encrypted with the existing secrets key, so no new KMS key charge                                             |
| Secrets Manager secret (production) | 0 now       | Created when production is applied; 0.40 then                                                                                                                   |
| Stripe                              | 0 standing  | Per-transaction fees only; test mode is free                                                                                                                    |
| NAT, load balancer, endpoint        | 0           | None added. The task has a public IP (`aws-ingress/main.tf:573`) and HTTPS egress to any address (`aws-network/main.tf:137-140`), so it reaches Stripe directly |
| Live proof unpark                   | 0 here      | Moved to `stripe-billing-proof` (D18)                                                                                                                           |

This branch stays parked through merge.

## Order of applies (owner runs every apply)

0. Apply 0, while parked: the secret, its key-policy entry, the task-role read and the task-definition environment. The owner puts the test-mode restricted key and the webhook signing secret into the secret by hand (runbook step). **This chunk stops here** and merges parked.
1. The unpark, `billing-admin settings`, `seed-test-catalogue`, a live Checkout with a Stripe test card, the webhook, the proofs and the re-park all belong to `stripe-billing-proof`.

## Risks

- **No enforcement until `billing-read-only` ships.** An unpaid `self_serve` organisation keeps writing. Accepted: no organisation is `self_serve` until the owner sets one (D12), and the owner does not set one before `billing-read-only` merges.
- **Billing state readable across tenants.** Mitigation: the status route answers 403 to a caller with no grant in the organisation, and to an unknown slug (test 7).
- **A webhook is forged, replayed or out of order.** Mitigation: signature verification with a tolerance; event-id idempotency; Apply re-reads under a row lock, so even a valid old event cannot write an old state.
- **A Checkout is linked to the wrong organisation.** `client_reference_id` comes from the slug lookup, never from input. Two-organisation test.
- **Double subscription.** Checkout answers 409 in every state that holds a subscription that is still live or still payable (Behaviour, Checkout). Two sessions opened in parallel can still both complete: the second is `ignored`, logged `billing_duplicate_subscription`, and the owner cancels it in Stripe. Accepted as rare.
- **Allocation reset.** `assignPlan` rebuilds allocations. Mitigation: it runs only on a real plan change, with a renewal test.
- **Plan write and account write in separate transactions.** If `assignPlan` fails after Apply commits, the event stays `received` and the retry converges. Accepted; changing `assignPlan` to take a caller's transaction would be an entitlements change, and this chunk does not make it.
- **A lost webhook leaves a wrong stored state** (which `billing-read-only` would later enforce). Mitigation: both `invoice.paid` and `customer.subscription.updated` re-read; the one-off `sync` re-reads on demand; 7 days of grace after Stripe's ~2 weeks of retries.
- **The webhook shares the tenant write throttle** (10 a second, burst 20, `aws-ingress/main.tf:135-142`, `:286-292`). A burst of Stripe events or a tenant flood gets 429, and Stripe retries. Accepted.
- **GST is wrong on an invoice after a settings change.** Mitigation: D4 is explicit, and existing subscriptions change only through `apply-tax-rate`.
- **A live key in staging or a test key in production.** Mitigation: the mode check answers 503 with a fixed code.
- **Stripe error text leaks.** Mitigation: errors are mapped to codes, and test 13 checks.
- **Unverified Stripe details**: the restricted-key permission names, the invoice → subscription field on the pinned API version, and whether the Portal can pay an `incomplete` subscription's first invoice. Mitigation: the plan pins each one against Stripe's documentation for the pinned version, and `stripe-billing-proof` exercises them live.

## Out-of-band

- **Split:** D19, approved 2026-10-17. `billing-read-only` and `stripe-billing-proof` each need their own spec.
- **Architecture change:** yes. §6.3 and ADR 0012 (D8); §7.3 and §21.1 (Stripe as subprocessor); §10 (billing state); §14.1 and §14.4. ADR 0014 amends ADR 0012 on the module list.
- **New vendor:** Stripe, already named in D7. It is now a subprocessor of personal data: the billing contact.
- **Legal and accounting (owner):**
  - whether Stripe invoices meet Australian tax-invoice requirements for our ABN (the ABN, the words "Tax invoice", the GST amount);
  - confirming GST registration;
  - the privacy policy's APP 8 disclosure that billing contact details go to Stripe outside Australia.
- **Stripe account (owner, in the dashboard):**
  - create the account;
  - the Customer Portal configuration: update card, view and pay invoices, cancel at period end only, no plan switching at launch;
  - the retry schedule, and "if all retries fail: mark unpaid" (D13);
  - Checkout's billing-address and tax-ID collection;
  - the webhook endpoint on the Sydney webhooks hostname, with the events in Behaviour, and its signing secret;
  - the restricted keys, to the D17 permission lists.
- **By the one-off:** the test-mode products and prices with lookup keys (`seed-test-catalogue`), and the TaxRate (`settings`).
- **By Terraform:** only the secret, its key-policy entry and the task-role read.
- **Plan contents and real prices (Q8b, owner):** before the first live customer.
- **Second fresh-context review:** required (payments, secrets, residency). The owner runs it when the pull request opens.
- **Rollback:** revert the code. The migration is additive, and the owner can destroy the secret. No organisation is `self_serve` until the owner sets one with `billing-admin mode`.
