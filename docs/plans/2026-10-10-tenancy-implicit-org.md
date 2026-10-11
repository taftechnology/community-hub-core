Spec: docs/specs/2026-10-10-tenancy-implicit-org.md

# Implicit organisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store an implicit organisation and its one community in the `platform` schema, and look a community up by slug.

**Architecture:** Four commits. The first adds the tenancy package, the manifest, and the slug rule. The second adds the two tables to the product journal. The third adds the command and the query, proved on the existing Docker Postgres. The fourth updates the catalogue. No HTTP route and no apply.

**Tech Stack:** TypeScript, Drizzle ORM `0.45.2`, `postgres` `3.4.9`, Vitest, Node 24, Docker `postgres:17`. No new third-party package.

Status: approved (2026-10-10, Abdus)

**Branch:** `feat/2026-10-10-tenancy-implicit-org` · one PR · 4 tasks, one commit each

## Global Constraints

- The spec Status line is `draft` until the owner approves it by name.
- Do not start Task 1 until this plan's Status line is `approved`. Do not mark this plan approved yourself.
- Do not edit `architecture.md`. No ADR. Do not edit `apps/api`, `apps/admin`, `infra/`, or `.github/workflows/ci.yml`.
- Do not add a column that the spec does not name. No `created_at`, `name`, `type`, `logo_url`, `public_location`, or `verified`. No `mobile_apps` and no `app_listings`.
- Do not add a command that inserts a second community or sets `kind` to `explicit`.
- Do not import `@community-hub/crypto` from `modules/core/tenancy`, including `import type`. The existing ESLint ban stays. Do not add a fixture for it.
- `packages/db/src` does not import `@community-hub/tenancy`.
- The public functions take `sql: Sql` from `postgres` first. They do not open a connection and they do not call `set_config`.
- Staging stays parked. Do not change `enable_database`, `desired_count`, or add `service_image`.
- The password re-read paragraph in `docs/roadmap.md` stays as it is. This chunk does not serve a request.
- Migration wave: expand. One additive journal entry. No backfill. No `DROP` in this entry.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- Tenancy is a sensitive chunk. The second fresh-context review starts when the pull request opens. Leave that line open. Do not write the second review. The agent does not merge and does not apply.
- Every task runs `pnpm gate` before its commit. Format the files in that commit first: `pnpm exec prettier --write` on those paths. A code fence inside a list item is indented so Prettier does not join the list.
- Docker Postgres is started by the `@community-hub/db` test setup. Do not add a second compose file. If Docker is missing, stop and report. Do not skip the integration test.

**Rollback:** A later contract migration drops `platform.communities`, then `platform.organisations`. This journal entry is not edited after it ships. Revert of the PR before merge removes the entry with the branch. No Terraform change. Staging is unchanged.

**Cost:** No new hourly or monthly resource. Staging stays parked.

## File map

| File                                                                            | Responsibility                                                         |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm-workspace.yaml`                                                           | One new workspace member, `modules/core/tenancy`.                      |
| `modules/core/tenancy/`                                                         | Manifest, domain rule, schema, command, query, and their tests.        |
| `packages/db/drizzle.config.ts`                                                 | Kit reads `packages/db/drizzle.schema.ts` only.                        |
| `packages/db/drizzle.schema.ts`                                                 | Passes the one `platform` schema into `platformTables`.                |
| `packages/db/drizzle/`                                                          | One new journal entry after `0002_rare_jimmy_woo`.                     |
| `modules/core/tenancy/infrastructure/implicit-organisation.integration.test.ts` | Command, query, rollback, parsers, and role denial.                    |
| `docs/roadmap.md`, `AGENTS.md`                                                  | Catalogue. The only `AGENTS.md` edit is the repository-state sentence. |

## Dependencies

`@community-hub/tenancy` depends on `@community-hub/db` and `@community-hub/kernel` at `workspace:*`, plus the existing pins `drizzle-orm` `0.45.2` and `postgres` `3.4.9`. Dev dependencies match `@community-hub/kernel`: `typescript` `^5.8.2`, `@types/node` `^22.13.10`, `vitest` `^4.1.11`. No other dependency. `@community-hub/db` does not depend on `@community-hub/tenancy`. The integration test runs in the tenancy package. Its Vitest config uses `packages/db/test/global-setup.ts` and the plaintext factories. `turbo.json` runs `@community-hub/db#test` before `@community-hub/tenancy#test`, so the two suites do not share one Docker Postgres at the same time.

