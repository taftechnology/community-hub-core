Spec: docs/specs/2026-10-12-access-roles.md

# Users and roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a community grant the built-in organisation and community roles, add up to 20 custom roles, link an adult person to a user, and open Settings → Users & Roles in the admin shell.

**Architecture:** Nine commits. Policy is a pure decision. People gains two reads and `people.restricted.read`. Access then adds the expand migration, the grant commands, custom roles, and the restricted-read gate. Contracts and the API follow. The admin page, the header change, and the catalogue are last. No apply.

**Tech Stack:** TypeScript, Drizzle ORM `0.45.2`, `postgres` `3.4.9`, Vitest, Node 24, Docker `postgres:17`, Zod `4.6.5`, React Router, Terraform `~> 1.11.0`. No new third-party package.

Status: approved (2026-10-12, Adnan Bin Hossen)

**Branch:** `feat/2026-10-12-access-roles` · one PR · 9 tasks, one commit each

## Global Constraints

- The spec and this plan stay `approved (2026-10-12, Adnan Bin Hossen)`. Review fixes update both so they describe rank, the removed bootstrap route, gateway CORS, and the human applies.
- Do not start Task 1 until this plan's Status line is `approved`. Do not mark this plan approved yourself.
- Do not add a column, a route, a package, a permission, or a public function the spec does not name.
- `readPerson` and `openPersonFieldKeys` stay as they are. This chunk does not change their signatures or their audit.
- `packages/db/src` does not import `@community-hub/access`. `db/schema.ts` does not call `pgSchema`.
- `@community-hub/crypto/testing` is a test alias only. No non-test file imports it. Access code does not call `generateDataKey` or `decrypt`.
- Access and people-fact commands take `tx: AppTransaction` first. They do not open a connection, do not call `set_config`, and do not call `sql.begin`. A unique-key race uses `tx.savepoint(name, fn)`. Raw `SAVEPOINT` SQL is not used. Audit commands run inside `withRequest`. They do not enter request context themselves.
- One journal entry, in Task 3, after `0006_people_org_scoped_uniques`. Later tasks do not add a migration. Migration wave: expand. No drop and no change to a people table, `app.audit_events`, or `app.outbox`.
- `org_id` and `community_id` in inserts are `current_setting(...)::uuid`, not bound parameters.
- Staging stays parked. Do not change `enable_database`, `desired_count`, or add `service_image`. Terraform edits are the admin response-headers `connect-src` local and the tenant API gateway `cors_configuration`. Do not apply.
- The agent does not apply and does not merge. Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- This chunk is authorisation and a minor's restricted read. The second fresh-context review starts when the pull request opens. Leave that line open. Do not write the second review.
- Every task runs `pnpm gate` before its commit. Format the files in that commit first: `pnpm exec prettier --write` on those paths. A code fence inside a list item is indented so Prettier does not join the list.
- Docker Postgres is started by the `@community-hub/db` test setup. Do not add a second compose file. If Docker is missing, stop and report. Do not skip the integration test.

**Rollback:** A later contract migration drops `app.custom_role_permissions`, `app.community_role_grants`, `app.user_links`, `app.custom_roles`, then `app.organisation_role_grants`. This journal entry is not edited after it ships. Revert of the PR before merge removes the entry with the branch. The header change reverts with the same PR. Staging flags are unchanged.

**Cost:** No new hourly or monthly resource. The response-headers policy already exists. Staging stays parked.

## File map

| File                                                 | Responsibility                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/policy/`                                   | `catalogue`, `bundle`, and `decide`. No database.                      |
| `modules/core/people/infrastructure/access-facts.ts` | `personIsMinor` and `hasGuardianView`.                                 |
| `modules/core/people/module.manifest.ts`             | Adds `people.restricted.read` only.                                    |
| `modules/core/access/`                               | Manifest, domain rules, schema, grants, custom roles, restricted read. |
| `packages/db/drizzle.schema.ts`                      | Passes the one `app` schema into `accessTables`.                       |
| `packages/db/drizzle/`                               | One new journal entry after `0006_people_org_scoped_uniques`.          |
| `packages/contracts/src/access.ts`                   | Strict request schemas. Export path `./access`.                        |
| `apps/api/src/access-routes.ts`                      | The eight POST routes.                                                 |
| `apps/admin/src/`                                    | Settings → Users & Roles and sign-in.                                  |
| `infra/modules/aws-admin-static/`                    | `connect-src` gains the API origin and the auth origin.                |
| `.github/workflows/ci.yml`                           | Publish exports the two origins. It does not print them.               |
| `docs/roadmap.md`, `AGENTS.md`                       | The sentences the spec names.                                          |

## Dependencies

`@community-hub/policy` has no runtime dependency. Dev dependencies match `@community-hub/people`: `typescript` `^5.8.2`, `@types/node` `^22.13.10`, `vitest` `^4.1.11`.

`@community-hub/access` depends on `@community-hub/policy`, `@community-hub/people`, `@community-hub/db`, and `@community-hub/kernel` at `workspace:*`, plus `drizzle-orm` `0.45.2` and `postgres` `3.4.9`. It does not depend on `@community-hub/tenancy` or `@community-hub/identity`. Tests may call tenancy's public `createImplicitOrganisation` and people's public commands. `@community-hub/db` does not depend on access.

`@community-hub/contracts` keeps Zod `4.6.5`. The `.` export stays `./dist/auth.js`. `package.json` exports gain `"./access"` to `./dist/access.js` with types `./dist/access.d.ts`.

Turbo order, so the one Docker Postgres is not shared concurrently:

- `@community-hub/people#test` depends on `^build` and `@community-hub/identity#test`. Remove `@community-hub/api#test` from that list.
- `@community-hub/access#test` depends on `^build` and `@community-hub/people#test`.
- `@community-hub/api#test` depends on `^build` and `@community-hub/access#test`.

