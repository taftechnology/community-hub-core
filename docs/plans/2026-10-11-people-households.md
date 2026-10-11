Spec: docs/specs/2026-10-11-people-households.md

# People and households Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record a person, a household, and a guardian link, with `is_minor` fixed at insert, a minor's confidential fields under the household key, person tags, and an activity log that holds no personal fields.

**Architecture:** Eight commits. The first adds the package, the domain rules, and every `app` table in one expand migration. The next three add keys, households, and persons. Guardians, tags, and the field-key resolver follow. The last commit is the catalogue. No apply.

**Tech Stack:** TypeScript, Drizzle ORM `0.45.2`, `postgres` `3.4.9`, Vitest, Node 24, Docker `postgres:17`, `@community-hub/crypto`. No new third-party package.

Status: approved (2026-10-11, Adnan Bin Hossen)

**Branch:** `feat/2026-10-11-people-households` · one PR · 8 tasks, one commit each

## Global Constraints

- The spec Status line is `approved (2026-10-11, Adnan Bin Hossen)`. Do not edit the spec.
- Do not start Task 1 until this plan's Status line is `approved`. Do not mark this plan approved yourself.
- Do not add a column, a route, a package, or a public function the spec does not name.
- `readPerson` and `openPersonFieldKeys` each append exactly one `people.person.read` row. Both call an internal helper that does not append. `readPerson` must not call `openPersonFieldKeys`.
- `packages/db/src` does not import `@community-hub/people`. `db/schema.ts` does not call `pgSchema`.
- `@community-hub/crypto/testing` is a test alias only. No non-test file imports it.
- People commands take `tx: AppTransaction` first. They do not open a connection, do not call `set_config`, and do not call `sql.begin`. A unique-key race uses `tx.savepoint(name, fn)`, the same call audit append uses. Raw `SAVEPOINT` SQL is not used.
- One journal entry, in Task 1, after `0004_solid_the_twelve`. Later tasks do not add a migration. Migration wave: expand. No drop and no change to `app.audit_events` or `app.outbox`.
- `org_id` and `community_id` in inserts are `current_setting(...)::uuid`, not bound parameters.
- Staging stays parked. Do not change `enable_database`, `desired_count`, or add `service_image`. Do not edit `infra/` or `.github/workflows/ci.yml`.
- Do not add an HTTP route, an admin screen, a group, an age band, a person-to-user link, or an update of `is_minor`.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed.
- This chunk is children's data, encryption, and tenancy. The second fresh-context review starts when the pull request opens. Leave that line open. Do not write the second review. The agent does not merge and does not apply.
- Every task runs `pnpm gate` before its commit. Format the files in that commit first: `pnpm exec prettier --write` on those paths. A code fence inside a list item is indented so Prettier does not join the list.
- Docker Postgres is started by the `@community-hub/db` test setup. Do not add a second compose file. If Docker is missing, stop and report. Do not skip the integration test.
- There are no Terraform asserts in this plan. No scratch probe.

**Rollback:** A later contract migration drops the new tables in the spec's order. This journal entry is not edited after it ships. Revert of the PR before merge removes the entry with the branch. No Terraform change. Staging is unchanged.

**Cost:** No new hourly or monthly resource. Staging stays parked.

## File map

| File                                              | Responsibility                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm-workspace.yaml`                             | One new workspace member, `modules/core/people`.                           |
| `turbo.json`                                      | `@community-hub/people#test` after the identity test.                      |
| `modules/core/people/`                            | Manifest, domain rules, schema, keys, persons, guardians, tags, and tests. |
| `packages/db/drizzle.schema.ts`                   | Passes the one `app` schema into `peopleTables`.                           |
| `packages/db/drizzle/`                            | One new journal entry after `0004_solid_the_twelve`.                       |
| `packages/db/src/audit-append.ts`                 | Accepts `OrgTransaction \| AppTransaction`.                                |
| `architecture.md`, `docs/roadmap.md`, `AGENTS.md` | The sentences the spec names.                                              |

## Dependencies

`@community-hub/people` depends on `@community-hub/db`, `@community-hub/kernel`, and `@community-hub/crypto` at `workspace:*`, plus `drizzle-orm` `0.45.2` and `postgres` `3.4.9`. Dev dependencies match `@community-hub/tenancy`: `typescript` `^5.8.2`, `@types/node` `^22.13.10`, `vitest` `^4.1.11`. No dependency on `@community-hub/tenancy` or `@community-hub/identity`. Tests insert `platform.organisations` and `platform.communities` with SQL. They do not import those packages. `@community-hub/db` does not depend on people.

