Spec: docs/specs/2026-10-19-billing-read-only.md

# Read-only on non-payment, the billing banner and General Settings → Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Routes marked `write` refuse grant-holders with 402 while an organisation's billing state is `none` or `read_only`. The admin shows the billing banner, has Settings → General Settings → Billing with Checkout and the Portal, and hides write controls while writes are blocked. Nothing in AWS changes; staging stays parked.

**Architecture:** `GateRoute` carries the only copy of the `billing` marking, and the gate hands it to the handler. A shared `apps/api/src/billing-guard.ts` runs inside each module's `communityScope`: grant check first, then the billing read through `core/billing`'s new `assertWritable`. `core/entitlements` exports `listCheckoutPlans` for a new `POST /v1/billing/plans`. In `apps/admin`, one shared API client and one community context feed the banner, the new General Settings page and the two existing Settings pages. `packages/ui` gains an `Alert`.

Slug: billing-read-only
Status: approved (2026-10-19, Abdus)

## Who does what

| Actor                     | Writes repo commits                              | Runs `terraform apply` | Puts secret values, runs AWS one-offs | Applies or merges |
| ------------------------- | ------------------------------------------------ | ---------------------- | ------------------------------------- | ----------------- |
| Implementer (Antigravity) | Yes — Tasks 1–12, only the files each task names | Never                  | Never                                 | Never             |
| Reviewer (fresh Claude)   | Never                                            | Never                  | Never                                 | Never             |
| Human owner (Abdus)       | Never during the run                             | Not needed             | Not needed                            | Merges the PR     |
| Developer (Adnan)         | Never during the run                             | Never                  | Never                                 | Never             |

The owner approves this plan after the independent assistant's check (AGENTS.md §2, §4).

## Global constraints

- The spec is approved and no task edits it. Where this plan refines the spec, the refinement is listed in **Deviations from the spec** and repeated in the PR body.
- No agent runs `terraform`, `aws`, `docker push`, or a Stripe call with a real key. Implementer and reviewer runs start with no AWS credentials, no Stripe key, and pushes blocked.
- Staging stays parked. No task touches `infra/`, a Dockerfile, a workflow, `turbo.json`, a migration, or any `package.json` dependency list. No new dependency.
- No account id, hostname, email address, secret, Stripe object id or IP address in any commit. Tests use synthetic UUIDs, `example.test` addresses, and the synthetic Stripe ids the billing tests already use, split so secret scanners never match (`"sk_" + "test_synthetic"`).
- No amount appears anywhere: not in code, tests, contracts or admin copy.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Only one run at a time uses the Docker test database (`packages/db/test/docker-compose.yml`). `apps/api` integration tests run with `fileParallelism: false` (`apps/api/vitest.integration.config.ts`).
- `apps/api` tests run against the built workspace packages. After changing `modules/core/billing`, `modules/core/entitlements` or `packages/contracts`, run `pnpm --filter <package> build` before the `apps/api` tests.
- Integration tests share one database per run and never assume they own a table: they insert rows with fresh `token()` keys and assert on their own rows.
- Before the PR: `pnpm test --force`, then `pnpm gate`, both green. LF line endings only.
- Second fresh-context review is required (payments, tenancy). The owner starts it when the PR opens.
- A race or timing assertion never depends on sleeps; admin time windows use `vi.setSystemTime`. "Never reads billing" is proven by a spy on `assertWritable` (route and integration tests) or on the platform checkout inside `guardWrite` (unit test), never by timing. A role spy at route level proves nothing: `communityScope` already checks out `platform` for `findCommunityBySlug`.
- Permission mocks answer by the permission argument, never by call order, so a swapped permission makes the test fail.
- Every 402 assertion also checks the body is empty (`await res.text() === ""`).

**Task count and size.** Twelve tasks, about 1,800–2,200 changed lines (spec Out-of-band). AGENTS.md §3 suggests 3–10 tasks per chunk. The owner approved one pull request on 2026-10-19. Tasks are split so that none is far over ~300 lines and the admin work does not share a commit with the API guard.

**Migration wave:** none. No schema change.

