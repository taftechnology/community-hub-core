Spec: docs/specs/2026-11-20-all-contacts-parity.md

# All Contacts parity Implementation Plan

Slug: all-contacts-parity
Status: approved (2026-11-20, Adnan Bin Hossen)

Revision 2 (2026-11-20) applies the fresh-context plan check (Claude Sonnet, READY WITH CHANGES, 1 High, 8 Medium, 14 Low).

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** All Contacts shows each adult's email, phone, age, date added, groups, source and status, with an inline Active switch, status, source and group filters, and four count cards, at Laravel parity. No minor ever appears in the adult list, the counts or a group lookup shown on screen. CSV export is not built.

**Architecture:**

- `packages/db`: migration `0021` (three columns on `app.persons`, a column `UPDATE` grant on two, a per-community backfill) and a backfill test.
- `modules/core/people`: schema, manifest, `createPerson` / `updatePerson` / `readPerson` source and status, a shared field-open helper, an exported Sydney age helper, an existing-key-only community key wrapper, `setPersonStatus`, `summarisePersons`, and the list's filters, decrypt, age and audit.
- `modules/features/groups`: `activeGroupsForPersons` and `personIdsInGroup` in `public/`.
- `packages/contracts`: list, read, status, summary and source schemas.
- `apps/api`: two routes, list and read changes, `@community-hub/groups` dependency, Dockerfile and image test.
- `apps/admin`: All Contacts columns, switch, filters, cards and Source select.
- `architecture.md`, `docs/roadmap.md`, `AGENTS.md`.

## Who does what

- **Implementer:** Antigravity (Gemini 3.8 Flash High), in `C:\Recovered\Taftech\wt-all-contacts` on the chunk branch. Fallback when it is out of quota: Cursor (grok-4.7-high), then a Claude Sonnet agent. Each fallback model used is named in the task report and excluded from the second review.
  - Tests first, one commit per task, commits locally, never pushes.
  - One plan task per run (12 GB of RAM on this machine).
  - For every Security pins row its task names, it writes the weakening as a `.patch` under `.superpowers/sdd/pins/` and a row in `.superpowers/sdd/pins/manifest.json` (the `pinrun.mjs` format). The reviewer runs them. This departs from AGENTS.md §4 Phase 2 ("the implementer runs each change once"), as in the last three chunks; the pull request body records it.
  - Every test result it claims points to a log it wrote with `tee` under `.superpowers/sdd/task-N-logs/`, UTF-8. A claim without a log counts as not run.
  - It starts with no AWS credentials; pushes are blocked by the push URL and the pre-push hook.
- **Reviewer agent:** this session, on Claude Opus 5.5 for the whole chunk. Each task is reviewed by its diff, the named tests re-run, and every named pin run through `pinrun.mjs`.
- **Owner's checks and second review:** the chunk owner runs them in a fresh session on a model that is not Opus and not any implementer model used (Gemini 3.8 Flash High; grok-4.7-high or Sonnet if a fallback ran). The spec check ran on Claude Sonnet.
- **Docker test database:** one run at a time. Tasks 1 to 5 and 7 need it, as does any full local gate. `pinrun` never runs while an implementer is editing the tree.

## Checkpoints

- **After Task 5** (all domain work): the reviewer runs pins 1 to 22, 19b, 25 and 39 to 42, and the chunk owner runs an owner's check of `git diff <plan-sha>..<task-5-sha>`. Task 6 starts after that check.
- **After Task 7** (routes): pins 23, 24, 26 to 32, 43 and 44; `index.test.ts`, `billing-guard.integration.test.ts` and `image.test.ts` re-run.
- **After Task 8** (admin): pins 33 to 38; `all-contacts.test.tsx` and `family-records.test.tsx` five times green; a browser check at 1280px and 375px, light and dark, screenshots for the pull request.

## Global constraints