`turbo.json` task `@community-hub/people#test` depends on `^build`, `@community-hub/db#test`, and `@community-hub/identity#test`. The people Vitest config uses `packages/db/test/global-setup.ts` and aliases `@community-hub/db/plaintext` and `@community-hub/crypto/testing` the same way `modules/core/identity/vitest.config.ts` does. The alias target for crypto testing is `packages/crypto/src/testing.ts`.

## Security pins

These are the settings named in the spec. For each one, during the task that adds the test, change the source once, see that test fail, restore the source, and report the failure. The report is session scratch. The weakened tree is never committed.

| Setting                                                | Task | Test                                     | Source change that must fail it                                 |
| ------------------------------------------------------ | ---- | ---------------------------------------- | --------------------------------------------------------------- |
| `organisation_keys` has no `community_id`              | 1    | SQL test on the new journal file         | Add `"community_id" uuid` to that table's `CREATE TABLE`        |
| Community tables name `app.community_id` in the policy | 1    | SQL test                                 | Remove `app.community_id` from the `persons` policy             |
| `FORCE ROW LEVEL SECURITY`                             | 1    | SQL test                                 | Delete one `FORCE ROW LEVEL SECURITY` statement                 |
| `app` cannot update or delete `persons`                | 1    | `has_table_privilege`                    | Delete the `REVOKE UPDATE, DELETE` for `app.persons`            |
| `identity` cannot select `persons`                     | 1    | Privilege test                           | Add `GRANT SELECT ON app.persons TO identity`                   |
| No website collection                                  | 1    | Manifest test                            | Add `website: { collections: ["people.persons"] }`              |
| No entitlement                                         | 1    | Manifest test                            | Add `entitlement: "people.households"`                          |
| No import of tenancy or identity                       | 1    | Source scan                              | Import `@community-hub/tenancy` from `public/index.ts`          |
| Staging stays parked                                   | 1    | Tfvars test                              | Set `enable_database = true` in `staging.tfvars`                |
| No `set_config`                                        | 2    | Source scan                              | Add a `set_config` call in `infrastructure/keys.ts`             |
| No key cache and no log of a name                      | 2    | Source scan                              | Add `const keyCache = new Map()` in `infrastructure/keys.ts`    |
| KMS context is only the three allowed keys             | 2    | Integration test                         | Add `email: "ada@example.com"` to the organisation KMS context  |
| Unique insert uses a savepoint                         | 2    | Overlapping `ensureOrganisationKey`      | Insert on `tx` instead of `tx.savepoint`                        |
| A minor's clear names are null                         | 4    | Integration select                       | Write `given_name` for the minor                                |
| A minor email index is not the community index         | 4    | Community-key lookup                     | Compute the minor index with the community `bidx` key           |
| An adult email uses the community key                  | 4    | Decrypt with the community `enc` key     | Encrypt that email with `crypto.subtle.generateKey` for AES-GCM |
| Ciphertext is not filtered                             | 4    | Source scan of `infrastructure/`         | Add `where email =` in `infrastructure/person.ts`               |
| A second tenant cannot select the person               | 4    | Cross-tenant select                      | Change the `persons` policy `USING` to `true`                   |
| `readPerson` appends one audit row                     | 4    | Count of `people.person.read`            | Call `appendAuditEvent` a second time inside `readPerson`       |
| `createPerson` appends in the same transaction         | 4    | Duplicate email leaves one created audit | Remove the `appendAuditEvent` call from `createPerson`          |
| A guardian cannot be the child                         | 5    | `invalid_guardian`                       | Skip the `is_minor` check                                       |
| Activity objects have no name, email, or phone         | 6    | `Object.keys` on each activity row       | Add `givenName: "Ada"` to the returned object                   |
| Adult and minor field keys are not interchangeable     | 7    | Decrypt across the two keys              | Return the community `enc` key for a minor                      |
| `openPersonFieldKeys` appends one audit row            | 7    | Count of `people.person.read`            | Append again inside the internal helper                         |

---

### Task 1: Package, domain rules, and the app tables

**Files:**

