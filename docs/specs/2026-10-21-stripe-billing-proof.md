# Spec: Stripe billing proof on staging

Slug: stripe-billing-proof
Status: approved (2026-10-21, Abdus Salam)
Architecture refs: §6.1, §7.3, §10.2, §10.3, §11.3, §14.1, §14.4, §14.5, §19.1, §23.1; ADR 0009 (rule 1 (c)), ADR 0014. Follows `docs/specs/2026-10-17-stripe-billing.md` (D18 moved the live proof here) and `docs/specs/2026-10-19-billing-read-only.md` (its staging verification was deferred here, owner, 2026-10-19). Model: `docs/specs/2026-10-15-ses-sign-in-proof.md`. Operator path: `docs/runbooks/apply-staging-au.md`, sections **Stripe billing**, **SES sign-in proof** and **Provision the first owner**.

## Problem

No organisation has paid on staging, and no Stripe event has reached the service. `stripe-billing` merged the Stripe adapter, the webhook, the Checkout, Portal and status routes and the `billing-admin` one-off, and ran Apply 0 (the billing secret) while parked. `billing-read-only` merged the 402 write guard, the shell banner and General Settings → Billing. Neither has run on AWS. The billing secret still holds the placeholder webhook secret `whsec_placeholder_until_stripe_billing_proof`, so a real Stripe event would fail its signature check. Three Stripe details were left to be confirmed live (`stripe-billing` Risks): the restricted-key permission names, the invoice → subscription field on the pinned API version, and whether the Portal can pay an `incomplete` subscription's first invoice. `main` at `5709fa1` (the `billing-read-only` merge, pull request 56) has published the service image and the admin shell that hold both chunks: CI, `publish` and `admin-publish` on that push succeeded.

## Decisions

| #   | Decision                     | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Source                                                              |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| P1  | Image and admin build        | The image `publish` pushed for `5709fa1`, or for a later `main` commit that contains it, and the admin shell `admin-publish` deployed for the same commit. The owner names `${DEPLOY_SHA}` at pre-check. Stop if either job did not succeed, the scan is not `COMPLETE`, or it shows any CRITICAL finding.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Runbook **Staging proof run → Pre-checks** items 1–4                |
| P2  | Unpark cost, window          | USD 0.0468 an hour. 24-hour target and 48-hour hard stop, measured from Apply 1 completion to the start of the re-park apply. The owner re-parks at the hard stop even if proofs remain.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `staging-proof-run` Cost table; **owner to re-confirm on approval** |
| P3  | Real webhook secret          | Put **while parked, before Apply 1**. The service caches the billing secret for the life of the process and drops the cache only on a Stripe authentication error (`apps/api/src/billing/secret.ts:29-33`, `apps/api/src/billing/stripe-adapter.ts:229-232`). A wrong webhook secret makes signature verification fail with 400 and never drops the cache (`stripe-adapter.ts:437-459`, `apps/api/src/billing-webhook.ts:84-92`). The placeholder passes the secret's shape check (`secret.ts:76`), so a task started with it keeps it.                                                                                                                                                                                                                                                                                      | Code; developer, 2026-10-21                                         |
| P4  | Synthetic tenant             | One organisation and one community with synthetic slugs, created by `provision-owner`, whose owner is the SES-verified mailbox the owner already controls (the only address that can sign in while SES is in the sandbox). It is set `self_serve` with `billing-admin mode`. The parked database is destroyed at re-park, so nothing carries over from `ses-sign-in-proof`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **Owner to confirm**                                                |
| P5  | Checkout details             | Every field Checkout asks for is synthetic: the email at `example.com` (RFC 2606), a distinctive name that cannot occur in a log (`Proof` plus 8 hex characters), the cardholder name, and, if billing-address collection is on, a synthetic address. Cards are Stripe's public test cards. No real person's details reach Stripe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | AGENTS.md §1 rules 1 and 7; developer, 2026-10-21                   |
| P6  | Billing settings and plan    | `billing-admin settings --gst-bps 1000 --inclusive true --trial-days 30 --grace-days 7` with a change note naming this chunk (`stripe-billing` D5). **A `plan` command is required:** no migration creates a `starter` row, so migration `0010`'s update matches nothing on a new database (`packages/db/drizzle/0010_silly_lila_cheney.sql:51`; the only insert is `upsertCatalogue`, reached from `billing-admin plan`). Proposed: `plan starter --lookup-key starter_monthly --trial-eligible true --entitlements <the architecture §10.2 Starter list>`. The list is proof-only data; Q8b stays open.                                                                                                                                                                                                                    | **Owner to confirm the list**                                       |
| P7  | Payment-failure path         | **Recommended:** S5 below. After the subscription is linked, the owner sets a card that attaches but declines in the Portal and ends the trial now in the dashboard. That should give `invoice.payment_failed` and `past_due` (`retrying`, the "Payment failed" banner). He then pays the open invoice in the Portal with `4242 4242 4242 4242`, which should give `invoice.paid` and `ok`. Not proven live: `unpaid` and `grace`, which need retries to run out (days, or test clocks that Checkout-created customers do not use); the integration tests cover them. The Stripe behaviour is inferred, not checked: if ending the trial does not charge at once, S5 is recorded as not run and the invoice → subscription field stays open. Alternative: skip S5, and leave the invoice field and `past_due` as open items. | **Owner to decide**                                                 |
| P8  | Portal pays `incomplete`     | **Recommended:** not proven live; it stays an open item. Checkout keeps a declined or unauthenticated card on its own page, so it does not leave an `incomplete` subscription, and no other path here creates one. S5 proves the nearest case: the Portal paying an open invoice on a `past_due` subscription.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **Owner to decide**                                                 |
| P9  | Admin browser pass           | The owner runs the signed-in admin pass, because only his inbox receives the code. Evidence is yes/no per check; no screenshot, because the shell shows the signed-in address.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | AGENTS.md §8 (staging hostname); developer, 2026-10-21              |
| P10 | Sessions and the sign-in cap | Access tokens last 15 minutes and refresh tokens 30 days (`modules/core/identity/infrastructure/session.ts:9-10`). The shell holds both and refreshes through `POST /v1/auth/session/refresh` before each proof group. The admin does not refresh: on a 401 it clears the token (`apps/admin/src/api.ts:44`), so each S10 check starts within 15 minutes of a browser sign-in. Cap: at most 5 `start` calls for the address in the run, and at most 5 in any 60 minutes (`modules/core/identity/infrastructure/email-otp.ts:63-71`). Browser sign-ins count.                                                                                                                                                                                                                                                                 | Code; developer, 2026-10-21                                         |