- **Branch:** `feat/2026-11-20-all-contacts-parity`, from `origin/main` at `c6b32a8`. The spec is its first commit (`f076d0b`), this plan its second.
- **Untouched:** identity, tenancy, access (except types that pass `readPerson` output through), billing and entitlement source; `household-routes.ts` except the source passed by `add-adult` and `add-minor` through `createPerson` (no route code change is expected: `addAdult` / `addMinor` set it); Terraform, workflows, `infra/`; the capabilities route and `people-access.tsx`; `FilterBar`; the Minors tab behaviour. Staging stays parked.
- **Dependencies:** `apps/api` gains the workspace dependency `@community-hub/groups` (Task 7). No other dependency and no new workspace package.
- **Never disabled to get green:** a check, a lint rule (no `eslint-disable`), an axe rule other than the repo's existing `color-contrast` exclusion, RLS, a test or a CI gate. No `@ts-ignore` or `@ts-expect-error`.
- **Fixtures** are synthetic: invented names, `example.test` addresses, `+61 4xx 555 xxx` phones. No real person.
- **No personal data** in logs, error bodies, URLs or audit rows. Audit rows carry ids only. A decrypt failure logs the error class only.
- **Build order:** `apps/api` imports the built `dist` of `@community-hub/contracts`, `@community-hub/people` and `@community-hub/groups`. After changing one, run `pnpm --filter <pkg> build` before `apps/api` tests. Pins that weaken a module and run an `apps/api` test list `"build": [...]`.
- **Local gate per task:** `pnpm format && pnpm lint && pnpm typecheck && pnpm exec turbo run test --continue --force; pnpm check:boundaries`, teed, and the turbo summary read for any failure other than the allowed ones.
- **Allowed failures on this Windows machine,** and only these: `packages/db/src/generate.test.ts` drizzle ENOENT; the `image-publish` symlink EPERM; the `migrate.integration` and `plaintext-dist` timeouts; the identity `tsbuildinfo.test` 5 s timing flake. Task 1's migration is still proven by `migrate`-based tests that do run (the backfill test and the people suites).
- **Admin tests:** no real waits; exact fetch call counts; each new section repeated five times green before the task is reported.
- **Line endings:** LF.

## Decisions fixed by the spec (do not reopen)

1. Status has its own route; a no-op with a current version returns unchanged, bumps nothing, audits nothing; a stale version is 409 even on a no-op.
2. One `people.person.listed` audit per non-empty adult page, ids only.
3. Age in whole years on the `Australia/Sydney` civil date from an injected `now`; the date of birth is never in the list.
4. "Added this month" uses an `addedSince` instant the admin computes from the browser's month start.
5. Groups need `groups.basic`; active groups only; the summary's `groups` key is the admin's signal; `[]` versus absent is meaningful.
6. Source on create and update is `manual` or `family_records` only; an automatic source is kept on edit unless staff pick one.
7. Group names shown to `people.view` holders; no `groups.*` permission check.
8. Keys derived at most once per request, never created by a read; a decrypt failure fails the request with 500.
9. `cache-control: no-store` on list, read and summary.
10. CSV export is not built.

## Security pins

Each row is a weakening the implementer writes as a patch and the reviewer runs through `node ~/.claude/crew/bin/pinrun.mjs .superpowers/sdd/pins/manifest.json --only <id>`. The weakened run must fail **on an assertion** in the named test; the restored run must pass. The weakened tree is never committed.

Files: **M** = `packages/db/test/persons-status-source-migration.integration.test.ts` (new); **P** = `modules/core/people/infrastructure/privileges.integration.test.ts`; **S** = `modules/core/people/infrastructure/person-status.integration.test.ts` (new); **SU** = `modules/core/people/infrastructure/person-summary.integration.test.ts` (new); **L** = `modules/core/people/infrastructure/list-persons.integration.test.ts`; **U** = `modules/core/people/infrastructure/update-person.integration.test.ts`; **PI** = `modules/core/people/infrastructure/person.integration.test.ts`; **G** = `modules/features/groups/infrastructure/members.integration.test.ts`; **C** = `packages/contracts/src/people.test.ts`; **R** = `apps/api/src/people-routes.test.ts`; **I** = `apps/api/src/people-routes.integration.test.ts`; **B** = `apps/api/src/billing-guard.integration.test.ts`; **A** = `apps/admin/src/all-contacts.test.tsx`.