- Modify: `pnpm-workspace.yaml`
- Modify: `turbo.json`
- Modify: `pnpm-lock.yaml`
- Create: `modules/core/people/package.json`
- Create: `modules/core/people/tsconfig.json`
- Create: `modules/core/people/tsconfig.test.json`
- Create: `modules/core/people/vitest.config.ts`
- Create: `modules/core/people/module.manifest.ts`
- Create: `modules/core/people/domain/error.ts`
- Create: `modules/core/people/domain/person.ts`
- Create: `modules/core/people/domain/person.test.ts`
- Create: `modules/core/people/domain/manifest.test.ts`
- Create: `modules/core/people/domain/boundaries.test.ts`
- Create: `modules/core/people/db/schema.ts`
- Create: `modules/core/people/db/schema.test.ts`
- Create: `modules/core/people/infrastructure/privileges.integration.test.ts`
- Create: `modules/core/people/public/index.ts`
- Modify: `packages/db/drizzle.schema.ts`
- Create: the Kit journal entry under `packages/db/drizzle/` and its `meta` snapshot
- Modify: `packages/db/drizzle/meta/_journal.json`

**Interfaces:**

- Produces: `PeopleError extends Error` with `code` the twelve strings in the spec's Contracts section.
- Produces: domain functions, not exported from `public/index.ts`: normalise email, phone, name, and tag; `isMinor` and `birthdayMd` from a date string and `now`.
- Produces: `defineModule` key `core.people`, version `1`, empty `requires`, `publishes`, `subscribes`, and `ports`. No `entitlement`, `features`, `permissions`, or `website`. `dataClasses` has one entry per column in the spec Data table. The key is the table name without `app.` and the column, for example `persons.given_name`. The value is that row's classification.
- Produces: `peopleTables(app)` and one journal file containing every table in the spec.

**Rule this must not break:** domain imports no Drizzle, no `postgres`, and no `@community-hub/crypto`. The journal is expand-only. `schema-rls` still passes.

- [ ] **Step 1: Write the failing tests**

`domain/person.test.ts` imports the domain functions and `PeopleError`.

Age, using `Intl` only inside the domain, not in the test's expected values. `isMinor("2008-10-12", new Date("2026-10-11T00:00:00+11:00"))` is true. `isMinor("2008-10-11", new Date("2026-10-11T00:00:00+11:00"))` is false. `isMinor(null, that date)` is true. `isMinor("2008-02-29", new Date("2026-02-28T12:00:00+11:00"))` is true. `isMinor("2008-02-29", new Date("2026-03-01T12:00:00+11:00"))` is false. These throw `PeopleError` with `code` `invalid_date`: `"2026-02-31"`, `"11/10/2008"`, and `"2026-10-12"` when `now` is `2026-10-11T00:00:00+11:00`. `birthdayMd("2008-10-11")` is `1011`. `birthdayMd(null)` is null.

Email: `Ada@Example.com` and `ada@example.com` become `ada@example.com`. `""`, `"ada"`, `"a da@example.com"`, `"ada@@example.com"`, `"ada@example"`, `"ada@-example.com"`, and a string containing a newline throw `invalid_email`.

Phone: `"+61 412 345 678"` becomes `"61412345678"`. `"12"` throws `invalid_phone`.

Name: `" Ada "` becomes `"Ada"`. A newline and a string of 81 characters throw `invalid_name`.

Tag: `"Choir"` becomes `"choir"`. `"A_b"` throws `invalid_tag`.

Assert `error instanceof PeopleError` and `error instanceof Error`.

`domain/manifest.test.ts` expects the module object above, including every `dataClasses` entry and no `website` key.

`domain/boundaries.test.ts` reads every `.ts` file under `modules/core/people` and fails if any contains `@community-hub/tenancy` or `@community-hub/identity`. It reads `infra/regions/au/env/staging.tfvars` and fails unless that file contains `enable_database = false` and `desired_count = 0`. It reads every file in that directory and fails if any contains `service_image`.

`db/schema.test.ts` finds the new journal file, the only `packages/db/drizzle/*.sql` file that contains `"app"."persons"`. That file must contain every table name from the spec: `organisation_keys`, `community_keys`, `household_keys`, `households`, `persons`, `guardian_links`, `person_tags`, `person_tag_links`, `person_activity`. It must contain `FORCE ROW LEVEL SECURITY` once per those tables, `current_setting('app.org_id')`, and `current_setting('app.community_id')`. The `CREATE TABLE` for `organisation_keys` must not contain `community_id`. Every other new `CREATE TABLE` must contain `community_id`. The `persons` policy must contain `app.community_id`. The file must contain the `REVOKE UPDATE, DELETE` for `app.persons` and must not contain `ON DELETE CASCADE` or `DEFAULT`. It must not contain `CREATE INDEX` on `given_name_restricted`, `family_name_restricted`, `date_of_birth`, `email`, `phone`, or `label` except the blind-index uniques, which name `email_bidx` or `phone_bidx`.