**New dependency:** none. `apps/admin` does not depend on `@community-hub/contracts` today and does not gain it; the admin declares the narrow response types it reads (Task 8) and the contract tests in `apps/api` pin the server side.

## Deviations from the spec (repeated in the PR body)

1. **`assertWritable` throws.** Spec Contracts names `assertWritable(sql, organisationId, now)`. This plan makes it return the derived `BillingState` when writable and throw a new `BillingReadOnly` (carrying the state) when blocking, so a job that forgets to check the result still cannot write. The guard catches `BillingReadOnly` and answers 402.
2. **One shared guard file.** Spec R2 puts the guard "inside each module's `communityScope`". The three helpers call one function, `guardWrite`, in `apps/api/src/billing-guard.ts`, so the order (grant, then billing) exists once.
3. **Shared admin API client.** The duplicated `post` helpers (`users-roles.tsx:177-198`, `module-toggles.tsx:72-92`) move into `apps/admin/src/api.ts` in Task 8. Behaviour is unchanged; the banner and General Settings need the same helper.
4. **Permission name.** Spec test 6 says "a `member` without `access.manage`". No such permission exists; the access writes check `access.roles.manage` (`modules/core/access/domain/role.ts:30`). The tests use that name.
5. **Log field name.** Spec R7 says the log line carries "the route pattern". The logger's allow-list has no `pattern` key and drops unknown keys (`packages/observability/src/logger.ts:54-71`), so the field is `path`, holding the route pattern (never the request URL).
6. **`warning` alert without a new token.** The theme has no warning colour (`packages/ui/theme.css`). The warning variant uses existing tokens plus a visible "Warning:" label, so no token or checker change is needed.

## Security pins

Each row: the implementer weakens the source once as described, sees the named test fail, restores the source, and reports the failure output in its task report. A weakened tree is never committed.

| #   | Setting                                                                              | Test that pins it                                                                                               | Weakening that must make it fail                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A route without a valid `billing` marking stops the gate from building               | `apps/api/src/gate.test.ts` (Task 1)                                                                            | Delete the `billing` check from `assertRoutes`                                                                                                                      |
| 2   | Every production route has exactly the spec's marking, and the set is exact          | `apps/api/src/index.test.ts` marking case (Task 1; Task 4 adds `/plans`)                                        | Mark `/v1/entitlements/toggle` `read`; or add a route without adding it to the table                                                                                |
| 3   | The handler receives the marking from the gate, not from a literal                   | `gate.test.ts` context case (Task 1)                                                                            | Call `route.handle(request)` without the context                                                                                                                    |
| 4   | Writes stop in `none` and `read_only` only                                           | `modules/core/billing/domain/writable.test.ts` (Task 2)                                                         | Add `grace` to the blocking set; or remove `none`                                                                                                                   |
| 5   | A missing `billing_accounts` row is writable (`invoiced`)                            | `writable.test.ts` and `writable.integration.test.ts` (Task 2)                                                  | Treat a `null` account as `none` in `assertWritable`                                                                                                                |
| 6   | The billing read is filtered to the target organisation                              | `modules/core/billing/infrastructure/writable.integration.test.ts` (Task 2)                                     | Drop `where organisation_id = …` from `readAccount` (`accounts.ts:60-82`)                                                                                           |
| 7   | Plans without a lookup key are not offered                                           | `modules/core/entitlements/infrastructure/checkout-plans.integration.test.ts` (Task 3)                          | Drop the `stripe_lookup_key is not null` filter                                                                                                                     |
| 8   | `/v1/billing/plans` needs `billing.manage`                                           | `apps/api/src/billing-routes.test.ts` plans cases (Task 4)                                                      | Authorise the plans route with `billing.view`                                                                                                                       |
| 9   | `trialAvailable` is false once the organisation has trialled                         | `billing-routes.test.ts` plans cases (Task 4)                                                                   | Return `trial_eligible` without `trialDaysFor`                                                                                                                      |
| 10  | A caller without a grant never causes a billing read                                 | `apps/api/src/billing-guard.test.ts` (Task 5)                                                                   | Read billing state before `holdsAnyGrant`                                                                                                                           |
| 11  | A grant-holder in a blocking state gets 402, empty body, before the permission check | `billing-guard.test.ts`; `access-routes.test.ts` member case; `entitlement-routes.test.ts` member case (Task 5) | Return the scope instead of 402 when blocking; or move the guard after `authorise` in the toggle (fails the entitlement case); or return a JSON body with the state |
| 12  | A guard read failure is 503 and nothing is written                                   | `billing-guard.test.ts` failure cases (Task 5)                                                                  | Catch the billing read error and return the scope                                                                                                                   |
| 13  | The 402 log line reaches the real logger with only `path` and `organisationId`       | `billing-guard.test.ts` log case; `index.test.ts` logger case (Task 5)                                          | Add `userId` or the slug to the log fields; or name the field `pattern` (dropped by the allow-list); or wire `guardLog` to `shared.log`                             |
| 14  | Every `write` route is guarded in a real request through the gate                    | `apps/api/src/billing-guard.integration.test.ts` iterated case (Task 6)                                         | In one write handler, pass `{ billing: "read" }` instead of the gate's context                                                                                      |
| 15  | Cross-organisation: a grant-holder of B writing to A gets 403, never 402             | `billing-guard.integration.test.ts` two-org case, both orders (Task 6)                                          | In `guardWrite`, skip `holdsAnyGrant` and treat every caller as a grant-holder                                                                                      |
| 16  | The admin hides write controls in `none` and `read_only`                             | `users-roles.test.tsx`, `module-toggles.test.tsx` (Task 11)                                                     | Remove the blocking-state check from one page                                                                                                                       |
| 17  | Actions in the banner and General Settings need `canManage`                          | `billing-banner.test.tsx` (Task 9), `general-settings.test.tsx` (Task 10)                                       | Render the action regardless of `canManage`                                                                                                                         |
| 18  | An unknown `?billing=` value is ignored and never rendered                           | `billing-banner.test.tsx` (Task 9)                                                                              | Render the raw parameter value in the message                                                                                                                       |
| 19  | The plans response carries only `key` and `trialAvailable`                           | `billing-routes.test.ts` plans key check (Task 4)                                                               | Add an `amount` (or any other) field to the plans response                                                                                                          |