`@community-hub/policy#test` uses the default `test` task. It has no `globalSetup`. The access Vitest config matches `modules/core/people/vitest.config.ts`, including the plaintext alias, the crypto testing alias, and `packages/db/test/global-setup.ts`.

## Security pins

These are the settings named in the spec. For each one, during the task that adds the test, change the source once, see that test fail, restore the source, and report the failure. The report is session scratch. The weakened tree is never committed.

| Setting                                          | Task | Test                             | Source change that must fail it                             |
| ------------------------------------------------ | ---- | -------------------------------- | ----------------------------------------------------------- |
| Policy does not import the database              | 1    | Source scan of `packages/policy` | Add `import "@community-hub/db"` in `src/decide.ts`         |
| `personIsMinor` does not decrypt or audit        | 2    | Source scan of `access-facts.ts` | Add `appendAuditEvent` in `personIsMinor`                   |
| People permission list is exactly one string     | 2    | Manifest test                    | Append `"people.export"` to `permissions`                   |
| `organisation_role_grants` has no `community_id` | 3    | SQL test                         | Add `"community_id" uuid` to that `CREATE TABLE`            |
| Community policies name `app.community_id`       | 3    | SQL test                         | Remove `app.community_id` from the `user_links` policy      |
| `FORCE ROW LEVEL SECURITY`                       | 3    | SQL test                         | Delete one `FORCE ROW LEVEL SECURITY` statement             |
| `app` cannot update the grant tables             | 3    | `has_table_privilege`            | Delete `REVOKE UPDATE` for `app.community_role_grants`      |
| `identity` cannot select grants                  | 3    | Privilege test                   | Add `GRANT SELECT ON app.community_role_grants TO identity` |
| No website and no entitlement                    | 3    | Manifest test                    | Add `website: { collections: ["access.roles"] }`            |
| Access does not import tenancy or identity       | 3    | Source scan                      | Import `@community-hub/identity` from `public/index.ts`     |
| Staging stays parked                             | 3    | Tfvars scan                      | Set `enable_database = true` in `staging.tfvars`            |
| A minor cannot be linked                         | 4    | Integration                      | Skip the `personIsMinor` check in `linkUser`                |
| A `community_admin` cannot grant `org_owner`     | 4    | Integration                      | Delete the organisation-role actor check                    |
| The last `org_owner` stays                       | 4    | Integration                      | Delete the `last_owner` count                               |
| A second tenant sees no grants                   | 4    | Cross-tenant select              | Change the `user_links` policy `USING` to `true`            |
| The twenty-first custom role is refused          | 5    | Integration                      | Compare the count with `21` instead of `20`                 |
| A permission outside the five strings is refused | 5    | Integration                      | Remove the catalogue membership check                       |
| A denied restricted read does not decrypt        | 6    | Audit count                      | Call `readPerson` before `decide`                           |
| A guardian is scoped to one child                | 6    | Two person ids                   | Pass `guardianView: true` for every person                  |
| Access does not call KMS decrypt                 | 6    | Source scan                      | Call `kms.decrypt` in `readPersonForActor`                  |
| An extra `organisationId` is 400                 | 7    | Route test                       | Delete `.strict()` from the grant schema                    |
| The auth hostname is 404 for access routes       | 7    | Route test                       | Return 200 before the hostname compare                      |
| The page does not render an email                | 8    | Render test                      | Render `grant.email` when present                           |
| `sessionStorage` keeps only the access token     | 8    | Sign-in test                     | Also set `community-hub.email`                              |
| `connect-src` names both origins                 | 8    | Terraform test                   | Remove `https://auth.au.${var.zone_name}` from the local    |

---

### Task 1: Permission decision

**Files:**