| #   | Setting                                                       | Weakening                                                                                             | File                                     | Test that must fail (exact `it` title)                                                                                                   |
| --- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `status` check constraint                                     | Drop the `status` check from the schema and migration                                                 | M                                        | migration 0021: refuses a status outside active and inactive                                                                             |
| 2   | `source` check constraint                                     | Drop the `source` check                                                                               | M                                        | migration 0021: refuses a source outside the eleven keys                                                                                 |
| 3   | Backfill per community under FORCE RLS                        | Set the two settings for the first community only, then run the `UPDATE` once                         | M                                        | migration 0021: backfills created_at in two communities of one organisation                                                              |
| 4   | Backfill fallback to the earliest activity of any kind        | Drop the middle `coalesce` term                                                                       | M                                        | migration 0021: a person whose only activity is not kind created gets that activity's time                                               |
| 5   | `status`, `source` updatable by `app`                         | Remove `status` from the `GRANT`                                                                      | P                                        | grants app update on app.persons only by column for allowed columns (Deviation 3)                                                        |
| 6   | `created_at` not updatable by `app`                           | Add `created_at` to the `GRANT`                                                                       | P                                        | grants app update on app.persons only by column for allowed columns (Deviation 3)                                                        |
| 7   | Create records the given source                               | `createPerson` ignores `input.source` and writes the default                                          | PI                                       | createPerson: stores source family_records when given                                                                                    |
| 8   | Update source limited and optional                            | `updatePerson` writes `source` as `manual` when omitted                                               | U                                        | updatePerson: an update without source leaves an automatic source unchanged                                                              |
| 9   | Source-only update derives no keys                            | Add `\|\| changes.source !== undefined` to `needsCrypto` (`update-person.ts:224`)                     | U                                        | updatePerson: a source-only update makes no KMS call                                                                                     |
| 10  | Status refuses a minor                                        | Remove `and is_minor = false` from the status update                                                  | S                                        | setPersonStatus: a minor's id throws not_found and changes nothing                                                                       |
| 11  | Status cross-community                                        | Remove the explicit `community_id` predicate (SQL-text test with a stub `tx`)                         | S                                        | setPersonStatus: the update filters by org, community and is_minor explicitly                                                            |
| 12  | Stale version refused                                         | Remove the version predicate                                                                          | S                                        | setPersonStatus: a stale version with a different status throws conflict and leaves the row unchanged                                    |
| 13  | Status change audited, ids only                               | Delete the audit append                                                                               | S                                        | setPersonStatus: a change bumps version and appends status_changed with the person id only                                               |
| 14  | No-op writes nothing                                          | Always bump and audit                                                                                 | S                                        | setPersonStatus: the stored status with a current version bumps nothing and audits nothing                                               |
| 15  | Summary counts adults only                                    | Remove `is_minor = false` from the summary                                                            | SU                                       | summarisePersons: minors are never counted                                                                                               |
| 16  | Summary community scope                                       | Remove the explicit `community_id` predicate (SQL-text test)                                          | SU                                       | summarisePersons: every count filters by org, community and is_minor explicitly                                                          |
| 17  | Group filter never yields a minor                             | Drop `is_minor = false` when `personIds` is set                                                       | L                                        | listPersons: a minor in the filtered group never appears                                                                                 |
| 18  | One audit per adult page                                      | Delete the `people.person.listed` append                                                              | L                                        | listPersons: a non-empty adult page appends one listed event with the page ids only                                                      |
| 19  | One derive per request (search)                               | Derive keys per row                                                                                   | L                                        | listPersons: an email search page with contact details makes one KMS Decrypt                                                             |
| 19b | One derive per request (no search)                            | Derive keys per row                                                                                   | L                                        | listPersons: a page of two adults with contact details makes one KMS Decrypt                                                             |
| 20  | A read never creates keys                                     | Use `communityFieldKeys` (`openCommunityHkdf`) in the list                                            | L                                        | listPersons: an email search in a community with no key rows returns an empty page, creates no key rows and makes no KMS call            |
| 21  | Decrypt failure fails closed                                  | Catch the open error and return `null`                                                                | L                                        | listPersons: a tampered email ciphertext fails the request                                                                               |
| 22  | Groups: active only, tenant scoped                            | `personIdsInGroup` drops `status = 'active'`                                                          | G                                        | personIdsInGroup: an archived group returns no ids                                                                                       |
| 23  | List filters refused for minors                               | Remove the `kind: "minors"` refinement                                                                | C                                        | listPeopleBody refuses status, source and groupId with kind minors                                                                       |
| 24  | Create and update source limited                              | Widen the `source` enum to all eleven keys                                                            | C                                        | createPersonBody and updatePersonBody accept only manual and family_records as source                                                    |
| 25  | No date of birth in a list item                               | Add `dateOfBirth` to the adult item in `listPersons`                                                  | L                                        | listPersons: an adult item has exactly the expected keys                                                                                 |
| 26  | Status needs `people.manage`                                  | Check `VIEW` instead of `MANAGE` in the status handler                                                | R                                        | POST /v1/people/status: a caller with only people.view gets 403 and no update                                                            |
| 27  | Summary needs `people.view`                                   | Remove the permission check from the summary handler                                                  | R                                        | POST /v1/people/summary: a caller without people.view gets 403                                                                           |
| 28  | `groupId` needs `groups.basic`                                | Skip the `groups.basic` guard when `groupId` is set                                                   | R                                        | POST /v1/people/list: groupId without groups.basic gets 403                                                                              |
| 29  | `groups` absent without `groups.basic`                        | Always attach `groups`                                                                                | R                                        | POST /v1/people/list and summary: no groups key without groups.basic                                                                     |
| 30  | `no-store`                                                    | Remove the header from the list response                                                              | R                                        | POST /v1/people/list, read and summary send cache-control no-store                                                                       |
| 31  | Status route is a billing write                               | Mark the route `billing: "read"`                                                                      | B                                        | guards every write route through the gate: 2xx and row count changes in ok, 402 with empty body and unchanged rows in read_only (pin 14) |
| 32  | Group filter never widens to everyone                         | Treat an empty `personIdsInGroup` result as no filter (`personIds: ids.length > 0 ? ids : undefined`) | I                                        | people list: a groupId from another community of the same organisation gives an empty page                                               |
| 33  | Switch hidden when billing is read-only                       | Render the `Switch` regardless of `hideWrites`                                                        | A                                        | All Contacts: billing read-only shows a status badge, not a switch                                                                       |
| 34  | Switch hidden without `people.manage`                         | Render the `Switch` regardless of permission                                                          | A                                        | All Contacts: without people.manage the status is a badge                                                                                |
| 35  | Groups column and filter need the summary signal              | Always render the Groups column                                                                       | A                                        | All Contacts: no groups key in the summary hides the Groups column and filter                                                            |
| 36  | 409 reloads                                                   | Ignore 409 and keep the new switch state                                                              | A                                        | All Contacts: a 409 on the switch reloads the list and shows the changed alert                                                           |
| 37  | Source sent only when picked                                  | Always send `source` on edit                                                                          | A                                        | All Contacts: editing a contact with an automatic source sends no source unless one is picked                                            |
| 38  | Family Records shows no Source select                         | Render the Source select by default in `ContactFields`                                                | `apps/admin/src/family-records.test.tsx` | Family Records: the add adult form has no Source select                                                                                  |
| 39  | A minor's read has no status or source                        | Return `status` and `source` for a minor too                                                          | PI                                       | readPerson: returns status and source for an adult and neither for a minor                                                               |
| 40  | A minor's list item is unchanged                              | Return the adult fields on the minors path                                                            | L                                        | listPersons: a minor item has exactly the minor keys                                                                                     |
| 41  | Groups lookups filter explicitly                              | Remove the explicit `community_id` predicate from `personIdsInGroup` (SQL-text test with a stub `tx`) | G                                        | personIdsInGroup and activeGroupsForPersons filter by org and community explicitly                                                       |
| 42  | An empty id set is an empty page                              | Treat an empty `personIds` as no filter in `listPersons`                                              | L                                        | listPersons: an empty personIds returns an empty page and makes no query                                                                 |
| 43  | Decrypt failure at the route: 500, empty body, class-only log | Return the error message in the response body                                                         | I                                        | people list: a tampered ciphertext gives 500 with an empty body and no value in the log                                                  |
| 44  | `people.directory` on status and summary                      | Skip the entitlement guard in `communityScope` for the two new handlers                               | R                                        | POST /v1/people/status and summary without people.directory get 403                                                                      |

