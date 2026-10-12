# Spec: Plans and entitlements

Slug: entitlements-plans
Status: draft
Architecture refs: §6.3, §8.1, §10.1, §10.2, §10.3, §10.4, §11.3, §12.1, §26 Q8, Q12, Q14, Q15. Implements the `entitlements-plans` row. Depends on `tenancy-implicit-org`, `people-households`, `access-roles`, and `admin-shell`, all on `main`. Staging stays parked.

## Problem

A community cannot tell which capabilities its organisation may use, or switch an allocated capability off. Architecture already stores plans, add-ons, entitlements, allocations, overrides, and feature flags in the `platform` schema, and it already names the five-step check. Q14 is still open: how a request sees those rows, and how stale a cached answer may be. The admin shell still shows Dashboard and Users & Roles with no toggle screen. Q8, plan contents and pricing, is still a product decision and is not answered here.

## Scope

**In**

- `modules/core/entitlements`, package `@community-hub/entitlements`. `pnpm-workspace.yaml` gains the line `modules/core/entitlements`. No other workspace glob.
- `packages/entitlements`, package `@community-hub/entitlements-eval`. The package name is not `@community-hub/entitlements`, because that name is the module. It has no runtime dependency. It does not import `@community-hub/db`, `@community-hub/tenancy`, `@community-hub/access`, `@community-hub/people`, `@community-hub/identity`, or `@community-hub/crypto`.
- `module.manifest.ts` calls `defineModule` with `key` `core.entitlements`, `version` 1, `requires: ["core.tenancy"]`, empty `publishes`, `subscribes`, `ports`, and `features`. No `entitlement`. No `website`. `permissions` is `entitlements.view` and `entitlements.manage`, in that order. `dataClasses` lists every column in [Data](#data) as `internal`.
- `modules/core/people/module.manifest.ts` gains `features: ["people.directory", "people.households", "people.custom_fields"]`, in that order. No other field on that manifest changes. The module still has no `entitlement` and no `website`.
- `packages/policy` appends `entitlements.view` and `entitlements.manage` to `catalogue()`, after `people.restricted.read`. `org_owner`, `org_admin`, and `community_admin` keep the whole catalogue, so they hold both. `org_billing`, `org_auditor`, and `staff` each gain `entitlements.view` and do not gain `entitlements.manage`. `finance`, `safeguarding_officer`, `volunteer_coordinator`, `content_editor`, and `member` gain neither. A guardian check still grants only `people.restricted.read`. It does not grant either entitlements permission.
- `modules/core/access` exports `holdsPermission(tx, userId, permission)`. It reads that user's grants in the current transaction and calls `decide` with `guardianView: false` and `personScoped: false`. It does not write and it does not append an audit event. The access routes keep their own directory query.
- `modules/core/tenancy` exports `listCommunityIds(sql, organisationId)`. It returns the community ids of that organisation, or an empty list. It does not return slugs. It takes `sql: Sql` from `postgres` as the first argument. The caller passes a connection that is already the `platform` login. It does not call `set_config`.
- Tables in the `platform` schema, contributed from `modules/core/entitlements/db/schema.ts` as `entitlementTables(platform)`. That function does not call `pgSchema`. `packages/db` keeps the only product journal. `packages/db/drizzle.schema.ts` imports `platform` from `packages/db/src/namespaces.ts` and calls `entitlementTables`. `packages/db/src` does not import `@community-hub/entitlements`.
- One new product journal entry after `0007_fast_gorilla_man`. Drizzle Kit generates it. No hand-added row level security. The migration is additive. It does not drop, and it does not alter `platform.organisations`, `platform.communities`, an `app` table, or an `identity` table. It inserts no plan, no add-on, and no entitlement key.
- Ids on `platform.plans`, `platform.add_ons`, `platform.entitlement_overrides`, and `platform.feature_flags` are minted with `newId()` from `@community-hub/db`. The SQL has no `DEFAULT` for `id`. The other tables have no `id` column.
- No new table has a column named `org_id`. None enables row level security or `FORCE ROW LEVEL SECURITY`. None has a policy. `schema-rls` is not changed. It still checks `app` tables only.
- Grants stay the default privileges from `0000_schemas.sql`. The `platform` login receives select, insert, update, and delete. This migration does not grant these tables to `app`, `identity`, or `PUBLIC`.
- Foreign keys stay inside `platform`. They use `ON DELETE RESTRICT`. There is no foreign key to `app` or `identity`.
- The write functions take `sql: Sql` from `postgres` first. The caller passes a connection that is already the `platform` login. They do not open a connection, do not call `set_config`, and do not set `app.org_id` or `app.community_id`.
- Domain code under `modules/core/entitlements/domain/` and under `packages/entitlements` imports no framework, no Drizzle, and no `@community-hub/crypto`.
- `packages/entitlements-eval` decides availability from a snapshot the entitlements module loaded. The module reads its own tables and `platform.communities` only through `listCommunityIds`. It does not read `app` or `identity`.
- `readSnapshot` is the Q14 read path. It is specified under Behaviour. The cache bound is 60 seconds.
- Routes on the regional service, in `apps/api/src/entitlement-routes.ts`, surface `tenant`. The presented hostname must be the API hostname. The auth, webhooks, and ops hostnames answer 404 for these paths. `GET /health` is unchanged.
- The admin shell keeps the frozen sixteen labels. Settings gains one child after Users & Roles: Module Toggles. Top-level labels other than Dashboard and Settings stay absent. The shell calls `visibleLabels`. The production map is empty, so no Phase 2 label is linked.
- `@community-hub/contracts` gains the export `./entitlements`. The `.` export stays `auth.js`. The `./access` export stays.
- The catalogue commit updates `docs/roadmap.md`, the repository-state sentence in `AGENTS.md`, `architecture.md` at the sentences named under [Catalogue](#catalogue), and adds `docs/adr/0012-entitlement-visibility.md`.
- Q14 is closed by this spec once it is approved. The decision is the read path and the 60-second bound in Behaviour. ADR 0012 records it. §6.3 is updated so `core/entitlements` may query the `platform` schema. `core/tenancy` still may. No other module may.

**Out**

- Prices, currencies, Stripe products, Stripe customers, and webhook handling. Q8 stays open. `stripe-billing` is the next row. This chunk does not insert the §10.2 example catalogue.
- An upgrade prompt. There is no price to show. A capability that fails a step is absent. It is not a disabled control.
- Hard usage counters. `limit()` returns the number stored on a plan or add-on row, or `null`. It does not increment anything. Q15 stays open.
- Operator screens, passkeys, and the `platform` role's relationship to `app`. `ops-console` is later. `upsertPlan`, `upsertAddOn`, `assignPlan`, `allocate`, `grantOverride`, and `setFeatureFlag` have no HTTP route.
- A nav link to Enquires, Engagement, Contacts & Members, Family Records, Membership, Records, Certifications, Volunteers, Forms, Communication, Mobile App, Website & CMS, Donations, or E-commerce. Those pages do not exist. Phase 2 and later chunks add a map entry when they add the page.
- General Settings and Email Settings. Q9 stays open.
- A feature-flag vendor. Q12 stays closed as it already is.
- A new CI checker. The migration inserts no keys. A test fails if that SQL contains `insert`.
- Unparking staging. `enable_database` stays false, `desired_count` stays 0, and no committed var file gains `service_image`. No Terraform change.
- A new dependency and a new subprocessor.
- Editing `docs/specs/2026-10-12-access-roles.md` or `docs/specs/2026-10-11-people-households.md`. Those specs stay as shipped. This spec is the change.

## Behaviour

`now` is an argument on `readSnapshot`, `evaluate`, and `grantOverride`. Those functions do not read the clock, except `newId()`.

A write that fails throws `EntitlementError` and writes nothing. `EntitlementError` extends `Error`. Its discriminating property is `code`.

### Keys

An entitlement key matches `^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$` and is at most 64 characters. `people.directory` matches. `starter` does not. A plan key and an add-on key match `^[a-z][a-z0-9_]{1,31}$`. `starter` matches. `people.directory` does not. Anything else is `invalid_key` before a write.

### Evaluation

`evaluate(snapshot, key, now)` returns `{ ok: true }` or `{ ok: false, step }`. The steps are tried in this order. The first failure is the result.

1. `flag`. A feature-flag row matches when its key equals this key, and each target that is not null equals the snapshot: `organisation_id`, `community_id`, `plan_key`, `region`. A null target matches any value. `region` in this snapshot is `au`. Step 1 fails when any matching row has `enabled` false. No matching row passes.
2. `entitlement`. The organisation's plan includes the key, or an assigned add-on includes the key, or an override for that organisation and key has `expires_at` greater than `now`. An expired override does not count. A missing plan fails this step unless an add-on or an unexpired override includes the key.
3. `allocation`. `community_allocations` has this community and this key.
4. `toggle`. There is no toggle row, or the toggle row has `enabled` true. A missing row means on.

Permission is not a step of `evaluate`. The route checks it separately.

`limit(snapshot, key)` returns the plan row's `limit_value` when the plan includes the key, including when that value is null. Otherwise it returns the smallest non-null `limit_value` among assigned add-ons that include the key, or `null` when none of those rows set a limit. An override does not change the limit.

### Cache

`readSnapshot(sql, { organisationId, communityId, now })` loads the rows for that pair from the `platform` schema. It keeps the snapshot in the process, keyed by the two ids. A stored snapshot whose `loadedAt` is less than 60 seconds before `now` is returned without a query. A stored snapshot whose `loadedAt` is 60 seconds or more before `now` is loaded again. `loadedAt` is the `now` of the load, not a clock read inside the cache.

A write deletes the cache entries it can affect before it returns. `upsertPlan`, `upsertAddOn`, and a feature flag whose `organisation_id` is null delete the whole process cache. `assignPlan`, `grantOverride`, and a feature flag for one organisation delete every community of that organisation. `setToggle` and `allocate` delete that one organisation and community. A write in another process is visible here only after that process's snapshot reaches 60 seconds. There is no snapshot table and no propagation job.

The cached value holds ids, keys, booleans, limits, and timestamps. It holds no name, no email, and no phone.

### Plans and allocations

`upsertPlan(sql, { key, entitlements })` inserts the plan or replaces its `plan_entitlements` rows. `entitlements` entries are `{ key, limit }`. `limit` is `null` or an integer greater than or equal to 0. A negative limit is `invalid_limit`. Replacing the rows does not rewrite `organisation_plans` or `community_allocations`.

`upsertAddOn(sql, { key, entitlements })` does the same for one add-on.

`assignPlan(sql, { organisationId, planKey })` requires the organisation and the plan. Otherwise `not_found`, and it writes nothing. The organisation has one plan row after the call. For each community returned by `listCommunityIds`, the allocation rows become the keys on that plan, the keys on the organisation's add-ons, and the keys on that organisation's overrides whose `expires_at` is still in the future at `now`. `assignPlan` takes `now`. It deletes allocation rows for those communities that are not in that set. It does not delete toggle rows. It does not write an `app` table.

`allocate(sql, { communityId, key })` inserts one allocation row. A duplicate is `duplicate_allocation` and writes nothing. The community must exist. Otherwise `not_found`.

`grantOverride(sql, { organisationId, key, expiresAt, now })` inserts or replaces the one override row for that organisation and key. `expiresAt` must be greater than `now`. Otherwise `invalid_expiry`, and it writes nothing.

`setFeatureFlag(sql, input)` inserts or replaces the one flag row with that key and those four targets. Targets may be null. `region`, when set, is `au`. Anything else is `invalid_key` for a bad entitlement key, or `invalid_region` for a bad region. `enabled` is a boolean.

None of these six functions has an HTTP route. None of them appends `app.audit_events`. `stripe-billing` and `ops-console` are the later callers, and those chunks append the audit when they add a route.

### Community toggle

`setToggle(sql, { organisationId, communityId, key, enabled, now })` loads a fresh snapshot for that pair, bypassing the cache, then runs `evaluate` as if the toggle step passed. If step 1, 2, or 3 would fail, it throws `not_allocated` and writes nothing. If the stored toggle already matches `enabled`, including a missing row when `enabled` is true, it returns `unchanged` and writes nothing. Otherwise it inserts or updates the toggle row and returns `changed`. A missing row remains the way to store on. `enabled: true` deletes the toggle row. `enabled: false` stores `enabled` false.

### Routes

Both routes are `POST`, surface `tenant`. The body is JSON. A missing bearer, an unknown session, or a session that fails `readSession` is 401. The community slug is resolved with `findCommunityBySlug`. An unknown slug is 404. The route does not read an organisation id or a community id from the body.

The route calls `holdsPermission` for the permission in the table. When that is false it appends `entitlements.permission.denied` and returns 403 with an empty body. The list purpose is `entitlements.toggles.view`. The toggle purpose is `entitlements.toggles.manage`. Targets are the organisation id, then the community id.

| Route                          | Permission            | Body                              | Success                                   |
| ------------------------------ | --------------------- | --------------------------------- | ----------------------------------------- |
| `POST /v1/entitlements/list`   | `entitlements.view`   | `{ communitySlug }`               | `{ keys: [{ key, enabled }], canManage }` |
| `POST /v1/entitlements/toggle` | `entitlements.manage` | `{ communitySlug, key, enabled }` | empty 200                                 |

`keys` contains only keys that pass steps 1, 2, and 3. `enabled` is the toggle step: true when the row is missing or `enabled` is true. The order is the sorted key order. A key that fails step 1, 2, or 3 is absent. `canManage` is the result of `holdsPermission` for `entitlements.manage`.

Toggle calls `setToggle`. `unchanged` is 200 and appends no audit event. `changed` appends `entitlements.toggle.changed`, purpose `entitlements.toggles.manage`, targets the organisation id then the community id, and then returns 200. The audit row has no field for the entitlement key. The key stays on `platform.community_toggles` only.

The platform write and the audit append are two transactions. The route writes the toggle first. If the audit append throws, the route calls `setToggle` again with the previous `enabled` value and returns 500. If that restore also throws, the route still returns 500. The log line is the path, the status, and the request id. It does not include a body, a token, a slug, a key, or an id.

`not_allocated` and `invalid_key` are 400 with an empty body. Logs for these routes use the existing request log and the same three fields.

### Admin

The frozen label list stays the sixteen strings it already is. The sidebar still has accessible name `Admin`. Dashboard remains a link to `/`. Settings is text, not a link. Its children, in order, are `Users & Roles` to `/settings/users` and `Module Toggles` to `/settings/modules`. The other fourteen top-level labels stay absent from the document. General Settings and Email Settings stay absent. There is no Website control, no community switcher, and no person name. Dashboard's heading and Refresh button stay. Refresh still reloads and does not call `fetch`.

`visibleLabels(labels, entitledKeys, map)` returns Dashboard and Settings always. It returns a mapped label only when `map` gives that label a key and `entitledKeys` contains that key. Users & Roles and Module Toggles are not in that map. The shell always renders both children. The production map is empty. A test map `{ "Contacts & Members": "people.directory" }` includes that label only when `people.directory` is in `entitledKeys`. The shell uses the production map, so Contacts & Members stays absent.

`/settings/modules` is a route. It uses the same `VITE_API_ORIGIN`, `VITE_AUTH_ORIGIN`, and `sessionStorage` key as Users & Roles. When either origin is missing, the page shows `Directory unavailable` and does not call `fetch`. With no token, the page shows `Sign in required` and a link `Sign in` to `/sign-in`, and it does not call `fetch`.

The page heading is `Module Toggles`. With a token, it shows a field named `Community`, a button `Load`, and no list until Load succeeds. Load `POST`s `{ communitySlug }` to `{VITE_API_ORIGIN}/v1/entitlements/list`. An empty `keys` array shows `No modules are allocated.` Each returned key is a switch whose accessible name is that key. The switch is absent unless `canManage` is true. A missing `canManage` hides every switch. Turning a switch `POST`s `{ communitySlug, key, enabled }` to `{VITE_API_ORIGIN}/v1/entitlements/toggle`. A 403 shows `You cannot manage modules`. A 400 shows `That change was rejected`. A network failure shows `Directory unavailable`. The page never renders a name, an email, a phone, a price, or the words upgrade. It does not render a switch for a key the list did not return.

## Data

No personal data. No minor fields. No encrypted column. No blind index. Classification of every column is `internal`. SQL may filter these columns. None is encrypted.

| Table                            | Column            | Notes                                                                            |
| -------------------------------- | ----------------- | -------------------------------------------------------------------------------- |
| `platform.plans`                 | `id`              | UUIDv7 primary key.                                                              |
| `platform.plans`                 | `key`             | Unique. Plan-key check.                                                          |
| `platform.plan_entitlements`     | `plan_id`         | Primary key with `entitlement_key`. References `platform.plans`.                 |
| `platform.plan_entitlements`     | `entitlement_key` | Entitlement-key check.                                                           |
| `platform.plan_entitlements`     | `limit_value`     | Integer null, or greater than or equal to 0.                                     |
| `platform.add_ons`               | `id`              | UUIDv7 primary key.                                                              |
| `platform.add_ons`               | `key`             | Unique. Plan-key check.                                                          |
| `platform.add_on_entitlements`   | `add_on_id`       | Primary key with `entitlement_key`. References `platform.add_ons`.               |
| `platform.add_on_entitlements`   | `entitlement_key` | Entitlement-key check.                                                           |
| `platform.add_on_entitlements`   | `limit_value`     | Integer null, or greater than or equal to 0.                                     |
| `platform.organisation_plans`    | `organisation_id` | Primary key. References `platform.organisations`. One plan for the organisation. |
| `platform.organisation_plans`    | `plan_id`         | References `platform.plans`.                                                     |
| `platform.organisation_add_ons`  | `organisation_id` | Primary key with `add_on_id`. References `platform.organisations`.               |
| `platform.organisation_add_ons`  | `add_on_id`       | References `platform.add_ons`.                                                   |
| `platform.community_allocations` | `community_id`    | Primary key with `entitlement_key`. References `platform.communities`.           |
| `platform.community_allocations` | `entitlement_key` | Entitlement-key check.                                                           |
| `platform.community_toggles`     | `community_id`    | Primary key with `entitlement_key`. References `platform.communities`.           |
| `platform.community_toggles`     | `entitlement_key` | Entitlement-key check.                                                           |
| `platform.community_toggles`     | `enabled`         | Boolean not null. False is the only stored value. On deletes the row.            |
| `platform.entitlement_overrides` | `id`              | UUIDv7 primary key.                                                              |
| `platform.entitlement_overrides` | `organisation_id` | Unique with `entitlement_key`. References `platform.organisations`.              |
| `platform.entitlement_overrides` | `entitlement_key` | Entitlement-key check.                                                           |
| `platform.entitlement_overrides` | `expires_at`      | `timestamptz` not null.                                                          |
| `platform.feature_flags`         | `id`              | UUIDv7 primary key.                                                              |
| `platform.feature_flags`         | `key`             | Entitlement-key check.                                                           |
| `platform.feature_flags`         | `enabled`         | Boolean not null.                                                                |
| `platform.feature_flags`         | `organisation_id` | Null or references `platform.organisations`.                                     |
| `platform.feature_flags`         | `community_id`    | Null or references `platform.communities`.                                       |
| `platform.feature_flags`         | `plan_key`        | Null or the plan-key check.                                                      |
| `platform.feature_flags`         | `region`          | Null or `au`.                                                                    |

`platform.feature_flags` is unique on `(key, organisation_id, community_id, plan_key, region)` with nulls not distinct.

`enabled` on a toggle is not null in the table. The absent row is the on state, so a check constraint requires `enabled = false`.

## Rules touched

Tenancy and residency. These rows are region-scoped `platform` tables. They have no `org_id`. Callers use the `platform` login and do not set `app.org_id`. The `app` and `identity` logins have no privilege on them. The rows hold no personal data.

Authorisation. The policy catalogue gains two permissions. The route checks `holdsPermission` before it lists or toggles. A failed check appends a denial and returns 403. The page does not render a switch the caller cannot use.

Children, money, consent, retention, and analytics. No children's fields, no payment fields, no consent rows, and no analytics. Q8 and Q15 stay open.

Downgrades. Removing a key from a plan, failing a flag, or switching a toggle off does not delete `app` data. This chunk writes no `app` business table. It may delete an allocation row or a toggle row. Those are not tenant content.

## Contracts

| Contract | Value                                                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module   | `@community-hub/entitlements`, key `core.entitlements`, version 1. Requires `core.tenancy`. Permissions `entitlements.view`, `entitlements.manage`. No events, no entitlement key, no website. |
| Eval     | `@community-hub/entitlements-eval`. Exports `evaluate` and `limit`. No database.                                                                                                               |
| People   | `features` is the three strings in the order above. Nothing else on that manifest changes.                                                                                                     |
| Policy   | `catalogue()` ends with the two new permissions. Bundles change only as Behaviour says.                                                                                                        |
| Access   | `holdsPermission(tx, userId, permission): Promise<boolean>`. Read only.                                                                                                                        |
| Tenancy  | `listCommunityIds(sql, organisationId): Promise<string[]>`.                                                                                                                                    |
| Reads    | `readSnapshot(sql, { organisationId, communityId, now })`. Cache bound 60 seconds.                                                                                                             |
| Writes   | `upsertPlan`, `upsertAddOn`, `assignPlan`, `allocate`, `grantOverride`, `setFeatureFlag`, `setToggle`. Platform login. No `set_config`. The first six have no route.                           |
| Routes   | `POST /v1/entitlements/list` and `POST /v1/entitlements/toggle`. Surface `tenant`. API hostname only.                                                                                          |
| Audit    | `entitlements.permission.denied` and `entitlements.toggle.changed`. Targets are organisation id, then community id.                                                                            |
| Admin    | Settings children: Users & Roles, Module Toggles. Production nav map is empty.                                                                                                                 |
| Journal  | One additive entry in `packages/db/drizzle` after `0007_fast_gorilla_man`. No seed rows.                                                                                                       |
| Roles    | `platform` can read and write. `app` and `identity` cannot.                                                                                                                                    |
| Staging  | Parked. No apply.                                                                                                                                                                              |

## Dependencies

`@community-hub/entitlements-eval` has no runtime dependency. Dev dependencies match `@community-hub/policy`.

`@community-hub/entitlements` depends on `@community-hub/db`, `@community-hub/kernel`, and `@community-hub/tenancy` at `workspace:*`, plus `drizzle-orm` `0.45.2` and `postgres` `3.4.9`. It does not depend on `@community-hub/access`, `@community-hub/people`, `@community-hub/identity`, or `@community-hub/crypto`. `@community-hub/db` does not depend on entitlements.

`@community-hub/contracts` keeps Zod `4.6.5`. `package.json` exports gain `"./entitlements"`.

Turbo order, so the one Docker Postgres is not shared concurrently:

- `@community-hub/entitlements#test` depends on `^build`, `@community-hub/tenancy#test`, and `@community-hub/access#test`.
- `@community-hub/api#test` depends on `^build` and `@community-hub/entitlements#test`. `@community-hub/access#test` comes off that list. Access still runs before the API because entitlements waits for it.

No new third-party package.

## Cost

No new resource billed by the hour or the month. No NAT gateway, load balancer, or interface endpoint. Staging stays parked, so this chunk adds no database charge and no task charge.

## Risks

| Risk                                                      | Mitigation                                                                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `app` login can read who bought what                  | Default privileges stay platform-only. A test as `app` and as `identity` fails the select.                                                                                   |
| A cached entitlement stays true after a toggle            | The writing process deletes its key. A test advances `now` by 60 seconds and sees the new row. A test at 59 seconds still sees the stored snapshot.                          |
| The body supplies another organisation's id               | The route takes `communitySlug` only and uses `findCommunityBySlug`. A test sends an extra id field and the schema rejects it.                                               |
| A toggle turns on a key the organisation does not have    | `setToggle` requires steps 1 to 3 on a fresh snapshot. The failure writes nothing.                                                                                           |
| The page shows a price, a name, or an upgrade control     | The response is keys and booleans. A test fails if the page source contains `upgrade` or a currency sign.                                                                    |
| The migration seeds a commercial plan                     | The journal SQL has no `insert`. A test reads that file and fails if it does.                                                                                                |
| A platform table is given `org_id` and row level security | A test fails if any new table's SQL contains a column named `org_id`, `ENABLE ROW LEVEL SECURITY`, or `FORCE ROW LEVEL SECURITY`.                                            |
| Another module imports the platform schema                | `entitlementTables` is called from `packages/db/drizzle.schema.ts` only. The module file does not call `pgSchema`. The architecture sentence names the two modules that may. |

This chunk changes the policy catalogue and who may toggle a capability. The second fresh-context review starts when the pull request opens. That line stays open until that review is written.

## Catalogue

The last commit marks the Phase 1 row done. The What cell becomes `Plans and allocations in the platform schema. Community toggles; nav hide/show. Spec docs/specs/2026-10-12-entitlements-plans.md.` The snapshot stays on Phase `1 — Core platform`. Last shipped becomes `entitlements-plans`. Next chunk becomes `stripe-billing`. The Phase 0 count stays `24 rows: 23 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stays `not started`. The sentence under the Phase 0 table becomes `Next is stripe-billing.` The Next spec section names `stripe-billing`.

In `AGENTS.md`, the repository-state cell names `stripe-billing` as next. The Phase 0 counts in that cell stay as they are. That is the only `AGENTS.md` edit.

`architecture.md` changes only these sentences:

- §6.3 owner cell for region-scoped platform: directory rows stay `core/tenancy`. Plans, add-ons, entitlements, allocations, overrides, community toggles, and feature flags are `core/entitlements`. No other module may query the schema.
- §6.3 CI sentence: a module outside `core/tenancy` and `core/entitlements` must not reference the `platform` schema. The identity clause stays.
- §10.1 Allocation stored-in cell: `platform.community_allocations`. The open Q14 pointer goes.
- §10.1 Override stored-in cell: `platform.entitlement_overrides`. An unexpired override satisfies the entitlement step only. The open Q14 pointer goes.
- §10.3 and §10.4: replace the Q14 leaning with the decision. A request reads those rows from the `platform` schema on the platform login. The process cache is at most 60 seconds, keyed by organisation id and community id. The writer deletes its own key. There is no snapshot table and no propagation job. `stripe-billing` writes the same tables from the webhook and does not publish a snapshot. The Q15 paragraph stays.
- §26 Q14 result: closed by ADR 0012 and this spec. Same decision in one sentence. The leaning is not left beside it.

`docs/adr/0012-entitlement-visibility.md` records that decision and the two-module platform rule. Status accepted. Date is the date of the catalogue commit. It names this spec.

`docs/roadmap.md` open questions keep Q8. They do not gain a Q14 row. The open-items section is not edited.

## Out-of-band

No legal sign-off. No new subprocessor. Q8 stays a product decision. Approving this spec approves the 60-second bound and the `core/entitlements` platform read. It does not approve prices or the §10.2 list as the plans for sale.
