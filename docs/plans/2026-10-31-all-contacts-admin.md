Spec: docs/specs/2026-10-31-all-contacts-admin.md

# All Contacts admin Implementation Plan

Slug: all-contacts-admin
Status: approved (2026-10-31, Adnan Bin Hossen)

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** A community administrator can list, search, read, add and edit adult contacts in the admin, and a holder of `people.restricted.read` can list and read minors. An unprivileged caller can never learn that a minor exists.

**Architecture:** `modules/core/people` gains `listPersons` and `updatePerson`. `modules/core/access` changes `readPersonForActor` to check `people.view` for adults and `people.restricted.read` for minors. `packages/policy` and `modules/core/access/domain/role.ts` gain `people.view` and `people.manage`. Migration `0015` widens the custom-role permission CHECK and adds `app.persons.version`. `packages/contracts` gets `people.ts`. `apps/api` gets `people-routes.ts` (four POST routes). `apps/admin` gets an All Contacts screen under Contacts & Members. No new table, no event, no port, no infrastructure.

## Who does what

Implementer: Antigravity, in its own worktree on the chunk branch, test first, one commit per task, commits locally and never pushes. Reviewer: fresh-context Claude session reviewing each task by diff. The branch is not opened until this plan is approved. Only one run at a time uses the Docker test database.

## Checkpoint

After Task 5 (the people functions and the access gate, before any route) the reviewer runs the full weaken-and-fail table for pins 1–4 and 8 and accepts or returns the work before Task 6 starts.

## Global constraints

- Branch `feat/2026-10-31-all-contacts-admin`, created from `origin/main` after approval of this plan. Migration `0015` is the only migration. Expand-only.
- Every query through `packages/db` helpers inside `withAppTransaction`; community and organisation ids come from `findCommunityBySlug`, never from the request body.
- `includeRestricted`, `isMinor`, `orgId`, `communityId` are never request fields. Every body schema is `.strict()`.
- No personal data in paths, query strings, logs, audit values or error text. Search terms are personal data.
- Fixtures are synthetic. Fixture strings that look like secrets are split so scanners never match.
- `readPerson` stays exported ungated from `people/public` (owner decision). Routes call only `readPersonForActor`.
- Staging stays parked. No Terraform, Dockerfile or workflow change. `apps/api/Dockerfile` and `image.test.ts` already list people; Task 7 re-checks that and changes neither.
- Nothing is disabled to get green. Any new `packages/ui` component carries an axe test.
- Local gate per task: `pnpm gate` (after `pnpm install --frozen-lockfile` and `pnpm build` in a fresh worktree; bypass the turbo cache with `--force` where a test reads a file outside its package).

## Deviations from the spec (repeated in the PR body)

