Spec: docs/specs/2026-10-12-entitlements-plans.md

# Plans and entitlements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store plans, allocations, overrides, feature flags, and community toggles in the `platform` schema, let a request read them from an in-process cache of at most 60 seconds, and open Settings → Module Toggles.

**Architecture:** Nine commits. Evaluation is a pure function in `packages/entitlements-eval`. Policy and the people manifest gain the keys this chunk names. Access and tenancy gain one read each. The expand migration and the module writes follow. Contracts and the two POST routes follow. The admin page and the catalogue are last. No apply.

**Tech Stack:** TypeScript, Drizzle ORM `0.45.2`, `postgres` `3.4.9`, Vitest, Node 24, Docker `postgres:17`, Zod `4.6.5`, React Router. No new third-party package. No Terraform change.

Status: approved (2026-10-12, owner)

**Branch:** `feat/2026-10-12-entitlements-plans` · one PR · 9 tasks, one commit each

## Global Constraints

- The spec and this plan stay `approved (2026-10-12, owner)`. The review clarifications are already in both. Step 1 passes when no flag row matches, and fails when any matching row has `enabled` false. The eval package directory is `packages/entitlements-eval`. `EntitlementSnapshot` is exported from `@community-hub/entitlements-eval`.
- Do not start Task 1 until this plan's Status line is `approved`. Do not change that line back to draft.
- Do not add a column, a route, a package, a permission, or a public function the spec does not name.
- `packages/db/src` does not import `@community-hub/entitlements`. `db/schema.ts` does not call `pgSchema`.
- The eval package and the entitlements domain import no framework, no Drizzle, and no `@community-hub/crypto`. The module does not import `@community-hub/access`, `@community-hub/people`, `@community-hub/identity`, or `@community-hub/crypto`.
- Write functions take `sql: Sql` from `postgres` first. They do not open a connection and do not call `set_config`. A multi-row write may use `sql.begin`. That begin does not set `app.org_id` or `app.community_id`.
- One journal entry, in Task 4, after `0007_fast_gorilla_man`. Later tasks do not add a migration. Migration wave: expand. No drop. No change to `platform.organisations`, `platform.communities`, an `app` table, or an `identity` table. The SQL inserts no row.
- Staging stays parked. Do not change `enable_database`, `desired_count`, or add `service_image`. Do not edit Terraform. Do not apply.
- The agent does not apply and does not merge. Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- This chunk changes the permission catalogue. The second fresh-context review starts when the pull request opens. Leave that line open. Do not write the second review.
- Every task runs `pnpm gate` before its commit. Format the files in that commit first: `pnpm exec prettier --write` on those paths. A code fence inside a list item is indented so Prettier does not join the list.
- Docker Postgres is started by the `@community-hub/db` test setup. Do not add a second compose file. If Docker is missing, stop and report. Do not skip the integration test.
- This plan changes no Terraform. There is no Terraform assert to probe and no scratch apply.

**Rollback:** A later contract migration drops `platform.feature_flags`, `platform.entitlement_overrides`, `platform.community_toggles`, `platform.community_allocations`, `platform.organisation_add_ons`, `platform.organisation_plans`, `platform.add_on_entitlements`, `platform.plan_entitlements`, `platform.add_ons`, then `platform.plans`. This journal entry is not edited after it ships. Revert of the PR before merge removes the entry with the branch. Staging flags are unchanged.

**Cost:** No new hourly or monthly resource. Staging stays parked.

## File map

