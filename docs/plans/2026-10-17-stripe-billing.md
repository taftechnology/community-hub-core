Spec: docs/specs/2026-10-17-stripe-billing.md

# Platform subscriptions through Stripe Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An organisation can be put on a Stripe subscription. Stripe can tell us about it through a signed webhook on the Sydney hostname, and the service stores and reports the organisation's billing state. Nothing is enforced yet; `billing-read-only` enforces it. The staging secret is applied while parked (Apply 0). The live test-mode proof is `stripe-billing-proof`.

**Architecture:** A new module `modules/core/billing` owns three `platform` tables, the pure state rules, a Stripe port and the repository. It reads other modules only through their `public/` exports. `apps/api` adds a Stripe adapter behind that port, a per-route POST body cap, the webhook route, three tenant billing routes and the `billing-admin` one-off. `packages/policy` gains two organisation-only permissions. `modules/core/access` exports `holdsAnyGrant`. Terraform adds one empty secret, its key-policy pattern, a task-role read and two container variables.

Slug: stripe-billing
Status: approved (2026-10-17, Abdus)

**Branch:** `feat/2026-10-17-stripe-billing` · one PR · fourteen agent commits after the approved spec

## Who does what

| Actor                     | Writes repo commits                              | Runs `terraform apply`                  | Puts secret values, runs AWS one-offs | Applies or merges |
| ------------------------- | ------------------------------------------------ | --------------------------------------- | ------------------------------------- | ----------------- |
| Implementer (Antigravity) | Yes — Tasks 1–14, only the files each task names | Never                                   | Never                                 | Never             |
| Reviewer (fresh Claude)   | Never                                            | Never — read-only plan without the lock | Never — read-only AWS                 | Never             |
| Human owner (Abdus)       | Never during the run                             | Yes — Apply 0                           | Yes — the test-mode Stripe values     | Merges the PR     |
| Developer (Adnan)         | Approves this plan                               | Never                                   | Never                                 | Never             |

## Global constraints

- The spec is approved and no task edits it. Where this plan refines the spec, the deviation is listed in **Deviations from the spec** and repeated in the PR body.
- No agent runs `terraform apply`, `terraform init` against a live backend, `aws`, `docker push`, a Stripe API call with a real key, or any step in a **Human** section. Implementer and reviewer runs start with no AWS credentials, no Stripe key and pushes blocked. The orchestrator pushes the branch before Apply 0.
- Staging stays parked. No task touches `infra/regions/au/env/*.tfvars`. `service_image` is never committed.
- No account id, zone id, ARN, hostname, email address, secret value, Stripe key, real Stripe object id, task id or IP address appears in any commit, this plan, or the runbook evidence. There are two exceptions: hostnames already in committed Terraform (the zone names at `infra/regions/au/main.tf:7`), and the synthetic mock ARNs the existing Terraform tests already use. Other tests use synthetic values: `sk_test_synthetic…`, `whsec_synthetic…`, `cus_test1`, `sub_test1`, `evt_test1`, `in_test1`, and synthetic UUIDs.
- No amount appears in code, tests, seeds or fixtures, except the placeholder amounts `seed-test-catalogue` passes to Stripe test mode (Task 12). Those live in one constant map, commented as test-mode placeholders (Q8b).
- **Lock files.** No `.terraform.lock.hcl` change is ever committed. On Windows, `init -lockfile=readonly` fails because the lock files carry the Linux hash only. Either run Terraform under Linux (WSL), or run plain `init -backend=false` and then `git checkout -- '**/.terraform.lock.hcl'` before committing and before `pnpm check:boundaries`.
- From Apply 0 onward: no rebase, no amend, no force-push. If `origin/main` moves, merge it in. The PR opens only after Task 14, with the full gate green and the turbo cache bypassed (`pnpm test --force`, then `pnpm gate`).
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Second fresh-context review is required (payments, secrets, residency). The owner starts it when the PR opens.
- Only one run at a time uses the Docker test database (`packages/db/test/docker-compose.yml`). Turbo serialises the database test suites (Task 2 adds billing to the chain).
- A race test never depends on timing. Concurrency is proven by observing the lock in `pg_stat_activity` (Task 5), never by sleeps or by an absence that could just be slowness.

**Task count and size.** This plan has fourteen tasks. AGENTS.md §3 suggests 3–10 per chunk, and about 800 changed lines per chunk. The fresh review estimated about 5,900 lines for chunk (a). That is twice spec D19's 2,500–3,000 lines, because of the test volume this chunk's payment and tenancy rules need. Tasks were split so that none is far over ~500 lines. **Owner decision, 2026-10-17:** chunk (a) stays one pull request across the fourteen tasks.

**Migration wave:** expand. One migration, `0010`, in Task 2. Recovery: the tables and columns are additive and unused once the code is reverted; a later contract PR drops them.

**New dependency:** `stripe` (the official SDK) in `apps/api`, added in Task 7.

- Use the current major on npm, at a version at least two weeks old, and **no older than v18**. v18 is the first major on API version `2025-03-31.basil`, which the field paths in **Stripe details** assume.
- Pin the `apiVersion` that the SDK's types declare. Record the SDK version and API version in the Task 7 report.
- If the pinned API version is newer than `basil` and changes a field path in **Stripe details**, stop and report.
- Justified in the PR per AGENTS.md §14: it replaces hand-written form encoding, signature verification and retries; MIT licence; maintained by Stripe.
- `pnpm audit --audit-level=high` must pass.

## Stripe details (pins the three items spec Risks names)

| Item                                     | Pinned answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Source                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Invoice → subscription                   | Never read from the webhook payload. Task 7's adapter re-retrieves the invoice with the pinned API version and reads `parent.subscription_details.subscription`, checking that `parent.type === "subscription_details"`. On API versions from `2025-03-31.basil`, the top-level `invoice.subscription` is removed. Re-retrieving also makes us independent of the webhook endpoint's own API version.                                                                                                                                                                                                           | Stripe changelog, basil 2025-03-31, "Invoicing resources now specify how they were generated" |
| Period end                               | `items.data[0].current_period_end` (one item per subscription, spec D1). The subscription-level `current_period_end` is removed from `basil` onward.                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Stripe changelog, basil 2025-03-31, "Adds subscription item-level billing periods"            |
| Restricted-key permissions               | Stripe's public docs do not list the dashboard's resource names, so this is settled from the code. The Task 7 report lists every SDK method the adapter calls and the HTTP endpoint behind it. Task 13 turns that list into the runbook's `### Restricted key permissions` section, using the dashboard's resource names, before Apply 0. Expected resources: Checkout Sessions (write), Customer portal (write), Subscriptions (write), Tax Rates (write), Invoices (read), Prices (read), Products (read), Customers (read). The staging key also gets Products and Prices (write) for `seed-test-catalogue`. | Stripe "Restricted API keys"; spec D17                                                        |
| Portal and an `incomplete` first invoice | Not relied on. An `incomplete` organisation's banner says "Finish payment", and the Portal is opened. If the live proof shows that the Portal cannot pay it, `stripe-billing-proof` records a finding, and `billing-read-only` changes the banner to "Contact support". Nothing in this chunk depends on it.                                                                                                                                                                                                                                                                                                    | Spec review finding H2; spec state table                                                      |

## Deviations from the spec (repeated in the PR body)

1. **Idempotency keys for the seeded catalogue.** The spec table has one key, `seed:<lookup key>`. Stripe rejects a key reused for a different request, so there are two: `seed:product:<lookup key>` and `seed:price:<lookup key>`. Re-runs are idempotent through a lookup-key search first, because Stripe expires keys after about a day.
2. **Error codes in logs** are upper case (`BILLING_KEY_UNAVAILABLE`), because the logger's `errorCode` pattern is `^[A-Z0-9_]{1,40}$` (`packages/observability/src/logger.ts:64`). The spec writes them in lower case.
3. **Apply 0 creates no task definition.** While parked, `service_image` is null and the task definition has `count = 0` (`infra/modules/aws-ingress/main.tf:441`). The two container variables first appear in `stripe-billing-proof` Apply 1. The spec's Order of applies listed "the task-definition environment" under Apply 0.
4. **Plan rows (approved by the owner, 2026-10-17).** No code path creates `starter` or `growth` plan rows, or sets their lookup keys. `upsertPlan` (`modules/core/entitlements/infrastructure/writes.ts:95-101`) is called only from a test. So `0010`'s seed `UPDATE`s are no-ops in every environment, and Checkout would answer 422 until plan rows exist. This plan adds `billing-admin plan <key> --lookup-key <k> --trial-eligible <bool> --entitlements <keys>` (Task 12). It writes one plan through the entitlements `public/` exports. Plan contents (Q8b) stay operator data, entered by the owner. `stripe-billing-proof` uses it with the §10.2 placeholder contents. The spec's `0010` `UPDATE`s are kept, for any environment that already has the rows.