`infrastructure/privileges.integration.test.ts` uses the db harness the way `modules/core/tenancy/infrastructure/implicit-organisation.integration.test.ts` does. Apply product migrations on `productOnlyUrl`. As the direct login, `has_table_privilege` for `UPDATE` and `DELETE` is false on `app.persons`, and `DELETE` is true on `app.guardian_links`. As `identity` and as `platform`, `SELECT` on `app.persons` is false. As `app`, `SELECT` is true.

The tests fail because the package does not exist.

- [ ] **Step 2: Add the package and generate the journal**

`pnpm-workspace.yaml` gains `- "modules/core/people"`. No other glob.

`package.json` name `@community-hub/people`, `"type": "module"`, `"private": true`, `"version": "0.0.0"`. Exports `"."` to `./dist/public/index.js` with types `./dist/public/index.d.ts`. Scripts match `@community-hub/tenancy`. Dependencies are the list above.

`tsconfig.json` and `tsconfig.test.json` match `modules/core/identity`, including the crypto testing path and the plaintext path.

`db/schema.ts` exports `peopleTables(app)`. It may import `encryptedColumn` and `blindIndexColumn` from `@community-hub/db`. It does not import `@community-hub/db/plaintext`. Ciphertext columns use `encryptedColumn` with the spec labels (`people.given_name`, `people.family_name`, `people.date_of_birth`, `people.email`, `people.phone`, `people.household_label`). Blind indexes use `blindIndexColumn` with purposes `people.email` and `people.phone`. Clear names, `is_minor`, and `birthday_md` are not encrypted columns. Primary keys, checks, partial unique indexes, and foreign keys with `onDelete: "restrict"` are the spec's Data section. `organisation_keys` has no `community_id`. Its policy is `tenant_isolation`, `FOR ALL`, `USING` and `WITH CHECK` on `app.org_id` only. Every other table's policy is `community_isolation`, `FOR ALL`, `USING` and `WITH CHECK` on both settings. Call `.enableRLS()` on each table.

`packages/db/drizzle.schema.ts` imports `app` from `./src/namespaces.ts`, calls `peopleTables(app)`, and exports the tables the way it exports the identity tables. Do not export them from `packages/db/src/index.ts`.

From `packages/db`, run `pnpm exec drizzle-kit generate`. Commit the new SQL, the new snapshot, and the journal entry. Do not edit `0000` through `0004`. Kit does not emit `FORCE ROW LEVEL SECURITY`. Hand-add `ALTER TABLE ... FORCE ROW LEVEL SECURITY` for each new table. Hand-add the `REVOKE` statements from the spec. Do not hand-edit column lists. If a check or a partial index is missing, fix `schema.ts` and generate again.

`public/index.ts` exports `PeopleError` only.

`pnpm install` so the lockfile records the workspace package. `turbo.json` gains the people test dependency described above.

- [ ] **Step 3: Pin the table shape**

Add `"community_id" uuid` inside the `organisation_keys` `CREATE TABLE`. The SQL test fails. Restore the file.

Remove `app.community_id` from the `persons` policy. The SQL test fails. Restore the file.

Delete one `FORCE ROW LEVEL SECURITY` statement. The SQL test fails. Restore the file.

Delete `REVOKE UPDATE, DELETE` for `app.persons`. The privilege test fails. Restore the SQL.

Add `GRANT SELECT ON TABLE app.persons TO identity`. The privilege test fails. Restore the SQL.

Add `website: { collections: ["people.persons"] }` to `defineModule`. The manifest test fails. Restore the file. Then add `entitlement: "people.households"`. The manifest test fails. Restore the file.

Add `import "@community-hub/tenancy"` in `public/index.ts`. The boundary test fails. Restore the file.

Set `enable_database = true` in `infra/regions/au/env/staging.tfvars`. The boundary test fails. Restore the file.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the TypeScript in this task. Do not run Prettier on `.sql` or Kit snapshots if it would reflow them. Then `pnpm gate`.

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml turbo.json modules/core/people packages/db/drizzle.schema.ts packages/db/drizzle
git commit -m "$(cat <<'EOF'
feat(people): add person tables and the minor age rule

App tables force row level security. A minor is under 18 on the Sydney date.

