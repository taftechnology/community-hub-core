# Spec: Implicit organisation

Slug: tenancy-implicit-org
Status: draft
Architecture refs: §6.2, §6.3, §8.1, §8.2, §12.1, §12.2.1, D4. Implements the `tenancy-implicit-org` row. Depends on `packages-db` and `kernel-runtime`, both on `main`. Staging stays parked.

## Problem

The `platform` schema exists and has no organisation or community rows. A later chunk cannot attach identity, people, or a request to a tenant, because those rows are not there. Architecture already says every current customer is an implicit organisation with one community, in the regional database, not in a separate control plane.

## Scope

**In**

- `modules/core/tenancy`, package `@community-hub/tenancy`. `pnpm-workspace.yaml` gains the line `modules/core/tenancy`. No other workspace glob.
- `module.manifest.ts` calls `defineModule` with `key` `core.tenancy`, `version` 1, empty `requires`, `publishes`, `subscribes`, and `ports`. No `entitlement`, `features`, `permissions`, or `website`. `dataClasses` lists every column below as `internal`.
- Two tables in the `platform` schema, contributed from `modules/core/tenancy/db/schema.ts`. `packages/db` keeps the only product journal. `packages/db/drizzle.config.ts` adds that schema file by path. `packages/db/src` does not import `@community-hub/tenancy`.
- `platform.organisations`: `id` uuid not null primary key, `slug` text not null, `region` text not null, `kind` text not null. Unique on `slug`.
- `platform.communities`: `id` uuid not null primary key, `organisation_id` uuid not null, `slug` text not null, `region` text not null. Unique on `slug`. `organisation_id` references `platform.organisations(id)` with no `ON DELETE CASCADE`. An index on `organisation_id` is not unique.
- Neither table has a column named `org_id`. Neither enables row level security nor `FORCE ROW LEVEL SECURITY`. Neither has a policy. `schema-rls` is not changed. It still checks `app` tables only.
- Checks, exact. `region = 'au'` on both tables. `kind in ('implicit', 'explicit')` on organisations. `slug` on both tables matches `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`. That is one DNS label: 1 to 63 characters, lowercase letters, digits, and internal hyphens.
- Ids are minted with `newId()` from `@community-hub/db`. The SQL has no `DEFAULT` for `id`.
- Grants stay the default privileges from `0000_schemas.sql`. The `platform` login receives select, insert, update, and delete. This migration does not grant those tables to `app`, `identity`, or `PUBLIC`.
- One new product journal entry after `0002_rare_jimmy_woo`. Drizzle Kit generates it. No hand-added `FORCE ROW LEVEL SECURITY`. The migration is additive.
- Domain code under `modules/core/tenancy/domain/` imports no framework and no Drizzle. It accepts an organisation slug and a community slug. It rejects a slug that fails the check above. It does not accept a region. The stored region is `au` and the stored kind is `implicit`.
- `createImplicitOrganisation` inserts one organisation and one community in one transaction on a connection that is already the `platform` login. It does not call `set_config`. It does not set `app.org_id` or `app.community_id`. A duplicate organisation slug or a duplicate community slug throws `ImplicitOrganisationError` with `code` `duplicate_organisation_slug` or `duplicate_community_slug`, and inserts nothing. An invalid slug throws the same error with `code` `invalid_slug`, and inserts nothing.
- `findCommunityBySlug` returns `{ id, organisationId, slug, region }` or null. It does not return kind.
- The public surface is `modules/core/tenancy/public/`. It exports the command, the query, and `ImplicitOrganisationError`. Other packages import that surface only.
- The catalogue commit marks this row done and links this spec. The snapshot stays on Phase `1 — Core platform`. Last shipped becomes `tenancy-implicit-org`. Next chunk becomes `identity-otp`. The Phase 0 count stays `23 rows: 22 done, 1 superseded (api-au-hostname), 0 not started`. Later phases stays `not started`. The sentence under the Phase 0 table names `identity-otp`. The Next spec section names `identity-otp`. The repository-state sentence in `AGENTS.md` names `identity-otp` and leaves the Phase 0 counts unchanged. That is the only `AGENTS.md` edit.

**Out**

- A second community, and any update of `kind` from `implicit` to `explicit`. The check allows `explicit` so a later chunk can write it. This chunk has no command that does.
- `name`, `type`, `logo_url`, `public_location`, `verified`, sites, lifecycle, and community moves. §13.1 is the later directory shape. This chunk does not create `mobile_apps` or `app_listings`, and it does not rename that sketch.
- Organisation keys, community keys, and any import of `@community-hub/crypto`.
- Identity tables, people, households, HTTP routes, and any edit under `apps/api` or `apps/admin`.
- Password re-read, and pooled checkout of `createAppSql`, `createIdentitySql`, and `createPlatformSql`. Nothing in this chunk serves a request. The open item in `docs/roadmap.md` stays as it is.
- Unparking staging. `enable_database` stays false, `desired_count` stays 0, and no committed var file gains `service_image`.
- An ADR, and any edit to `architecture.md`. §6.2, §6.3, and §12.1 already decide the rows, the missing `org_id`, and that a module's columns live on `dataClasses`.

## Behaviour

`createImplicitOrganisation({ organisationSlug: "example-parish", communitySlug: "example-parish" })` inserts one organisation with `kind = 'implicit'` and `region = 'au'`, and one community with that `organisation_id` and `region = 'au'`. The two ids differ. Both slugs may be the same string. They are unique inside their own table, not across the two tables.

`example-parish` is accepted. `Example`, `a_b`, `-ab`, `ab-`, an empty string, and a 64-character label are rejected with `invalid_slug` before any insert. A second call with the same organisation slug rejects with `duplicate_organisation_slug` and leaves one organisation row. A second call with a new organisation slug and the same community slug rejects with `duplicate_community_slug` and does not insert the second organisation.