## Security pins

Each row: the implementer weakens the source once as described, sees the named test fail, restores the source, and reports the failure output in its task report. A weakened tree is never committed.

| #   | Setting                                                                                                                     | Test that pins it                                                                                                                                                | Weakening that must make it fail                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `billing.*` are outside `CATALOGUE`; community roles hold neither; org roles as in spec Permissions                         | `packages/policy/src/decide.test.ts` (Task 1)                                                                                                                    | Add `billing.manage` to `CATALOGUE`; or give `community_admin` `billing.view`                                                                                                                                                              |
| 2   | Custom roles cannot hold `billing.*`                                                                                        | `modules/core/access/infrastructure/holds-any-grant.integration.test.ts` custom-role insert case (Task 1)                                                        | Add `billing.manage` to the custom-role check in a scratch migration. The scratch migration is not committed; the reviewer checks this pin by reading the check at `access/db/schema.ts:153`, which no task edits                          |
| 3   | `holdsAnyGrant` checks both grant kinds in the transaction's scope                                                          | `holds-any-grant.integration.test.ts` (Task 1)                                                                                                                   | Drop the organisation-grant query; or skip community rows whose `custom_role_id` is not null. Dropping an `org_id` filter is masked by FORCE RLS (`0007_fast_gorilla_man.sql:63,66`) and is not a valid weakening; keep the filters anyway |
| 4   | `billing_settings` is append-only for `platform`                                                                            | `modules/core/billing/db/schema.integration.test.ts` privilege case (Task 2)                                                                                     | Remove the `REVOKE` from `0010`                                                                                                                                                                                                            |
| 5   | `0010` grants nothing to `app` or anyone                                                                                    | `modules/core/billing/db/schema.test.ts` text scan, and the existing `hasForbiddenPlatformGrant` (`entitlements/db/schema.test.ts:65`) (Task 2)                  | Add `GRANT SELECT ON platform.billing_settings TO app` to `0010`                                                                                                                                                                           |
| 6   | A missing account row is `invoiced`; every state-table row maps as specified; `grace_until` boundary                        | `modules/core/billing/domain/state.test.ts` (Task 3)                                                                                                             | Treat a missing row as `none`; or use `>` for `<` at `grace_until`                                                                                                                                                                         |
| 7   | Checkout only for `self_serve` with no subscription, `canceled` or `incomplete_expired`                                     | `domain/checkout.test.ts` (Task 3)                                                                                                                               | Allow `unpaid`; or allow `invoiced`                                                                                                                                                                                                        |
| 8   | Trial only for a `trial_eligible` plan and an organisation that never trialled                                              | `domain/trial.test.ts` (Task 3)                                                                                                                                  | Ignore `trial_used_at`                                                                                                                                                                                                                     |
| 9   | Linking keeps the first live subscription; replaces only a `canceled` or `incomplete_expired` one                           | `infrastructure/accounts.integration.test.ts` (Task 4)                                                                                                           | Overwrite on `duplicate`; or treat `past_due` as replaceable                                                                                                                                                                               |
| 10  | Event replay short-circuits only `processed` and `ignored`                                                                  | `infrastructure/events.integration.test.ts` (Task 4)                                                                                                             | Short-circuit `received` too                                                                                                                                                                                                               |
| 11  | Apply locks the account row before re-reading Stripe                                                                        | `infrastructure/apply.integration.test.ts` lock case (Task 5)                                                                                                    | Remove `for update`                                                                                                                                                                                                                        |
| 12  | Billing never writes an `invoiced` organisation's plan; `assignPlan` runs only on a real plan change                        | `apply.integration.test.ts` plan cases with a custom allocation (Task 5)                                                                                         | Drop the mode check; or call `assignPlan` on every apply                                                                                                                                                                                   |
| 13  | Trial recorded once                                                                                                         | `apply.integration.test.ts` trial case (Task 5)                                                                                                                  | Drop the `trial_used_at` write; or overwrite it on every apply                                                                                                                                                                             |
| 14  | New log keys keep only valid values; outcomes `processed` and `ignored` exist                                               | `packages/observability/src/logger.test.ts` (Task 6)                                                                                                             | Accept any string for `stripeEventType`                                                                                                                                                                                                    |
| 15  | Key mode must match the environment; secret read lazily; any reader error becomes a fixed code                              | `apps/api/src/billing/secret.test.ts` (Task 6)                                                                                                                   | Skip the prefix check; or rethrow the reader's error                                                                                                                                                                                       |
| 16  | Stripe errors become fixed codes; no message, payload, email or amount in logs, thrown errors or bodies                     | `apps/api/src/billing/stripe-adapter.test.ts` leakage case (Task 7)                                                                                              | Log `error.message`; or rethrow the Stripe error                                                                                                                                                                                           |
| 17  | Signature verified on the raw bytes with a 300-second tolerance                                                             | `stripe-adapter.test.ts` (Task 7)                                                                                                                                | Verify `JSON.stringify(JSON.parse(body))` (the test payload is pretty-printed JSON); or pass tolerance 0                                                                                                                                   |
| 18  | Every Stripe write carries its named idempotency key                                                                        | `stripe-adapter.test.ts` per-call assertions (Task 7)                                                                                                            | Omit `idempotencyKey` on Checkout                                                                                                                                                                                                          |
| 19  | Boot never reads the billing secret; without the variables the port rejects with a fixed code                               | `apps/api/src/index.test.ts` (Task 7)                                                                                                                            | Read the secret in `bindServices`                                                                                                                                                                                                          |
| 20  | Only `POST /v1/stripe/webhook` with the webhooks hostname reads more than 4096 bytes, up to 256 KiB                         | `apps/api/src/server.test.ts` (Task 8)                                                                                                                           | Raise `POST_BODY_MAX_BYTES`; or ignore the hostname in the cap lookup                                                                                                                                                                      |
| 21  | Nothing is recorded before the signature is verified                                                                        | `apps/api/src/billing-webhook.test.ts`, with the real adapter's `verifyEvent` (Task 8)                                                                           | Call `recordReceived` before verifying                                                                                                                                                                                                     |
| 22  | Apply uses Stripe's re-read, never the event payload                                                                        | `billing-webhook.test.ts` out-of-order case (Task 8)                                                                                                             | Apply `event.data.object` directly                                                                                                                                                                                                         |
| 23  | Webhook answers 404 on every other hostname                                                                                 | `billing-webhook.test.ts` (Task 8)                                                                                                                               | Remove the hostname check                                                                                                                                                                                                                  |
| 24  | Checkout and Portal need `billing.manage`, not `billing.view`; unknown slug and stranger answer 403; strict bodies          | `apps/api/src/billing-routes.test.ts` (Task 9); `billing-flow.integration.test.ts` (Task 10)                                                                     | Check `billing.view` in Checkout; or return 404 for an unknown slug; or accept an `organisationId` field                                                                                                                                   |
| 25  | Return URLs are `ADMIN_ORIGIN` plus a fixed flag and nothing else                                                           | `billing-routes.test.ts` exact strings (Task 9)                                                                                                                  | Append the slug                                                                                                                                                                                                                            |
| 26  | Status returns banner fields only to a grant-holder without `billing.view`; no audit row on the fallback                    | `billing-routes.test.ts` status cases (Task 10)                                                                                                                  | Return the full fields when `holdsAnyGrant` is true; or audit the fallback                                                                                                                                                                 |
| 27  | `billing-admin settings` writes nothing when Stripe fails; bounds and note enforced                                         | `apps/api/src/billing-admin.test.ts` (Task 12)                                                                                                                   | Insert the row before the TaxRate call                                                                                                                                                                                                     |
| 28  | `seed-test-catalogue` refuses a live key; `mode invoiced` refuses a live subscription without the flag                      | `billing-admin.test.ts` (Task 12)                                                                                                                                | Drop either guard                                                                                                                                                                                                                          |
| 29  | Task role reads exactly the billing secret; the execution role does not; the root does not add it to `db_secret_arns`       | `envelope.tftest.hcl` `happy` whole-statement `==` and the execution check; `cell.tftest.hcl` `staging_happy` and `prod_tfvars` `db_secret_arns` regex (Task 13) | Use a `*` resource (envelope fails); or add the ARN to `execution_secrets` (envelope fails); or add `module.db_secrets.billing_secret_arn` to `db_secret_arns` in `infra/regions/au/main.tf` (cell fails)                                  |
| 30  | Key policy admits exactly five secret ARN patterns, including billing; no Terraform-managed secret version                  | `secrets.tftest.hcl` `happy` (Task 13)                                                                                                                           | Remove the `-billing-??????` pattern; or add an `aws_secretsmanager_secret_version.billing`                                                                                                                                                |
| 31  | Container gets the two variables only together and only when set; never in `secrets`; `ADMIN_ORIGIN` equals the CORS origin | `ingress.tftest.hcl` `staging_image_set` exact list (`:579`) and the new `billing_variables_into_task` run (Task 13)                                             | Emit them with empty values when null; or add a `secrets` entry for the ARN                                                                                                                                                                |
| 32  | Staging parked in committed files at merge                                                                                  | Existing parked tests, including `modules/core/entitlements/db/parked.test.ts`                                                                                   | (not weakened; checked by the full gate with `--force`)                                                                                                                                                                                    |