Refs: docs/plans/2026-10-11-people-households.md task 1
EOF
)"
```

---

### Task 2: Organisation and community keys

**Files:**

- Create: `modules/core/people/infrastructure/keys.ts`
- Create: `modules/core/people/infrastructure/keys.test.ts`
- Create: `modules/core/people/infrastructure/keys.integration.test.ts`
- Modify: `modules/core/people/public/index.ts`

**Interfaces:**

- Consumes: `AppTransaction`, `generateKmsRoot`, `unwrapKmsRoot`, `deriveKeys`, `generateAndWrap`, `unwrapKey`.
- Produces: `ensureOrganisationKey(tx, kms, keyArn)` and `ensureCommunityKey(tx, kms, keyArn)`, each returning `{ keyId: string }`. Neither returns a `CryptoKey`.

**Rule this must not break:** no module-scope `CryptoKey` or `Map`. The KMS context is `{ key_kind: "org", org_id, key_version: "1" }` with `org_id` from `current_setting('app.org_id')`. No personal field in that object.

- [ ] **Step 1: Write the failing tests**

`infrastructure/keys.test.ts` reads `keys.ts` and fails if it matches `set_config`, `\bSET\b`, `new Map`, `console.`, or `logger`.

`infrastructure/keys.integration.test.ts` applies product migrations, inserts one implicit organisation and one community as `platform` (`region` `au`, `kind` `implicit`, slug `example-parish` on both, ids from `newId()`), then uses `withAppTransaction` as `app`. `keyArn` is `arn:aws:kms:ap-southeast-2:123456789012:key/mrk-` plus `ab` repeated 16 times. KMS is a wrapper around `createLocalKmsPort` from `@community-hub/crypto/testing`. The wrapper records `Object.keys` of each context.

`ensureOrganisationKey` twice in sequence leaves one `app.organisation_keys` row with `key_version` `1`. The recorded context keys are exactly `key_kind`, `org_id`, and `key_version`. `ensureCommunityKey` leaves one `app.community_keys` row whose `parent_key_id` is the organisation key id.

Overlapping path: two `withAppTransaction` calls run `ensureOrganisationKey` on a fresh organisation. The wrapper's `generateDataKey` waits until two callers are inside it, then releases both. The wait has a two-second timeout. Afterwards one organisation-key row exists and both calls return that id.

The tests fail because the functions are not exported.

- [ ] **Step 2: Implement the two ensures**

Select by `current_setting`. On a miss, call `generateKmsRoot` or `generateAndWrap`, then insert inside `tx.savepoint`. On `23505`, roll the savepoint back, select the winner, unwrap it, and return its id. Do not store the root. `ensureCommunityKey` calls `ensureOrganisationKey` first. Wrap AAD uses the 16-byte UUID form from the spec. Copy that helper into this module. Do not import identity.

`public/index.ts` also exports the two functions.

- [ ] **Step 3: Pin the key rules**

Add `set_config("app.org_id", "00000000-0000-0000-0000-000000000000", true)` in `keys.ts`. The source test fails. Restore the file.

Add `const keyCache = new Map()`. The source test fails. Restore the file.

Add `email: "ada@example.com"` to the organisation context object. The integration test fails. Restore the file.

Move the organisation insert onto `tx` and delete the `savepoint` around it. The overlapping test fails. Restore the file.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the TypeScript in this task, then `pnpm gate`.

```bash
git add modules/core/people
git commit -m "$(cat <<'EOF'
feat(people): wrap organisation and community keys without a cache

A lost insert rolls back a savepoint and keeps the winner's blob.

Refs: docs/plans/2026-10-11-people-households.md task 2
EOF
)"
```

---

### Task 3: Household create and read

**Files:**

- Modify: `packages/db/src/audit-append.ts`
- Create: `packages/db/src/audit-append-tx.test.ts`
- Create: `modules/core/people/infrastructure/household.ts`
- Create: `modules/core/people/infrastructure/household.integration.test.ts`
- Modify: `modules/core/people/public/index.ts`

**Interfaces:**

- Consumes: `ensureCommunityKey` and `appendAuditEvent`.
- Produces: `appendAuditEvent(tx: OrgTransaction | AppTransaction, ...)`. SQL unchanged.
- Produces: `createHousehold` and `readHousehold` as in the spec. Audit names `people.household.created` and `people.household.read`, registered when the people public module loads.

**Rule this must not break:** existing audit callers that pass `OrgTransaction` still typecheck. A pooled `Sql` is still not assignable. `readHousehold` of an unknown id writes no audit row.

- [ ] **Step 1: Write the failing tests**

`packages/db/src/audit-append-tx.test.ts` assigns an `AppTransaction` value to a variable accepted by `appendAuditEvent`'s first parameter, and keeps an `@ts-expect-error` on a pooled `Sql`. The `AppTransaction` line fails until the parameter widens.

`household.integration.test.ts` runs inside `withRequest` with a fixed UUID `requestId`. `createHousehold` with label `" Example "` stores ciphertext, not the clear word. `readHousehold` returns `{ householdId, label: "Example" }` and one `app.audit_events` row with action `people.household.created` already present from the create, plus one `people.household.read`. A second id returns null and does not add a read row. `actorUserId` null stores actor kind `system`.

The tests fail because the functions do not exist.

- [ ] **Step 2: Widen audit append and store the household**

Change the first parameter of `appendAuditEvent` to `OrgTransaction | AppTransaction`. Do not change its SQL.

`createHousehold` ensures the community key, inserts the household and the household key, encrypts a non-null label with the household `enc` key, and appends `people.household.created` in that same `tx`. `readHousehold` decrypts with an internal unwrap that does not append, then appends `people.household.read` once. Register both audit names with `defineAuditAction` and `defineAuditPurpose` from `public/index.ts`.

Export `createHousehold` and `readHousehold`.

- [ ] **Step 3: Gate and commit**

`pnpm exec prettier --write` on the TypeScript in this task, then `pnpm gate`.

```bash
git add packages/db/src/audit-append.ts packages/db/src/audit-append-tx.test.ts modules/core/people
git commit -m "$(cat <<'EOF'
feat(people): record a household and audit the read