## Security pins

These are the settings named in the spec. For each one, during the task that adds the test, change the source once, see that test fail, restore the source, and report the failure. The report is session scratch. The weakened tree is never committed.

| Setting                                                     | Test                                    | Source change that must fail it                                         |
| ----------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| Invalid slug is rejected                                    | Domain test rejects `Example`           | Make `implicitPair` return that slug                                    |
| No `org_id`, no RLS                                         | SQL test on the generated journal entry | Add `"org_id"` or `ENABLE ROW LEVEL SECURITY` to that SQL, then restore |
| Duplicate community slug rolls back the organisation insert | Integration test                        | Insert the organisation outside `sql.begin`                             |
| `app` and `identity` have no schema or table privilege      | Integration test                        | Add `GRANT USAGE ON SCHEMA platform TO app` to the journal SQL          |
| No `set_config`                                             | Source test                             | Add a `set_config` call in `infrastructure/implicit-organisation.ts`    |
| Stored kind is `implicit`                                   | Integration test                        | Write `explicit` from the command                                       |

---

### Task 1: Package, manifest, and slug rule

**Files:**

- Modify: `pnpm-workspace.yaml`
- Create: `modules/core/tenancy/package.json`
- Create: `modules/core/tenancy/tsconfig.json`
- Create: `modules/core/tenancy/tsconfig.test.json`
- Create: `modules/core/tenancy/vitest.config.ts`
- Create: `modules/core/tenancy/module.manifest.ts`
- Create: `modules/core/tenancy/domain/error.ts`
- Create: `modules/core/tenancy/domain/slug.ts`
- Create: `modules/core/tenancy/domain/slug.test.ts`
- Create: `modules/core/tenancy/domain/manifest.test.ts`
- Create: `modules/core/tenancy/public/index.ts`
- Modify: `pnpm-lock.yaml`

**Interfaces:**

- Produces: `implicitPair({ organisationSlug, communitySlug })` returns `{ organisationSlug, communitySlug, region: "au", kind: "implicit" }` or throws `ImplicitOrganisationError` with `code` `invalid_slug`.
- Produces: `ImplicitOrganisationError extends Error` with `code: "duplicate_organisation_slug" | "duplicate_community_slug" | "invalid_slug"`.
- Produces: `defineModule` key `core.tenancy`, version `1`, empty `requires`, `publishes`, `subscribes`, and `ports`. `dataClasses` is the eight keys below, each `"internal"`. No `entitlement`, `features`, `permissions`, or `website`.

**Rule this must not break:** domain imports no Drizzle, no `postgres`, and no `@community-hub/db`. The package does not import `@community-hub/crypto`.

- [ ] **Step 1: Write the failing tests**

`domain/slug.test.ts` imports `implicitPair` and `ImplicitOrganisationError`.

`implicitPair({ organisationSlug: "example-parish", communitySlug: "example-parish" })` returns both slugs, `region` `"au"`, and `kind` `"implicit"`. The same slug for both arguments is valid.

These throw `ImplicitOrganisationError` and `code` `"invalid_slug"`: `Example`, `a_b`, `-ab`, `ab-`, `""`, `"ab"`, and `"a".repeat(64)`. `"a".repeat(63)` and `"abc"` are valid. A label shorter than 3 characters is rejected. These reserved names are also rejected: `admin`, `api`, `app`, `assets`, `au`, `auth`, `billing`, `cdn`, `docs`, `help`, `login`, `mail`, `ops`, `portal`, `staging`, `static`, `status`, `support`, `www`. Assert `error instanceof ImplicitOrganisationError` and `error instanceof Error`.