- Create: `packages/policy/package.json`
- Create: `packages/policy/tsconfig.json`
- Create: `packages/policy/tsconfig.test.json`
- Create: `packages/policy/vitest.config.ts`
- Create: `packages/policy/src/decide.ts`
- Create: `packages/policy/src/decide.test.ts`
- Create: `packages/policy/src/boundaries.test.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: `catalogue(): readonly string[]` returning `access.users.view`, `access.users.manage`, `access.roles.view`, `access.roles.manage`, `people.restricted.read`, in that order.
- Produces: `bundle(roleKey: string): readonly string[] | null` for the eleven roles in the spec table. `bundle("platform_admin")` is `null`. `finance`, `content_editor`, and `member` return an empty array, not `null`.
- Produces: `decide(input: DecideInput): boolean` with the spec's fields. Unknown role keys are ignored. `people.restricted.read` is true when `personScoped` and `guardianView` are both true, even with no roles. That same guardian input is false for `access.roles.manage`.

**Rule this must not break:** `packages/policy` imports no `@community-hub/db`, `@community-hub/people`, `@community-hub/identity`, or `@community-hub/crypto`. It has no runtime dependency.

- [ ] **Step 1: Write the failing tests**

`decide.test.ts` covers `org_owner` for all five permissions, `staff` for the two view permissions only, and `member` for none. A person-scoped guardian with no roles is allowed `people.restricted.read` and denied `access.roles.manage`. A guardian with `personScoped` false is denied `people.restricted.read`. `bundle("platform_admin")` is `null`. `bundle("finance")` deep-equals `[]`.

`boundaries.test.ts` reads every file under `packages/policy` and fails if any contains `@community-hub/db`, `@community-hub/people`, `@community-hub/identity`, `@community-hub/crypto`, `drizzle`, or `postgres`.

The tests fail because the package does not exist.

- [ ] **Step 2: Add the package**

`package.json` name `@community-hub/policy`, `"type": "module"`, `"private": true`, `"version": "0.0.0"`. Exports `"."` to `./dist/src/decide.js` with types `./dist/src/decide.d.ts`. Scripts match `@community-hub/people`. No `dependencies` key. `pnpm-workspace.yaml` already includes `packages/*`. Do not add a glob.

`tsconfig.json` matches a package that emits `dist`. `vitest.config.ts` includes `src/**/*.test.ts` and has no `globalSetup`.

`pnpm install` so the lockfile records the package.

- [ ] **Step 3: Pin the boundary**

Add `import "@community-hub/db"` in `src/decide.ts`. The boundary test fails. Restore the file.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the TypeScript in this task. Then `pnpm gate`.

```bash
git add packages/policy pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(policy): decide a permission from role bundles

A guardian view allows one child's restricted read and no manage permission.

Refs: docs/plans/2026-10-12-access-roles.md task 1
EOF
)"
```

---

### Task 2: People facts and the restricted-read permission

**Files:**

- Create: `modules/core/people/infrastructure/access-facts.ts`
- Create: `modules/core/people/infrastructure/access-facts.integration.test.ts`
- Create: `modules/core/people/infrastructure/access-facts.test.ts`
- Modify: `modules/core/people/public/index.ts`
- Modify: `modules/core/people/module.manifest.ts`
- Modify: `modules/core/people/domain/manifest.test.ts`

**Interfaces:**

- Produces: `personIsMinor(tx, personId): Promise<boolean | null>`. Unknown id is `null`. A known id is the clear `is_minor` value.
- Produces: `hasGuardianView(tx, guardianPersonId, childPersonId): Promise<boolean>`. True only when this community has a guardian link for that pair with `view` true.
- Produces: manifest `permissions: ["people.restricted.read"]`. Every other manifest field stays.

**Rule this must not break:** neither function selects a name, email, phone, or date of birth. Neither calls `appendAuditEvent`, `encrypt`, `decrypt`, or `set_config`. `readPerson` is unchanged.

- [ ] **Step 1: Write the failing tests**

The integration test uses the people harness: `withAppTransaction`, `createImplicitOrganisation`, and `createPerson`. An adult returns `false`. A minor returns `true`. A random uuid returns `null`. `hasGuardianView` is false before `linkGuardian`, true after a link with `view` true, and false for a different child. The audit table gains no row from these calls. Assert the SQL text of `access-facts.ts` does not contain `given_name`, `email`, `phone`, or `date_of_birth`.

`access-facts.test.ts` reads `access-facts.ts` and fails if it contains `appendAuditEvent`, `set_config`, `encrypt`, or `decrypt`.

`manifest.test.ts` expects `permissions` to deep-equal `["people.restricted.read"]` and still expects no `website` and no `entitlement`.

The tests fail because the functions and the permission are absent.

- [ ] **Step 2: Add the reads**

Implement the two functions with `tx` template queries. Select `is_minor` from `app.persons` and `view` from `app.guardian_links`, filtered by `org_id` and `community_id` from `current_setting`. Re-export both from `public/index.ts`. Add the one permission to the manifest. Do not change `readPerson`.

- [ ] **Step 3: Pin the reads**

Add `appendAuditEvent` inside `personIsMinor`. The source test fails. Restore the file.

Append `"people.export"` to `permissions`. The manifest test fails. Restore the file.

- [ ] **Step 4: Gate and commit**

```bash
git add modules/core/people
git commit -m "$(cat <<'EOF'
feat(people): expose minor and guardian facts for access

The reads stay on clear columns. The manifest names people.restricted.read.