## Scope

In:

- A runbook section **Stripe billing proof**: the dashboard checks, the webhook-secret put, the pre-checks, the one-offs, the proofs, the log counts and the evidence rules below. It refers to the Apply 1, Apply 2, one-off and sign-in steps of **SES sign-in proof** where they are unchanged.
- The webhook-secret put while parked (P3), by the owner, through the same silent-prompt and stdin method as **Put the test-mode values**.
- An unpark commit: `enable_database = true` and `desired_count = 1` in `infra/regions/au/env/staging.tfvars`. `service_image` goes only in the gitignored `staging.local.tfvars`.
- Read-only pre-checks, Apply 1, the one-offs, proofs S1–S12, an evidence commit, a re-park commit, Apply 2, and a plan with no changes.
- Evidence in the runbook: counts, statuses, key sets, lengths, yes/no facts, SHAs, digests and resource addresses only.
- Last commit: in `docs/roadmap.md`, the snapshot, the `stripe-billing-proof` row marked done, Open items (what P7 and P8 leave open, and the permissions S11 does not exercise) and Next spec; and the `AGENTS.md:9` Repository state row. Staging is parked in committed files.

Out:

- Any change to application code, Terraform, the Dockerfile, CI or dependencies. If a proof fails because of code, the owner re-parks and the fix goes on a separate `fix/` branch. This chunk resumes with a new unpark after that fix merges and publishes.
- Plan contents and real prices (Q8b), live mode, production, the production restricted key.
- `sync` and `apply-tax-rate` live. Quantity stays 1, because no path adds a second community, and the tax rate is created once. So Subscriptions write is not exercised.
- Add-ons through Checkout (`stripe-billing` D15).
- Open items this run may observe but does not fix: Fargate Spot interruptions, the webhooks CORS preflight, admin deep-link 403s, the silent secret re-read. New observations go to Open items.

## Behaviour

**Who does what**