`domain/manifest.test.ts` imports the manifest. It equals:

```ts
{
  key: "core.tenancy",
  version: 1,
  requires: [],
  publishes: [],
  subscribes: [],
  ports: [],
  dataClasses: {
    "organisations.id": "internal",
    "organisations.slug": "internal",
    "organisations.region": "internal",
    "organisations.kind": "internal",
    "communities.id": "internal",
    "communities.organisation_id": "internal",
    "communities.slug": "internal",
    "communities.region": "internal",
  },
}
```

Run the tenancy test script. It fails because the files do not exist.

- [ ] **Step 2: Add the package**

`pnpm-workspace.yaml` gains `- "modules/core/tenancy"`. No other glob.

`package.json` name `@community-hub/tenancy`, `"type": "module"`, `"private": true`, `"version": "0.0.0"`. Exports `"."` to `./dist/public/index.js` with types `./dist/public/index.d.ts`. Scripts: `lint` is `eslint .`, `typecheck` is `tsc --build && tsc --noEmit -p tsconfig.test.json`, `test` is `vitest run --config vitest.config.ts`, `build` is `tsc --build`.

`tsconfig.json` extends `../../tsconfig.base.json`, `rootDir` `"."`, `outDir` `./dist`. Include the manifest, `domain/**/*.ts`, `public/**/*.ts`, `db/**/*.ts`, and `infrastructure/**/*.ts`. Exclude `**/*.test.ts`.

`tsconfig.test.json` extends the base, `noEmit` true, `composite` false, `rootDir` `"."`, include the same trees plus the tests.

`vitest.config.ts` includes `domain/**/*.test.ts`, `db/**/*.test.ts`, and `infrastructure/**/*.test.ts`.

`domain/error.ts` is the class. The constructor takes the `code`, sets `this.name` to `ImplicitOrganisationError`, and passes `code` to `super`.

`domain/slug.ts` exports `implicitPair`. The slug pattern, used as a full-string match, is `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`. The domain also rejects a slug shorter than 3 characters. These names are reserved in that function, not in the database check: `admin`, `api`, `app`, `assets`, `au`, `auth`, `billing`, `cdn`, `docs`, `help`, `login`, `mail`, `ops`, `portal`, `staging`, `static`, `status`, `support`, `www`. The database check is not changed. A failure throws `invalid_slug` before returning. The function always returns `region: "au"` and `kind: "implicit"`. It takes no region argument.

`module.manifest.ts` calls `defineModule` from `@community-hub/kernel/module` with the object the test expects, and exports that value as the default.

`public/index.ts` exports `ImplicitOrganisationError` only. The command and the query are Task 3.

`pnpm install` so the lockfile records the workspace package.

- [ ] **Step 3: Pin the slug rule**

Change `implicitPair` so `Example` is returned. The domain test fails. Restore the check.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the files in this task, then `pnpm gate`.

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml modules/core/tenancy
git commit -m "$(cat <<'EOF'
feat(tenancy): add the implicit organisation slug rule

The package can reject a slug that is not one DNS label.