1. **`app.persons` has no creation-time column.** The spec ordered the minors page by creation time then id. There is no such column and this chunk adds none. The minors page is keyset-paged on `id` alone. Adults keep family name, given name, id.
2. **Adult read permission (owner decision, 2026-10-31).** Today `readPersonForActor` lets `safeguarding_officer` (which holds `people.restricted.read` and not `people.view`) read any person. In Task 5 an adult is readable with `people.view` **or** `people.restricted.read`, so `safeguarding_officer` keeps full read capability. `people.view` alone never opens a minor. This differs from the spec's literal "`people.view` for adults".
3. **Column-level UPDATE grant (checkpoint finding 3).** `updatePerson` needs `UPDATE` on `app.persons`, which `0005` had revoked. Migration `0015` must grant `UPDATE` only on the columns `updatePerson` writes (`given_name`, `family_name`, `email`, `email_bidx`, `phone`, `phone_bidx`, `date_of_birth`, `birthday_md`, `age_basis`, `version`), not table-wide, so `is_minor`, `household_id`, `org_id`, `community_id` and the `*_restricted` columns stay unwritable by `app`. `app` still lacks `DELETE`. The privileges test asserts column privileges. Recovery note: `REVOKE UPDATE (...) ON app.persons FROM app`.
4. **`version` is returned (checkpoint finding 2).** `readPerson` and `PersonListItem` gain `version: number` (additive). The spec said `readPerson` stays as it is; this is the smallest change that lets the update flow work.
5. **Update audit lists the person id only (checkpoint finding 4).** `appendAuditEvent` takes only action, purpose and target ids, so the spec's "changed field names" cannot be recorded without a larger audit-API change. The update audit row carries action `people.person.updated`, purpose and the person id, no values and no field names. An update with no changes is `invalid_input`: no version bump, no audit row.
6. **Adult denial audit uses the purpose `people.person.view`.** An adult is readable with either key, and audit purposes must have three segments (database CHECK and the event-names checker), so the two-segment key `people.view` cannot be a purpose. `people.person.view` is registered with `defineAuditPurpose` in `modules/core/access/public/index.ts`, like `entitlements.toggles.view`. The minor denial keeps `people.restricted.read`.
7. **`listPersons` minors mode refuses `includeRestricted` other than `true`** (`invalid_input`, no audit row, no rows), so an unprivileged call can never return blank rows or a count.
8. The `decide` and `role.ts` permission lists are two copies of one list; both change in Task 1, and a test asserts they match the CHECK (Task 2).
9. **No index on `app.persons` (Task 3 `EXPLAIN`).** On 5,000 adults plus 50 minors in one community, both list queries are sequential scans and run in 5.9 ms (adults) and 0.4 ms (minors). The plan said an index would be added if a sequential scan showed; the cost is a second migration surface for a parish-sized table, so none is added. The roadmap open items record that an index starting with `org_id` is added when a real community passes a few tens of thousands of contacts or the list is measured slow.
10. **A route-level entitlement guard (`apps/api/src/entitlement-guard.ts`) is added** before Task 7, as its own commit. No route checked an entitlement before; the guard is built on `readSnapshot` and `evaluate`, refuses a disabled, absent or unevaluable key with 403 and an empty body, and writes no audit row. The four people routes use it. It adds no dependency.

## Security pins

Each row is run once by the implementer: weaken the source, see the named test fail, restore, report the failure. The weakened tree is never committed.

| #   | Setting                                                           | Pinning test                                                                                                               | Weaken by                                                                              |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | Adult list excludes minors in SQL                                 | `list-persons.integration.test.ts`: community with 2 adults and 2 minors, `adults` returns 2, no minor id, any search      | Remove `is_minor = false` from the adult query                                         |
| 2   | `includeRestricted` is not a request field                        | `people.test.ts` (contracts) and route test: body with `includeRestricted`, `isMinor`, `orgId` is 400                      | Drop `.strict()` from a body schema                                                    |
| 3   | `includeRestricted` derives from `decide(people.restricted.read)` | route test: caller with `people.view` only asks `minors` → 403; caller with restricted read gets names                     | Hardcode `includeRestricted: true` or derive it from the body                          |
| 4   | Minors mode needs `people.restricted.read`                        | route test (403 + `people.permission.denied` audit row, no count in the response)                                          | Check `people.view` instead                                                            |
| 5   | Each route checks its own permission                              | one route test per route: a caller holding only each of the other two keys is refused                                      | Swap `people.manage` for `people.view` on create or update, or view for manage on list |
| 6   | Identical 404 for absent, cross-community and unreadable minor    | route test compares status and body bytes for the three cases                                                              | Return 403 for the unreadable minor                                                    |
| 7   | Every decrypt is audited, ids only                                | integration: a minors list and a read write audit rows; rows hold ids and purpose, no name or search term                  | Remove the audit append in `readRosterNames` call path or in `readPersonForActor`      |
| 8   | Adult/minor branch of the gate                                    | `restricted-read.integration.test.ts`: `people.view` reads an adult, is refused a minor; guardian view still opens a minor | Check `people.view` for both                                                           |
| 9   | Update runs `where version = $1` and bumps it                     | `update-person.integration.test.ts`: stale version → conflict, row unchanged, and no audit row                             | Drop the version predicate                                                             |
| 10  | Organisation and community scope on list and update               | two-organisation and two-community tests for list, read, update                                                            | Remove the `org_id` or `community_id` predicate in `listPersons`/`updatePerson`        |
| 11  | Write routes are `billing: "write"`                               | route test: read-only organisation gets 402 on create and update, 200 on list and read                                     | Mark create as `read`                                                                  |
| 12  | `people.directory` entitlement checked in the routes              | route test with the entitlement off → refused                                                                              | Skip the entitlement check                                                             |
| 13  | Search term never reaches logs, audit or errors                   | route test captures logger output and audit rows after a search for a unique synthetic term                                | Log the request body or put the term in an error                                       |
| 14  | Permission list in sync (`decide`, `role.ts`, CHECK)              | `role.test.ts` and `schema.test.ts` compare the three                                                                      | Add `people.view` to only two of the three                                             |
| 15  | Admin hides controls without the permission or entitlement        | `all-contacts.test.tsx`: no Add, Edit or Minors tab without the key; nav hidden without `people.directory`                 | Render the controls unconditionally                                                    |