The household label is ciphertext. Audit append accepts an app transaction.

Refs: docs/plans/2026-10-11-people-households.md task 3
EOF
)"
```

---

### Task 4: Person create and read

**Files:**

- Create: `modules/core/people/infrastructure/person.ts`
- Create: `modules/core/people/infrastructure/person-keys.ts`
- Create: `modules/core/people/infrastructure/person.integration.test.ts`
- Create: `modules/core/people/infrastructure/person.test.ts`
- Modify: `modules/core/people/public/index.ts`

**Interfaces:**

- Consumes: household and community keys, the domain rules, `appendAuditEvent`.
- Produces: `createPerson` and `readPerson` as in the spec. Internal `derivePersonFieldKeys` returns `{ enc, bidx }` and does not append. It is not exported from `public/index.ts`.
- Produces: audit names `people.person.created` and `people.person.read`.

**Rule this must not break:** `readPerson` calls `derivePersonFieldKeys`, then appends once. It does not call a public opener. A minor's clear name columns stay null. SQL does not filter ciphertext.

- [ ] **Step 1: Write the failing tests**

`person.test.ts` reads every file in `infrastructure/` and fails on `set_config`, `where email =`, `order by`, or `group by`.

`person.integration.test.ts`, inside `withAppTransaction` and `withRequest`:

Adult. Date of birth `2008-10-11`, `now` `2026-10-11T00:00:00+11:00`, names `Ada` and `Example`, email `ada@example.com`, phone `+61 412 345 678`, `householdId` null. The row has `is_minor` false, `birthday_md` 1011, clear names, null restricted names. Decrypt `email` with the community `enc` key and AAD `{ tag: "chub/field/v1", label: "people.email", rowId, communityId }`. The plaintext is `ada@example.com`. The phone plaintext is `61412345678`. `readPerson` returns those clear values. Audit holds one `people.person.created` and one `people.person.read`. Activity kind `created` is on `app.person_activity`.

Minor. `dateOfBirth` null, names `Ned` and `Example`, email `ned@example.com`, and the household from Task 3's helper path (`createHousehold` then this person). `householdId` null throws `household_required` and inserts nothing. The stored row has `is_minor` true, null `birthday_md`, null `given_name`, null `family_name`. Decrypt the restricted given name with the household `enc` key. Decrypting it with the community `enc` key throws. A blind index of `ned@example.com` computed with the community `bidx` key matches no row. The same bytes computed with the household `bidx` key match one row.

A second `withAppTransaction` for another organisation selects no row from `app.persons` for the first person's id. Duplicate `ada@example.com` in the same community throws `duplicate_email`, leaves one person, and leaves one `people.person.created` audit row.

The tests fail because `createPerson` is not exported.

- [ ] **Step 2: Store and read the person**

`createPerson` resolves age in the domain, requires a household for a minor, encrypts with `derivePersonFieldKeys`, and inserts `org_id` and `community_id` from `current_setting`. It writes activity `created` and appends `people.person.created` before returning, on the same `tx`. Map a unique violation on the email index to `duplicate_email`, and on the phone index to `duplicate_phone`.

`readPerson` returns null without an audit row when the id is absent. Otherwise it decrypts through `derivePersonFieldKeys` and appends `people.person.read` once.

Register the two person audit names next to the household names.

Export `createPerson` and `readPerson` only. Do not export `derivePersonFieldKeys`.

- [ ] **Step 3: Pin the person rules**

Write the minor's clear `given_name` in the insert. The minor select fails. Restore the file.

Compute the minor email index with the community `bidx` key. The community-key lookup test fails. Restore the file.

Encrypt the adult email with a key from `crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"])`. The decrypt test fails. Restore the file.