## Rollback

| Point          | Rollback                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Before Apply 0 | Nothing in AWS. Revert commits on new commits.                                                                      |
| After Apply 0  | The secret is additive and unused while parked. The owner can destroy it by reverting Task 13 and applying.         |
| After merge    | Revert the code. Migration `0010` is additive. No organisation is `self_serve` until the owner sets one (spec D12). |

## Stop and ask (AGENTS.md §12)

Implementer, stop and report if any of these happens:

- the plan is wrong or ambiguous;
- a migration, Dockerfile, workflow, Terraform, `turbo.json` or dependency change is needed that this plan does not name;
- a checker or test outside the named files needs changing;
- the Stripe SDK cannot do something a task needs without a raw HTTP call;
- the pinned API version contradicts **Stripe details**;
- the same step fails twice.

Day of Apply 0, the owner stops if the plan shows changes outside the Task 13 resources.

---

### Task 1: Billing permissions and `holdsAnyGrant`

**Files:**

- Modify: `packages/policy/src/decide.ts`, `packages/policy/src/decide.test.ts`
- Create: `modules/core/access/infrastructure/holds-any-grant.ts`, `holds-any-grant.integration.test.ts`
- Modify: `modules/core/access/public/index.ts` (export `holdsAnyGrant`)

**Shape:**

- **Policy.** `decide.ts` gains `BILLING = ["billing.view", "billing.manage"] as const`, outside `CATALOGUE` (`decide.ts:1-9`).
  - `org_owner` and `org_admin` become `[...CATALOGUE, ...BILLING]`.
  - `org_billing` becomes `["access.users.view", "entitlements.view", ...BILLING]`.
  - `org_auditor` adds `billing.view`.
  - `community_admin` stays `CATALOGUE`. `catalogue()` is unchanged, so `callerPermissions` (`apps/api/src/access-routes.ts:253-255`) and the custom-role check (`modules/core/access/db/schema.ts:153`) do not change.
  - `decide` itself does not change. It accepts any custom permission it is given (`decide.ts:62-64`); the database check is what stops a custom role holding `billing.*`.
- **`holdsAnyGrant`.** `holdsAnyGrant(tx: AppTransaction, userId: string): Promise<boolean>` mirrors the two grant queries in `holds-permission.ts:9-21`, including both `org_id` filters and the community filter. It is true if either query returns a row, including a community row that carries only a `custom_role_id`.

**Test first (RED):**

- `decide.test.ts`:
  - the bundle pins at `:39-62` gain the new entries;
  - `catalogue()` still equals the seven entries (`:25-37`);
  - `decide` is true for `billing.manage` with organisation role `org_billing`;
  - `decide` is false for `billing.manage` with community role `community_admin`, and with community role `member`.
- `holds-any-grant.integration.test.ts`, on the Docker database, with two organisations each with one community, plus a second community in organisation A (model on `modules/core/entitlements/infrastructure/two-org.integration.test.ts:38`). It returns:
  - true for an organisation grant, a community role grant, a `member` grant, and a community grant through a custom role;
  - false for a user whose only grants are in the other organisation;
  - false for a community grant in A's other community.
  - Inserting `billing.manage` into `app.custom_role_permissions` fails with SQLSTATE 23514.

**Rule this must not break:** rule 2. Existing access and entitlement permission behaviour is unchanged: all existing tests pass, except the bundle pins.

**Commit subject:** `feat(access): add billing permissions and a grant check`

- [ ] RED: `pnpm --filter @community-hub/policy test` and `pnpm --filter @community-hub/access exec vitest run infrastructure/holds-any-grant` fail.
- [ ] GREEN; build policy and access.
- [ ] Security pins 1, 2 (read), 3.
- [ ] `pnpm gate`.

### Task 2: Billing module, tables and migration `0010`

**Files:**

- Create `modules/core/billing/`, copying the layout and configuration of `modules/core/access`: `exports` to `./dist/public/index.js`, and `vitest.config.ts` with the shared globalSetup and `fileParallelism: false`. Its files:
  - `package.json`, `tsconfig.json`, `tsconfig.test.json`, `vitest.config.ts`;
  - `module.manifest.ts`;
  - `db/schema.ts`, `db/schema.test.ts`, `db/schema.integration.test.ts`;
  - `domain/manifest.test.ts`;
  - `public/index.ts`.
- Modify: `pnpm-workspace.yaml` (add the module), `pnpm-lock.yaml`.
- Modify: `turbo.json`. Add `"@community-hub/billing#test": { "dependsOn": ["^build", "@community-hub/entitlements#test"] }`, and add `"@community-hub/billing#test"` to `@community-hub/api#test`'s `dependsOn`, so that the database suites stay serial.
- Modify entitlements:
  - `modules/core/entitlements/db/schema.ts`: the `plans` factory (`:52-58`) gains `stripe_lookup_key text` (unique) and `trial_eligible boolean not null default false`;
  - `module.manifest.ts` and `domain/manifest.test.ts`;
  - `public/index.ts`, plus a new `infrastructure/plan-billing.ts` and `plan-billing.integration.test.ts`.
- Modify: `packages/db/drizzle.schema.ts`, to wire `billingTables(platform, { organisationId })` beside `entitlementTables` (`:15-26`).
- Create: `packages/db/drizzle/0010_<generated name>.sql` and `meta/0010_snapshot.json`; modify `meta/_journal.json`.

**Shape:**

- **Billing tables.** `db/schema.ts` exports `billingTables(platform, refs: { organisationId })`. The organisation column is passed in, as `entitlementTables` receives tenancy's columns (`modules/core/entitlements/db/schema.ts:16-32`). The function returns `billing_accounts`, `billing_settings` and `billing_stripe_events`, exactly as in the spec's Data section:
  - checks on `mode`, `outcome`, the bounds and the note;
  - unique `stripe_customer_id` and `stripe_subscription_id`;
  - an FK to the organisation, on delete restrict.

  The factory imports only `drizzle-orm`, like the existing factories. There is no guard test for this; the reviewer reads the imports.

- **Entitlements public reads and write.** `plan-billing.ts` exports:
  - `planByLookupKey(sql, lookupKey): { key } | null`;
  - `currentPlan(sql, organisationId): { key, stripeLookupKey, trialEligible } | null`;
  - `planBilling(sql, planKey): { stripeLookupKey, trialEligible } | null`;
  - `setPlanBilling(sql, planKey, { stripeLookupKey, trialEligible })`.

  All four are exported from `public/`, so billing never queries entitlements tables directly (AGENTS.md §6).

- **Generating `0010`.** Generate with drizzle-kit against `packages/db/drizzle.config.ts`, as `packages/db/src/generate.test.ts:33` does. Then append these statements by hand, each separated by `--> statement-breakpoint` (precedents: `0002_rare_jimmy_woo.sql:39-40`, `0007_fast_gorilla_man.sql:78-81`):
  - `REVOKE UPDATE, DELETE, TRUNCATE ON platform.billing_settings FROM platform;`
  - one `INSERT` of the seed settings row: 1000 bps, inclusive true, trial 30, grace 7, a null TaxRate, note `seed`, and a fixed synthetic UUID;
  - the two spec `UPDATE`s of `platform.plans` (`starter` → `starter_monthly`, trial-eligible; `growth` → `growth_monthly`). They are no-ops when the rows are absent (see deviation 4).

  `generate.test.ts` must still pass.