Notes:

- Pins 11 and 16 use a stub `tx` that records SQL text, because RLS gives the same answer as the explicit predicates against a real database (precedent: pin 9b of `add-adult-create`).
- Pins 9, 19, 19b and 20 count calls on a counting wrapper around the test's local `KmsPort` (one `kms.decrypt` per derive, `keys.ts:127-132`), in the test file, not a production seam. Pin 9 asserts zero calls; a throwing KMS would fail with an error, not an assertion.
- Pin 21 tampers one byte of a stored ciphertext inside the test transaction.
- Pin 31: the `fixtureMap` (`billing-guard.integration.test.ts:480`) gains `"POST /v1/people/status"`, whose `count()` reads the person's version (`personVersion(setup, personId)`, as the update fixture does); the summary is a read and needs no entry.
- Pins 11 and 41 inspect every SQL statement the function sends (for status: the `UPDATE` and the fallback `SELECT`).
- The Task 1 seeds make pins 3 and 4 fail on an assertion, not on a migration error.

## Rollback

- Revert the pull request's merge commit. The routes, columns' readers and the screen changes disappear.
- Migration `0021` stays applied (expand only). Its columns are unused after the revert; a later contract pull request may drop them. The grant is withdrawn with `REVOKE UPDATE (status, source) ON app.persons FROM app` if wanted.
- Audit rows written stay (append-only, ids only).

## Stop and ask (AGENTS.md §12)

The implementer stops and reports, without improvising, when:

- the plan is wrong or ambiguous, or the code does not match a pointer in it;
- a migration other than `0021`, a change to a file listed as untouched, a dependency other than `@community-hub/groups` in `apps/api`, a workspace package, a workflow or a Terraform change looks necessary;
- a production seam would be needed only so a test can run;
- a test it wrote passes before the source change it is meant to drive, except the tests of pins 11, 16 and 41 on a first draft that already has the predicates, and the privileges test's forbidden-column half; the report lists them as "passes before the change, by design";
- the same step fails twice;
- anything would put personal data in a log, an error body, a URL path or query, or an audit row;
- a secret, token or account identifier appears in any file or output.

### Task 1: Migration 0021 and schema

**Commit:** `feat(people): add status, source and created_at to persons`

**Files:**