Add `where email =` in `person.ts`. The source test fails. Restore the file.

Change the `persons` policy `USING` to `true` in the journal SQL. The cross-tenant select fails. Restore the file.

Call `appendAuditEvent` a second time at the end of `readPerson`. The read count fails. Restore the file.

Remove the `appendAuditEvent` call from `createPerson`. The created-audit count fails. Restore the file.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the TypeScript in this task, then `pnpm gate`.

```bash
git add modules/core/people
git commit -m "$(cat <<'EOF'
feat(people): store a minor under the household key

Adult names stay clear. A minor email index is not a community index.

Refs: docs/plans/2026-10-11-people-households.md task 4
EOF
)"
```

---

### Task 5: Guardian links

**Files:**

- Create: `modules/core/people/infrastructure/guardian.ts`
- Create: `modules/core/people/infrastructure/guardian.integration.test.ts`
- Modify: `modules/core/people/public/index.ts`

**Interfaces:**

- Consumes: `createHousehold` and `createPerson`.
- Produces: `linkGuardian` and `unlinkGuardian` as in the spec. No KMS parameter.

**Rule this must not break:** the guardian is an adult, the child is a minor, and both already belong to that household. A failed link writes no activity row.

- [ ] **Step 1: Write the failing test**

Create a household, an adult in it (`2008-10-11`), and a minor in it (null date of birth). `linkGuardian` with `consent` true and the other rights false returns `{ linkId }` and activity `guardian_linked` on the child. The adult as `childPersonId` throws `invalid_guardian` and does not add a link. A second identical link throws `duplicate_guardian_link`. All four rights false throws `invalid_guardian`. `unlinkGuardian` writes `guardian_unlinked`. A second unlink throws `not_found` and does not add another activity row.

The test fails because the functions are not exported.

- [ ] **Step 2: Implement the link**

Read `is_minor` and `household_id` under the caller's transaction. Insert or delete the link. On success, insert the activity row with the command's `now`. Do not call KMS and do not append an audit event.

Export both functions.

- [ ] **Step 3: Pin the guardian rule**

Skip the `is_minor` comparison. The adult-as-child test fails. Restore the file.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the TypeScript in this task, then `pnpm gate`.

```bash
git add modules/core/people
git commit -m "$(cat <<'EOF'
feat(people): link an adult guardian to a child

The child is a minor in that household. The link stores rights, not names.

Refs: docs/plans/2026-10-11-people-households.md task 5
EOF
)"
```

---

### Task 6: Tags and the activity list

**Files:**

- Create: `modules/core/people/infrastructure/tags.ts`
- Create: `modules/core/people/infrastructure/activity.ts`
- Create: `modules/core/people/infrastructure/tags.integration.test.ts`
- Modify: `modules/core/people/public/index.ts`

**Interfaces:**

- Consumes: a person id from `createPerson`.
- Produces: `createTag`, `attachTag`, `detachTag`, `listPersonTags`, and `listPersonActivity` as in the spec.

**Rule this must not break:** tag labels are clear categories. Activity rows returned to the caller have only `id`, `kind`, `actorUserId`, and `occurredAt`.

- [ ] **Step 1: Write the failing test**

`createTag({ label: "Choir" })` stores `choir`. A second `Choir` throws `duplicate_tag`. `"A_b"` throws `invalid_tag`. `attachTag` on the adult writes activity `tagged`. `listPersonTags` returns `[{ tagId, label: "choir" }]`. `listPersonActivity` returns `created` then `tagged`, in that order. `Object.keys` of each object sorted are `actorUserId`, `id`, `kind`, `occurredAt`. `detachTag` adds `untagged`. An unknown person id returns null from both lists. A person with no tags returns an empty array, not null.

The test fails because the functions are not exported.

- [ ] **Step 2: Implement tags and the list**

Normalise the tag in the domain. Insert the clear label. Attach and detach write the activity kinds. Lists do not decrypt and do not call `appendAuditEvent`. Order tags by `label`. Order activity by `occurred_at`, then `id`.

Export the five functions.

- [ ] **Step 3: Pin the activity shape**

Add `givenName: "Ada"` to each object `listPersonActivity` returns. The key test fails. Restore the file.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the TypeScript in this task, then `pnpm gate`.