Refs: docs/plans/2026-10-12-access-roles.md task 2
EOF
)"
```

---

### Task 3: Access package and the expand migration

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `turbo.json`
- Modify: `pnpm-lock.yaml`
- Create: `modules/core/access/package.json`
- Create: `modules/core/access/tsconfig.json`
- Create: `modules/core/access/tsconfig.test.json`
- Create: `modules/core/access/vitest.config.ts`
- Create: `modules/core/access/module.manifest.ts`
- Create: `modules/core/access/domain/error.ts`
- Create: `modules/core/access/domain/role.ts`
- Create: `modules/core/access/domain/role.test.ts`
- Create: `modules/core/access/domain/manifest.test.ts`
- Create: `modules/core/access/domain/boundaries.test.ts`
- Create: `modules/core/access/db/schema.ts`
- Create: `modules/core/access/db/schema.test.ts`
- Create: `modules/core/access/infrastructure/privileges.integration.test.ts`
- Create: `modules/core/access/public/index.ts`
- Modify: `packages/db/drizzle.schema.ts`
- Create: the Kit journal entry under `packages/db/drizzle/` and its `meta` snapshot
- Modify: `packages/db/drizzle/meta/_journal.json`

**Interfaces:**

- Produces: `AccessError extends Error` with `code` the thirteen strings in the spec's Contracts section.
- Produces: domain helpers, not exported from `public/index.ts`: `parseUuid`, `parseCustomRoleKey`, `parsePermissionList`, and `assertCustomRoleCapacity(count: number)`. Capacity throws `limit_reached` when `count` is 20 or more. The custom key matches `^[a-z][a-z0-9_]{1,31}$` and is not a built-in key and not `platform_admin`, `platform_support`, or `platform_security`. `Org_Owner` throws `invalid_role`.
- Produces: `defineModule` key `core.access`, version `1`, `requires: ["core.people"]`, empty `publishes`, `subscribes`, and `ports`. No `entitlement`, `features`, or `website`. `permissions` is the four `access.*` strings in the spec's order. `dataClasses` has one entry per column in the spec Data table. The key is the table name without `app.` and the column.
- Produces: `accessTables(app)` and one journal file containing the five tables.

**Rule this must not break:** domain imports no Drizzle, no `postgres`, and no `@community-hub/crypto`. The journal is expand-only. `schema-rls` still passes. `0000` through `0006` are not edited.

- [ ] **Step 1: Write the failing tests**

`domain/role.test.ts` accepts `choir_lead` and rejects `Org_Owner`, `org_owner`, `platform_admin`, `A`, and `has space`. `parsePermissionList(["access.users.view", "people.restricted.read"])` returns that list. An empty list, a duplicate, and `"giving.refund"` throw `invalid_permission`. `assertCustomRoleCapacity(19)` returns. `assertCustomRoleCapacity(20)` throws `limit_reached`. Assert `error instanceof AccessError`.

`domain/manifest.test.ts` expects the module object above, including every `dataClasses` entry, and no `website` or `entitlement` key.

`domain/boundaries.test.ts` reads every `.ts` file under `modules/core/access` and fails on `@community-hub/tenancy` or `@community-hub/identity`. It reads `infra/regions/au/env/staging.tfvars` and fails unless that file contains `enable_database = false` and `desired_count = 0`. It fails if any file in that directory contains `service_image`.

`db/schema.test.ts` finds the new journal file, the only `packages/db/drizzle/*.sql` file that contains `"app"."user_links"`. That file must contain `organisation_role_grants`, `community_role_grants`, `custom_roles`, `custom_role_permissions`, and `user_links`. It must contain `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY` once per those tables. The `CREATE TABLE` for `organisation_role_grants` must not contain `community_id`. Every other new `CREATE TABLE` must contain `community_id`. The `user_links` policy must contain `app.community_id`. The organisation-grant policy must contain `app.org_id` and must not contain `app.community_id`. The file must contain `REVOKE UPDATE, TRUNCATE` for each of the five tables and must not contain `ON DELETE CASCADE` or `DEFAULT`. It must contain each of the five catalogue permission strings inside the permission check.

`infrastructure/privileges.integration.test.ts` applies product migrations the way the people privilege test does. As `app`, `UPDATE` is false and `DELETE` is true on `app.community_role_grants`. As `identity` and as `platform`, `SELECT` on that table is false. As `app`, `SELECT` is true.

The tests fail because the package does not exist.

- [ ] **Step 2: Add the package and generate the journal**

`pnpm-workspace.yaml` gains `- "modules/core/access"`. No other glob.

`package.json` name `@community-hub/access`. Exports `"."` to `./dist/public/index.js`. Scripts and dev dependencies match `@community-hub/people`. Dependencies are the list in Dependencies above.

`db/schema.ts` exports `accessTables(app)`. It does not import column helpers from `@community-hub/crypto`. Primary keys, checks, partial unique indexes, and foreign keys with `onDelete: "restrict"` are the spec's Data section. `organisation_role_grants` has no `community_id`. Its policy is `org_isolation`, `FOR ALL`, `USING` and `WITH CHECK` on `app.org_id` only. Every other table's policy is `community_isolation`, `FOR ALL`, on both settings. Call `.enableRLS()` on each table.

`packages/db/drizzle.schema.ts` calls `accessTables(appNamespace)` and exports the five tables. Do not export them from `packages/db/src/index.ts`.

`public/index.ts` exports `AccessError` only, and calls `defineAuditAction` and `defineAuditPurpose` for the eight spec names. Do not export the commands yet.

From `packages/db`, run `pnpm exec drizzle-kit generate`. Commit the new SQL, the new snapshot, and the journal entry. Do not edit `0000` through `0006`. Hand-add `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and the `REVOKE UPDATE, TRUNCATE` statements. Do not hand-edit column lists. If a check or a partial index is missing, fix `schema.ts` and generate again.

Update `turbo.json` to the order in Dependencies. `pnpm install`.

- [ ] **Step 3: Pin the table shape**

Run each source change in the security-pins rows for this task. Restore after each failure.

- [ ] **Step 4: Gate and commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml turbo.json modules/core/access packages/db/drizzle.schema.ts packages/db/drizzle
git commit -m "$(cat <<'EOF'
feat(access): add role grant tables under row level security

Organisation grants have no community id. The app role cannot update them.

Refs: docs/plans/2026-10-12-access-roles.md task 3
EOF
)"
```

---

### Task 4: Links, bootstrap, and grants

**Files:**

- Create: `modules/core/access/infrastructure/grants.ts`
- Create: `modules/core/access/infrastructure/grants.integration.test.ts`
- Modify: `modules/core/access/public/index.ts`

**Interfaces:**

- Produces: `linkUser`, `unlinkUser`, `bootstrapOwner`, `grantRole`, and `revokeRole` with the spec signatures.
- `linkUser` calls `personIsMinor`. `true` is `minor_forbidden`. `null` is `not_found`.
- `bootstrapOwner` requires `userId === actorUserId`. It takes the organisation advisory lock, then inserts `org_owner` and `community_admin` only when both grant tables are empty for this transaction's scope. Two concurrent calls create one owner. There is no HTTP route.
- `grantRole` requires `access.roles.manage` from `decide` on the actor's current grants. An organisation role also requires the actor to hold `org_owner` or `org_admin`. Every permission in the granted role must already be allowed for the actor. A linked minor is `minor_forbidden`. A user with no link skips that check.
- `revokeRole` of the last `org_owner` is `last_owner` and leaves the row.
- Each success appends the spec's audit name. A `forbidden` from grant or revoke appends `access.permission.denied` and writes no grant change. `already_bootstrapped` writes no audit row.

**Rule this must not break:** inserts use `current_setting`. Access does not query `identity.users`, `app.persons`, or `app.guardian_links`. It calls `personIsMinor` for the minor check.

- [ ] **Step 1: Write the failing integration test**

Mint a tenant with `createImplicitOrganisation`. Create an adult and a minor with `createPerson`. Run inside `withRequest`.

`bootstrapOwner` returns two ids and one `access.owner.bootstrapped` row. A second call throws `already_bootstrapped` and the grant count stays. Two concurrent calls leave one owner. `linkUser` of the adult returns a link id and writes `access.user.linked`. `linkUser` of the minor throws `minor_forbidden` and writes no link. `linkUser` and `unlinkUser` refuse an actor who lacks `access.users.manage`. `grantRole` of `staff` by the owner writes `access.role.granted`. Only an `org_owner` may grant `org_owner`. An `org_admin` may grant `org_admin` and anything below it, and a community-level actor may grant only community-scoped roles they are allowed to hold. `grantRole` of `org_owner` by a `community_admin` or an `org_admin` throws `forbidden`. Revoke uses that same rank rule. Revoking the only `org_owner` throws `last_owner`. The owner count takes the organisation advisory lock. Two concurrent revokes of two owners leave one owner.

A second organisation's transaction selects none of the first organisation's `app.user_links` or `app.organisation_role_grants`.

The test fails because the commands are not exported.

- [ ] **Step 2: Implement the commands**

Load the actor's organisation keys, community keys, and custom permission strings, then call `decide`. Unique violations become `duplicate_link` or `duplicate_grant` after the savepoint rolls back. Export the five functions from `public/index.ts`.

- [ ] **Step 3: Pin the guards**

Skip the `personIsMinor` check. The minor link test fails. Restore.

Delete the organisation-role actor check. The `community_admin` test fails. Restore.

Delete the last-owner count. The revoke test fails. Restore.

Change the `user_links` policy `USING` to `true` in the new journal file. The cross-tenant test fails. Restore the policy.

- [ ] **Step 4: Gate and commit**

```bash
git add modules/core/access
git commit -m "$(cat <<'EOF'
feat(access): grant built-in roles and link an adult person

A minor cannot be linked. The last organisation owner cannot be revoked.

Refs: docs/plans/2026-10-12-access-roles.md task 4
EOF
)"
```

---

### Task 5: Custom roles

**Files:**

- Create: `modules/core/access/infrastructure/custom-roles.ts`
- Create: `modules/core/access/infrastructure/custom-roles.integration.test.ts`
- Modify: `modules/core/access/public/index.ts`
- Modify: `modules/core/access/infrastructure/grants.ts`

**Interfaces:**

- Produces: `createCustomRole` and `deleteCustomRole` with the spec signatures.
- `grantRole` accepts a `customRoleId` in this community. The actor must already hold every permission on that role.
- `deleteCustomRole` throws `role_in_use` when a community grant still points at the role. Otherwise it deletes permission rows, then the role, and appends `access.custom_role.deleted`.

**Rule this must not break:** the cap is 20. A permission outside `catalogue()` is `invalid_permission`. A custom role is community-scoped. There is no organisation custom role.

- [ ] **Step 1: Write the failing integration test**

As `org_owner`, `createCustomRole` of `choir_lead` with `access.users.view` returns an id and writes `access.custom_role.created`. Granting that id to another user writes a community grant with a null `role_key`. Creating the same key again throws `duplicate_role`. `"giving.refund"` throws `invalid_permission` and writes no role. The twenty-first distinct key throws `limit_reached`. Deleting a role that still has a grant throws `role_in_use`. After that grant is revoked, delete succeeds and the permission rows are gone.

The test fails because the commands do not exist.

- [ ] **Step 2: Implement custom roles**

Use `parseCustomRoleKey`, `parsePermissionList`, and `assertCustomRoleCapacity` from Task 3. Count existing `app.custom_roles` rows in the transaction. Insert the role and its permission rows in one transaction. Export both functions. Teach `grantRole` the custom id path without changing the built-in path.

- [ ] **Step 3: Pin the cap and the catalogue**

Compare the count with `21`. The limit test fails. Restore `20`.

Remove the `catalogue()` membership check. The `giving.refund` test fails. Restore the check.

- [ ] **Step 4: Gate and commit**

```bash
git add modules/core/access
git commit -m "$(cat <<'EOF'
feat(access): add community custom roles within the catalogue

The twenty-first role is refused. A granted custom role cannot be deleted.

Refs: docs/plans/2026-10-12-access-roles.md task 5
EOF
)"
```

---

### Task 6: Restricted read for an actor

**Files:**

- Create: `modules/core/access/infrastructure/restricted-read.ts`
- Create: `modules/core/access/infrastructure/restricted-read.integration.test.ts`
- Create: `modules/core/access/infrastructure/kms-boundary.test.ts`
- Modify: `modules/core/access/public/index.ts`

**Interfaces:**

- Produces: `readPersonForActor(tx, kms, keyArn, { personId, actorUserId })`.
- Denied: append `access.permission.denied` with purpose `people.restricted.read` and target the person id, throw `forbidden`, and do not call `readPerson`.
- Allowed: return the `readPerson` result. Do not append a second audit row.
- The actor's link, when present, is the guardian person id passed to `hasGuardianView` with this `personId`. No link means `guardianView` false.

**Rule this must not break:** `readPerson` is still the only decrypt path. A denied call writes no `people.person.read` row. A guardian allowance is for that child only.

- [ ] **Step 1: Write the failing integration test**

Use the crypto testing port. A `safeguarding_officer` read of a minor returns the person view and writes one `people.person.read` row. A `member` read throws `forbidden`, writes one `access.permission.denied` row, and writes no `people.person.read` row. Link an adult guardian with `view` true. That user, with no role, can read that child and is `forbidden` for a different person in the same community.

`kms-boundary.test.ts` reads every `.ts` file under `modules/core/access` except tests and fails if any contains `.decrypt(`, `generateDataKey(`, or `from "@community-hub/crypto/testing"`.

The test fails because `readPersonForActor` is absent.

- [ ] **Step 2: Implement the gate**

Call `decide` before `readPerson`. Export the function.

- [ ] **Step 3: Pin the gate**

Call `readPerson` before `decide`. The member test sees a `people.person.read` row and fails. Restore the order.

Pass `guardianView: true` whenever any guardian link exists, ignoring `personId`. The second-child test fails. Restore the person id argument.

Add `await kms.decrypt()`. The boundary test fails. Restore the file.

- [ ] **Step 4: Gate and commit**

```bash
git add modules/core/access
git commit -m "$(cat <<'EOF'
feat(access): gate a restricted person read on the actor

A denied call writes no people read audit. A guardian view is one child.

Refs: docs/plans/2026-10-12-access-roles.md task 6
EOF
)"
```

---

### Task 7: Contracts and the access routes

**Files:**

- Create: `packages/contracts/src/access.ts`
- Create: `packages/contracts/src/access.test.ts`
- Modify: `packages/contracts/package.json`
- Create: `apps/api/src/access-routes.ts`
- Create: `apps/api/src/access-routes.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/package.json`

**Interfaces:**

- Produces: one strict Zod object per request body in the spec's route table. `grantBody` is a union of the `roleKey` object and the `customRoleId` object, each strict, so a body cannot carry both and cannot carry `organisationId`.
- Produces: `accessRoutes(deps): GateRoute[]`, seven `POST` routes, surface `tenant`. There is no bootstrap route.
- The presented hostname must equal `deps.apiHostname`. Otherwise 404 with an empty body, before the session check.
- `readSession` on the identity checkout. A missing or unknown token is 401 with an empty body.
- `findCommunityBySlug` on the platform checkout. The route passes that pair to `withAppTransaction`. It does not read an organisation id or a community id from the body.
- Unknown slug after a valid session is 403, the same status as a community where the caller has no role.
- List success includes `permissions`, the catalogue permissions the caller holds. The actor id comes from the session and never from the body.
- `AccessError` maps as the spec's HTTP section. Error bodies are empty. Success JSON is the spec's shapes. List requires `access.roles.view`.
- `productionRoutes` and `run` include `accessRoutes` after the auth routes. `GET /health` is unchanged.

**Rule this must not break:** logs stay the existing request log. A log line for these routes has no body, token, slug, or email. `apps/api` may depend on `@community-hub/access` and `@community-hub/contracts`. Access still does not import tenancy or identity.

- [ ] **Step 1: Write the failing tests**

`access.test.ts` parses each success body and rejects `{ communitySlug: "ada", organisationId: "00000000-0000-4000-8000-000000000001" }` and a grant body that sets both `roleKey` and `customRoleId`.

`access-routes.test.ts` follows `auth-routes.test.ts`. Use hostnames `au.api.example.test` and `auth.au.example.test`. No token is 401. A token with an extra JSON key is 400. A grant body that includes `organisationId` or `actorUserId` is 400 and inserts no grant. List on the API hostname returns the owner grant and the caller's permissions. The same list on the auth hostname is 404. An unknown slug and a community where the caller has no role are both 403. Capture the log sink and fail if a recorded field contains `@` or the access token. One integration test drives list, grant, and revoke through the real server and a real database, with no mocked access module.

The route tests fail because `access-routes.ts` does not exist.

- [ ] **Step 2: Add the routes**

Add the contracts export. Add `@community-hub/access` to the API package dependencies. Wire `accessRoutes` in `index.ts` beside `authRoutes`. Checkout identity for `readSession`, platform for `findCommunityBySlug`, and app for `withAppTransaction`. Do not construct a KMS client on the list path.

- [ ] **Step 3: Pin the strict body and the hostname**

Remove `.strict()` from the grant schema. The `organisationId` test fails. Restore it.

Return 200 before the hostname compare. The auth-hostname test fails. Restore the compare.

- [ ] **Step 4: Gate and commit**

```bash
git add packages/contracts apps/api pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(api): post role grants on the API hostname

The community id comes from the directory slug. An extra body key is empty 400.

Refs: docs/plans/2026-10-12-access-roles.md task 7
EOF
)"
```

---

### Task 8: Settings, sign-in, and the header

**Files:**

- Modify: `apps/admin/src/shell.tsx`
- Modify: `apps/admin/src/shell.test.tsx`
- Create: `apps/admin/src/nav.tsx`
- Create: `apps/admin/src/sign-in.tsx`
- Create: `apps/admin/src/sign-in.test.tsx`
- Create: `apps/admin/src/users-roles.tsx`
- Create: `apps/admin/src/users-roles.test.tsx`
- Modify: `apps/admin/vitest.config.ts`
- Modify: `infra/modules/aws-admin-static/main.tf`
- Modify: `infra/modules/aws-admin-static/tests/admin.tftest.hcl`
- Modify: `.github/workflows/ci.yml`
- Create: `tooling/checks/image-publish/publish-origins.test.ts`

**Interfaces:**

- The nav has accessible name `Admin`. Dashboard links to `/`. Settings is text, not a link. Its only child links to `/settings/users` with name `Users & Roles`. The other fourteen labels are absent. General Settings and Email Settings are absent.
- Dashboard heading and Refresh stay. Refresh reloads and does not call `fetch`.
- `/sign-in` and `/settings/users` are routes. Both include the nav.
- Missing `VITE_API_ORIGIN` or `VITE_AUTH_ORIGIN` shows `Directory unavailable` and does not call `fetch`.
- The token key is `community-hub.access-token`. Sign-in posts to the auth origin paths in the spec. A 200 stores `accessToken` only and navigates to `/settings/users`. Any other status shows `Sign-in failed` and does not show the address.
- Users & Roles without a token shows `Sign in required` and a `Sign in` link, and does not call `fetch`. Load posts `{ communitySlug }`. Empty grants show `No role grants` and no bootstrap control. `Grant`, `Revoke`, and `Delete custom role` render only with `access.roles.manage`. `Link` and `Unlink` render only with `access.users.manage`. At 20 custom roles, `Create custom role` is absent and the page shows `Custom role limit reached`. A 403 shows `You cannot manage roles`. A 409 shows `That change was rejected`. The rendered text does not include a fixture email.
- The tenant API `cors_configuration` allows `https://admin.${var.zone_name}`, methods `GET`, `POST`, and `OPTIONS`, and headers `authorization` and `content-type`, with credentials off. The ops API has no CORS configuration.
- `content_security_policy` keeps every directive except `connect-src`. That directive becomes `'self' https://au.api.${var.zone_name} https://auth.au.${var.zone_name}`. The test zone stays `example.net`. `override_during` stays `plan`.
- `admin-publish` reads `vars.ADMIN_API_ORIGIN` and `vars.ADMIN_AUTH_ORIGIN`. Those are repository variables, not secrets. The empty check for the publish role, bucket, and distribution stays separate from the empty check for the two origins. Neither echo prints the origin names or calls the origins secrets. Before `pnpm --filter @community-hub/admin build`, the step exports them as `VITE_API_ORIGIN` and `VITE_AUTH_ORIGIN`. No new `aws` command. No new checker violation id.

**Rule this must not break:** the frozen `labels` array stays. Dashboard still does not call `fetch`. The other response headers stay. Staging tfvars stay parked. The agent does not apply.

Scratch probe, already run outside the repo, not committed: the existing `happy` run with this `connect-src` equality, `override_during = plan`, variables `zone_name = "example.net"`, no var file, no apply. `terraform` `1.11.4` `test` passed (`1 passed, 0 failed`). The scratch copy could not reuse the repo lock's provider hashes on Windows, so that copy initialized its own lock and used `hashicorp/aws` `6.68.0`. The repo lock is unchanged. Do not point the probe at a real var file.

- [ ] **Step 1: Write the failing tests**

Rewrite the shell test that expected a single Dashboard link. It still expects the frozen label array. The nav has two links, Dashboard and Users & Roles. Settings is present and is not a link. Every frozen label other than Dashboard and Settings is absent. The Refresh test still expects no `fetch` and one reload. The axe run still expects no violations, with `color-contrast` disabled as it is now. Run axe on the sign-in page and the users page as well.

`sign-in.test.tsx` stubs a 200 verify body `{ accessToken: "token-1", userId: "00000000-0000-4000-8000-000000000002", refreshToken: "refresh-1", expiresIn: 900 }`. After Verify, `sessionStorage` has only the access token. `community-hub.email` is absent. The verify URL is `https://auth.au.example.test/v1/auth/email-otp/verify`. A 503 shows `Sign-in failed` and does not show `ada@example.com`.

`users-roles.test.tsx` with no token does not call `fetch`. With a token, Load posts the slug to `https://au.api.example.test/v1/access/grants/list` and renders the returned user id and `org_owner`. The fixture email `ada@example.com` is not in the document. A list of 20 custom roles hides `Create custom role` and shows `Custom role limit reached`.

`publish-origins.test.ts` reads `.github/workflows/ci.yml` and requires `vars.ADMIN_API_ORIGIN`, `vars.ADMIN_AUTH_ORIGIN`, `export VITE_API_ORIGIN`, and `export VITE_AUTH_ORIGIN` inside the `admin-publish` job. It fails if that job contains `echo` of either origin name.

The Terraform assert replaces the old `connect-src 'self'` equality with:

`default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' https://au.api.example.net https://auth.au.example.net`

The other asserts in that block stay.

Set the two example origins in `apps/admin/vitest.config.ts` `test.env`. A test calls `vi.stubEnv("VITE_API_ORIGIN", "")` and expects `Directory unavailable` with no fetch.

The tests fail because the routes and the header string are unchanged.

- [ ] **Step 2: Implement the pages and the header**

Share the nav from `nav.tsx`. Keep `createBrowserRouter`. Add the two routes. Forms use `<label>` text that matches the accessible names in the spec. Do not put the slug, the token, or an email in a URL.

Change only the `connect-src` portion of `local.content_security_policy`. Extend the publish step's `env` and its empty check. Export the two variables before the admin build.

- [ ] **Step 3: Pin the page and the header**

Render `grant.email` in the list. The email test fails. Restore.

Set `sessionStorage` `community-hub.email` in the verify success path. The storage test fails. Restore.

Remove `https://auth.au.${var.zone_name}` from the local. The Terraform test fails. Restore.

Remove `ADMIN_API_ORIGIN` from the empty check. The publish-origins test fails. Restore.

- [ ] **Step 4: Gate and commit**

`pnpm gate` includes the offline Terraform test. Do not apply.

```bash
git add apps/admin infra/modules/aws-admin-static .github/workflows/ci.yml tooling/checks/image-publish/publish-origins.test.ts
git commit -m "$(cat <<'EOF'
feat(admin): open Settings to Users and Roles

Sign-in keeps the access token only. connect-src allows the API and auth origins.

Refs: docs/plans/2026-10-12-access-roles.md task 8
EOF
)"
```

---

### Task 9: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`

**Rule this must not break:** Phase 0 stays `24 rows: 23 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stay `not started`. The startup sentence, the key-cache sentence, the `is_minor` sentence, and the Fargate sentence stay. `architecture.md` is not edited. The only `AGENTS.md` edit is the repository-state sentence.

- [ ] **Step 1: Update the catalogue**

In the Where we are table, last shipped becomes `access-roles` and next chunk becomes `entitlements-plans`. The phase stays `1 — Core platform`.

The Phase 1 row for `access-roles` becomes `done` and links `docs/specs/2026-10-12-access-roles.md`. The sentence under the Phase 0 table becomes `Next is entitlements-plans.` The Next spec section names `entitlements-plans`.

Replace the open-item sentence that begins `` `withAppTransaction` does not verify `` with: the access routes derive both ids from `findCommunityBySlug`. `withAppTransaction` does not verify that a community belongs to an organisation. Later routes follow the same directory lookup and never take either id from request input.

In `AGENTS.md`, in the repository-state cell, replace the next-chunk name `access-roles` with `entitlements-plans`. Leave the Phase 0 counts and the rest of that cell unchanged.

- [ ] **Step 2: Gate and commit**

```bash
git add docs/roadmap.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark access-roles done

The next Phase 1 chunk is entitlements-plans. Staging stays parked.

Refs: docs/plans/2026-10-12-access-roles.md task 9
EOF
)"
```

The access routes derive both ids from the directory. The next chunk is entitlements-plans.

## Human

Before merge, the repository variables `ADMIN_API_ORIGIN` and `ADMIN_AUTH_ORIGIN` must exist. They are variables, not secrets.

Two applies, run by a human. The agent does not apply.

1. The admin content-security policy `connect-src` in `infra/modules/aws-admin-static`.
2. The API gateway CORS configuration in `infra/modules/aws-ingress`.