- **Manifest.** `core.billing`: `requires: ["core.tenancy", "core.entitlements"]`, `permissions: ["billing.view", "billing.manage"]`, and `dataClasses` for every new column, all `internal`.

**Test first (RED):**

- `domain/manifest.test.ts`: equality on the whole billing manifest. The entitlements `manifest.test.ts` gains the two `plans` entries.
- `db/schema.test.ts`, text checks on `0010`:
  - the `REVOKE` is present;
  - there is exactly one `INSERT`, into `billing_settings`;
  - there is no `GRANT`;
  - no `app.` table is touched;
  - every hand-written statement is separated by a breakpoint.
- `db/schema.integration.test.ts`, after migrating:
  - `platform` can insert into and select from `billing_settings`, and UPDATE and DELETE fail with 42501;
  - the seed row has the D5 values;
  - the checks reject `gst_rate_bps = 5001`, `trial_days = 91`, `grace_days = 31`, a 201-character note and a mode of `free`;
  - a duplicate `stripe_customer_id` fails as unique.
- `plan-billing.integration.test.ts`:
  - set, then read back;
  - lookup by key;
  - `currentPlan` for an organisation with and without a plan;
  - two lookup keys cannot be the same (unique).

**Rule this must not break:** rule 2 (no `org_id`; `platform` only). The journal stays linear, existing migrations are untouched, and `pnpm check:boundaries` passes.

**Commit subject:** `feat(billing): add billing tables and Stripe lookup keys on plans`

- [ ] RED, GENERATE, GREEN; `pnpm --filter @community-hub/db build`.
- [ ] Security pins 4, 5.
- [ ] `pnpm gate`.

### Task 3: Billing state rules and the port (pure domain)

**Files:**

- Create: `modules/core/billing/domain/state.ts`, `state.test.ts`, `checkout.ts`, `checkout.test.ts`, `trial.ts`, `trial.test.ts`, `transition.ts`, `transition.test.ts`, `port.ts`
- Modify: `modules/core/billing/public/index.ts`

**Shape:**

- `deriveState(account: Account | null, now: Date): BillingState` implements the spec's state table exactly; `null` means `invoiced`.
- `checkoutDecision(account: Account | null): "allowed" | "conflict"`, per spec Behaviour → Checkout.
- `trialDaysFor(plan: { trialEligible: boolean }, account: Account | null, settings: Settings): number | undefined`.
- `transition(prev, nextStatus, now, graceDays)` returns the new `unpaid_since` and `grace_until`: set on entry into `unpaid`, kept while still `unpaid`, cleared on any other status.
- `port.ts`:
  - `class BillingUnavailable extends Error`, with `readonly code`;
  - the `StripeBilling` port, with plain types only and no `stripe` import: `createCheckoutSession`, `createPortalSession`, `retrieveSubscription`, `subscriptionForInvoice`, `findPriceByLookupKey`, `createTaxRate`, `updateQuantity`, `updateDefaultTaxRate`, `verifyEvent`, `ensureProduct`, `ensurePrice`;
  - every write takes `idempotencyKey`;
  - `retrieveSubscription` returns `{ id, customerId, status, lookupKey, quantity, currentPeriodEnd, trialEnd, taxRateId, organisationIdMetadata }`.

**Test first (RED):** table-driven tests:

- every row of the state table, and `grace_until` equal to `now` (that is `read_only`);
- checkout for every row;
- trial: eligible and never trialled; eligible and already trialled; ineligible; settings at 0 days;
- transitions: `active → past_due → unpaid → unpaid → active`; `unpaid → canceled`; a second entry into `unpaid` after a recovery (sets a new grace).

**Rule this must not break:** B6 (no deletion; read-only only after grace). `domain/` stays framework-free: no `drizzle`, no `stripe`.

**Commit subject:** `feat(billing): derive billing state, checkout and trial rules`

- [ ] RED, GREEN.
- [ ] Security pins 6, 7, 8.
- [ ] `pnpm gate`.

### Task 4: Billing repository

**Files:**

- Create, under `modules/core/billing/infrastructure/`: `accounts.ts`, `events.ts`, `settings.ts`, `accounts.integration.test.ts`, `events.integration.test.ts`, `settings.integration.test.ts`
- Modify: `modules/core/billing/public/index.ts`

**Shape** (all on the `platform` SQL client):

- `events.ts`:
  - `recordReceived(sql, eventId, type)` is an upsert that returns the stored `outcome`;
  - `markOutcome(sql, eventId, "processed" | "ignored")`.
- `accounts.ts`:
  - `readAccount(sql, orgId)`, `findBySubscription` and `findByCustomer`;
  - `setMode(sql, orgId, mode)`, an upsert;
  - `linkSubscription(sql, orgId, customerId, subscriptionId)` runs under `select … for update` on the account row. It links when the stored subscription id is null or equal, or when the stored `stripe_status` is `canceled` or `incomplete_expired`. In that last case it replaces the id and clears `unpaid_since` and `grace_until`. Otherwise it returns `duplicate`. It returns `"linked" | "duplicate" | "invoiced" | "missing"`, where `invoiced` covers both no row and mode `invoiced`.
- `settings.ts`:
  - `currentSettings` returns the newest row by `created_at`, then by `id`;
  - `insertSettings` rejects a null TaxRate id.

**Test first (RED), on the Docker database:**

- `events`:
  - the first `recordReceived` returns `received`;
  - after `markOutcome(processed)` it returns `processed`, and `ignored` likewise;
  - a `received` row stays `received`.
- `accounts`:
  - link to an empty account, then link the same subscription again: both `linked`;
  - a different subscription while the stored one is `active` or `past_due`: `duplicate`, and the first link is kept;
  - stored `canceled`, then `incomplete_expired`: the new subscription replaces it (`linked`);
  - an `invoiced` organisation and a missing row both return `invoiced`; an unknown organisation returns `missing`;
  - two organisations: linking in A never touches B.
- `settings`:
  - the newest row wins;
  - `insertSettings` with a null TaxRate fails.

**Rule this must not break:** rule 2.

**Commit subject:** `feat(billing): store billing accounts, settings and Stripe events`

- [ ] RED, GREEN.
- [ ] Security pins 9, 10.
- [ ] `pnpm gate`.

### Task 5: Apply Stripe state under a row lock

**Files:**

- Create: `modules/core/billing/infrastructure/apply.ts`, `apply.integration.test.ts`
- Modify: `modules/core/billing/public/index.ts`; `modules/core/billing/package.json` (depend on `@community-hub/entitlements` and `@community-hub/tenancy`); `pnpm-lock.yaml`

**Shape:** `applySubscription(sql, port, subscriptionId, now, hooks?: { afterLock?: () => Promise<void> })` runs these steps:

1. `sql.begin`;
2. `select … from platform.billing_accounts where stripe_subscription_id = $1 for update`. If there is no row, return `"unlinked"`;
3. `await hooks?.afterLock?.()`, which is used only by the lock test;
4. `currentSettings` (for the grace days), inside the transaction;
5. `port.retrieveSubscription` while the lock is held;
6. compute `transition`;
7. update the mirrored columns and `synced_at`, plus `trial_used_at = coalesce(trial_used_at, now)` when the status is `trialing` or `trialEnd` is set;
8. commit.

After the commit, when the mode is `self_serve`:

- `planByLookupKey` returns null: return `"unknown_price"` and touch no plan;
- the plan differs from `currentPlan`: call `assignPlan(sql, { organisationId, planKey, now })`.

The function returns `"applied" | "unlinked" | "unknown_price"`. `syncQuantity(sql, port, orgId, key)` reads the community count with `(await listCommunityIds(sql, orgId)).length` from `@community-hub/tenancy`, then calls `port.updateQuantity` with `proration_behavior: "create_prorations"`.

**Test first (RED), on the Docker database, with a fake port:**

- The mirrored columns equal the port's answer, not anything passed in.
- **Lock.** These steps prove B was blocked by the lock, not just slow:
  1. A calls `applySubscription` with an `afterLock` that resolves `locked` and then awaits `release`;
  2. after `locked`, B calls `applySubscription` with no hook;
  3. the test polls `select wait_event_type from pg_stat_activity where pid = <B's pid>` until it shows `Lock`. The poll is a bounded loop over query results, with no timer; B's pid is read through `pg_backend_pid()` on B's connection, exposed by the fake port's first call or by a dedicated pool of one;
  4. it then asserts that B's port spy has 0 calls;
  5. release A and await both. B's `synced_at` is later than A's, and `grace_until` equals A's value.

  With `for update` removed, B reaches the port before it blocks, so step 4 fails every time.