- **Owner (Abdus):**
  - the Stripe dashboard and the webhook-secret put;
  - the applies and every one-off;
  - the sign-ins;
  - Checkout and the Portal in the browser, and the dashboard actions (end trial, resend, cancel);
  - the admin pass;
  - the log counts that need a held value.
- **Owner's assistant (read-only):**
  - the image, admin-build, SES and secret pre-checks;
  - the plan check against the expected addresses;
  - the running-task check;
  - HTTP calls that need no session;
  - log reads that need no held value;
  - the post-apply read-back.
- **Implementer:** the commits.
- **Developer:** drafts and reports; the owner approves the spec and plan.

**Order**

1. **Stripe dashboard (owner, test mode, parked).** Record yes/no only.
   - The Customer Portal is configured as `stripe-billing` asks: update card, view and pay invoices, cancel at period end only, no plan switching.
   - The retry schedule ends with "mark the subscription unpaid" (`stripe-billing` D13).
   - A webhook endpoint on the webhooks hostname at `/v1/stripe/webhook` sends exactly these events:
     - `checkout.session.completed`;
     - `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`;
     - `invoice.paid` and `invoice.payment_failed`.
   - The restricted key matches **Restricted key permissions**. If the existing key cannot be revealed again, a new one is created to that list and the old one is revoked.
2. **Webhook secret (owner, parked, P3).** Put `{secret_key, webhook_secret}`: the restricted key, and the endpoint's signing secret.
   - The assistant confirms as yes/no that the secret has a new `AWSCURRENT` version, dated after Apply 0.
   - The owner confirms in his shell, printing yes/no only:
     - `webhook_secret` starts with `whsec_` and is not the placeholder;
     - `secret_key` starts with `rk_test_`.
3. **Pre-checks.** Any failure is a stop, and nothing has been spent yet.
   - **P1:**
     - `publish` and `admin-publish` both `success` for `${DEPLOY_SHA}`;
     - the image digest and its scan;
     - the repository variables `ADMIN_API_ORIGIN` and `ADMIN_AUTH_ORIGIN` are present.
   - **SES:**
     - the domain identity and DKIM are `SUCCESS`;
     - production access is still off;
     - the owner's address shows `VerificationStatus` `SUCCESS` (record the status only).
   - **Plan:** a read-only plan without the lock, on the unpark commit, compared with the expected addresses in step 4.
4. **Apply 1.** Push the unpark commit, then plan. The expected plan is exactly 18 to add, 0 to change and 0 to destroy:
   - 8 under `module.rds[0]`;
   - 6 under `module.ingress`;
   - 4 at the root;
   - the same addresses as `ses-sign-in-proof`. Since then `infra/` has changed only in resources that are not count-gated, or that Apply 0 already applied.

   Any other address or count is a stop before apply. Record the UTC completion time, which starts the cost clock.

5. **One-offs.** Wait for RDS to be `available`. Each one-off below exits 0 with stderr empty.

   | One-off                                             | Expected stdout                                                                                                                                                                |
   | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `db-bootstrap`                                      | One integer                                                                                                                                                                    |
   | `db-migrate`                                        | Eleven `applied <tag>` lines, `0000_schemas` to `0010_silly_lila_cheney` in journal order, then `done applied=11 total=11`. The pre-check reads the journal at `${DEPLOY_SHA}` |
   | `provision-owner` (P4)                              | `created`. The provision secret is deleted and its absence verified                                                                                                            |
   | `billing-admin settings` (P6)                       | `tax_rate <id>`. The id is not recorded; it lands in that one-off's log stream, before the proof window                                                                        |
   | `billing-admin plan starter …` (P6)                 | `plan_set`                                                                                                                                                                     |
   | `billing-admin seed-test-catalogue`, run twice      | `seeded` both times. The evidence for idempotency is in the dashboard: 7 products and 7 prices with the 7 lookup keys (`apps/api/src/billing-admin.ts:70-78`)                  |
   | `billing-admin mode <organisation slug> self_serve` | `none`                                                                                                                                                                         |

6. **Running-task check.** The service is stable, and the running task definition's image digest equals the pre-checked digest. Its environment variable names include all four of these (names only):
   - `BILLING_SECRET_ARN` and `ADMIN_ORIGIN`. Without both, Checkout, the Portal and the webhook answer 503 (`apps/api/src/index.ts:216-241`); status and plans do not use the Stripe port.
   - `MAIL_FROM_ADDRESS` and `SES_CONFIGURATION_SET`, which the sign-in needs.