There are no Terraform asserts in this chunk, so the scratch Terraform probe is not needed.

## Rollback

Revert the pull request. If `0015` is deployed and a custom role grants `people.view` or `people.manage`, delete those grants first, then restore the old CHECK. The `version` column stays (dropping it is a later contract PR).

## Stop and ask (AGENTS.md §12)

Stop and report, do not improvise, when: the plan is wrong; a task needs a migration other than `0015`, or a Dockerfile, workflow, Terraform or dependency change not named here; the same step fails twice; a test needs real data; anything looks like a security issue.

---

### Task 1: Permission keys in policy and roles

**Files:** `packages/policy/src/decide.ts`, `packages/policy/src/decide.test.ts`, `modules/core/access/domain/role.ts`, `modules/core/access/domain/role.test.ts`.

- [ ] RED: tests that `catalogue()` contains `people.view` and `people.manage`; that `org_owner`, `org_admin` and `community_admin` hold both; that `staff`, `member`, `safeguarding_officer`, `org_billing`, `org_auditor` hold neither; that a custom role may select either; that `CATALOGUE_PERMISSIONS` equals `catalogue()`.
- [ ] GREEN: add both keys to `CATALOGUE` in `decide.ts` (the bundles for the three roles already spread it) and to `CATALOGUE_PERMISSIONS` in `role.ts`.
- [ ] Commit `feat(policy): add people.view and people.manage`.

Must not break: no built-in role other than the three gains a key (pin 14 partly).

### Task 2: Migration 0015 — permission CHECK and `persons.version`

**Files:** `modules/core/access/db/schema.ts` and `schema.test.ts`, `modules/core/people/db/schema.ts`, `modules/core/people/module.manifest.ts`, `modules/core/people/domain/manifest.test.ts`, `packages/db/drizzle/0015_*.sql` and `meta`, plus the people/db boundary tests that list columns.

- [ ] RED: tests that a custom-role permission row with `people.view` and `people.manage` inserts and one with an unknown key fails; that `app.persons.version` exists, is `integer not null default 1`, defaults to 1 for rows inserted by `createPerson`; that RLS and `FORCE ROW LEVEL SECURITY` are still on `persons`; that `app` still lacks `DELETE`; that the CHECK list equals `catalogue()` (pin 14); that `dataClasses` classifies `version` as `internal`.
- [ ] GREEN: widen the CHECK, add `version`, generate `0015` with the repo's generator, add `version` to `dataClasses` and `manifest.test.ts`. The schema file imports no values from `@community-hub/db`.
- [ ] Migration wave: **expand**. Recovery note is under Rollback.
- [ ] Commit `feat(db): migration 0015 for people permissions and persons version`.

### Task 3: `listPersons`

**Files:** `modules/core/people/infrastructure/list-persons.ts`, its integration test, `public/index.ts`, `module.manifest.ts` (audit action `people.person.listed_minors`), possibly an index in `people/db/schema.ts` and the `0015` migration if `EXPLAIN` on synthetic data shows a sequential scan at 5,000 rows. An index starts with `org_id`; if one is added it goes into `0015` in this task and the commit says so.