- `modules/core/people/db/schema.ts` (`app.persons`, about `:150-172`): `status` `text not null default 'active'`, `source` `text not null default 'manual'`, `created_at` `timestamptz not null default now()`, two check constraints (`persons_status_check`, `persons_source_check` with the eleven keys).
- `packages/db/drizzle/0021_<generated>.sql`, `meta/_journal.json` (idx 21), `meta/0021_snapshot.json`: generated by drizzle-kit, then hand SQL appended as in `0019_spotty_cloak.sql:58-87`: `GRANT UPDATE (status, source) ON app.persons TO app` before a `-- Recovery note` comment, and after it a `DO` block looping `platform.communities` with `set_config('app.org_id', ..., true)` and `set_config('app.community_id', ..., true)` (`0019:69-71`), updating `created_at` to `coalesce((earliest created activity), (earliest activity), now())`, then resetting both settings (`0019:85-86`). Statements separated by `--> statement-breakpoint`.
- `modules/core/people/module.manifest.ts`: `persons.status`, `persons.source`, `persons.created_at` as `internal`; `modules/core/people/domain/manifest.test.ts`: the exact object.
- `modules/core/people/infrastructure/privileges.integration.test.ts:153-166`: `status`, `source` in `allowedColumns`; `created_at` in `forbiddenColumns`.
- `packages/db/test/persons-status-source-migration.integration.test.ts` (new), on the pattern of `membership-backfill.integration.test.ts:34-47, 106-109, 187-216`: migrate with the journal filtered to idx 20 and below; seed as `migrator` inside `sql.begin` with per-community `set_config(..., true)` two communities of one organisation, each holding (a) a person with a `created` row and an earlier `tagged` row (created wins), (b) a person whose only activity is `tagged` (middle fallback), (c) a person with no activity row (now()); then apply the full folder (`0021` addressed by journal index, since its tag is generated); assert each backfilled value in both communities, the defaults on insert, and the tests of pins 1 to 4.

**Test first:** the migration test and the privileges change (RED: no columns), then the schema and migration.

**Rule it must not break:** expand only; every existing people and db suite unchanged; `generate.test.ts` reports no schema changes (allowed ENOENT on this machine; CI runs it).

**Pins:** 1 to 6.

### Task 2: Source and status on create, update and read

**Commit:** `feat(people): record source on create and update, return status and source on read`

**Files:**

- `modules/core/people/infrastructure/person.ts`: `PersonInput` (`:21-31`) gains `source?: PersonSource` (default `manual`); the insert (`:240`) writes `source` and `created_at = input.now`; `readPerson` (`:297-387`) returns `status` and `source` for an adult only; its return type becomes a union on `isMinor`, and the access module's `readPersonForActor` return type follows (pass-through, no code change). Export `openField` (`:157-174`) for Task 5. `roster-names.ts` is not touched.
- `modules/core/people/infrastructure/household-members.ts:196, :271`: `addMinor` and `addAdult` pass `source: "family_records"`.
- `modules/core/people/infrastructure/update-person.ts`: `UpdatePersonChanges` gains `source?: "manual" | "family_records"`; the "nothing to change" check (`:208-216`) counts it; `needsCrypto` (`:224`) is unchanged, so a source-only update derives no keys; the update writes it and bumps `version`; audit unchanged (`people.person.updated`).
- `modules/core/people/domain/person.ts`: export a `PersonSource` type and `PERSON_SOURCES` (eleven keys), `PersonStatus`, and `ageOn(dateOfBirth, now)` built on `sydneyCivilDate` (`:42`) and `completedYears` (`:66`).
- Tests: `person.integration.test.ts` (pins 7 and 39; "createPerson: writes created_at from now"), `household-members.integration.test.ts` ("addMinor and addAdult record source family_records"), `update-person.integration.test.ts` (pins 8 and 9; "updatePerson: a source change bumps version"), `domain/person.test.ts` ("ageOn: counts completed years on the Sydney civil date", with a `now` at a Sydney/UTC date boundary).

**Test first:** all new tests, then the source.

**Rule it must not break:** every existing person, household and roster test unchanged; minors' reads unchanged.

**Pins:** 7 to 9, 39.

### Task 3: Status and summary

**Commit:** `feat(people): set an adult's status and summarise the adult list`

**Files:**