7. **Sign-in (P10).** The owner signs in by email code as in `ses-sign-in-proof` P1–P2. He holds the access token and the refresh token in shell variables.
8. **Proofs.** Note the window start time, in milliseconds, before S1. Every route below takes `{communitySlug}` with `content-type: application/json`. A billing route is any route under `/v1/billing/`.
   - **S1. Status before Checkout.** `POST /v1/billing/status` answers 200.
     - The key set is exactly `["canManage","canView","current_period_end","grace_until","planKey","quantity","state","trial_end"]`.
     - The values: `state` `none`, `canView` and `canManage` true, and `planKey` and `quantity` null.
   - **S2. Read-only guard (`billing-read-only`).** The body is `{communitySlug, key: "module.engagement", enabled: false}`.
     - `POST /v1/entitlements/toggle` with that body answers 402 with an empty body.
     - The same call with no `authorization` header answers 401.
     - `POST /v1/access/grants/list` answers 200.
   - **S3. Checkout.** In the admin, General Settings → Billing lists Starter with "Includes a free trial". The owner starts the subscription from there, which exercises the plans route and the admin Checkout path.
     - Checkout shows a 30-day trial and GST included. The owner pays with the P5 details.
     - The browser returns to the admin origin with only `?billing=done` in the query.
     - "Payment received, your plan will appear shortly" shows once.
   - **S4. Webhook link.** Within 5 minutes, the `webhook` lines (`operation` `stripe_webhook`) show `checkout.session.completed` with `outcome` `processed` and no `errorCode`.
     - The outcomes of `customer.subscription.created` and `invoice.paid` (the $0 trial invoice) are recorded as observed. `ignored` is expected for either one when it arrives before the link (`modules/core/billing/infrastructure/apply.ts:38-53`).
     - The dashboard shows each delivery answered 2xx, possibly after a retry.
     - Status answers `ok`, `planKey` `starter`, `quantity` 1, and a `trial_end` about 30 days out.
     - Key sets are recorded with `jq -c 'keys'`. The `checkout.session.completed` line has exactly `["level","message","operation","organisationId","outcome","stripeEventId","stripeEventType"]`, and every other `webhook` line has the same set without `organisationId`.
   - **S5. Failed payment and recovery (P7).** In the Portal, the owner sets Stripe's test card that attaches but declines charges. In the dashboard, he ends the trial now.
     - Expected: `invoice.payment_failed` and `customer.subscription.updated`, both `processed` with no `errorCode`.
     - Status `retrying`, and the admin banner reads "Payment failed, update your card".
     - He then pays the open invoice in the Portal with `4242 4242 4242 4242`. Expected: `invoice.paid` `processed` with no `errorCode`, and status `ok`.
     - This is the proof of the invoice → subscription field (`apps/api/src/billing/stripe-adapter.ts:315-325`).
   - **S6. Writes resume.** The S2 toggle answers 200. Then the same call with `enabled: true` answers 200, which restores the original value.
   - **S7. Replay and forgery.**
     - The owner resends `checkout.session.completed` from the dashboard. It answers 200 and its line shows `outcome` `processed` with no `organisationId`. The status response is the same before and after: `state`, `planKey`, `quantity` and `current_period_end`.
     - A POST to the webhook path on the webhooks hostname with a made-up signature answers 400. The service writes no `webhook` line for it; the evidence is the access-log line and the service `request` line with `path` `/v1/stripe/webhook` and `status` 400.
     - The webhook path on the api hostname answers 404.
     - A second `POST /v1/billing/checkout` with `{communitySlug, planKey: "starter"}` answers 409.
   - **S8. Portal.** `POST /v1/billing/portal` answers 200 with `{url}`. The owner opens it and sees update card, invoices, and cancel at period end. He sees no plan switching, and he does not cancel there.
   - **S9. End of subscription.** The owner cancels the subscription immediately in the dashboard.
     - Within 5 minutes, `customer.subscription.deleted` is `processed` and status answers `read_only`.
     - The S2 toggle answers 402 again.
     - `POST /v1/billing/checkout` answers 200 with `{url}` (D14). The owner does not complete it.
   - **S10. Admin pass (P9, P10).** Start at `/`. Each check is yes/no, using the exact strings in `apps/admin/src`.
     - At `none`, before S3:
       - the banner reads "Choose a plan to start using Community Hub", with the link "Choose a plan";
       - Module Toggles and Users & Roles show "Read-only until billing is settled" with the link "General Settings";
       - General Settings shows Billing and the plan list.
     - At `ok`, after S4: no billing banner (the trial ends in more than 7 days), and write controls shown.
     - At `retrying`, during S5: the banner "Payment failed, update your card".
     - At `read_only`, after S9: the banner "Subscription ended" with the link "Choose a plan", and the read-only message in place of the controls.
   - **S11. Restricted key.**
     - Over the window there are 0 `stripe_call` lines with `outcome` `failed`, whatever the `errorCode`. A missing permission shows only as `STRIPE_API`.
     - There are at least as many `ok` lines as the Stripe calls the proofs made. The plan counts them.
     - The one-offs prove the write permissions on Tax Rates, Products and Prices by their exit 0 and stdout.
     - Exercised in this run:
       - Checkout Sessions write and Customer Portal write;
       - Prices read;
       - Subscriptions read;
       - Invoices read, if S5 runs.
     - Not exercised; they go to Open items: Subscriptions write and Customers read.
   - **S12. Log hygiene.** All counts run in the owner's shell, over the window, with `--start-time` and no `--filter-pattern`, as in `ses-sign-in-proof` P5. Pull `events[].message` from the service log group and the tenant API access log group, then count with `grep -c -i -F --`. Write the at-sign as `$'\x40'`.
     - **These values must count 0 in both groups:**
       - the owner address, the P5 address and the P5 name;
       - every email code, the access token and the refresh token;
       - the organisation slug and the community slug;
       - the literals `Bearer`, the at-sign, `stripe.com`, `4242424242` and `4242 4242`;
       - the prefixes `cus_`, `sub_`, `cs_test_`, `pi_`, `in_`, `txr_`, `price_`, `prod_`, `pm_`, `seti_`, `rk_test_`, `rk_live_`, `sk_test_`, `sk_live_` and `whsec_`.
     - **Expected by design, not a leak:**
       - the Stripe event id on `webhook` lines;
       - the organisation id on the `checkout.session.completed` line and on `billing_write_blocked` lines;
       - request ids.
     - **Positive controls (the counts must be met):**
       - `"operation":"stripe_webhook"` lines: at least the deliveries the dashboard shows;
       - `stripe_call` `ok` lines: at least S11's count;
       - `billing_write_blocked` lines: equal to the 402s in S2 and S9;
       - `"routeKey"` lines in the access group: at least the HTTP calls made.
     - Only after S12, unset every held value.