## Rollback

| Point        | Rollback                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Before merge | Revert commits on new commits.                                                                                                             |
| After merge  | Revert the merge. No schema, infrastructure or secret change to undo. No organisation is `self_serve` until the owner sets one (spec D12). |

## Stop and ask (AGENTS.md §12)

Implementer, stop and report if any of these happens:

- the plan or spec is wrong or ambiguous;
- a migration, Dockerfile, workflow, Terraform, `turbo.json`, `package.json` dependency or checker change is needed that this plan does not name;
- a test outside the named files needs changing (Task 1 names the existing test files it may touch, and only for the second `handle` argument and the `billing` field);
- a write route is found that does not call `communityScope`;
- the same step fails twice.

---

### Task 1: The `billing` marking on every route

**Files:**

- Modify: `apps/api/src/gate.ts`, `gate.test.ts`
- Modify: `apps/api/src/access-routes.ts`, `entitlement-routes.ts`, `auth-routes.ts`, `billing-routes.ts`, `billing-webhook.ts`, `index.ts` (the route literals only)
- Modify: `apps/api/src/index.test.ts`
- Modify, only to pass the route context as the second argument (`route.handle(req, { billing: route.billing, pattern: route.pattern })`, or a local `call(route, req)` helper) and to add `billing` to fake `GateRoute` literals: `gate.test.ts`, `access-routes.test.ts`, `auth-routes.test.ts`, `billing-routes.test.ts`, `billing-webhook.test.ts`, `entitlement-routes.test.ts`, `server.test.ts`, `billing-flow.integration.test.ts`, `entitlement-flow.integration.test.ts` (all in `apps/api/src`). No assertion changes. About 80 call sites.

**Shape:**