- [ ] RED: integration tests for pin 1 and pin 10; adult keyset order (family name, given name, id) across three pages; page size bounds 1–100; case-insensitive prefix search on adults; exact match on email and phone through the blind index (term never echoed); a minor never returned by any adult query, including a name that matches a minor's household member; `minors` mode: ids found in `app.persons` where `is_minor` is true, keyset on `id`, names resolved through `readRosterNames` with the caller-supplied `includeRestricted`; `minors` mode audits through `readRosterNames` (pin 7).
- [ ] GREEN: `listPersons(tx, kms, keyArn, { kind, search, cursor, limit, includeRestricted, actorUserId })`. It does no permission checking; the route does.
- [ ] Commit `feat(people): list persons with adult and minor modes`.

### Task 4: `updatePerson`

**Files:** `modules/core/people/infrastructure/update-person.ts`, integration test, `public/index.ts`, manifest audit action `people.person.updated`.

- [ ] RED: updates given name, family name, email, phone for an adult; recomputes blind indexes; duplicate email/phone is a typed conflict with no field named; stale `version` is a typed conflict, row and audit unchanged (pin 9); a minor id is a not-found; cross-organisation and cross-community id is a not-found (pin 10); the audit row lists changed field **names** only; `version` increments by exactly one.
- [ ] GREEN: `updatePerson(tx, kms, keyArn, { personId, version, changes, actorUserId })`, `where version = $1 and is_minor = false`.
- [ ] Commit `feat(people): update an adult with a version check`.

### Task 5: The gate checks adult vs minor (checkpoint)

**Files:** `modules/core/access/infrastructure/restricted-read.ts` and its integration test; `modules/core/access/public/index.ts` if a new export is needed.

- [ ] RED (pin 8): `people.view` reads an adult; is refused a minor with the same `forbidden`; `people.restricted.read` reads a minor; guardian view still reads a minor; an unknown id and a cross-community id throw the same error as an unreadable minor; the denial audit row records the permission that was actually required and ids only; a `safeguarding_officer` still reads an adult (Deviation 2).
- [ ] GREEN: look up `is_minor` for the id in the same transaction, then `decide` with `people.view` (adult) or `people.restricted.read` (minor).
- [ ] Commit `feat(access): readPersonForActor checks view for adults and restricted for minors`.
- [ ] Reviewer checkpoint (see above).

### Task 6: Contracts

**Files:** `packages/contracts/src/people.ts`, `people.test.ts`, `index` export.

- [ ] RED (pin 2): each body is `.strict()`; `kind` is `adults | minors`; `limit` 1–100; `search` 1–100 chars, trimmed; `cursor` is an opaque string with a length cap; names 1–100 chars; email and phone shaped; `version` positive integer; bodies carrying `includeRestricted`, `isMinor`, `orgId`, `communityId` are rejected; every body carries `communitySlug`; bodies fit the 4096-byte cap at their maximum.
- [ ] GREEN: the four request schemas and the response types.
- [ ] Commit `feat(contracts): people list, read, create and update`.

### Task 7: List and read routes

**Files:** `apps/api/src/people-routes.ts`, `people-routes.test.ts`, `apps/api/src/index.ts` (wire the routes in `bindServices`, `run` and `productionRoutes`), `apps/api/package.json` (workspace dependency `@community-hub/people`) and the lockfile.

- [ ] Re-check: `apps/api/Dockerfile` and `image.test.ts` already list people; change neither, and the image test stays green.
- [ ] RED: `POST /v1/people/list` and `/v1/people/read` as `GateRoute`s shaped like `access-routes.ts`: 401, 400 on extra fields, 403 and the `people.permission.denied` audit row (pins 3, 4, 5); identical 404 (pin 6); entitlement off (pin 12); log and audit hygiene (pins 7, 13); `billing: "read"` works for a read-only organisation (pin 11); two-organisation isolation.
- [ ] GREEN: list calls `decide` for `people.view` (adults) or `people.restricted.read` (minors) and derives `includeRestricted` server-side; read calls `readPersonForActor`. Errors map through `statusFor` to empty bodies.
- [ ] Commit `feat(api): people list and read routes`.

### Task 8: Create and update routes