| File                                                                                         | Responsibility                                                 |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/entitlements-eval/`                                                                | `EntitlementSnapshot`, `evaluate`, and `limit`. No database.   |
| `packages/policy/src/decide.ts`                                                              | Catalogue and the three view bundles gain `entitlements.view`. |
| `modules/core/people/module.manifest.ts`                                                     | The three `features` strings.                                  |
| `modules/core/access/infrastructure/holds-permission.ts`                                     | `holdsPermission`. Read only.                                  |
| `modules/core/tenancy/infrastructure/communities.ts`                                         | `listCommunityIds`.                                            |
| `modules/core/entitlements/`                                                                 | Manifest, schema, writes, cache, toggle.                       |
| `packages/db/drizzle.schema.ts`                                                              | Passes the one `platform` schema into `entitlementTables`.     |
| `packages/db/drizzle/`                                                                       | One new journal entry after `0007_fast_gorilla_man`.           |
| `packages/contracts/src/entitlements.ts`                                                     | Strict request schemas. Export path `./entitlements`.          |
| `apps/api/src/entitlement-routes.ts`                                                         | The two POST routes.                                           |
| `apps/admin/src/`                                                                            | `visibleLabels` and Module Toggles.                            |
| `docs/roadmap.md`, `AGENTS.md`, `architecture.md`, `docs/adr/0012-entitlement-visibility.md` | The sentences the spec names.                                  |

## Dependencies

`@community-hub/entitlements-eval` has no runtime dependency. Dev dependencies match `@community-hub/policy`: `typescript` `^5.8.2`, `@types/node` `^22.13.10`, `vitest` `^4.1.11`. `pnpm-workspace.yaml` already includes `packages/*`. Do not add a glob for it.

`@community-hub/entitlements` depends on `@community-hub/db`, `@community-hub/kernel`, `@community-hub/tenancy`, and `@community-hub/entitlements-eval` at `workspace:*`, plus `drizzle-orm` `0.45.2` and `postgres` `3.4.9`. `@community-hub/db` does not depend on entitlements. `pnpm-workspace.yaml` gains the line `modules/core/entitlements` in Task 4.

`@community-hub/contracts` keeps Zod `4.6.5`. The `.` export stays `./dist/auth.js`. The `./access` export stays. `package.json` exports gain `"./entitlements"` to `./dist/entitlements.js` with types `./dist/entitlements.d.ts`.

`apps/api` gains `@community-hub/entitlements` and `@community-hub/entitlements-eval` at `workspace:*` in Task 7.

Turbo order, so the one Docker Postgres is not shared concurrently. Edit this in Task 4:

- `@community-hub/entitlements#test` depends on `^build`, `@community-hub/tenancy#test`, and `@community-hub/access#test`.
- `@community-hub/api#test` depends on `^build` and `@community-hub/entitlements#test`. Remove `@community-hub/access#test` from that list.

`@community-hub/entitlements-eval#test` uses the default `test` task. It has no `globalSetup`. The entitlements Vitest config matches `modules/core/tenancy/vitest.config.ts`, including the plaintext alias and `packages/db/test/global-setup.ts`.

## Security pins

These are the settings named in the spec and the review. For each one, during the task that adds the test, change the source once, see that test fail, restore the source, and report the failure. The report is session scratch. The weakened tree is never committed.

| Setting                                        | Task | Test                                        | Source change that must fail it                             |
| ---------------------------------------------- | ---- | ------------------------------------------- | ----------------------------------------------------------- |
| Eval does not import the database              | 1    | Source scan of `packages/entitlements-eval` | Add `import "@community-hub/db"` in `src/evaluate.ts`       |
| No matching flag passes step 1                 | 1    | Unit                                        | Return `{ ok: false, step: "flag" }` when `flags` is empty  |
| A matching `enabled: false` fails step 1       | 1    | Unit                                        | Delete the `enabled === false` check                        |
| A guardian does not gain `entitlements.manage` | 2    | `decide` test                               | Return true for that permission when `guardianView` is true |
| People features are exactly three strings      | 2    | Manifest test                               | Append `"people.export"` to `features`                      |
| `member` does not gain `entitlements.manage`   | 2    | Bundle test                                 | Add `"entitlements.manage"` to the `member` bundle          |
| `holdsPermission` does not audit               | 3    | Source scan                                 | Add `appendAuditEvent` in `holdsPermission`                 |
| `listCommunityIds` does not call `set_config`  | 3    | Source scan                                 | Add `set_config` in `listCommunityIds`                      |
| `platform.plans` has no `org_id`               | 4    | SQL test                                    | Add `"org_id" uuid` to that `CREATE TABLE`                  |
| New tables have no row level security          | 4    | SQL test                                    | Add `ENABLE ROW LEVEL SECURITY` on `platform.plans`         |
| The migration inserts no catalogue             | 4    | File scan                                   | Add `INSERT INTO platform.plans`                            |
| `app` cannot select plans                      | 4    | Privilege test                              | Add `GRANT SELECT ON platform.plans TO app`                 |
| The module does not call `pgSchema`            | 4    | Source scan                                 | Call `pgSchema("platform")` in `db/schema.ts`               |
| Staging stays parked                           | 4    | Tfvars scan                                 | Set `enable_database = true` in `staging.tfvars`            |
| A toggle cannot enable an unallocated key      | 6    | Integration                                 | Skip `evaluate` in `setToggle`                              |
| A 59-second cache is not reloaded              | 6    | Integration                                 | Compare the age with `>= 0` so every read reloads           |
| An extra `organisationId` is 400               | 7    | Route test                                  | Delete `.strict()` from the list schema                     |
| The auth hostname is 404                       | 7    | Route test                                  | Return 200 before the hostname compare                      |
| A failed audit restores the toggle             | 7    | Route test                                  | Skip the restore `setToggle`                                |
| The page does not say upgrade                  | 8    | Render test                                 | Render `Upgrade` in the empty state                         |
| The production map does not add Contacts       | 8    | Shell test                                  | Put `Contacts & Members` in the production map              |

---

### Task 1: Pure evaluation

**Files:**

- Create: `packages/entitlements-eval/package.json`
- Create: `packages/entitlements-eval/tsconfig.json`
- Create: `packages/entitlements-eval/tsconfig.test.json`
- Create: `packages/entitlements-eval/vitest.config.ts`
- Create: `packages/entitlements-eval/src/evaluate.ts`
- Create: `packages/entitlements-eval/src/evaluate.test.ts`
- Create: `packages/entitlements-eval/src/boundaries.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: `EntitlementSnapshot` with `organisationId`, `communityId`, `region: "au"`, `planKey: string | null`, `loadedAt: Date`, `planEntitlements: readonly { key: string; limit: number | null }[]`, `addOnEntitlements` of that same element type, `allocations: readonly string[]`, `toggles: readonly { key: string; enabled: boolean }[]`, `overrides: readonly { key: string; expiresAt: Date }[]`, and `flags: readonly { key: string; enabled: boolean; organisationId: string | null; communityId: string | null; planKey: string | null; region: string | null }[]`.
- Produces: `evaluate(snapshot: EntitlementSnapshot, key: string, now: Date): { ok: true } | { ok: false; step: "flag" | "entitlement" | "allocation" | "toggle" }`.
- Produces: `limit(snapshot: EntitlementSnapshot, key: string): number | null`.

**Rule this must not break:** the package imports no `@community-hub/db` and has no runtime dependency. When no flag row matches, step 1 passes. When any matching row has `enabled` false, step 1 fails.

- [ ] **Step 1: Write the failing tests**

`evaluate.test.ts` builds a snapshot whose plan includes `people.directory` with limit `null`, whose allocations include that key, and whose flags and toggles are empty. `evaluate` at that snapshot returns `{ ok: true }`. The same snapshot plus a flag `{ key: "people.directory", enabled: false, organisationId: null, communityId: null, planKey: null, region: null }` returns `{ ok: false, step: "flag" }`. A flag with `enabled: true` and a different `planKey` does not kill. An empty plan, no add-on, and no override returns `{ ok: false, step: "entitlement" }`. An override with `expiresAt` after `now` passes step 2 and still returns `{ ok: false, step: "allocation" }` when the key is absent from `allocations`. An override with `expiresAt` equal to `now` does not pass step 2. A toggle `{ key: "people.directory", enabled: false }` on an otherwise available key returns `{ ok: false, step: "toggle" }`. A missing toggle row leaves the result `{ ok: true }`.

`limit` returns the plan's `null` when the plan includes the key, even if an add-on sets `10`. When the plan omits the key and two add-ons set `10` and `4`, `limit` returns `4`. When no row sets a number, `limit` returns `null`.

`boundaries.test.ts` reads every file under `packages/entitlements-eval` and fails if any contains `@community-hub/db`, `drizzle`, or `postgres`.

The tests fail because the package does not exist.

- [ ] **Step 2: Add the package**

`package.json` name `@community-hub/entitlements-eval`, `"type": "module"`, `"private": true`, `"version": "0.0.0"`. Exports `"."` to `./dist/src/evaluate.js` with types `./dist/src/evaluate.d.ts`. Scripts match `@community-hub/policy`. No `dependencies` key. Copy `tsconfig.json`, `tsconfig.test.json`, and `vitest.config.ts` from `packages/policy`.

A flag matches when its key equals the requested key and each non-null target equals the snapshot. `region` on the snapshot is `au`. `evaluate` does not read the clock. `limit` prefers the plan row, then the smallest non-null add-on limit.

`pnpm install` so the lockfile records the package.

- [ ] **Step 3: Pin the boundary and step 1**

Add `import "@community-hub/db"` in `src/evaluate.ts`. The boundary test fails. Restore the file.

Return `{ ok: false, step: "flag" }` when `flags` is empty. The empty-flag test fails. Restore.

Delete the `enabled === false` check. The kill-switch test fails. Restore.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the TypeScript in this task. Then `pnpm gate`.

```bash
git add packages/entitlements-eval pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(entitlements): evaluate a snapshot without a database

No matching flag passes. A matching disabled flag stops the check.

Refs: docs/plans/2026-10-12-entitlements-plans.md task 1
EOF
)"
```

---

### Task 2: Catalogue permissions and people features

**Files:**

- Modify: `packages/policy/src/decide.ts`
- Modify: `packages/policy/src/decide.test.ts`
- Modify: `modules/core/people/module.manifest.ts`
- Modify: `modules/core/people/domain/manifest.test.ts`

**Interfaces:**

- Produces: `catalogue()` ending in `entitlements.view`, then `entitlements.manage`, after `people.restricted.read`.
- Produces: `org_billing`, `org_auditor`, and `staff` each include `entitlements.view` and exclude `entitlements.manage`. `member` stays empty. `org_owner`, `org_admin`, and `community_admin` stay the whole catalogue.
- Produces: people `features: ["people.directory", "people.households", "people.custom_fields"]`. No `entitlement`. No `website`. `permissions` stays `["people.restricted.read"]`.

**Rule this must not break:** a person-scoped guardian still receives only `people.restricted.read`. `decide` does not grant either entitlements permission from `guardianView`.

- [ ] **Step 1: Write the failing tests**

The catalogue test expects the seven strings in that order. `bundle("org_billing")` deep-equals `["access.users.view", "entitlements.view"]`. `bundle("org_auditor")` deep-equals `["access.users.view", "access.roles.view", "entitlements.view"]`. The staff view list gains `entitlements.view` and still rejects `entitlements.manage`. `bundle("member")` stays `[]`. A person-scoped guardian with no roles is allowed `people.restricted.read` and denied `entitlements.manage` and `entitlements.view`.

`manifest.test.ts` expects `features` to deep-equal the three strings and still expects no `website` and no `entitlement`.

The tests fail because the two permissions and the features are absent.

- [ ] **Step 2: Add the keys**

Append the two permissions to `CATALOGUE`. Add `entitlements.view` to the `org_billing`, `org_auditor`, and `staff` arrays. Leave `member`, `finance`, `safeguarding_officer`, `volunteer_coordinator`, and `content_editor` unchanged. Add `features` to the people manifest before `permissions`.

- [ ] **Step 3: Pin the bundles**

Return true from `decide` when `permission === "entitlements.manage"` and `guardianView` is true. The guardian test fails. Restore.

Append `"people.export"` to `features`. The manifest test fails. Restore.

Add `"entitlements.manage"` to the `member` bundle. The member test fails. Restore.

- [ ] **Step 4: Gate and commit**

```bash
git add packages/policy/src/decide.ts packages/policy/src/decide.test.ts modules/core/people/module.manifest.ts modules/core/people/domain/manifest.test.ts
git commit -m "$(cat <<'EOF'
feat(policy): add entitlement view and manage permissions

Owners hold both. Billing, audit, and staff can view. A guardian holds neither.

Refs: docs/plans/2026-10-12-entitlements-plans.md task 2
EOF
)"
```

---

### Task 3: Permission read and community ids

**Files:**

- Create: `modules/core/access/infrastructure/holds-permission.ts`
- Create: `modules/core/access/infrastructure/holds-permission.integration.test.ts`
- Create: `modules/core/access/infrastructure/holds-permission.test.ts`
- Modify: `modules/core/access/public/index.ts`
- Create: `modules/core/tenancy/infrastructure/communities.ts`
- Create: `modules/core/tenancy/infrastructure/communities.integration.test.ts`
- Create: `modules/core/tenancy/infrastructure/communities.test.ts`
- Modify: `modules/core/tenancy/public/index.ts`

**Interfaces:**

- Produces: `holdsPermission(tx, userId, permission): Promise<boolean>`. It loads that user's organisation grants, community grants, and custom-role permissions in the current transaction, then calls `decide` with `guardianView: false` and `personScoped: false`. It does not write.
- Produces: `listCommunityIds(sql, organisationId): Promise<string[]>`. Empty when the organisation has no communities. Ids only.

**Rule this must not break:** `holdsPermission` does not call `appendAuditEvent`. `listCommunityIds` does not call `set_config` and does not return a slug. The access routes keep their private directory query.

- [ ] **Step 1: Write the failing tests**

The access integration test grants `staff` and expects `holdsPermission` true for `entitlements.view` and false for `entitlements.manage`. A user with no grant is false. A custom role whose permissions are `["entitlements.manage"]` is true for that permission only. The audit table gains no row. `holds-permission.test.ts` reads the source and fails if it contains `appendAuditEvent`, `insert`, or `set_config`.

The tenancy integration test creates an implicit organisation and expects `listCommunityIds` to return that one community id. An unknown organisation id returns `[]`. The result has no `slug` property. `communities.test.ts` reads the source and fails if it contains `set_config` or `slug`.

The tests fail because the functions are absent.

- [ ] **Step 2: Add the reads**

`holdsPermission` selects from `app.organisation_role_grants`, `app.community_role_grants`, `app.custom_roles`, and `app.custom_role_permissions`, filtered by `current_setting('app.org_id')` and, for community tables, `current_setting('app.community_id')`, and by the user id. Re-export it from `public/index.ts`.

`listCommunityIds` selects `id` from `platform.communities` where `organisation_id` is the argument. Re-export it from `public/index.ts`.

- [ ] **Step 3: Pin the reads**

Add `appendAuditEvent` inside `holdsPermission`. The source test fails. Restore.

Add `set_config` inside `listCommunityIds`. The source test fails. Restore.

- [ ] **Step 4: Gate and commit**

```bash
git add modules/core/access/infrastructure/holds-permission.ts modules/core/access/infrastructure/holds-permission.integration.test.ts modules/core/access/infrastructure/holds-permission.test.ts modules/core/access/public/index.ts modules/core/tenancy/infrastructure/communities.ts modules/core/tenancy/infrastructure/communities.integration.test.ts modules/core/tenancy/infrastructure/communities.test.ts modules/core/tenancy/public/index.ts
git commit -m "$(cat <<'EOF'
feat(access): read whether a user holds a permission

Tenancy lists community ids for an organisation without setting the tenant.

Refs: docs/plans/2026-10-12-entitlements-plans.md task 3
EOF
)"
```

---

### Task 4: Platform tables

**Files:**

- Create: `modules/core/entitlements/package.json`
- Create: `modules/core/entitlements/tsconfig.json`
- Create: `modules/core/entitlements/tsconfig.test.json`
- Create: `modules/core/entitlements/vitest.config.ts`
- Create: `modules/core/entitlements/module.manifest.ts`
- Create: `modules/core/entitlements/domain/manifest.test.ts`
- Create: `modules/core/entitlements/domain/keys.ts`
- Create: `modules/core/entitlements/domain/keys.test.ts`
- Create: `modules/core/entitlements/domain/error.ts`
- Create: `modules/core/entitlements/db/schema.ts`
- Create: `modules/core/entitlements/db/schema.test.ts`
- Create: `modules/core/entitlements/db/schema.integration.test.ts`
- Create: `modules/core/entitlements/db/parked.test.ts`
- Create: `modules/core/entitlements/public/index.ts`
- Modify: `packages/db/drizzle.schema.ts`
- Create: the generated journal entry under `packages/db/drizzle/`
- Modify: `packages/db/drizzle/meta/_journal.json` and the generated snapshot
- Modify: `pnpm-workspace.yaml`
- Modify: `turbo.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: `entitlementTables(platform)` for the ten tables in the spec Data table. Checks, uniques, and `onDelete: "restrict"` foreign keys live in `schema.ts`. `platform.community_toggles.enabled` has a check that it equals false. `platform.feature_flags` is unique on `(key, organisation_id, community_id, plan_key, region)`.
- Produces: `EntitlementError` with `code` of `invalid_key`, `invalid_limit`, `invalid_region`, `invalid_expiry`, `not_found`, `duplicate_allocation`, or `not_allocated`.
- Produces: `defineModule` key `core.entitlements`, version `1`, `requires: ["core.tenancy"]`, empty `publishes`, `subscribes`, `ports`, and `features`. No `entitlement`. No `website`. `permissions` is `entitlements.view`, `entitlements.manage`. `dataClasses` has one `internal` entry per column, keyed as `plans.id` and the same shape for every other column.

**Rule this must not break:** no new table has a column named `org_id`. None enables row level security. The migration contains no `insert`. `schema-rls` is not edited. `packages/db/src` does not import the module.

- [ ] **Step 1: Write the failing tests**

`keys.test.ts` accepts `people.directory` and rejects `starter` as an entitlement key. It accepts `starter` and rejects `people.directory` as a plan key. A 65-character entitlement key is rejected.

`manifest.test.ts` expects the module object above, including every `dataClasses` entry, and no `website` or `entitlement` key.

`schema.test.ts` will read the new SQL file. It fails if that file matches `org_id`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, or `insert`. It requires `NULLS NOT DISTINCT` and `ON DELETE RESTRICT`. It requires a check that toggle `enabled` is false.

`parked.test.ts` reads `infra/regions/au/env/staging.tfvars` and fails if `enable_database` is true, `desired_count` is not 0, or the file contains `service_image`.

`boundaries` are in `schema.test.ts` as a source read of `db/schema.ts`: it fails if the file contains `pgSchema`.

The tests fail because the module and the journal entry do not exist.

- [ ] **Step 2: Add the tables**

Copy the tenancy package's `tsconfig` files and Vitest config. `package.json` name `@community-hub/entitlements`. Dependencies are the four workspace packages and the two pinned libraries named above. Add `modules/core/entitlements` to `pnpm-workspace.yaml`. Add the turbo edges from Dependencies. `pnpm install`.

`drizzle.schema.ts` imports `entitlementTables` and calls it with the existing `platform` schema. Export each table.

From `packages/db`, run `pnpm exec drizzle-kit generate`. Commit the new SQL, the new snapshot, and the journal entry. Do not edit `0000` through `0007`. Do not hand-add row level security. If the feature-flag unique lacks `NULLS NOT DISTINCT`, hand-add that phrase on that one constraint and nowhere else. If a check is missing, fix `schema.ts` and generate again.

`public/index.ts` exports `EntitlementError` only in this task.

- [ ] **Step 3: Pin the SQL**

Add `"org_id" uuid` to `platform.plans` in the generated SQL. The SQL test fails. Restore.

Add `ENABLE ROW LEVEL SECURITY` on `platform.plans`. The SQL test fails. Restore.

Add `INSERT INTO platform.plans` in that file. The file scan fails. Restore.

Call `pgSchema("platform")` in `db/schema.ts`. The source test fails. Restore.

Set `enable_database = true` in `infra/regions/au/env/staging.tfvars`. The parked test fails. Restore.

The privilege test is an integration test in `db/schema.integration.test.ts`: as `app` and as `identity`, `select` from `platform.plans` fails. Add `GRANT SELECT ON platform.plans TO app` in the SQL, see that test fail, and restore.

- [ ] **Step 4: Gate and commit**

```bash
git add modules/core/entitlements packages/db/drizzle.schema.ts packages/db/drizzle pnpm-workspace.yaml turbo.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(entitlements): add platform plan and toggle tables

The tables have no org_id and no row level security. The migration inserts nothing.

Refs: docs/plans/2026-10-12-entitlements-plans.md task 4
EOF
)"
```

---

### Task 5: Plan writes

**Files:**

- Create: `modules/core/entitlements/infrastructure/writes.ts`
- Create: `modules/core/entitlements/infrastructure/writes.integration.test.ts`
- Create: `modules/core/entitlements/infrastructure/writes.test.ts`
- Modify: `modules/core/entitlements/public/index.ts`

**Interfaces:**

- Produces: `upsertPlan(sql, { key, entitlements })`, `upsertAddOn(sql, { key, entitlements })`, `assignPlan(sql, { organisationId, planKey, now })`, `allocate(sql, { communityId, key })`, `grantOverride(sql, { organisationId, key, expiresAt, now })`, and `setFeatureFlag(sql, { key, enabled, organisationId, communityId, planKey, region })`.
- `entitlements` entries are `{ key, limit }` with `limit` null or an integer `>= 0`.
- `assignPlan` calls `listCommunityIds`. The resulting allocation rows are the plan keys, the assigned add-on keys, and the override keys whose `expiresAt` is after `now`. Other allocation rows for those communities are deleted. Toggle rows stay.

**Rule this must not break:** none of these functions calls `set_config`. None has an HTTP route. None appends `app.audit_events`. An invalid key writes nothing.

- [ ] **Step 1: Write the failing tests**

The integration test uses `createPlatformSql` from the db plaintext harness and `createImplicitOrganisation`. `upsertPlan` of `starter` with `people.directory` and limit `null` inserts one plan. A second call with a different key list replaces `plan_entitlements` and leaves the plan id. A negative limit throws `invalid_limit` and leaves the previous rows. `assignPlan` for that organisation inserts one allocation. A second community is not created here. Replacing the plan with no entitlements deletes that allocation and leaves any toggle row. An unknown plan throws `not_found` and writes nothing. `allocate` twice throws `duplicate_allocation`. `grantOverride` with `expiresAt` equal to `now` throws `invalid_expiry`. `setFeatureFlag` with `region: "eu"` throws `invalid_region`. A second flag call with the same four targets updates `enabled` and does not insert a second row. Two flags with all-null targets and the same key are one row.

`writes.test.ts` reads `writes.ts` and fails if it contains `set_config`, `appendAuditEvent`, or `app.`.

The tests fail because the functions are absent.

- [ ] **Step 2: Add the writes**

Validate keys in `domain/keys.ts` before any statement. Use `newId()` for `plans`, `add_ons`, `entitlement_overrides`, and `feature_flags`. Use `sql.begin` when more than one statement must succeed or fail together. Re-export the six functions from `public/index.ts`.

- [ ] **Step 3: Pin the writes**

Add `set_config` in `upsertPlan`. The source test fails. Restore.

- [ ] **Step 4: Gate and commit**

```bash
git add modules/core/entitlements/infrastructure/writes.ts modules/core/entitlements/infrastructure/writes.integration.test.ts modules/core/entitlements/infrastructure/writes.test.ts modules/core/entitlements/public/index.ts
git commit -m "$(cat <<'EOF'
feat(entitlements): write plans, allocations, overrides, and flags

These commands use the platform login and have no HTTP route.

Refs: docs/plans/2026-10-12-entitlements-plans.md task 5
EOF
)"
```

---

### Task 6: Snapshot cache and community toggle

**Files:**

- Create: `modules/core/entitlements/infrastructure/snapshot.ts`
- Create: `modules/core/entitlements/infrastructure/snapshot.integration.test.ts`
- Create: `modules/core/entitlements/infrastructure/toggle.ts`
- Create: `modules/core/entitlements/infrastructure/toggle.integration.test.ts`
- Modify: `modules/core/entitlements/public/index.ts`
- Modify: `modules/core/entitlements/infrastructure/writes.ts`

**Interfaces:**

- Produces: `readSnapshot(sql, { organisationId, communityId, now }): Promise<EntitlementSnapshot>` imported from `@community-hub/entitlements-eval`.
- Produces: `setToggle(sql, { organisationId, communityId, key, enabled, now }): Promise<"changed" | "unchanged">`.
- The cache is a process map keyed by the two ids. Age is `now` minus `loadedAt`. Age under 60 seconds returns the stored snapshot and issues no query. Age of 60 seconds or more loads again. `loadedAt` is the `now` argument of the load.

**Rule this must not break:** `setToggle` loads a fresh snapshot, ignoring the cache, and runs `evaluate` on a copy whose `toggles` is empty. A failure of step 1, 2, or 3 throws `not_allocated` and writes nothing. `enabled: true` deletes the row. `enabled: false` stores false. The writing functions delete the cache entries the spec names before they return.

- [ ] **Step 1: Write the failing tests**

Allocate `people.directory`, then `readSnapshot`. `evaluate` on that snapshot returns `{ ok: true }`. Update `platform.plan_entitlements` with raw SQL so the cache is not cleared. `readSnapshot` 59 seconds later still reports the old plan row. `readSnapshot` 60 seconds later reports the new row. `setToggle` to false, then `readSnapshot` at the same `now`, reports the toggle without waiting. `upsertPlan` clears the whole cache: a following `readSnapshot` at the same `now` sees the new plan rows.

`setToggle` to false twice returns `changed` then `unchanged`. `setToggle` to true deletes the row and the second true returns `unchanged`. `setToggle` for a key that is not allocated throws `not_allocated` and leaves no toggle row. A flag with `enabled` false on that key also throws `not_allocated`.

The tests fail because the functions are absent.

- [ ] **Step 2: Add the cache and the toggle**

`readSnapshot` selects the plan, add-ons, allocations, toggles, overrides, and flags that can match this organisation and community, including flag rows whose targets are null. Map the rows into `EntitlementSnapshot`. `region` is `"au"`.

Each write in `writes.ts` and `setToggle` deletes cache entries as the spec says: `upsertPlan`, `upsertAddOn`, and a flag with a null organisation id clear the map; `assignPlan`, `grantOverride`, and a flag for one organisation clear that organisation's communities via `listCommunityIds`; `allocate` and `setToggle` clear the one pair.

Re-export `readSnapshot` and `setToggle`.

- [ ] **Step 3: Pin the cache and the toggle**

Skip `evaluate` in `setToggle`. The unallocated-key test fails. Restore.

Compare cache age with `>= 0`. The 59-second test fails. Restore.

- [ ] **Step 4: Gate and commit**

```bash
git add modules/core/entitlements/infrastructure/snapshot.ts modules/core/entitlements/infrastructure/snapshot.integration.test.ts modules/core/entitlements/infrastructure/toggle.ts modules/core/entitlements/infrastructure/toggle.integration.test.ts modules/core/entitlements/infrastructure/writes.ts modules/core/entitlements/public/index.ts
git commit -m "$(cat <<'EOF'
feat(entitlements): cache the platform snapshot for 60 seconds

A toggle of a key the organisation does not have writes nothing.

Refs: docs/plans/2026-10-12-entitlements-plans.md task 6
EOF
)"
```

---

### Task 7: Routes

**Files:**

- Create: `packages/contracts/src/entitlements.ts`
- Create: `packages/contracts/src/entitlements.test.ts`
- Modify: `packages/contracts/package.json`
- Create: `apps/api/src/entitlement-routes.ts`
- Create: `apps/api/src/entitlement-routes.test.ts`
- Create: `apps/api/src/entitlement-flow.integration.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/package.json`
- Modify: `modules/core/entitlements/public/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: `listEntitlementsBody` as `{ communitySlug }` strict, and `toggleEntitlementBody` as `{ communitySlug, key, enabled }` strict.
- Produces: `entitlementRoutes(deps): GateRoute[]`. Both routes are `POST`, surface `tenant`. Deps use the same `checkout`, `kms`, `keyArn`, `now`, `apiHostname`, and `log` shape as access.
- Produces: `defineAuditAction("entitlements.permission.denied")`, `defineAuditAction("entitlements.toggle.changed")`, `defineAuditPurpose("entitlements.toggles.view")`, and `defineAuditPurpose("entitlements.toggles.manage")` in the entitlements public index.

**Rule this must not break:** the route reads the community with `findCommunityBySlug` on the platform login. It does not read an organisation id from the body. List requires `entitlements.view`. Toggle requires `entitlements.manage`. `GET /health` is unchanged. The auth, webhooks, and ops hostnames answer 404.

- [ ] **Step 1: Write the failing tests**

`entitlements.test.ts` rejects `{ communitySlug, organisationId }` and rejects a toggle body that omits `enabled`.

`entitlement-routes.test.ts` expects both routes on surface `tenant`. A request whose `x-community-hub-hostname` is the auth hostname is 404. The same path on the API hostname with no bearer is 401.

The integration test creates an organisation, a plan, an allocation, and a `community_admin` grant. Inside `withRequest`, list returns `{ keys: [{ key: "people.directory", enabled: true }], canManage: true }` sorted by key. A `staff` grant returns `canManage: false`. Toggle to false returns 200 and appends `entitlements.toggle.changed` with targets organisation id then community id. A second toggle to false appends no audit row. A key that is not allocated returns 400 and appends no toggle-changed row. A user with no grant receives 403 and one `entitlements.permission.denied` row. Logs passed to `deps.log` are the path, the status, and the request id, and the serialised fields do not contain the slug or the key.

Call the toggle handler inside `withRequest({ requestId: "not-a-uuid" })` after a real change would have been written. The response is 500 and the toggle row is back to its previous state.

The tests fail because the routes are absent.

- [ ] **Step 2: Add the routes**

Parse with the Zod schemas. Resolve the slug. On an unknown slug return 404. `checkout("app")` and `withAppTransaction` for `holdsPermission` and `appendAuditEvent`. `checkout("platform")` for `readSnapshot` and `setToggle`. List keeps keys that pass `evaluate` steps 1 to 3. `canManage` is a second `holdsPermission` for `entitlements.manage` and does not 403 by itself.

On `changed`, append the audit after the platform write. If that append throws, call `setToggle` with the previous `enabled` value and return 500. If the restore throws, still return 500.

Wire `entitlementRoutes` beside `accessRoutes` in `bindServices` and `productionRoutes`. Add the two workspace dependencies. `pnpm install`.

- [ ] **Step 3: Pin the routes**

Delete `.strict()` from `listEntitlementsBody`. The extra-id test fails. Restore.

Return 200 before the hostname compare. The auth-hostname test fails. Restore.

Skip the restore `setToggle`. The bad-request-id test fails. Restore.

- [ ] **Step 4: Gate and commit**

```bash
git add packages/contracts/src/entitlements.ts packages/contracts/src/entitlements.test.ts packages/contracts/package.json apps/api/src/entitlement-routes.ts apps/api/src/entitlement-routes.test.ts apps/api/src/entitlement-flow.integration.test.ts apps/api/src/index.ts apps/api/package.json modules/core/entitlements/public/index.ts pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(api): list and toggle community entitlements

A failed audit write puts the toggle back. The body cannot carry an organisation id.

Refs: docs/plans/2026-10-12-entitlements-plans.md task 7
EOF
)"
```

---

### Task 8: Module Toggles

**Files:**

- Create: `apps/admin/src/visible-labels.ts`
- Create: `apps/admin/src/visible-labels.test.ts`
- Create: `apps/admin/src/module-toggles.tsx`
- Create: `apps/admin/src/module-toggles.test.tsx`
- Modify: `apps/admin/src/nav.tsx`
- Modify: `apps/admin/src/shell.tsx`
- Modify: `apps/admin/src/shell.test.tsx`

**Interfaces:**

- Produces: `visibleLabels(labels, entitledKeys, map)` as the spec states. The production map is an empty object in `nav.tsx`.
- Produces: route `/settings/modules`. Heading `Module Toggles`. Children under Settings, after Users & Roles.

**Rule this must not break:** the frozen `labels` array stays the sixteen strings. Dashboard's Refresh still does not call `fetch`. General Settings and Email Settings stay absent. The page does not render `Upgrade`, a currency sign, a name, an email, or a phone.

- [ ] **Step 1: Write the failing tests**

`visible-labels.test.ts` with an empty map returns Dashboard and Settings and omits Contacts & Members. The test map `{ "Contacts & Members": "people.directory" }` includes that label only when the entitled set contains `people.directory`.

The shell test expects three links: Dashboard, Users & Roles, Module Toggles. Settings is present and is not a link. Module Toggles href is `/settings/modules`. Every frozen label other than Dashboard and Settings is absent. The Refresh test still expects no `fetch`.

`module-toggles.test.tsx` with no token does not call `fetch` and shows `Sign in required`. With a token, Load posts `{ communitySlug }` to `https://au.api.example.test/v1/entitlements/list`. An empty `keys` array shows `No modules are allocated.` A returned key is a switch named with that key only when `canManage` is true. `canManage: false` renders the key and no switch. The document does not contain `Upgrade` or `$`. A 403 shows `You cannot manage modules`.

The tests fail because the route and the child link are absent.

- [ ] **Step 2: Add the page**

Follow the Users & Roles fetch, token, and origin checks. Register `{ path: "settings/modules", element: <ModuleTogglesPage /> }` beside `settings/users` in `shell.tsx`. The switch posts `{ communitySlug, key, enabled }` to `/v1/entitlements/toggle`. Do not put the slug or the token in a URL.

- [ ] **Step 3: Pin the page**

Render `Upgrade` in the empty state. The source test fails. Restore.

Add `Contacts & Members` to the production map. The shell test fails. Restore.

- [ ] **Step 4: Gate and commit**

```bash
git add apps/admin/src/visible-labels.ts apps/admin/src/visible-labels.test.ts apps/admin/src/module-toggles.tsx apps/admin/src/module-toggles.test.tsx apps/admin/src/nav.tsx apps/admin/src/shell.tsx apps/admin/src/shell.test.tsx
git commit -m "$(cat <<'EOF'
feat(admin): open Settings to Module Toggles

The production nav map stays empty, so Phase 2 labels stay off the page.

Refs: docs/plans/2026-10-12-entitlements-plans.md task 8
EOF
)"
```

---

### Task 9: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`
- Modify: `architecture.md`
- Create: `docs/adr/0012-entitlement-visibility.md`

**Rule this must not break:** Phase 0 stays `24 rows: 23 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stay `not started`. The open-items section of `docs/roadmap.md` stays. Q8 stays in the roadmap open questions. The only `AGENTS.md` edit is the repository-state sentence. `architecture.md` changes only the sentences below.

- [ ] **Step 1: Update the catalogue**

In the Where we are table, last shipped becomes `entitlements-plans` and next chunk becomes `stripe-billing`. The phase stays `1 — Core platform`.

The Phase 1 row for `entitlements-plans` becomes `done`. Its What cell becomes `Plans and allocations in the platform schema. Community toggles; nav hide/show. Spec docs/specs/2026-10-12-entitlements-plans.md.` The sentence under the Phase 0 table becomes `Next is stripe-billing.` The Next spec section names `stripe-billing`.

In `AGENTS.md`, in the repository-state cell, replace the next-chunk name `entitlements-plans` with `stripe-billing`. Leave the Phase 0 counts and the rest of that cell unchanged.

In `architecture.md` §8.1, rename the packages line `entitlements/` to `entitlements-eval/`. Leave the comment `snapshot reader, entitled(), limit()`.

In §6.3, the region-scoped platform row names `core/tenancy` for directory rows and `core/entitlements` for plans, add-ons, entitlements, allocations, overrides, community toggles, and feature flags. No other module may query the schema. The CI sentence names both modules as the only ones that may reference the `platform` schema. The identity clause stays.

In §10.1, the Allocation stored-in cell becomes `platform.community_allocations`. The Override stored-in cell becomes `platform.entitlement_overrides`. An unexpired override satisfies the entitlement step only. Both open Q14 pointers go.

In §10.3 and §10.4, replace the Q14 leaning with this decision. A request reads those rows from the `platform` schema on the platform login. The process cache is at most 60 seconds, keyed by organisation id and community id. The writer deletes its own key. There is no snapshot table and no propagation job. `stripe-billing` writes the same tables from the webhook and does not publish a snapshot. The Q15 paragraph in §10.4 stays, still open.

In §26, the Q14 result becomes: closed by ADR 0012 and `docs/specs/2026-10-12-entitlements-plans.md`. A request reads the platform tables, with an in-process cache of at most 60 seconds. There is no snapshot and no propagation step. Do not leave the leaning beside that result.

`docs/adr/0012-entitlement-visibility.md` uses the ADR 0011 headings. Status accepted. Date is the date of this commit. Spec is `docs/specs/2026-10-12-entitlements-plans.md`. Context is Q14 and the old single-owner sentence for the `platform` schema. Decision is the 60-second read path and the two modules that may query that schema. Consequences name `stripe-billing` as the webhook writer and leave Q8 and Q15 open. Alternatives rejected are a snapshot table, a propagation job, and a feature-flag vendor.

- [ ] **Step 2: Gate and commit**

```bash
git add docs/roadmap.md AGENTS.md architecture.md docs/adr/0012-entitlement-visibility.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark entitlements-plans done

The next Phase 1 chunk is stripe-billing. A request may cache platform rows for 60 seconds.

Refs: docs/plans/2026-10-12-entitlements-plans.md task 9
EOF
)"
```

Q14 is closed by this chunk. Staging stays parked.

## Human

The agent does not apply and does not merge. Staging stays parked. There is no Terraform apply in this chunk.

The second fresh-context review starts when the pull request opens. That line stays open until that review is written.