- `modules/core/people/infrastructure/person-status.ts` (new): `setPersonStatus(tx, { now, personId, version, status, actorUserId })` → `{ version, status }`. One `UPDATE ... SET status, version = version + 1 WHERE id = $ AND org_id = current_setting(...) AND community_id = current_setting(...) AND is_minor = false AND version = $ AND status <> $new RETURNING`; on no row, a `SELECT version, status` with the same scope predicates decides: absent gives `not_found`; a different version gives `conflict`; a matching version with the status already `$new` returns unchanged with no write. Audit `people.person.status_changed`, `targetIds: [personId]`.
- `modules/core/people/infrastructure/person-summary.ts` (new): `summarisePersons(tx, { addedSince })` → `{ total, active, inactive, addedSince }`, one query with `count(*) filter (...)`, explicit org, community and `is_minor = false`.
- `modules/core/people/public/index.ts:17-24`: `defineAuditAction` and `defineAuditPurpose` for `people.person.listed` and `people.person.status_changed`; export both functions and their types.
- Tests: **S** (pins 10 to 14; "setPersonStatus: a stale version with the status unchanged throws conflict" (no pin claim); "setPersonStatus: an unknown id throws not_found"; "setPersonStatus: an id in another organisation throws not_found"), **SU** (pins 15 and 16; "summarisePersons: counts total, active, inactive and added since"; "summarisePersons: a future addedSince counts 0"; "summarisePersons: records no usage fact"; "summarisePersons: another community's adults are not counted").

**Test first:** S and SU, then the source.

**Rule it must not break:** the event-names check passes (`tooling/checks/event-names/check.ts:472`).

**Pins:** 10 to 16.

### Task 4: Groups lookups

**Commit:** `feat(groups): look up active groups for people and people in a group`

**Files:**

- `modules/features/groups/infrastructure/members.ts`: `activeGroupsForPersons(tx, personIds: string[])` → `Map<personId, { id, name }[]>` (active groups, ordered by `name_key, id`; empty input makes no query); `personIdsInGroup(tx, groupId)` → `string[]` (empty for an unknown, archived or out-of-scope group). Raw SQL in the module's style with explicit `org_id` and `community_id` predicates.
- `modules/features/groups/public/index.ts:35-47`: export both.
- `members.integration.test.ts`: pins 22 and 41; "activeGroupsForPersons: returns only active groups by name"; "personIdsInGroup: a group in another community of the same organisation returns no ids"; "personIdsInGroup: a group in another organisation returns no ids"; "activeGroupsForPersons: empty input makes no query".

**Test first:** the tests, then the source.

**Rule it must not break:** groups does not import anything new from people; every groups test unchanged.

**Pins:** 22, 41.

### Task 5: The adult list

**Commit:** `feat(people): list adults with contact details, status, source and filters`

**Files:**

- `modules/core/people/infrastructure/person-keys.ts`: `existingCommunityFieldKeys(tx, kms, keyArn)` beside `communityFieldKeys` (`:32-40`), over `openExistingCommunityHkdf` (`keys.ts:182`). It returns `null` when the organisation key or the community key row is absent: it checks for the rows first, makes no KMS call and does not throw.
- `modules/core/people/infrastructure/list-persons.ts`:
  - `ListPersonsInput` (`:11-18`) gains `now?: Date` (default `new Date()`, as `update-person.ts:31`; the route always passes `deps.now()`), `status?`, `source?`, `personIds?: string[]` (the route resolves `groupId`).
  - The adult query (`:198-219`) adds `created_at`, `status`, `source`, `date_of_birth`, `email`, `phone`, and `and status = $`, `and source = $`, `and id = any($)` when set; `is_minor = false` stays. An empty `personIds` returns an empty page with no query.
  - Keys: derive with `existingCommunityFieldKeys` at most once per call, lazily, shared by the email or phone blind index (`:160`, `:181`) and the page decrypt; not at all when nothing needs it. With `null` keys, a search that needs a blind index adds `and 1 = 0` (an empty page); a row holding ciphertext while keys are `null` throws (500).
  - Existing test edited: `list-persons.integration.test.ts:870-914` (finding 8) seeds one person first so keys exist, then keeps its `kms_outage` assertion. No other existing test changes.
  - Item: `PersonListItem` (`:20-27`) becomes a union; an adult item adds `email`, `phone`, `age` (`ageOn`), `createdAt`, `status`, `source`. An open failure propagates (no catch).
  - After a non-empty adult page, one audit `people.person.listed` with the page ids.
- Tests in **L**: pins 17 to 21, 19b, 25, 40 and 42; "listPersons: filters by status, by source, by personIds and combines them with search"; "listPersons: returns email, phone, age, createdAt, status and source for adults"; "listPersons: an empty page appends no audit and makes no KMS call"; "listPersons: the minors list is unchanged".

**Test first:** the tests, then the source.

**Rule it must not break:** the existing list, search and minors tests unchanged; the minors audit unchanged.

**Pins:** 17 to 21, 19b, 25, 40, 42.

### Task 6: Contracts

**Commit:** `feat(contracts): people list filters, status, summary and source`

**Files:**