9. **Evidence and re-park.** Make the evidence commit. Push the re-park commit and remove `service_image` from `staging.local.tfvars`.
   - Apply 2 is exactly 18 to destroy, the same addresses.
   - Follow it with a plan that shows no changes.
   - Record the UTC completion time and the total window.
   - The Stripe webhook endpoint stays configured. Deliveries while parked fail at the gateway and are harmless, because nothing is stored.
10. **Close.** Make the catalogue commit, run the full gate on the re-parked tree, and open the pull request.

**Failures and history**

- A failed proof, or a second failure on the same step, is a stop. Re-park first (AGENTS.md §12).
- These are not failures:
  - S5 not running because Stripe behaves differently from the inference in P7; record what was observed.
  - A Spot interruption: wait for the replacement task and rerun that step once.
  - A webhook delivery that fails and later succeeds on Stripe's retry: record both.
- After Apply 1 there is no rebase, amend or force-push on this branch. `main` comes in by a merge commit. The pull request merges with a merge commit and its body records the applied SHAs.

## Data

No table, column or migration.

Staging holds synthetic data only:

- one organisation, one community, and one owner whose address is the owner's verified mailbox;
- one `billing_settings` row and one proof-only `starter` plan with its entitlements (P6);
- one `billing_accounts` row and the `billing_stripe_events` rows from this run.

Stripe test mode holds one customer with P5's synthetic details, its test invoices, and the seeded test catalogue. The re-park destroys the database. The Stripe test-mode objects stay, and they hold nothing real.

## Rules touched