- `gate.ts:5-11`: `export type BillingMarking = "write" | "read" | "exempt"`; `GateRoute` gains required `billing: BillingMarking`; `handle(request: Request, context: RouteContext)` where `RouteContext = { readonly billing: BillingMarking; readonly pattern: string }`.
- `assertRoutes` (`gate.ts:49`) throws `RoutesRejected` for a missing or unknown `billing`, the same way it rejects a bad `surface`.
- `gate.ts:141`: `route.handle(request, { billing: route.billing, pattern: route.pattern })`.
- Each route literal gets the marking from spec Behaviour → Route marking. Handlers do not declare the context parameter until Task 5 (no unused argument for lint).

**Test first (RED):**

- `gate.test.ts`: `assertRoutes` rejects a route with no `billing` and with `billing: "maybe"`; `createGate` throws on such a list; a matched route's `handle` receives `{ billing, pattern }` equal to its own marking and pattern (pin 3).
- `index.test.ts`: build `productionRoutes` and map `METHOD pattern` → `billing`. Assert the map **equals** a literal table of the 21 routes and markings in the spec (pin 2). The table is written in the test, not derived from the routes.

**Rule this must not break:** no route changes behaviour in this task.

**Commit subject:** `feat(api): mark every route read, write or exempt for billing`

- [ ] RED, GREEN.
- [ ] Security pins 1, 2, 3.
- [ ] `pnpm gate`.

### Task 2: `isWritable` and `assertWritable` in `core/billing`

**Files:**

- Create: `modules/core/billing/domain/writable.ts`, `writable.test.ts`
- Create: `modules/core/billing/infrastructure/writable.ts`, `writable.integration.test.ts`
- Modify: `modules/core/billing/public/index.ts`

**Shape:**

- Domain: `isWritable(state: BillingState): boolean`, false only for `none` and `read_only` (`state.ts:3`). `class BillingReadOnly extends Error { readonly state }`.
- Infrastructure: `assertWritable(sql, organisationId: string, now: Date): Promise<BillingState>`: `readAccount` (`accounts.ts:60-63`), `deriveState` (`state.ts:14`), throw `BillingReadOnly` when not writable, else return the state. No cache. Runs on the `platform` role's connection, which the caller supplies.

**Test first (RED):**

- `writable.test.ts`: every `BillingState` value, by name.
- `writable.integration.test.ts`, on the Docker database: three organisations' `billing_accounts` rows inserted in the order (ok, read_only, retrying); `assertWritable` for the middle one throws `BillingReadOnly`, for the others returns their state; a fourth organisation with no row returns `invoiced`; the `grace_until` boundary (equal to `now` throws, one millisecond before does not) (pins 4–6).

**Rule this must not break:** rule 2 (the platform read is organisation-filtered); ADR 0014 decision 7.

**Commit subject:** `feat(billing): decide whether an organisation can write`

- [ ] RED, GREEN; `pnpm --filter @community-hub/billing build`.
- [ ] Security pins 4, 5, 6.
- [ ] `pnpm gate`.

### Task 3: `listCheckoutPlans` in `core/entitlements`

**Files:**

- Create: `modules/core/entitlements/infrastructure/checkout-plans.ts`, `checkout-plans.integration.test.ts`
- Modify: `modules/core/entitlements/public/index.ts`

**Shape:** `listCheckoutPlans(sql): Promise<readonly { key: string; trialEligible: boolean }[]>`, from `platform.plans` where `stripe_lookup_key is not null`, ordered by `key`. Model on `planBilling` (`plan-billing.ts:72-92`).

**Test first (RED):** on the Docker database, insert three plans with fresh `token()` keys and lookup keys (two with a lookup key, inserted in reverse key order; one without). Other tests' plans share the table, so assert: (a) the result filtered to this test's three keys equals the two, in key order, with the right `trialEligible`; (b) the whole result is sorted by key; (c) the third key is absent (pin 7).

**Rule this must not break:** ADR 0012 (only `core/entitlements` queries `platform.plans`).

**Commit subject:** `feat(entitlements): list the plans that can be bought`

- [ ] RED, GREEN; `pnpm --filter @community-hub/entitlements build`.
- [ ] Security pin 7.
- [ ] `pnpm gate`.

### Task 4: `POST /v1/billing/plans`

**Files:**