- `packages/contracts/src/people.ts`: `listPeopleBody` (`:12-20`) gains `status`, `source`, `groupId`, refused with `kind: "minors"`; the `PersonListItem` type as a union on `isMinor` (`:58-65`) with the adult fields, `groups` optional; `ReadPersonResponse` (`:72-84`, a single type today) becomes a union on `isMinor` whose adult variant gains `status` and `source`; `personStatusBody` / `personStatusResponse`; `peopleSummaryBody` (`addedSince` as an ISO instant with offset) / `peopleSummaryResponse` (`groups` optional); `source` on `createPersonBody` and `updatePersonBody` as `manual | family_records`; `PERSON_SOURCES` and labels.
- `packages/contracts/src/people.test.ts`: pins 23 and 24 and one acceptance test per new schema; "PERSON_SOURCES lists the eleven keys in order" (the domain test and the migration test pin the same literal list, so the three copies cannot drift); "peopleSummaryBody refuses an addedSince without an offset".

**Test first:** the tests, then the schemas.

**Rule it must not break:** every existing contract test unchanged.

**Pins:** 23, 24.

### Task 7: Routes

**Commit:** `feat(api): people status and summary routes, list filters and groups`

**Files:**

- `apps/api/package.json:16-29`: `"@community-hub/groups": "workspace:*"` after `entitlements-eval`; `pnpm-lock.yaml` by `pnpm install`.
- `apps/api/Dockerfile:8`: `--filter @community-hub/groups`. `apps/api/src/image.test.ts:148-158`: `@community-hub/groups` in the array; `pnpm deploy --prod` resolves its workspace dependencies (people, crypto, db, kernel, usage, all already built).
- `apps/api/src/people-routes.ts`:
  - `groups.basic`: one `checkEntitlement` (`entitlement-guard.ts:43`) in the list and summary handlers, before `deps.checkout("app", ...)`, as `access-routes.ts:729`; the answer is reused for `groupId`, `groups` items and the summary's `groups`.
  - list (`:223-288`): parse the new fields; `groupId` → `groups.basic` (403 when absent) → `personIdsInGroup`; pass `now: deps.now()` (`:268`); after the page, when the community has `groups.basic`, attach `groups` from `activeGroupsForPersons` to adult items; `cache-control: no-store`.
  - read (`:313-317`): `no-store`; type change only.
  - create (`:353`): pass `source`; update: `if (body.source !== undefined) changes.source = body.source` after the `changes` block (`:399-414`).
  - `status` (new): `prepare` with billing write, `holdsPermission(MANAGE)`, `setPersonStatus`, errors mapped (`not_found` 404, `conflict` 409, `invalid_input` 400), every refusal body empty.
  - `summary` (new): `prepare` with billing read, `holdsPermission(VIEW)`, `summarisePersons`, `listGroups` when `groups.basic`, `no-store`.
  - Route table (`:438-467`): two entries, surface `tenant`.
- `apps/api/src/index.test.ts:815`: 60 routes; markings `["POST /v1/people/summary", "read"]` near `:837-839` and `["POST /v1/people/status", "write"]` near `:853-855`.
- `apps/api/src/billing-guard.integration.test.ts:480`: a `fixtureMap` entry for `POST /v1/people/status`.
- Tests: **R** (pins 26 to 30 and 44; unit tests for each status code of the two routes); **I** (pins 32 and 43; "people list: a groupId from another organisation gives an empty page"; "people status: a minor's id gives 404"; "people status: two organisations"; "people summary: counts only the caller's community"; "people list: a minor in a group never appears and adults carry their groups"); **B** (pin 31).

**Test first:** the tests, then the source.

**Rule it must not break:** every existing route test; the image test; no other route's behaviour.

**Pins:** 26 to 32, 43, 44.

### Task 8: All Contacts screen

**Commit:** `feat(admin): All Contacts columns, status switch, filters and counts`

**Files:**

- `apps/admin/src/all-contacts.tsx`: `ContactItem` / `parseContactItem` (`:24-28`, `:51`) for the new fields; `fetchContacts` (`:166-187`) sends the filters; a summary fetch with `addedSince` = the browser's month start; the four cards; three `Select`s in `Field`s beside `FilterBar` (`:753`); `DataTable` (`:777`) columns in the board's order; the status `Switch` / `StatusBadge` per `people.manage` and `hideWrites` (`:164`); 409 and failure handling; the empty-filter state; Source on add (`:421-436`) and edit (`:469-480`).
  - The admin has no `@community-hub/contracts` dependency and gains none: it keeps its own label map for the eleven keys, and a test checks every key has a label.
  - Existing tests stay green: items without the new fields parse tolerantly (status `active`, email and phone "None"); the list body omits unset filters; the summary is fetched only when the list is ("Not allowed" still makes zero `/v1/people/` calls); new columns apply to the adults tab only; a search with no match keeps "No contacts match" (`all-contacts.test.tsx:1112-1130`) and only a filter with no match shows "No contacts match these filters".
  - The `Switch` keeps the visible label "Active" (`switch.tsx:6` requires one) and gets an `aria-label` that includes the contact's name.
  - Below 640px `DataTable` stacks rows into cards (`data-table.tsx:30-62`); that is the expected phone layout, and the browser check confirms no page-level sideways scroll.