```bash
git add modules/core/people
git commit -m "$(cat <<'EOF'
feat(people): attach a tag and list activity without a name

The timeline stores a kind and ids. The tag label is a clear category.

Refs: docs/plans/2026-10-11-people-households.md task 6
EOF
)"
```

---

### Task 7: Field-key resolver

**Files:**

- Create: `modules/core/people/infrastructure/person-keys.integration.test.ts`
- Modify: `modules/core/people/public/index.ts`
- Modify: `modules/core/people/infrastructure/person-keys.ts` only to export a public wrapper, not to change `derivePersonFieldKeys`

**Interfaces:**

- Consumes: `derivePersonFieldKeys`.
- Produces: `openPersonFieldKeys` as in the spec. Unknown id returns null and writes no audit row. A known person returns `{ enc, bidx }` and appends one `people.person.read`.

**Rule this must not break:** the wrapper appends. The helper does not. One call writes one audit row, not two. The wrap key is not returned.

- [ ] **Step 1: Write the failing test**

On the adult from the person fixtures, `openPersonFieldKeys` returns keys that decrypt the stored email. On the minor, those adult keys do not decrypt `given_name_restricted`, and the minor's returned `enc` key does. `exportKey("raw", enc)` rejects. Each call adds one `people.person.read` row, counted from the number already written by earlier reads in that test. An unknown id returns null and adds none.

The test fails because the function is not exported.

- [ ] **Step 2: Export the wrapper**

`openPersonFieldKeys` calls `derivePersonFieldKeys` and then `appendAuditEvent` once. Do not append inside `derivePersonFieldKeys`. Do not return `wrap`.

- [ ] **Step 3: Pin the resolver**

Return the community `enc` and `bidx` for a minor. The minor decrypt test fails. Restore the file.

Append `people.person.read` inside `derivePersonFieldKeys` as well as in the wrapper. The count test fails. Restore the file.

- [ ] **Step 4: Gate and commit**

`pnpm exec prettier --write` on the TypeScript in this task, then `pnpm gate`.

```bash
git add modules/core/people
git commit -m "$(cat <<'EOF'
feat(people): open field keys for an adult or a minor

A minor's keys are the household keys. The call audits once.

Refs: docs/plans/2026-10-11-people-households.md task 7
EOF
)"
```

---

### Task 8: Catalogue

**Files:**

- Modify: `architecture.md`
- Modify: `docs/roadmap.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Consumes: the seven commits above. This task does not change runtime code.
- Produces: the Phase 1 row done, the next chunk `access-roles`, and the cache sentence closed.

**Rule this must not break:** Phase 0 stays `24 rows: 23 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stay `not started`. The startup sentence from `identity-otp` stays. The Fargate sentence stays. The only `AGENTS.md` edit is the repository-state sentence.

- [ ] **Step 1: Record the catalogue**

In `architecture.md` §12.2, keep `Unwrapped keys are not logged.` Replace the following sentence, the one that calls a short-lived cache an open item, with: unwrapped organisation, community, and household keys are not cached; the operation that needs one unwraps it and drops it; decided in `people-households`. Edit no other architecture section.

In `docs/roadmap.md`:

- Snapshot last shipped becomes `people-households`. Next chunk becomes `access-roles`. Phase, Phase 0, and Later phases stay as they are.
- The sentence under the Phase 0 table becomes: Next is `access-roles`.
- The Phase 1 row for `people-households` becomes `done`. Keep the existing What sentence and append `Spec `docs/specs/2026-10-11-people-households.md`.`
- The Next spec section names `access-roles`.
- In the open-items paragraph, keep the startup sentence. Replace the cache sentence with: unwrapped organisation keys are not cached; each operation unwraps and drops them, decided in `people-households`.

In `AGENTS.md`, in the repository-state cell, replace the next-chunk name `people-households` with `access-roles`. Leave the Phase 0 counts and the rest of that cell unchanged.

- [ ] **Step 2: Gate and commit**

`pnpm exec prettier --write` on the three files, then `pnpm gate`.

```bash
git add architecture.md docs/roadmap.md AGENTS.md
git commit -m "$(cat <<'EOF'
docs(roadmap): mark people-households done

Unwrapped organisation keys are not cached. The next chunk is access-roles.

Refs: docs/plans/2026-10-11-people-households.md task 8
EOF
)"
```

## Human

Approve this plan before Task 1. After Task 8, the pull request uses `.github/PULL_REQUEST_TEMPLATE.md`, links this spec and this plan, and leaves the second-review line open. The agent does not merge and does not apply. Staging stays parked.