- Modify: `packages/contracts/src/billing.ts` (`plansBody`, `plansResponse`), and its test if one exists beside it
- Modify: `apps/api/src/billing-routes.ts`, `billing-routes.test.ts`, `index.test.ts` (add the route to the Task 1 table, marked `exempt`)

**Shape:** `plansBody` = strict `{ communitySlug }`. `plansResponse` = `{ plans: { key: string, trialAvailable: boolean }[] }`, no other field. Handler order as Checkout (`billing-routes.ts:153-173`): foreign host 404, body 400, session 401, `communityScope` 403, `authorise` with `billing.manage` (403 plus audit), then `listCheckoutPlans`, `currentSettings` and `readAccount(scope.orgId)` on `platform`. `trialAvailable = trialDaysFor({ trialEligible }, account, settings) !== undefined` (`domain/trial.ts:11-15` returns `number | undefined`). If `currentSettings` returns `null`, every plan has `trialAvailable: false`; the route does not 503 (Checkout already does, `billing-routes.ts:191-194`). `surface: "tenant"`, `billing: "exempt"`.

**Test first (RED):** `billing-routes.test.ts`, with the `holdsPermission` mock answering by permission argument (the view-only caller is `bundle("org_auditor")`, so it answers true only for `billing.view`), never `mockResolvedValueOnce`:

- `billing.manage` gets the list; a `billing.view`-only caller gets 403 and one audit append; a stranger 403 (pin 8);
- a trial-eligible plan reads `trialAvailable: false` when `trial_used_at` is set and true when it is not; with `currentSettings` null every plan reads false (pin 9);
- `readAccount` is called with the organisation id `findCommunityBySlug` returned, and a second organisation's account (`trial_used_at` set) does not change the first's `trialAvailable`;
- the response parses with `plansResponse` and each plan's keys are exactly `key` and `trialAvailable` (pin 19).

**Rule this must not break:** rule 5; no amount.

**Commit subject:** `feat(api): list the plans an organisation can choose`

- [ ] RED, GREEN; `pnpm --filter @community-hub/contracts build`.
- [ ] Security pins 8, 9.
- [ ] `pnpm gate`.

### Task 5: The write guard

**Files:**

- Create: `apps/api/src/billing-guard.ts`, `billing-guard.test.ts`
- Modify: `apps/api/src/access-routes.ts`, `entitlement-routes.ts`, `billing-routes.ts` (`communityScope` and its call sites)
- Modify: `apps/api/src/access-routes.test.ts`, `entitlement-routes.test.ts`, `billing-routes.test.ts`, `auth-routes.test.ts`
- Modify: `apps/api/src/index.ts` (wire `guardLog`), `index.test.ts`

**Shape:**