`findCommunityBySlug("example-parish")` returns the community id, the organisation id, the slug, and `au`. An unknown slug returns null.

The `platform` login can insert and select both tables. The `app` login and the `identity` login cannot. The insert path does not set `app.org_id`.

## Data

| Table                    | Column            | Classification | Notes                                                                                           |
| ------------------------ | ----------------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `platform.organisations` | `id`              | `internal`     | Application-minted UUIDv7. Primary key. Not encrypted.                                          |
| `platform.organisations` | `slug`            | `internal`     | Clear. SQL filters it. Not a person's name.                                                     |
| `platform.organisations` | `region`          | `internal`     | Clear. SQL filters it. Only `au`.                                                               |
| `platform.organisations` | `kind`            | `internal`     | Clear. `implicit` or `explicit`. This chunk writes `implicit` only.                             |
| `platform.communities`   | `id`              | `internal`     | Application-minted UUIDv7. Primary key. Not encrypted.                                          |
| `platform.communities`   | `organisation_id` | `internal`     | Clear. Parent organisation. Not named `org_id`, and not an RLS key.                             |
| `platform.communities`   | `slug`            | `internal`     | Clear. SQL filters it. One DNS label, so it can later be `{slug}.communityhub.one`.             |
| `platform.communities`   | `region`          | `internal`     | Clear. SQL filters it. Only `au`.                                                               |

No personal data. No minor fields. No encrypted column. No blind index.

## Rules touched

Tenancy. These rows are region-scoped `platform` tables. They have no `org_id`. Callers use the `platform` login and do not set `app.org_id`. The `app` and `identity` logins have no privilege on them.

Residency. The rows live in the regional database. `region` is `au` only. No personal data leaves the database, because these columns are identifiers.

Children, money, consent, retention, and analytics. No children's fields, no payment fields, no consent rows, and no analytics.

## Contracts

| Contract   | Value                                                                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package    | `@community-hub/tenancy`. Public exports are the command, the query, and `ImplicitOrganisationError`.                                                          |
| Module     | `core.tenancy`, version 1, no events and no entitlement.                                                                                                       |
| Tables     | `platform.organisations` and `platform.communities`, columns above.                                                                                            |
| Command    | Two slugs in. One implicit organisation and one community. Region `au`. No `set_config`.                                                                       |
| Query      | `findCommunityBySlug` returns id, organisation id, slug, and region, or null.                                                                                  |
| Journal    | One additive entry in `packages/db/drizzle` after `0002`.                                                                                                      |
| Roles      | `platform` can read and write. `app` and `identity` cannot.                                                                                                    |
| Staging    | Parked. No apply.                                                                                                                                              |

## Dependencies

`@community-hub/tenancy` depends on `@community-hub/db` and `@community-hub/kernel`. It does not depend on `@community-hub/crypto`. No new third-party package. `@community-hub/db` does not gain a runtime dependency on tenancy. Its integration test may import the tenancy public surface, as a dev dependency only.

## Cost

No new resource billed by the hour or the month. No NAT gateway, load balancer, or interface endpoint. Staging stays parked, so this chunk adds no database charge and no task charge.

## Risks

| Risk                                                                              | Mitigation                                                                                                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| A platform table is given `org_id` and treated as tenant-scoped                   | The column is `organisation_id`. A test fails if either table's SQL contains a column named `org_id`, RLS, or `FORCE ROW LEVEL SECURITY`. |
| The `app` login can read the directory                                            | Default privileges stay platform-only. A test as `app` and as `identity` fails the select.                                          |
| A second community is inserted while `kind` is still `implicit`                   | This chunk has no such command. `organisation_id` is not unique, so a later chunk can add the second community without a drop.      |
| The command sets `app.org_id` on the platform connection                          | The repository does not call `set_config`. The session ban already fails a session-level `SET`.                                     |
| Slugs carry a person's name into a log or a URL                                   | The columns are organisation and community identifiers. Tests use `example-parish`.                                                 |
| Staging is unparked to try the migration                                          | The proof is the existing Docker Postgres in the db tests. Staging flags stay parked.                                               |

## Tests

- Domain tests, no database. `example-parish` is valid. The rejected spellings under Behaviour throw `invalid_slug`. The same slug is allowed for both arguments.
- Integration, in the existing `@community-hub/db` Docker Postgres, one database, not a second compose file. `createImplicitOrganisation` inserts one row in each table, both with `region` `au` and the organisation `kind` `implicit`. The two ids differ. A duplicate organisation slug rolls back. A duplicate community slug rolls back, including the organisation insert from that call. `findCommunityBySlug` returns the four fields, and an unknown slug returns null.
- The same test connects as `platform` and succeeds, then as `app` and as `identity` and is denied. It does not call `set_config`.
- The generated SQL for both tables has no `org_id` column, no `ENABLE ROW LEVEL SECURITY`, and no `FORCE ROW LEVEL SECURITY`. `schema-rls` still passes.
- A source check fails if `modules/core/tenancy` imports `@community-hub/crypto`. The existing ESLint ban stays the must-fail, including `import type`.

## Out-of-band

- Legal: none. New subprocessor: none. No ADR. `architecture.md` is not edited.
- Tenancy is a sensitive chunk. The second fresh-context review starts when the pull request opens. The pull request is not merged until that line is closed.
- The human does not apply. The agent does not apply. Staging stays parked.

## Rollback

Drop `platform.communities`, then `platform.organisations`. No other table references them in this chunk. The journal entry is not edited after it ships. A drop is a later contract migration, not this migration.

## Next spec after this lands

`identity-otp`, unless the human picks another Phase 1 row.