- **Plans.**
  - A `self_serve` organisation going from `starter_monthly` to `growth_monthly` calls `assignPlan` once.
  - A second apply with the same key leaves a custom `community_allocations` row intact.
  - An `invoiced` organisation with a linked subscription never changes its `organisation_plans` row or its allocations.
  - An unknown key returns `unknown_price`.
- **Trial.** A trialing apply sets `trial_used_at`; a later apply leaves it unchanged.
- **Two organisations.** Applying A's subscription never changes B's row.

**Rule this must not break:** rule 2. `assignPlan` and `writes.ts` are not edited.

**Commit subject:** `feat(billing): apply Stripe state under a row lock`

- [ ] RED, GREEN.
- [ ] Security pins 11, 12, 13.
- [ ] `pnpm gate`.

### Task 6: Log fields, billing environment and the billing secret

**Files:**

- Modify: `packages/observability/src/logger.ts`, `logger.test.ts`, `logger.types.test.ts`
- Modify: `apps/api/src/env.ts`, `env.test.ts`
- Create: `apps/api/src/billing/secret.ts`, `secret.test.ts`
- Modify: `apps/api/package.json` (depend on `@community-hub/billing`), `apps/api/tsconfig.json` (reference), `apps/api/Dockerfile:8` (add `--filter @community-hub/billing`), `apps/api/src/image.test.ts` (`:115-134`, add it to the filter list), `pnpm-lock.yaml`

**Shape:**

- **Logger.**
  - `LogOperation` (`logger.ts:7`, `OPERATIONS` `:72`) gains `stripe_call`, `stripe_webhook` and `billing_admin`.
  - `LogOutcome` and `OUTCOMES` (`:11`, `:74`) gain `processed` and `ignored`.
  - `ALLOWED_LOG_KEYS` (`:45-59`) gains three keys, each with a required value pattern:

    | Key               | Value must match            |
    | ----------------- | --------------------------- |
    | `organisationId`  | a UUID                      |
    | `stripeEventId`   | `^evt_[A-Za-z0-9]{1,255}$`  |
    | `stripeEventType` | `^[a-z_]+(\.[a-z_]+){1,4}$` |

    A value that does not match is dropped and counted.

  - Fixed codes go in `errorCode`: `BILLING_KEY_UNAVAILABLE`, `BILLING_KEY_MODE_MISMATCH`, `BILLING_UNKNOWN_PRICE`, `BILLING_DUPLICATE_SUBSCRIPTION`, `STRIPE_AUTH`, `STRIPE_RATE_LIMIT`, `STRIPE_INVALID_REQUEST`, `STRIPE_CONNECTION`, `STRIPE_API`.
- **Environment.** `env.ts` gains optional `BILLING_SECRET_ARN` and `ADMIN_ORIGIN`, set both or neither (precedent: `env.ts:120-124`, `:172-175`).
  - `BILLING_SECRET_ARN` is validated like `PROVISION_SECRET_ARN` (`provision-owner.ts:34-35`): a Secrets Manager ARN in `ap-southeast-2` whose name ends `-billing-` plus six characters.
  - `ADMIN_ORIGIN` must be `https://` plus a host, with no path, query or fragment.
- **Secret.** `secret.ts` exports `billingSecret(readSecret, arn, environment)`.
  - It reads through `secretsManagerReader` on first use and caches the result.
  - It parses `{ "secret_key": string, "webhook_secret": string }`.
  - The key prefix must match the environment: `sk_test_` or `rk_test_` in staging, `sk_live_` or `rk_live_` in prod. The webhook secret must start with `whsec_`.
  - Any reader rejection, bad JSON or missing field throws `BillingUnavailable("BILLING_KEY_UNAVAILABLE")` with no original message kept; AWS errors can contain an ARN. A prefix mismatch throws `BILLING_KEY_MODE_MISMATCH`.
  - `invalidate()` drops the cache; the adapter calls it after `STRIPE_AUTH`.

**Test first (RED):**

- logger:
  - the new operations, outcomes and keys are kept when valid;
  - an email in `stripeEventType`, a non-UUID `organisationId` and an `evt` id with a space are each dropped and counted.
- env:
  - both set, and neither set, are accepted;
  - each alone fails;
  - an ARN in another region fails, and so does one whose name lacks `-billing-`;
  - an origin with a path fails, and so does an `http://` origin.
- secret:
  - a reader rejection whose message holds a synthetic ARN, invalid JSON, and a missing field each give `BILLING_KEY_UNAVAILABLE`, and the thrown error does not contain the ARN;
  - a live key in staging and a test key in prod each give `BILLING_KEY_MODE_MISMATCH`;
  - the reader is called once for two uses, and again after `invalidate()`.
- image: the filter-list test includes `@community-hub/billing`.

**Rule this must not break:** rule 5, rule 8, the existing logger allow-list (the KMS and SES lines are unchanged), and the existing image tests.

**Commit subject:** `feat(api): read the billing secret and log billing fields`

- [ ] RED, GREEN; build observability and billing.
- [ ] Security pins 14, 15.
- [ ] `pnpm gate`.

### Task 7: Stripe adapter and wiring

**Files:**

- Create: `apps/api/src/billing/stripe-adapter.ts`, `stripe-adapter.test.ts`
- Modify: `apps/api/package.json`, `pnpm-lock.yaml` (add `stripe`), `apps/api/src/index.ts`, `index.test.ts`

**Shape:**

- **Construction.** `createStripeBilling({ secret, clientFor, info })`. `clientFor(secretKey)` is a factory that returns a structural client type, so tests inject a fake and no module mock is needed. The production factory is `new Stripe(key, { apiVersion: <pinned>, maxNetworkRetries: 1, timeout: 10000 })`.
- **Writes** pass `{ idempotencyKey }`.
- **`verifyEvent(rawBody: Uint8Array, header)`** calls the real `Stripe.webhooks.constructEvent(Buffer.from(rawBody), header, webhookSecret, 300)`. That is a static helper and needs no client.
- **Subscriptions.** `retrieveSubscription` maps the pinned API version's fields, with the period end taken from `items.data[0].current_period_end` (**Stripe details**).
- **Invoices.** `subscriptionForInvoice(invoiceId)` retrieves the invoice and returns `parent.subscription_details.subscription` when `parent.type === "subscription_details"`, else null.
- **Checkout** uses `mode: "subscription"`, `client_reference_id`, `metadata.organisation_id`, `subscription_data.metadata.organisation_id` and `subscription_data.default_tax_rates`. It adds `subscription_data.trial_period_days` when given, and `customer` when known.
- **Errors.** Every error is mapped by its `type` to a `STRIPE_*` code, then thrown as `BillingUnavailable(code)`. `info` logs only `{ operation: "stripe_call", outcome, errorCode }`.
- **Wiring.**
  - `bindServices` (`index.ts:102-198`) builds the adapter only when both billing variables are set; otherwise a rejecting port, where every method throws `BillingUnavailable("BILLING_KEY_UNAVAILABLE")`. It never reads the secret at boot.
  - The billing and webhook dependencies get `log: (message, fields: BillingLogFields) => logger.info(message, fields)`, where `BillingLogFields` is a subset of `LogFields`. That replaces the existing `() => undefined` (`index.ts:148`) for the billing routes only.
- **Report.** The task report lists every SDK method called and its HTTP endpoint, for Task 13's restricted-key section, plus the SDK version and the pinned API version.

**Test first (RED):**

- adapter, with a fake client:
  - each call's input is asserted field by field, including the idempotency key;
  - `subscriptionForInvoice` returns null for a non-subscription parent;
  - the period end comes from the item.
- `verifyEvent`, with the real helper:
  - a pretty-printed JSON payload signed with `Stripe.webhooks.generateTestHeaderString` and a synthetic secret passes;
  - a changed byte fails;
  - the payload re-serialised through `JSON.stringify(JSON.parse(...))` fails;
  - a timestamp 301 seconds old fails.