Refs: docs/plans/2026-10-10-tenancy-implicit-org.md task 1
EOF
)"
```

---

### Task 2: Platform tables

**Files:**

- Create: `modules/core/tenancy/db/schema.ts`
- Create: `modules/core/tenancy/db/schema.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/drizzle.config.ts`
- Create: the Kit journal entry under `packages/db/drizzle/` and its `meta` snapshot
- Modify: `packages/db/drizzle/meta/_journal.json`

**Interfaces:**

- Consumes: the `platform` schema export from `@community-hub/db`, passed into `platformTables`. Do not call `pgSchema("platform")` again.
- Produces: `organisations` and `communities` table objects. Constraint names `organisations_slug_unique`, `organisations_region_au`, `organisations_kind`, `organisations_slug_label`, `communities_slug_unique`, `communities_region_au`, `communities_slug_label`, and `communities_organisation_id_idx`.

**Rule this must not break:** `schema-rls` still checks `app` tables only. These tables have no column named `org_id`, no policy, and no row level security. `packages/db/src` does not import tenancy.

- [ ] **Step 1: Write the failing SQL test**

`db/schema.test.ts` reads every `packages/db/drizzle/*.sql` file. It fails until one file contains `CREATE TABLE "platform"."organisations"` and `CREATE TABLE "platform"."communities"`.

That file must also contain `organisations_slug_unique`, `communities_slug_unique`, `communities_organisation_id_idx`, `organisation_id`, the slug pattern `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$` twice, `'au'`, `'implicit'`, and `'explicit'`.

The same file must not match `\borg_id\b`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, `ON DELETE CASCADE`, or `DEFAULT`.

- [ ] **Step 2: Add the schema and generate**

In `packages/db/src/index.ts`, add `export { platform } from "./namespaces.js";` so that `import { platform } from "@community-hub/db"` compiles. Do not export `app` or `identity` from that file in this task.

`db/schema.ts` exports `platformTables(platform)`. It does not import `@community-hub/db` and it does not call `pgSchema`. Both tables use `uuid("id").primaryKey()` with no default.

`organisations` columns: `id`, `slug` text not null, `region` text not null, `kind` text not null. Unique `organisations_slug_unique` on `slug`. Checks: `region = 'au'`, `kind in ('implicit', 'explicit')`, and `slug` matches the pattern. Do not call `enableRLS` or `pgPolicy`.

`communities` columns: `id`, `organisation_id` uuid not null references `organisations.id` with no `onDelete`, `slug` text not null, `region` text not null. Unique `communities_slug_unique` on `slug`. Index `communities_organisation_id_idx` on `organisation_id`, not unique. The same region check and slug check. No RLS.

`packages/db/drizzle.config.ts` `schema` is `./drizzle.schema.ts` only.

Kit `require()`s each schema file after it registers tsx. `@community-hub/db` is `"type": "module"`. Its `import` condition is `dist/index.js`, and that file imports `@community-hub/kernel`, which has no `require` export. A `require` condition on `.` therefore cannot point at `dist/index.js`. The removed `drizzle-platform.cjs` satisfied `require()` by calling `pgSchema("platform")` a second time. Do not add that file back, and do not add an `eslint-disable`.

`packages/db/drizzle.schema.ts` is the Kit entry. It imports `platform` from `./src/namespaces.ts`, the one `pgSchema("platform")`, and calls `platformTables(platform)`. It re-exports `auditEvents` and `outbox` from `./src/schema.ts`. Kit does not load `modules/core/tenancy/db/schema.ts` as its own schema path, so it never resolves `@community-hub/db` from that file. `packages/db/src` still does not import tenancy.

From `packages/db`, run `pnpm exec drizzle-kit generate`. Commit the new SQL, the new snapshot, and the journal entry. Do not edit `0000`, `0001`, or `0002`. Do not add `FORCE ROW LEVEL SECURITY`. If the generated SQL contains `ENABLE ROW LEVEL SECURITY`, the schema called RLS. Remove that from the schema and generate again. Do not delete the line from SQL while leaving it in the schema.

- [ ] **Step 3: Pin the platform shape**

Add `"org_id" uuid` to the generated organisations statement. The SQL test fails. Restore the file. Then add `ENABLE ROW LEVEL SECURITY` for `platform.organisations`. The SQL test fails. Restore the file.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the TypeScript in this task. Do not run Prettier on `.sql` or `.json` snapshots if it would reflow Kit output. Then `pnpm gate`.

```bash
git add modules/core/tenancy/db packages/db/src/index.ts packages/db/drizzle.config.ts packages/db/drizzle
git commit -m "$(cat <<'EOF'
feat(tenancy): add organisation and community platform tables

The journal stores ids, slugs, and region au, with no org_id and no RLS.

Refs: docs/plans/2026-10-10-tenancy-implicit-org.md task 2
EOF
)"
```

---

### Task 3: Command, query, and role denial

**Files:**

- Create: `modules/core/tenancy/infrastructure/implicit-organisation.ts`
- Create: `modules/core/tenancy/infrastructure/implicit-organisation.test.ts`
- Modify: `modules/core/tenancy/public/index.ts`
- Create: `modules/core/tenancy/infrastructure/implicit-organisation.integration.test.ts`
- Modify: `modules/core/tenancy/vitest.config.ts`
- Modify: `modules/core/tenancy/tsconfig.test.json`
- Modify: `turbo.json`

**Interfaces:**

- Consumes: `sql: Sql` from `postgres`, `implicitPair`, `newId` from `@community-hub/db`, and the table objects.
- Produces:

```ts
createImplicitOrganisation(
  sql: Sql,
  input: { organisationSlug: string; communitySlug: string },
): Promise<{ organisationId: string; communityId: string }>

findCommunityBySlug(
  sql: Sql,
  slug: string,
): Promise<{ id: string; organisationId: string; slug: string; region: string } | null>
```

`public/index.ts` exports those two functions and `ImplicitOrganisationError`.

**Rule this must not break:** the `platform` login writes. `app` and `identity` are denied. A failed insert leaves no new row. The functions do not call `set_config`.

- [ ] **Step 1: Write the failing tests**

`infrastructure/implicit-organisation.test.ts` reads `implicit-organisation.ts` and fails if the text matches `set_config` or `\bSET\b`.

`modules/core/tenancy/infrastructure/implicit-organisation.integration.test.ts` uses the db test harness. Vitest `globalSetup` is `packages/db/test/global-setup.ts`. Read `.runtime.json` from that directory. Apply product migrations with `createPlaintextDirectSql` on `productOnlyUrl`. Then open `postgres://platform:<password>@127.0.0.1:5432/hub_product_only` with `createPlaintextPlatformSql`. Encode the password. Import the plaintext factories through the `@community-hub/db/plaintext` test alias, not through `package.json` `exports`.

Call `createImplicitOrganisation(sql, { organisationSlug: "example-parish", communitySlug: "example-parish" })`. The resolved ids differ. A select on `platform.organisations` shows `kind` `implicit` and `region` `au`. A select on `platform.communities` shows that `organisation_id`, slug `example-parish`, and `region` `au`.

`findCommunityBySlug(sql, "example-parish")` returns `{ id, organisationId, slug, region: "au" }`. `findCommunityBySlug(sql, "missing-parish")` returns `null`. The result has no `kind` key.

A second call with `example-parish` and `example-parish` throws `code` `duplicate_organisation_slug`. The organisation count for that slug stays 1.

A call with `second-parish` and `example-parish` throws `code` `duplicate_community_slug`. A count of `platform.organisations` stays 1. `second-parish` is absent.

`Example` throws `invalid_slug` and does not insert.

Open the same database as `app` and as `identity` with the plaintext factories. `select * from platform.organisations` throws. The driver `code` is `42501`. As the direct login, `has_schema_privilege` for `USAGE` on `platform` and `has_table_privilege` for `SELECT` on both tables are false for `app` and for `identity`.

After both functions run, `sql.options.parsers` is unchanged. Snapshot the parsers object before the calls and compare it after.

Do not add `@community-hub/tenancy` to `packages/db`. `turbo.json` task `@community-hub/tenancy#test` depends on `@community-hub/db#test`.

The integration test fails because the functions are not exported.

- [ ] **Step 2: Implement the command and the query**

`createImplicitOrganisation` calls `implicitPair` first, so an invalid slug throws before `sql.begin`. Inside one `sql.begin`, insert the organisation, then the community. Ids come from `newId()`. `region` and `kind` come from `implicitPair`. The resolved value is `{ organisationId, communityId }`.

A driver error with `code` `"23505"` and `constraint_name` `organisations_slug_unique` throws `duplicate_organisation_slug`. `communities_slug_unique` throws `duplicate_community_slug`. The transaction rolls back because the error is thrown inside `sql.begin`. Any other error is rethrown. Do not match on the error message text.

`findCommunityBySlug` selects `id`, `organisation_id`, `slug`, and `region` where `slug` matches. It returns that object or `null`. It does not select `kind`.

Write the two inserts and the select as `postgres` tagged templates on the `Sql` the caller passed. Do not call `drizzle()`. Do not assign `client.options`. Do not cast the transaction. Do not call `createPlatformSql`, `createPlaintextPlatformSql`, or `set_config`.

`public/index.ts` exports the two functions and `ImplicitOrganisationError`.

- [ ] **Step 3: Pin the failure behaviour**

Insert the organisation outside `sql.begin`, then insert the community inside it. The duplicate community slug test fails because `second-parish` remains. Restore the single transaction.

Add `GRANT USAGE ON SCHEMA platform TO app` to the journal SQL. The privilege test fails. Restore the SQL.

Add `set_config("app.org_id", "00000000-0000-0000-0000-000000000000", true)` in the infrastructure file. The source test fails. Restore the file.

Write `kind` `explicit` in the insert. The integration test fails. Restore `implicit`.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the files in this task, then `pnpm gate`.

```bash
git add modules/core/tenancy/infrastructure modules/core/tenancy/public modules/core/tenancy/vitest.config.ts modules/core/tenancy/tsconfig.test.json turbo.json
git commit -m "$(cat <<'EOF'
feat(tenancy): create an implicit organisation and one community

A duplicate slug rolls back, and the app and identity logins cannot read the rows.

Refs: docs/plans/2026-10-10-tenancy-implicit-org.md task 3
EOF
)"
```

---

### Task 4: Catalogue

**Files:**

- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Consumes: the three commits above. This task does not change runtime code.
- Produces: the Phase 1 row done, and the next chunk `identity-otp`.

**Rule this must not break:** Phase 0 stays `23 rows: 22 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stay `not started`. The password re-read paragraph is unchanged. This is the only `AGENTS.md` edit.

- [ ] **Step 1: Update the catalogue**

In `docs/roadmap.md`:

- Snapshot last shipped becomes `tenancy-implicit-org`. Next chunk becomes `identity-otp`. Phase, Phase 0, and Later phases stay as they are.
- The sentence under the Phase 0 table becomes: Next is `identity-otp`.
- The Phase 1 row for `tenancy-implicit-org` becomes `done`. Keep the existing What sentence and append `Spec `docs/specs/2026-10-10-tenancy-implicit-org.md`.`
- The Next spec section names `identity-otp`.

In `AGENTS.md`, in the repository-state cell, replace `tenancy-implicit-org` with `identity-otp`. Leave the Phase 0 counts and the rest of that cell unchanged.

- [ ] **Step 2: Gate and commit**

`pnpm exec prettier --write docs/roadmap.md AGENTS.md`, then `pnpm gate`.

```bash
git add docs/roadmap.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark tenancy-implicit-org done

The next chunk is identity-otp. The Phase 0 counts stay as they are.

Refs: docs/plans/2026-10-10-tenancy-implicit-org.md task 4
EOF
)"
```

## Human

Approve this plan before Task 1. After Task 4, the pull request uses `.github/PULL_REQUEST_TEMPLATE.md`, links this spec and this plan, and leaves the second-review line open. The agent does not merge and does not apply. Staging stays parked.