**Files:** `apps/api/src/people-routes.ts` and test.

- [ ] RED: `POST /v1/people/create` (201, `{ personId }`, passes `isMinor: false`, writes the `people.directory` usage fact once) and `/v1/people/update` (200 with the new `version`); `people.manage` required (pin 5); `billing: "write"` gives 402 for a read-only organisation (pin 11); duplicate email/phone is 409 with no hint which; stale version is 409; minors cannot be updated (404); the entitlement check (pin 12).
- [ ] GREEN: wire to `createPerson` and `updatePerson`.
- [ ] Commit `feat(api): people create and update routes`.

### Task 9: Admin — nav and list

**Files:** `apps/admin/src/nav.tsx`, `labels.ts`, `visible-labels.ts` (+ tests), `apps/admin/src/all-contacts.tsx`, `all-contacts.test.tsx`, `shell.tsx` (route), `apps/admin/src/api.ts` only if a helper is missing. `packages/ui` gains only what the list needs (a table and an input), each with an axe test.

- [ ] RED: Contacts & Members → All Contacts appears only with the `people.directory` entitlement and `people.view`/`people.manage`; list shows adults with search; the Minors tab appears only with `people.restricted.read`; states: empty ("No contacts yet"), no match ("No contacts match"), error alert with retry and no raw error text; the existing 402 banner; axe passes (pin 15).
- [ ] GREEN: minimal screen composing `packages/ui`, loaded through POST like `users-roles.tsx`, gated on `directory.permissions`.
- [ ] Commit `feat(admin): All Contacts list`.

### Task 10: Admin — detail, add and edit

**Files:** `apps/admin/src/all-contacts.tsx` (or a sibling file) and tests; `packages/ui` form pieces only if missing.

- [ ] RED: detail view from the read route; Add and Edit shown only with `people.manage` (pin 15); the form sends `version` and shows a conflict message on 409 that does not say which field clashed; no minor create/edit control anywhere; axe on detail and form.
- [ ] GREEN: minimal forms.
- [ ] Commit `feat(admin): view, add and edit a contact`.

If Tasks 9–10 push the chunk past the ~800-line target, the implementer reports the count and keeps going; the owner decides whether to trim the UI. Line count alone is not a reason to split.

### Task 11: Architecture records the decisions

**Files:** `architecture.md`.

- [ ] Module catalogue row and §12 note: the new permissions, the adult/minor gate rule, `persons.version`, the four routes, and that minors are listed only for `people.restricted.read`. Spec Decisions 1–4 are cited. No test.
- [ ] Commit `docs(architecture): record the All Contacts decisions`.

### Task 12: Catalogue (last task on this branch)

**Files:** `docs/roadmap.md`.

- [ ] `All Contacts admin` **done**; snapshot (last shipped, next chunk `Family Records`, counts); add an open item: the next chunk that unparks staging verifies migration `0015` (`persons.version` exists, the CHECK admits both keys, RLS flags on `persons` still true, `app` lacks `DELETE`) alongside `0013` and `0014`; record that the adult list search reveals low counts by design (spec Risks).
- [ ] Run the §5 cleanup: `rm -f docs/plans/*-report.md; git status --short`.
- [ ] Commit `docs: mark All Contacts admin done`.

---

## Definition of done (AGENTS.md §8)

- All twelve tasks done, or dropped with a note. `pnpm gate` green, CI Stages 1–3 green on the pull request.
- Tenant-isolation tests green for list, read and update. Residency unaffected (no new outbound call).
- Manifest updated (permissions, audit actions, `version`). `architecture.md` and `docs/roadmap.md` updated in the same pull request, roadmap last.
- Reviewer sign-off recorded in the PR. This chunk touches children's data, tenancy and the database, so the second fresh-context review is required before merge and starts when the PR opens.
- Staging verified parked in the committed var files. The spec's "verified on the staging hostname" is replaced by the roadmap line carrying `0015` to the next unparking chunk, as for `0013` and `0014`.
- Session scratch cleaned: no `docs/plans/*-report.md`; nothing under `.superpowers/` staged.

## Probe record

None. No Terraform in this chunk.