- **leakage:** a fake client error whose message contains a synthetic email address and an amount yields a thrown error and an `info` payload that contain neither of them, nor the message (serialise and search).
- `index.test.ts`:
  - boot with neither variable succeeds, and the billing port rejects with `BILLING_KEY_UNAVAILABLE`;
  - boot with both variables does not call the secret reader;
  - a billing log line through the real logger parses with `getDroppedFieldCount() === 0`.

**Rule this must not break:** rule 5; rule 8; `image.test.ts` boots with no billing variables.

**Commit subject:** `feat(api): talk to Stripe behind the billing port`

- [ ] RED; add the dependency; GREEN.
- [ ] Security pins 16, 17, 18, 19.
- [ ] `pnpm audit --audit-level=high`; `pnpm gate`.

### Task 8: Per-route body cap and the Stripe webhook

**Files:**

- Modify: `apps/api/src/gate.ts` (optional `largeBody?: "webhooks"` on `GateRoute`), `gate.test.ts`, `apps/api/src/server.ts`, `server.test.ts`
- Create: `apps/api/src/billing-webhook.ts`, `billing-webhook.test.ts`
- Modify: `apps/api/src/index.ts` (the route in `run()` `:67-73` and `productionRoutes()` `:200-208`), `index.test.ts`

**Shape:**

- **Gate.** `assertRoutes` rejects `largeBody` on any route other than `POST /v1/stripe/webhook`.
- **Server.** `server.ts` (`:19`, `:40-52`, `:100-111`) chooses the cap before reading the body, from `options.routes`, `options.env.WEBHOOKS_HOSTNAME` and the presented hostname header (`gate.ts:79-86`). A POST whose method and pathname match a route with `largeBody: "webhooks"`, **and** whose presented hostname equals the webhooks hostname, reads up to 262144 bytes; above that it answers 413 with an empty body. Every other POST keeps 4096 bytes and 400.
- **Route.** `billing-webhook.ts` exports `billingWebhookRoutes(deps)`, with one route: `{ method: "POST", pattern: "/v1/stripe/webhook", surface: "tenant", largeBody: "webhooks" }`.
- **Handler.**
  1. Answer 404 unless the presented hostname is the webhooks hostname.
  2. Read the bytes with `request.arrayBuffer()`.
  3. `port.verifyEvent`. Failure answers 400, and nothing is recorded; `BillingUnavailable` answers 503.
  4. `recordReceived`. For `processed` or `ignored`, answer 200.
  5. Dispatch:
     - `checkout.session.completed`: `client_reference_id` must be a UUID, else `ignored`. Call `linkSubscription`:
       - `duplicate` is `ignored`, logged `BILLING_DUPLICATE_SUBSCRIPTION`;
       - `invoiced` and `missing` are `ignored`;
       - `linked` goes on to `applySubscription`.
     - `customer.subscription.created`, `.updated` and `.deleted`: `applySubscription(event.data.object.id)`.
     - `invoice.paid` and `invoice.payment_failed`: `port.subscriptionForInvoice(event.data.object.id)`, then `applySubscription`; null is `ignored`.
     - From `applySubscription`: `unlinked` is `ignored`; `unknown_price` is `processed`, logged `BILLING_UNKNOWN_PRICE`.
     - Any other type is `ignored`.
  6. `markOutcome`, then answer 200.
- **Failures.** A thrown error answers 500 with an empty body and leaves the row `received`.
- **Logging.** Log lines use `operation: "stripe_webhook"`, `stripeEventId`, `stripeEventType`, `organisationId` when known, `outcome` and `errorCode`. The body is never logged.

**Test first (RED):**

- `server.test.ts`, beside `:358`:
  - a 10 KiB POST to the webhook path with the webhooks hostname header reaches the handler;
  - 262145 bytes gets 413, and the handler is not called;
  - a 4097-byte POST to `/v1/access/grants` still gets 400;
  - a 10 KiB POST to the webhook path with the **api** hostname header gets 400.
- `gate.test.ts`: `largeBody` on any other route is rejected.
- `billing-webhook.test.ts`, with fake repository functions and a fake port, except where noted:
  - signature, using the **real** `verifyEvent` from Task 7 and a synthetic secret: a missing header, a bad signature and an old timestamp each give 400, and `recordReceived` is not called;
  - replay: `processed` gives 200 with no port call; `received` is processed again;
  - out of order: the event object says `past_due` while the port says `active`, and `active` is what gets written;
  - an invoice event resolves its subscription through `subscriptionForInvoice`;
  - an unknown type is `ignored`;
  - a subscription event before the link is `ignored`;
  - a duplicate is `ignored`, with the code logged;
  - an invalid `client_reference_id` is `ignored`;
  - the api, auth and ops hostnames give 404;
  - a thrown error whose message holds a synthetic email gives 500 with an empty body, and the row stays `received`;
  - every log line parses with 0 dropped fields, and contains no part of the body.

**Rule this must not break:** every existing route keeps the 4096-byte cap; rule 5.

**Commit subject:** `feat(api): receive signed Stripe events on the webhooks hostname`

- [ ] RED, GREEN.
- [ ] Security pins 20, 21, 22, 23.
- [ ] `pnpm gate`.

### Task 9: Contracts, Checkout and Portal

**Files:**

- Create: `packages/contracts/src/billing.ts`, `billing.test.ts`; modify `packages/contracts/package.json` (a `./billing` export)
- Create: `apps/api/src/billing-routes.ts`, `billing-routes.test.ts`
- Modify: `apps/api/src/index.ts` (the routes in both lists)
- Modify: `modules/core/billing/public/index.ts`, `module.manifest.ts`, `domain/manifest.test.ts` (the audit action and purpose `billing.permission.denied`, as `modules/core/access/public/index.ts:3-21` registers its own)

**Shape:**

- **Contracts.** Zod `.strict()` request schemas: `{ communitySlug }` and `{ communitySlug, planKey }`. Responses: `{ url }`, and the status object (used in Task 10). Model on `packages/contracts/src/entitlements.ts`.
- **Request flow.** `billing-routes.ts` follows `entitlement-routes.ts:111-203`: `foreignHost`, `parse`, `sessionUser`, then `communityScope`. `communityScope` answers **403** for an unknown slug.
- **Permission.** Inside `withAppTransaction`, call `holdsPermission(tx, userId, "billing.manage")`. A denial appends `billing.permission.denied` and answers 403.
- **Checkout**, on `platform`, in this order:
  1. `readAccount`, then `checkoutDecision`: a conflict answers 409;
  2. `planBilling(planKey)`: no lookup key answers 422;
  3. `currentSettings` with a TaxRate: none answers 503;
  4. `findPriceByLookupKey`;
  5. `listCommunityIds(...).length` for the quantity;
  6. `trialDaysFor`;
  7. `createCheckoutSession`, with key `checkout:<orgId>:<requestId>`. `requestId` is `getRequestContext().requestId` from `@community-hub/kernel` (as `entitlement-routes.ts:7,116`).
- **Portal.** No customer answers 409. Otherwise `createPortalSession`, with key `portal:<orgId>:<requestId>`.
- **Return URLs** are exactly `${ADMIN_ORIGIN}/?billing=done`, `${ADMIN_ORIGIN}/?billing=cancelled` and `${ADMIN_ORIGIN}/?billing=portal`.
- **Errors.** `BillingUnavailable` answers 503. Every error answers with an empty body.

**Test first (RED):** `billing-routes.test.ts`, with module mocks as in `entitlement-routes.test.ts`. The `holdsPermission` mock answers per permission:

- 404 on a foreign hostname;
- 400 on an extra field, including `organisationId`;
- 401 with no session;
- 403 for an unknown slug;
- 403 for a stranger, with one audit append;
- 403 on Checkout and Portal for a caller holding `billing.view` but not `billing.manage`;
- 409 for each conflict state;
- 422 when the plan has no lookup key;
- 503 when there is no TaxRate;
- 503 with an empty body when the port throws an error whose message holds a synthetic email;
- the port receives the exact Checkout input: both metadata fields, the trial days only when eligible, the exact return URLs, and the key;
- Portal: 409 when there is no customer, and the Portal key is asserted.

**Rule this must not break:** rule 2 (ids only from `findCommunityBySlug`); rule 5; AGENTS.md §6 (contracts first).

**Commit subject:** `feat(api): open Stripe Checkout and Portal for an organisation`

- [ ] RED, GREEN.
- [ ] Security pins 24, 25.
- [ ] `pnpm gate`.

### Task 10: Status route and the two-organisation flow

**Files:**

- Modify: `apps/api/src/billing-routes.ts`, `billing-routes.test.ts`
- Create: `apps/api/src/billing-flow.integration.test.ts`