- Rule 1: the service, the database, the logs and the secret stay in `ap-southeast-2`. Stripe is a named subprocessor (ADR 0009 (c)), and in this run it receives only synthetic details (P5).
- Rule 5: S12 is the check. Evidence carries no address, slug, token, code, Stripe object id, Stripe URL, hostname, ARN or account id.
- Rule 7: no production data exists. Staging is a separate AWS account, and Stripe is in test mode.
- Rule 8: the restricted key and the webhook signing secret are entered at a silent prompt and piped through stdin. They are never written to a file or the shell history, and they are unset after the put.
- AGENTS.md §6 Cost: this spec says why staging is unparked, the cost and the window. The chunk re-parks before merge.

Security-relevant settings the plan must pin with a test and a weakening change:

1. **Staging is parked in committed files at merge.**
   - The same tests and the same `--force` handling as `ses-sign-in-proof` setting 1.
   - The unpark and evidence commits are expected to fail them. The full gate runs only on the re-parked tree.
2. **Production still refuses `enable_database = false`.** An existing test, rerun.
3. **A live key is refused in staging.** The existing billing-secret mode check, rerun.
4. **No identifier in any added line.** The plan names the scan pattern the reviewer runs on the diff.
   - It matches a Stripe prefix followed by at least 8 alphanumeric characters.
   - It covers `(rk|sk)_(test|live)_` keys and `whsec_` values of 16 characters or more.
   - It explicitly allows the committed placeholder, so the literal prefixes in this spec and the runbook do not match.

## Contracts

None changed.

## Cost

| Line                          | Monthly USD      | Method                                                                                           |
| ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------ |
| Unpark (database, task, IPv4) | 34.20 if left up | USD 0.0468 an hour (`staging-proof-run` Cost table): about USD 1.12 at 24 h and USD 2.25 at 48 h |
| One-off tasks, SES sends      | cents            | Billed per second; USD 0.10 per 1,000 messages. Outside the totals                               |
| Billing secret new version    | 0                | Already billed at USD 0.40 a month since Apply 0                                                 |
| Provision secret              | under 0.01       | Exists for minutes                                                                               |
| Stripe                        | 0                | Test mode                                                                                        |

At Apply 2, staging returns to the parked month: about USD 7.70 plus images, which now includes the billing secret. This window alone cannot reach the USD 40 budget alert.

## Risks

- **The webhook secret is put after the task starts, and every event fails its signature.**
  - Mitigation: P3 orders the put before Apply 1, and the pre-check confirms it.
  - If it happens anyway, the owner forces a new deployment of the service rather than editing the secret again. A new process re-reads the secret.
- **Events arrive before the link and are `ignored`.**
  - That is expected (S4). An `ignored` event is not reprocessed on resend, so S5 proves the invoice path on a linked subscription instead.
- **A Checkout lands on the wrong organisation.**
  - Mitigation: only one organisation exists, and `client_reference_id` comes from the slug lookup.
  - The two-organisation case stays covered by tests.
- **Tokens expire mid-run, or the sign-in cap is hit.**
  - Mitigation: P10.
- **The owner, the inbox and a browser must all be available inside the window.**
  - Mitigation: start Apply 1 only when S1–S10 can follow within hours.
- **The single Spot task can be interrupted mid-webhook.**
  - Mitigation: Stripe retries, and the event row stays `received` and converges.
- **The webhook shares the tenant write throttle.**
  - This run sends a handful of events. A 429 would show as a Stripe retry.
- **A code defect found live cannot be fixed on this branch.**
  - Mitigation: re-park and fix on a `fix/` branch.
- **A filter pattern may be recorded by CloudTrail.**
  - Mitigation: count locally (S12).

## Out-of-band

- Legal: none for test mode. The APP 8 disclosure and the tax-invoice questions from `stripe-billing` stay with the owner until before the first live customer.
- New vendor or AWS service: none.
- Architecture change: none.
- Size: docs plus one var-file flip each way, well under AGENTS.md §3's ~800 lines.
- Second fresh-context review: required (payments, authentication, tenancy). Under AGENTS.md §2, the owner's assistant uses a different tool and a different model family from both the implementer and the reviewer agent.
- Rollback: Apply 2 is the rollback. The Stripe test-mode objects are harmless and can be deleted in the dashboard.