- `apps/admin/src/contact-fields.tsx:19-27`: an optional `source` prop that renders the Source select only when passed; Family Records passes nothing.
- `apps/admin/src/all-contacts.test.tsx` (pins 33 to 37 and a test per Screen bullet of the spec), `apps/admin/src/family-records.test.tsx` (pin 38).

**Test first:** the tests (RED), then the screen.

**Rule it must not break:** every existing All Contacts and Family Records test; axe in the admin tests; WCAG 2.2 AA; no new `packages/ui` component.

**Pins:** 33 to 38.

### Task 9: Architecture, roadmap and repository state

**Commit:** `docs: mark all-contacts-parity done`

**Files:**

- `architecture.md`: `:563` (six routes, the list's fields and filters, read status and source, the grant now also on `status` and `source`); `:731` (§12.1 grant sentence: thirteen columns); `:774` (§12.2.1 `people.date_of_birth`: decrypted on the adult list to derive an age, never returned there); the inactive-contact rule for contact emails and broadcasts.
- `docs/roadmap.md`: the spec's Roadmap section, in full: `:176` split into five rows; `:189` Broadcast Messages rule; `:274` Intentionally dropped; `:379` group-route open item; `:19-27`, `:99`, `:425` snapshot and next chunk (`Contact delete`); counts.
- `AGENTS.md:9`: Repository state (this chunk done, Next `Contact delete`).

**Test first:** none (docs). `pnpm format` clean.

**Pins:** none.

## Spec pointer corrections

- Spec Behaviour (Read) says the read response "stays a union on `isMinor` as today". It is a single type today (`packages/contracts/src/people.ts:72-84`); Task 6 makes it a union.
- Spec Screen says the table scrolls inside its own container at 375px. `DataTable` stacks rows into cards below 640px; that is used instead, with the same goal of no page-level sideways scroll.
- Spec Behaviour (List) says the list uses a read path that never creates keys. In a community with no key rows that path returns no keys; an email or phone search then gives an empty page, not an error (Task 5).

## Dispatch order

Tasks 1 to 9 in order, one run each. Checkpoints after Tasks 5, 7 and 8.

## Definition of done (AGENTS.md §8)

- Every task committed and accepted; pins 1 to 44 (with 19b) fail weakened and pass restored, run by the reviewer.
- Full local gate green apart from the allowed Windows failures; CI green on the pull request.
- Browser check screenshots in the pull request; staging stays parked, recorded as an open item.
- Reviewer sign-off and the second review line in the pull request; no `docs/plans/*-report.md`; nothing under `.superpowers/` staged.

## Amendments during implementation

### A1 (2026-11-20, after checkpoint 1): test strength for Tasks 2, 3 and 5

Source: the reviewer's checkpoint pin run (pin 17 failed weakened on `OperationError: decryption failed`, not an assertion) and the checkpoint 1 owner's check (Claude Sonnet, APPROVE WITH NOTES, 0 High, 3 Medium, 9 Low). No source change; tests only, in one `test(people)` commit.

- Pin 17: the filtered group also holds a minor with no email, phone or date of birth; the test asserts by name that no minor appears, so the weakening fails on an assertion.
- New pins (file **L**):

| #   | Setting                                         | Weakening                                                           | Test that must fail (exact `it` title)                                                                    |
| --- | ----------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 18b | The audit lists only the returned page          | `targetIds` from all fetched rows (`limit + 1`) instead of the page | listPersons: a page smaller than the community audits exactly the returned ids                            |
| 20b | No-keys search is an empty page, not everyone   | The email branch sets no search clause when keys are `null`         | listPersons: an email or phone search in a keyless community with a name-only adult returns an empty page |
| 20c | A community without its own key row has no keys | Delete the community key row check in `existingCommunityFieldKeys`  | listPersons: a search in a keyless community of an organisation that has a key returns an empty page      |
| 20d | No derive when the page holds no ciphertext     | `hasCiphertext` replaced by `pageRows.length > 0`                   | listPersons: a page of name-only adults makes no KMS call and does not throw without keys                 |

- Tests with no pin claim: `createdAt` equals the stored value (a `now` different from the list's); `readPerson` returns `family_records` for an adult created with it; `updatePerson` and `listPersons` refuse a source outside their sets with `invalid_input`; the summary counts an adult whose `created_at` equals `addedSince`, and a two-organisation summary; a stub-`tx` SQL-text test that the adult list query filters by `community_id` explicitly; the migration test compares the `now()` fallback with `select now()` from the same database.
- Not acted on: `ageOn` throwing for a future date of birth (unreachable, creation refuses it; recorded for the pull request); a thrown-error weakening (W15); `example.com` fixtures.