**Shape:** status follows spec Behaviour → Status.

- A caller with `billing.view` gets the full object.
- Otherwise, `holdsAnyGrant` true gives the banner fields only: state, `trial_end` and `grace_until`. This fallback writes **no** audit row.
- Otherwise, 403 with one audit append.
- Every response carries `canView` and `canManage`.

**Test first (RED):**

- `billing-routes.test.ts`:
  - the full object with `billing.view`;
  - the banner fields only for a member;
  - `canView` and `canManage` correct for each role in the bundle table;
  - no audit append on the fallback, and one append on the final 403.
- `billing-flow.integration.test.ts`, on the Docker database, with two organisations and a fake port. A user of A gets 403 when calling Checkout, Portal or Status with B's slug. Checkout for A passes A's id as `client_reference_id`.

**Rule this must not break:** rule 2; spec Tests 7 and 10.

**Commit subject:** `feat(api): report an organisation's billing state`

- [ ] RED, GREEN.
- [ ] Security pins 24 (flow part), 26.
- [ ] `pnpm gate`.

### Task 11: ADR 0014 and architecture

**Files:**

- Create: `docs/adr/0014-platform-billing-state.md`
- Modify: `architecture.md`, and `docs/adr/0012-entitlement-visibility.md` (one "Amended by ADR 0014" line only)

**Content:**

- **ADR 0014.**
  - Context: B1–B7, and the split.
  - Decisions:
    - `core/billing` owns three `platform` tables, which amends ADR 0012's module list;
    - state is derived on read from Stripe's status and our grace;
    - read-only is a write guard, not an evaluation step (spec D10 and D11, built in `billing-read-only`);
    - a missing row means `invoiced`;
    - Stripe state is re-read under a row lock;
    - jobs that write call `assertWritable` once it exists.
  - Consequences, and the alternatives considered: the tables in `core/entitlements`; a separate evaluation step; a scheduled grace job.
- **`architecture.md`:**
  - §6.3: the platform owners gain `core/billing`;
  - §7.3 and §21.1: name Stripe as a subprocessor, with the fields in spec Rules touched → Rule 1;
  - §10: a short "Billing state" paragraph pointing to ADR 0014;
  - §14.1: the subscription row names `core/billing`, the webhooks hostname and the secret;
  - §14.4: the stale "Q14 … not a decision" line points to ADR 0012.

**Test first:** none (documents). `pnpm format` passes.

**Rule this must not break:** AGENTS.md §13.

**Commit subject:** `docs(billing): record platform billing state in ADR 0014`

- [ ] Write; `pnpm gate`.

### Task 12: `billing-admin` one-off

**Files:**

- Create: `apps/api/src/billing-admin.ts`, `billing-admin.test.ts`
- Modify: `apps/api/src/image.test.ts` (a `"ships billing-admin"` case beside `:461`)

**Shape:** model on `provision-owner.ts`:

- injected deps, and a result of `{ exitCode, stdout, stderr }`;
- fixed-word output;
- an entrypoint at the bottom (`:280-309`) that runs `readServiceEnv`, builds only the `platform` SQL client and the Stripe adapter, and calls `process.exit`. It needs no KMS logger.

Commands:

- **`settings --gst-bps <n> --inclusive <bool> --trial-days <n> --grace-days <n> --note <text>`.** Validate the bounds and the note (at most 200 printable ASCII characters, no newline). Generate the row id, then call `createTaxRate` with `{ percentage, inclusive, country: "AU", display_name: "GST" }` and key `taxrate:<row id>`, then `insertSettings`. A Stripe failure exits 1 and inserts nothing.
- **`sync <slug>`**: `syncQuantity` with key `qty:<subId>:<n>:<uuid>`.
- **`apply-tax-rate <slug>`**: `updateDefaultTaxRate` with key `taxmove:<subId>:<settingsId>`, then update `billing_accounts.tax_rate_id`.
- **`mode <slug> self_serve|invoiced [--subscription-cancelled-in-stripe]`**: the D12 guards apply; it prints the resulting state word.
- **`plan <key> --lookup-key <k> --trial-eligible <bool> --entitlements <comma list>`** (deviation 4): calls `upsertPlan` (entitlements public), then `setPlanBilling`. Lookup keys must match `^[a-z][a-z0-9_]{1,63}$`. It prints `plan_set`.
- **`seed-test-catalogue`**: refuses unless the key prefix is test mode. Otherwise, for `starter_monthly`, `growth_monthly` and the five §10.2 add-ons as `<addon>_monthly`, it runs `ensureProduct` (key `seed:product:<k>`, found first by metadata) and `ensurePrice` (key `seed:price:<k>`, found first by lookup key). Prices are AUD and monthly, and their `tax_behavior` follows the current settings' inclusive flag. Amounts come from the placeholder map.

Output prints the kinds of objects created and state words, never a key, an amount or an address.

**Test first (RED):**

- every command's happy path with fakes, asserting the exact idempotency keys;
- `settings` with a failing port inserts nothing;
- each bound fails at its edge plus one;
- a note with a newline fails;
- `seed-test-catalogue` with a live key exits non-zero, with no port call;
- a seed re-run with existing objects creates none;
- `mode invoiced` on `active` refuses without the flag, and succeeds with it;
- `plan` with a bad lookup key fails;
- output contains no `sk_` or `rk_` key and no amount;
- the image test ships `/app/billing-admin.js` (it runs with `RUN_IMAGE_TESTS=1`; the implementer runs it once and reports).

**Rule this must not break:** rule 8; existing image tests; `provision-owner` unchanged.

**Commit subject:** `feat(api): add the billing-admin one-off`

- [ ] RED, GREEN.
- [ ] Security pins 27, 28.
- [ ] `RUN_IMAGE_TESTS=1` image test once; `pnpm gate`.

### Task 13: Terraform — the billing secret, its read, the container variables, and the runbook's Apply 0 section

**Files:**

- Modify: `infra/modules/aws-db-secrets/main.tf`, `outputs.tf`, `tests/secrets.tftest.hcl`
- Modify: `infra/modules/aws-kms-envelope/main.tf`, `variables.tf`, `tests/envelope.tftest.hcl`
- Modify: `infra/modules/aws-ingress/main.tf`, `variables.tf`, `tests/ingress.tftest.hcl`
- Modify: `infra/regions/au/main.tf`, `infra/regions/au/tests/cell.tftest.hcl`
- Modify: `docs/runbooks/apply-staging-au.md`. Add a new section `## Stripe billing` with `### Apply 0`, `### Put the test-mode values` and `### Restricted key permissions` (from the Task 7 report's endpoint list, using the dashboard's resource names), and `### billing-admin commands` (with the `--note` warning).

**Resources:**

- **`aws-db-secrets`:**
  - add `aws_secretsmanager_secret.billing`: `region = var.aws_region`, `name = "${var.name}-billing"`, `kms_key_id = aws_kms_key.secrets.arn`, `tags = local.tags`. There is no version resource and no rotation;
  - the `SecretsManagerUse` key-policy `StringLike` list (`main.tf:53-58`) gains the `-billing-??????` pattern;
  - output `billing_secret_arn`.
- **`aws-kms-envelope`:**
  - a new required variable `billing_secret_arn` (string). `infra/regions/au` is its only caller;
  - `aws_iam_role_policy.task_secrets` (`main.tf:352-378`) gains `{ Sid = "ReadBillingSecret", Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.billing_secret_arn }`. `DecryptDbSecrets` already covers the secrets key;
  - `execution_secrets` is unchanged.
- **`aws-ingress`:**
  - `local.admin_origin = "https://admin.${var.zone_name}"`, used by `cors_configuration.allow_origins` (`main.tf:198`) and by the container;
  - a new variable `billing_secret_arn` (string, default `null`), beside `turnstile_secret_arn`;
  - the `environment` concat (`:474-497`) gains `var.billing_secret_arn == null ? [] : [{ name = "ADMIN_ORIGIN", value = local.admin_origin }, { name = "BILLING_SECRET_ARN", value = var.billing_secret_arn }]`;
  - `secrets` is unchanged.
- **`infra/regions/au/main.tf`:** passes `billing_secret_arn = module.db_secrets.billing_secret_arn` to `module.envelope` (`:154`) and `module.ingress` (`:223`).

**Test first (RED).** These are the asserts the probe ran; see the **Probe record**.