- `guardWrite(deps, scope, userId, context): Promise<Response | null>`. Returns `null` (go on) or a `Response`. The route pattern comes from `context.pattern` (Task 1), never from a string at the call site.
  1. `context.billing !== "write"` → `null`, no read.
  2. `withAppTransaction` on `checkout("app")`, `holdsAnyGrant(tx, userId)`. False → `null`.
  3. `checkout("platform")`, `assertWritable(sql, scope.orgId, deps.now())`. Returns → `null`. Throws `BillingReadOnly` → `deps.guardLog("billing_write_blocked", { path: context.pattern, organisationId })`, return `new Response(null, { status: 402 })`.
  - `guardLog` is a new dependency typed with `BillingLogFields` (`index.ts:109-124`). That `Pick<LogFields, …>` does not include `"path"` today; this task adds `| "path"` to it so the call typechecks (`path` is already on the logger's allow-list, `packages/observability/src/logger.ts:56`). `guardLog` is wired in `bindServices` to the real `logger.info` for both `access` and `entitlements`. Their existing `log: shared.log` is a no-op (`index.ts:256`, `:266`) and stays as it is.
  4. Any other error in steps 2–3 → `new Response(null, { status: 503 })`.
- Each `communityScope(slug)` becomes `communityScope(slug, context, userId)` returning `Scope | Response | null`, and passes `context` (with its `pattern`) straight to `guardWrite`; call sites return the `Response` as-is. A handler's `context` is the one the gate passed (Task 1); no handler writes a literal marking.

**Test first (RED):**

- `billing-guard.test.ts` with fake checkout and a spy on the roles used:
  - `read` and `exempt`: no checkout call at all;
  - no grant: `null`, and the platform role is never checked out (pin 10);
  - grant plus each state: 402 for `none` and `read_only`, `null` for the rest (pin 11);
  - `holdsAnyGrant` throws → 503; billing read throws → 503 (pin 12);
  - the 402 log fields are exactly `path` and `organisationId`, and the body is empty (pins 11, 13).
- `index.test.ts`: a 402 from an access write route, through `bindServices` with a capturing logger, writes one `billing_write_blocked` line with exactly `path` and `organisationId`, and `getDroppedFieldCount() === 0` (pin 13).
- `access-routes.test.ts`: a `member` without `access.roles.manage` gets 402 (empty body) on `POST /v1/access/grants` in `read_only` and 403 in `ok`; `grants/list` answers 200 in `read_only`, and also when `assertWritable` rejects (spec test 8).
- `entitlement-routes.test.ts`: a member without `entitlements.manage` gets 402 on toggle in `read_only`, and 403 plus one audit row in `ok` (pin 11, the `authorise` weakening); list normal.
- `billing-routes.test.ts`: with `assertWritable` mocked in the `@community-hub/billing` mock, status, portal, checkout and plans never call it in `read_only`.
- `auth-routes.test.ts`: `/v1/auth/session/refresh` answers normally and `assertWritable` is not called (spec test 7).

**Rule this must not break:** rule 2; spec R3, R6, R7.

**Commit subject:** `feat(api): refuse writes while an organisation is read-only`

- [ ] RED, GREEN.
- [ ] Security pins 10–13.
- [ ] `pnpm gate`.

### Task 6: The guard against a real database

**Files:**

- Create: `apps/api/src/billing-guard.integration.test.ts`

**Shape:** follows `access-flow.integration.test.ts` (`:150-170`): routes from `accessRoutes` and `entitlementRoutes` bound to the Docker `checkout`, served through `startServer`, so the **gate** supplies the context, never the test. Two organisations A and B, a community each, a grant-holder in each, `billing_accounts` rows set directly on the `platform` role. The set of `write` keys from those factories must equal the `write` keys of `productionRoutes` (built as in `index.test.ts`).

**Test first (RED, against Task 5's code with one weakening applied; GREEN once restored):**

- **Iterated:** a fixture map from `METHOD pattern` to a well-formed body, for every route `productionRoutes` marks `write`. The test first asserts the map's keys equal that set (so a new write route fails here until it has a fixture). Each fixture is proven able to write: on a fresh setup with A `ok`, it answers 2xx and changes its row count (the toggle fixture uses an allocated key). Then, on a fresh setup with A `read_only`, each answers 402 with an empty body and the row counts are unchanged: grants, custom roles and user links in `app`, community toggles in `platform` (pin 14; spec test 3a).
- **Two orgs, both orders:** (i) A `read_only`, B `ok`; (ii) A `ok`, B `read_only`. In each, a grant-holder writes in the `ok` one (2xx) and is refused in the blocking one (402); a grant-holder of one organisation writing to the other's community gets 403 (pin 15; spec test 5).
- A stranger in `read_only` gets the same status, the same (empty) body and the same audit row count as in `ok`, and `assertWritable` is never called (spy on a wrapped `guardWrite` dependency) (spec test 4).

**Rule this must not break:** rule 2.

**Commit subject:** `test(api): prove the write guard per route and per organisation`

- [ ] RED (by weakening), GREEN.
- [ ] Security pins 14, 15.
- [ ] `pnpm gate`.

### Task 7: `Alert` in `packages/ui`

**Files:**

- Create: `packages/ui/src/alert.tsx`, `alert.a11y.test.tsx`
- Modify: `packages/ui/src/index.ts`

**Shape:** copy shadcn's `alert` with the pinned CLI (`pnpm --filter @community-hub/ui shadcn add alert`, per `packages/ui/README.md`), keeping the THIRD_PARTY_NOTICES header that `button.tsx:1` carries. Variants `default` and `destructive` (shadcn's), plus `warning` built only from existing theme tokens with a visible "Warning:" label (Deviation 6). A `live` prop: `"polite"` renders `role="status"`, `"assertive"` renders `role="alert"`. No token, `theme.css` or checker change. If the CLI needs network access or changes any file other than `alert.tsx`, stop and report.

**Test first (RED):** axe on each variant passes as in `button.a11y.test.tsx`; the role follows `live`; the warning variant shows its label.

**Rule this must not break:** D16 (WCAG 2.2 AA); no third catalogue.

**Commit subject:** `feat(ui): add an alert`

- [ ] RED, GREEN.
- [ ] `pnpm gate`.

### Task 8: Shared API client and the shell community picker

**Files:**

- Create: `apps/admin/src/api.ts`, `api.test.ts`, `community.tsx`, `community.test.tsx`
- Modify: `apps/admin/src/shell.tsx`, `shell.test.tsx`, `users-roles.tsx`, `users-roles.test.tsx`, `module-toggles.tsx`, `module-toggles.test.tsx`

**Shape:**

- `api.ts`: `post(path, body)` moved from `users-roles.tsx:177-198` unchanged in behaviour (Bearer header, token cleared on 401), plus the narrow response types the admin reads for billing status and plans.
- `community.tsx`: a React context `{ slug, setSlug }`, initial value read from `sessionStorage` key `community-hub.community` (try/catch; a failure means no slug), written on change. The picker is one labelled text field and a button in `AdminLayout` (`shell.tsx:30-39`).
- `users-roles.tsx` and `module-toggles.tsx` drop their own slug forms (`users-roles.tsx:270-286`, `module-toggles.tsx:154-168`) and load from the context when it changes.

**Test first (RED):** `community.test.tsx`: the slug survives a route change and a remount within the same `sessionStorage`; a throwing `sessionStorage` leaves no slug and no crash. The two page tests: the page loads from the context slug with no slug field of its own. `api.test.ts`: the 401 behaviour. Axe on the shell with the picker.

**Rule this must not break:** rule 5 (the slug is not personal data and is never put in a URL).

**Commit subject:** `feat(admin): choose the community once for the whole shell`

- [ ] RED, GREEN.
- [ ] `pnpm gate`.

### Task 9: The billing banner and the return from Stripe

**Files:**

- Create: `apps/admin/src/billing-status.tsx` (context and fetch), `billing-banner.tsx`, `billing-banner.test.tsx`
- Modify: `apps/admin/src/shell.tsx`

**Shape:**

- `billing-status.tsx`: on slug change, one `POST /v1/billing/status`; exposes `{ status, refresh }`. 403 or failure → `status` is `null`.
- `billing-banner.tsx`: spec Behaviour → Billing banner, row by row, including `grace_until` present or absent for `read_only`, the 7-day trial window, and "Ask an organisation owner or billing contact" without `canManage`. Uses `Alert`. "Choose a plan" links to `/settings/general`; Portal actions `POST /v1/billing/portal` and assign `window.location` to the returned URL.
- Return handling in the shell: read `?billing=` once on load; `done`, `cancelled`, `portal` per spec; anything else ignored; then `history.replaceState` without the parameter. `done` calls `refresh` once after 5 seconds (fake timers in tests).

**Test first (RED):** one case per banner row, with `canManage` true and false (pin 17); with `vi.setSystemTime`, trial at 8 days absent, at 7 present; `role="alert"` only on first appearance in `read_only`, `role="status"` otherwise; navigating between routes makes no further status call and a community change makes exactly one; no community chosen, no banner; `read_only` with and without `grace_until`; `?billing=done|cancelled|portal` on `/` and on `/settings/users`; `?billing=<script>` renders nothing from the value (pin 18); the parameter is removed; axe per state.

**Rule this must not break:** D16; AGENTS.md §6 (no control that only 403s).

**Commit subject:** `feat(admin): show the billing banner`

- [ ] RED, GREEN.
- [ ] Security pins 17 (banner), 18.
- [ ] `pnpm gate`.

### Task 10: Settings → General Settings → Billing

**Files:**

- Create: `apps/admin/src/general-settings.tsx`, `general-settings.test.tsx`
- Modify: `apps/admin/src/shell.tsx` (route `settings/general`), `nav.tsx` (link under Settings, before Users & Roles), `labels.ts` (`planLabels` map, separate from the frozen `labels`), `shell.test.tsx` (nav order)

**Shape:** spec Behaviour → General Settings → Billing, every bullet, including the four 409 cases, 422 and 503 copy, `trialAvailable` copy, and `planLabels[key] ?? key`. Checkout `POST /v1/billing/checkout` and assign `window.location`.

**Test first (RED):** per permission (manage, view, neither, `invoiced`); plan list only in `none` and `read_only` without `grace_until`; Checkout 409 in `none` offers the Portal; Checkout 409 in ended `read_only` shows "Contact support"; Portal 409 hides the button and refreshes; 422 and 503 copy; unknown plan key shows the key; no raw error text (pin 17); a status network failure or 5xx shows "Billing status unavailable"; the page reads the community from the shell context (spec test 16); axe.

**Rule this must not break:** D16; frozen nav order (`docs/roadmap.md` Admin navigation).

**Commit subject:** `feat(admin): add General Settings with billing`

- [ ] RED, GREEN.
- [ ] Security pin 17 (page).
- [ ] `pnpm gate`.

### Task 11: Hide write controls while writes are blocked

**Files:**

- Modify: `apps/admin/src/users-roles.tsx`, `users-roles.test.tsx`, `module-toggles.tsx`, `module-toggles.test.tsx`

**Shape:** when the billing state is `none` or `read_only`, hide the custom-role form, grant form, link form, unlink button, the in-list grant and revoke buttons (`users-roles.tsx:300-336`, `:361-458`) and the toggle switch (`module-toggles.tsx:181-186`); show `Alert` "Read-only until billing is settled" linking to `/settings/general`. A write that answers 402 shows the same message and calls `refresh`.

**Test first (RED):** in `none` and `read_only` no write control is in the document and the message is; in `grace` the controls show; a 402 from a mutation shows the message and triggers one status call (pin 16).

**Rule this must not break:** AGENTS.md §6 (no control that can only 402 or 403).

**Commit subject:** `feat(admin): hide write controls while billing blocks writes`

- [ ] RED, GREEN.
- [ ] Security pin 16.
- [ ] `pnpm gate`.

### Task 12: Architecture and catalogue (last task on this branch)

**Files:**

- Modify: `architecture.md` (line 657: writes also stop in `none`, a `self_serve` organisation before Checkout completes; the gate carries the marking), `docs/roadmap.md` (`billing-read-only` **done** with the spec path; snapshot: last shipped `billing-read-only`, next `stripe-billing-proof`; Q8b line unchanged)

**Test first:** none (docs). `pnpm gate` (format).

**Commit subject:** `docs(roadmap): mark billing-read-only done`

- [ ] `rm -f docs/plans/*-report.md`; `git status --short` shows nothing from `.superpowers/`, and nothing outside this task's files is staged. The untracked `docs/Starting prompt for Claude Code … .md` is never committed.
- [ ] `pnpm test --force`, then `pnpm gate`.

## Definition of done (AGENTS.md §8)

- All twelve tasks committed, each reviewed by diff with its security pins reported.
- `pnpm test --force` and `pnpm gate` green; CI green on the PR.
- The tenant-isolation tests in Tasks 2, 5 and 6 are green.
- Staging parked; no file under `infra/` changed.
- `architecture.md` and the roadmap updated in this PR, the roadmap last.
- Staging verification deferred to `stripe-billing-proof` (owner, 2026-10-19), stated in the PR body.
- The PR body lists the implementer and reviewer configurations, the owner's check, the second-review line, and **Deviations from the spec**.
- No `docs/plans/*-report.md` on disk, and nothing under `.superpowers/` staged.

## Probe record

No Terraform in this chunk; no probe needed (AGENTS.md §4 Phase 2).