- **`secrets.tftest.hcl` `happy`:**
  - the file-level `mock_provider "aws"` gains `mock_resource "aws_kms_key" { defaults = { arn = "arn:aws:kms:ap-southeast-2:123456789012:key/mock-secrets" } }`;
  - the billing secret's name, `kms_key_id == aws_kms_key.secrets.arn`, and region;
  - no version resource: `!strcontains(file("${path.module}/main.tf"), "\"aws_secretsmanager_secret_version\" \"billing\"") && !strcontains(file("${path.module}/main.tf"), "aws_secretsmanager_secret.billing.")`;
  - the key-policy `StringLike` list equals the five patterns exactly.
- **`envelope.tftest.hcl`:**
  - all six runs set `billing_secret_arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:ch-staging-billing-AbCdEf"`;
  - in `happy`, the decoded `task_secrets` statements, compared whole with `==` to a literal that includes `ReadBillingSecret`;
  - no bare `*` resource;
  - `!strcontains(execution_secrets policy, var.billing_secret_arn)`.
- **`ingress.tftest.hcl`:**
  - the existing exact list in `staging_image_set` (`:579`) is unchanged when `billing_secret_arn` is null;
  - a new run, `billing_variables_into_task` (a copy of `mail_variables_into_task` with `billing_secret_arn` set and the mail variables removed), checks:
    - `slice(...)` of the last two environment entries equals `[ADMIN_ORIGIN, BILLING_SECRET_ARN]`;
    - `ADMIN_ORIGIN` equals `one(aws_apigatewayv2_api.tenant.cors_configuration[0].allow_origins)`;
    - the `secrets` names are exactly the three PG passwords, and none of them holds the ARN.
- **`cell.tftest.hcl`:**
  - `staging_happy`, `prod_tfvars`, `staging_image_set` and `prod_image_set` each gain `override_resource { target = module.db_secrets.aws_secretsmanager_secret.billing values = { arn = "arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:billing" } override_during = plan }`;
  - `staging_happy` and `prod_tfvars` check that the billing secret exists, that `!strcontains(regex("db_secret_arns\\s*=\\s*\\[[^\\]]*\\]", file("${path.module}/main.tf")), "billing")`, and that `length(regexall("(?m)^\\s*billing_secret_arn\\s*=\\s*module\\.db_secrets\\.billing_secret_arn\\s*$", file("${path.module}/main.tf"))) == 2`;
  - `prod_image_set`: the environment-count assert changes from 18 to 20;
  - `staging_image_set` and `prod_image_set` each check that `module.ingress.service_environment["BILLING_SECRET_ARN"] == module.db_secrets.billing_secret_arn`, and that `ADMIN_ORIGIN` is the admin origin derived from that environment's committed zone name (`infra/regions/au/main.tf:7`).

**Rule this must not break:** rule 8 (no value in Terraform; no var-file change). Also unchanged: `tooling/checks/terraform-invariants`, `terraform fmt`, tflint and the providers (no new one); the execution role cannot read the billing secret; no lock-file change.

**Commit subject:** `feat(infra): add the billing secret and its task-role read`

- [ ] Write the asserts. In each of the four directories run `init -backend=false` (see **Lock files**) and `test`, and see them fail.
- [ ] Implement, then in each directory run `fmt -recursive`, `validate`, `tflint --init && tflint` (CI has tflint; locally, report if it is missing) and `test`. Restore the lock files. Run `pnpm check:boundaries`.
- [ ] Security pins 29, 30, 31.
- [ ] `pnpm gate`.

## Human: Apply 0 (owner; reviewer reads)

1. The orchestrator pushes the branch.
2. The reviewer runs a read-only plan against real state, without taking the lock, and compares the change set with Task 13 address by address. The expected change set is:
   - the new secret;
   - the key-policy update on the secrets key;
   - the `task_secrets` policy update;
   - **no task definition**, because staging is parked and `service_image` is null (deviation 3);
   - nothing else.
3. The owner applies.
4. The owner puts the test-mode values by hand, from stdin through `put-secret-value` (runbook precedent `apply-staging-au.md:1235`): the restricted key built to `### Restricted key permissions`, and a placeholder `whsec_` value. The real signing secret exists only once the endpoint is created, in `stripe-billing-proof`.
5. The reviewer reads back, as yes-or-no facts and never values:
   - the secret exists, with the expected key;
   - it has a current version;
   - the task-role policy has `ReadBillingSecret`;
   - the execution role does not.

The container variables are checked in `stripe-billing-proof` Apply 1.

### Task 14: Apply 0 record and catalogue (last task on this branch)

**Files:**

- Modify: `docs/runbooks/apply-staging-au.md`, under `## Stripe billing`: `### Evidence` (the Apply 0 date, the commit SHA, resource addresses, yes-or-no read-backs) and `### Findings`.
- Modify: `docs/roadmap.md`:
  - `:25` and `:292`: next is `billing-read-only`;
  - `:99`: the next line;
  - `:124`: `stripe-billing` done, with its spec;
  - new rows below it: `billing-read-only` (not started) and `stripe-billing-proof` (not started);
  - `:246`: Q8 becomes "Q8a decided (spec 2026-10-17); Q8b plan contents and prices open";
  - `:266`: the CORS open item stays open, with spec D16's reason;
  - the snapshot table.
  - `AGENTS.md`'s Repository-state line is **not** changed here; that is a separate `chore/` docs PR.

**Test first:** none (documents). `pnpm format` passes. The orchestrator scans the added lines for identifiers before the commit.

**Commit subject:** `docs(roadmap): mark stripe-billing done and record Apply 0`

- [ ] Write this after Apply 0 and its read-back.
- [ ] `rm -f docs/plans/*-report.md`, then check that `git status --short` shows nothing from `.superpowers/`.
- [ ] `pnpm test --force`, then `pnpm gate`.

## Definition of done (AGENTS.md §8)

- All fourteen tasks committed, each reviewed by diff with its security pins reported.
- `pnpm gate` green with the turbo cache bypassed. CI green on the PR.
- The tenant-isolation tests in Tasks 1, 4, 5 and 10 are green.
- Staging parked in committed files, and Apply 0 recorded in the runbook.
- ADR 0014 and the `architecture.md` changes are in this PR.
- The roadmap is updated in the last commit.
- The PR body lists the implementer and reviewer configurations, the owner's check, the second-review line, and the **Deviations from the spec**.
- No `docs/plans/*-report.md` on disk, and nothing under `.superpowers/` staged.

## Probe record

Run on 2026-10-17 by a fresh agent, in a detached scratch worktree outside the repo, removed afterwards. It ran Terraform v1.11.4 (the version CI pins) with aws provider 6.67.0 and random 3.9.1. No apply, no backend, no real var file, no AWS call.

- **Results after the corrections:**

  | Directory                        | Runs passed | Note        |
  | -------------------------------- | ----------- | ----------- |
  | `infra/modules/aws-db-secrets`   | 2/2         |             |
  | `infra/modules/aws-kms-envelope` | 6/6         |             |
  | `infra/modules/aws-ingress`      | 25/25       | one new run |
  | `infra/regions/au`               | 16/16       |             |

  `fmt -check` and `validate` were OK. `terraform-invariants` `check()` found 0 violations.

- **Weakenings, each caught:**
  - `ReadBillingSecret` `Resource = "*"`: envelope `happy`.
  - The billing ARN added to `execution_secrets`: envelope `happy`.
  - The billing ARN added to `db_secret_arns` at the root: not caught by the first draft. After the probe's correction, caught by cell `staging_happy` and `prod_tfvars`.
  - The key-policy pattern removed: secrets `happy`.
  - A secret-version resource added: secrets `happy`.
  - Variables emitted when null: ingress `staging_image_set`.
  - The ARN added to `secrets`: ingress `billing_variables_into_task`.
  - The envelope wiring removed: cell, with "Missing required argument".
- **Corrections carried into Task 13:**
  - the KMS key mock;
  - the no-version check as a file check;
  - the envelope variable in all six runs;
  - `one(...)` on the `allow_origins` set;
  - run-level overrides for the billing ARN;
  - `prod_image_set` from 18 to 20;
  - the same-ARN check as a file check;
  - the root `db_secret_arns` check;
  - lock-file handling on Windows.
- **Not run:**
  - tflint (not installed locally; CI runs it);
  - `init -lockfile=readonly` on Windows (see **Lock files**);
  - the full `pnpm check:boundaries`;
  - the `terraform-invariants` self-test (Windows path length).
