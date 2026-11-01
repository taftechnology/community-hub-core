Spec: docs/specs/2026-11-01-family-records.md

# Family Records Implementation Plan

Slug: family-records
Status: approved (2026-11-01, Adnan Bin Hossen)

The spec's four open owner decisions were confirmed by the approver on 2026-11-01 and are fixed below. The spec approval line names Adnan Bin Hossen; Abdus is told in the PR body, as for earlier chunks.

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** A community administrator can list households, open one, create and rename it, move adults in and out, add a minor with a guardian, and link or unlink guardians. A caller without `people.restricted.read` never learns that a minor exists. One capabilities route replaces `/v1/people/access` and gates the nav.

**Architecture:** `modules/core/people` gains household list, detail and rename, `moveAdult`, `addMinor`, and a hardened `linkGuardian`/`unlinkGuardian` (audit, lock, last-guardian rule). Migration `0016` adds `households.version`, two column-level UPDATE grants and a trigger that stops a minor's `household_id` changing. `packages/contracts` gets `households.ts` and the capabilities schema. `apps/api` gets `household-routes.ts` and a `/v1/access/capabilities` route in `access-routes.ts`; `/v1/people/access` is removed. `apps/admin` gets the Family Records screen. No new table, event, port, workspace package or infrastructure.

## Who does what

Implementer: Antigravity, in its own worktree on the chunk branch, test first, one commit per task, commits locally and never pushes. Reviewer: fresh-context Claude session reviewing each task by diff. Only one run at a time uses the Docker test database.

## Checkpoint

After Task 4 (all people functions and the guardian rules, before any contract or route) the reviewer runs the full weaken-and-fail table for pins 1–8, 23 and 24 and accepts or returns the work before Task 5 starts.

## Global constraints

- Branch `feat/2026-11-01-family-records`, created from `origin/main` (already open with the spec as its first commit). Migration `0016` is the only migration. Expand-only.
- Every query through `packages/db` helpers inside `withAppTransaction`. Community and organisation ids come from `findCommunityBySlug`, never from the request body.
- `includeRestricted`, `isMinor`, `orgId`, `communityId` are never request fields. Every body schema is `.strict()`.
- No personal data in paths, query strings, logs, audit values or error text. Error bodies are empty.
- Fixtures are synthetic. Fixture strings that look like secrets are split so scanners never match.
- Staging stays parked. No Terraform, Dockerfile or workflow change. No new workspace package, so `apps/api/Dockerfile` and `image.test.ts` are re-checked in Task 9 and not changed.
- A new `app` table does not appear, and no new unique key is added. Nothing is disabled to get green. Any new `packages/ui` component carries an axe test.
- Local gate per task: `pnpm gate` (after `pnpm install --frozen-lockfile` and `pnpm build` in a fresh worktree; `--force` where a test reads a file outside its package; rebuild `@community-hub/db` after changing it).

## Decisions fixed by the spec (do not reopen)

- Page size default and maximum 25; keyset on `id` alone; one audit event per list with all returned ids.
- Callers without `people.restricted.read`: no label, no minors, no minor count or flag, no guardian link that references a minor.
- Add-minor: required date of birth resolving to under 18; no email or phone; one guardian already in the household; default rights view and consent.
- Move-adult refused (409) while the adult holds any guardian link; minors refused (400); takes and bumps person `version`.
- Unlink: body `householdId` and `linkId`; lock the child row `for update`, count remaining links, refuse (409) if none would remain.
- Link and unlink need `people.manage` and `people.restricted.read`; add-minor the same; list needs `people.view`; read needs `people.view` or `people.restricted.read`; create, rename, move-adult need `people.manage`.
- Household routes require `people.households` only. Nav needs `people.households` and `people.view`.
- A caller holding `people.restricted.read` and not `people.view` (the safeguarding officer) may call `households/read` and sees adults under the same rule as All Contacts reads; the label and minors need `people.restricted.read`. They cannot list households (`people.view`) and have no nav item.

## Security pins

Each row is run once by the implementer: weaken the source, see the named test fail, restore, report the failure. The weakened tree is never committed.

| #   | Setting                                                                    | Pinning test                                                                                                                                                  | Weaken by                                                                                 |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Database trigger stops a minor's `household_id` changing                   | `privileges.integration.test.ts`: as the `app` role, `update app.persons set household_id = …` on a minor raises; on an adult it succeeds                      | Drop the trigger from `0016`, or drop the `old.is_minor` condition                        |
| 2   | Column grants are exactly `households(label, version)` and `persons(household_id)` added to the ten from `0015`; no DELETE | `privileges.integration.test.ts`: reads `information_schema.column_privileges`; `app` cannot update `is_minor`, `org_id`, `community_id` or `households.id`; lacks DELETE on households, persons, household_keys | Widen to a table-wide `GRANT UPDATE`                                |
| 3   | Last guardian cannot be unlinked, including concurrently                   | `guardian.integration.test.ts`: single unlink of the only link → conflict, row remains; two transactions unlinking G1 and G2 of one child: the second waits on the child-row lock (capture the second backend's `pg_backend_pid()`, poll `pg_stat_activity` for that pid with `wait_event_type = 'Lock'` from the migrator connection, hard deadline, no sleep), then returns `last_guardian`; child ends with one link | Remove the `for update`, or count before locking                  |
| 4   | Unlink verifies the link belongs to the given household                    | `guardian.integration.test.ts`: a link id from household B with household A → not found, link remains                                                         | Delete by `linkId` alone                                                                  |
| 5   | Move-adult refused while the adult holds a guardian link                   | `household-members.integration.test.ts`: adult with a link → conflict, `household_id` unchanged, no audit row; after unlink the move works; an invariant query over every `guardian_links` row finds no guardian outside the link's household | Drop the link check                                  |
| 6   | Move-adult never moves a minor; add-minor rejects an adult DOB             | same file: minor id → `minor_not_movable`; DOB of 18+ → invalid, no `persons` row written (the age check runs before `createPerson`)                                                                      | Remove the `is_minor = false` predicate; skip the age check                               |
| 7   | Add-minor is atomic                                                        | same file: guardian not in the household → error; checked from a second connection after the call, no `persons`, `guardian_links` or audit row exists         | Catch and swallow the `linkGuardian` error in `addMinor` so the person row commits        |
| 8   | Update paths run `where version = $1` and bump it (rename, move-adult)     | integration: stale version → conflict, row unchanged, no audit row                                                                                            | Drop the version predicate                                                                |
| 9   | Caller without `people.restricted.read` sees no minor, count, flag, link or label | `household-detail.integration.test.ts` and route test: household with 2 adults, 2 minors and links to them; `people.view`-only caller gets adults only, no `minors` key, no link to a minor, `label: null`; response bytes contain no minor id | Always include minors; drop the link filter           |
| 10  | `includeRestricted` derives from `decide(people.restricted.read)`, not input | route tests: body carrying `includeRestricted`, `isMinor`, `orgId`, `communityId` → 400 (every schema `.strict()`); a `people.view`-only caller gets the same bytes whatever the body | Hardcode `true`, or drop `.strict()`                |
| 11  | Each route checks its own permission(s)                                    | one route test per row of the spec matrix: callers holding only each other key (and only `people.manage` for link/unlink/add-minor) are refused 403 with a `people.permission.denied` audit row | Swap `people.manage` for `people.view`; drop the restricted check on link/unlink/add-minor |
| 12  | Tenant scope on every function                                             | two-organisation and two-community tests for list, read, rename, move, add-minor, link, unlink: other scope's ids → identical 404, bytes equal to an absent id; `moveAdult` and `addMinor` verify the target household inside the scoped transaction (the foreign key is organisation-level) | Remove the `org_id` or `community_id` predicate in any of them                |
| 13  | `people.households` entitlement checked in every household route           | route test with it off → refused; `people.directory` off and `people.households` on → allowed                                                                  | Skip the check, or guard `people.directory`                                               |
| 14  | Writes are `billing: "write"`, reads `"read"`                              | route test: read-only organisation gets 402 on create, rename, move, add-minor, link, unlink and 200 on list, read; `index.test.ts` route-class table lists all | Mark create as `read`                                                                     |
| 15  | Guardian error codes map to 4xx                                            | route test: `invalid_guardian` 400, duplicate link 409, `last_guardian` 409, `adult_cannot_move_with_links` 409, `minor_not_movable` 400, all with empty bodies | Remove a `statusForPeople` case (→ 500)                                    |
| 16  | List writes one audit event with all ids; no label, name or term in audit/log/errors | integration: page of 5 households → exactly one list event whose `targetIds` equal the returned ids; log capture and audit rows contain none of the synthetic names | Append one event per row; put a name in an error                  |
| 17  | Capabilities allow-list is a constant; unknown keys are neither accepted nor returned | `access-routes.test.ts`: body with extra keys → 400; response key set equals the constant                                                                  | Echo requested keys; add a key without updating the constant                              |
| 18  | Capabilities booleans each derive from their own permission or entitlement | `access-routes.test.ts`: custom roles holding one key each; entitlement off                                                                                    | Swap two booleans; hardcode `people.restricted.read: true`                                |
| 19  | Stranger and unknown slug get the same empty 403                           | route unit and integration tests                                                                                                                              | Return 404 for the unknown slug                                                           |
| 20  | `/v1/people/access` is gone                                                | `people-routes.test.ts`: the route table has no such pattern; request → 404                                                                                   | Leave the route registered                                                                |
| 21  | Admin hides the nav item and controls without the permission or entitlement | `family-records.test.tsx`, `nav` test: item hidden without `people.households` or `people.view`; no Add minor, Link or Unlink without `people.manage` and `people.restricted.read`; no minor section without restricted read | Render unconditionally                       |
| 22  | `households.version` classified and manifest in sync                       | `manifest.test.ts` and `schema.test.ts`                                                                                                                       | Omit `version` from `dataClasses`                                                         |
| 23  | A move cannot race a link                                                  | `household-members.integration.test.ts`: `moveAdult` holds the guardian row lock while `linkGuardian` waits (same pid-and-wait technique as pin 3); after both finish no link has a guardian outside its household | Remove `for update` in `moveAdult` or `for share` in `linkGuardian`                      |
| 24  | Every household read and write appends an audit event, ids only            | integration: detail read, rename, move, add-minor, link, unlink each write exactly one event with the named action; none holds a name, label or term          | Drop the `appendAuditEvent` call in each function in turn                                 |
| 25  | The `people.households` usage fact is recorded once per household created  | `household.integration.test.ts`: `createHousehold` writes one fact; a failed create writes none                                                               | Remove the `recordSuccess` call                                                           |

There are no Terraform asserts in this chunk, so the scratch Terraform probe is not needed.

## Rollback

Revert the pull request. If `0016` is deployed, first `DROP TRIGGER` on `app.persons`, then `REVOKE UPDATE (label, version) ON app.households FROM app` and `REVOKE UPDATE (household_id) ON app.persons FROM app`. The `version` column stays (dropping it is a later contract PR). `/v1/people/access` is restored by the revert; the admin and API revert together.

## Stop and ask (AGENTS.md §12)

Stop and report, do not improvise, when: a task grows past about 400 changed lines excluding tests (split it and ask); the plan is wrong; a task needs a migration other than `0016`, or a Dockerfile, workflow, Terraform or dependency change not named here; the same step fails twice; a test needs real data; the trigger or a grant is rejected by a CI checker; anything looks like a security issue.

---

### Task 1: Migration 0016 — version, grants, trigger

**Files:** `modules/core/people/db/schema.ts`, `schema.test.ts`, `module.manifest.ts`, `domain/manifest.test.ts`, `infrastructure/privileges.integration.test.ts`, `packages/db/drizzle/0016_*.sql` and `meta`, plus boundary tests that list columns. `privileges.integration.test.ts` currently pins exactly ten updatable `persons` columns and lists `household_id` as forbidden; it changes to eleven and `household_id` moves to allowed. `manifest.test.ts` is a full equality check and gains `households.version`. Pin 2 uses `has_column_privilege`.

- [ ] RED: tests that `households.version` exists (`integer not null default 1`), RLS and `FORCE ROW LEVEL SECURITY` still on `households` and `persons`, `app` has UPDATE on exactly the added columns and still lacks DELETE and `guardian_links` UPDATE (pins 2, 22); the trigger test (pin 1).
- [ ] GREEN: add `version`, generate `0016` with the repo's generator, hand-add the two `GRANT UPDATE (…)` statements and the `BEFORE UPDATE` trigger function and trigger on `app.persons` (raises when `old.is_minor and new.household_id is distinct from old.household_id`), add `version` to `dataClasses` and `manifest.test.ts`. The schema file imports no values from `@community-hub/db`. No `guardian_links` grant.
- [ ] Migration wave: **expand**. Recovery note under Rollback.
- [ ] Commit `feat(db): migration 0016 for household version, grants and minor household guard`.

Must not break: RLS/FORCE RLS on `persons`; no UPDATE on `is_minor`.

### Task 2: Household list, detail and rename

**Files:** `modules/core/people/infrastructure/household.ts`, new `household-list.ts`, `household-detail.test`/integration files, `public/index.ts`, `module.manifest.ts` (audit actions registered with `defineAuditAction` and `defineAuditPurpose` in `public/index.ts`, not the manifest: `people.household.listed`, `people.household.updated`; `people.household.read` exists; `createHousehold` records the `people.households` usage fact, pin 25).

- [ ] RED: tests for pins 8 (rename), 9, 12, 16: list keyset on `id`, cap 25, `adultCount`, one audit event; detail with the restricted/unrestricted split; rename with `version`; two-organisation and two-community cases; a household with a minor fixture throughout. `createHousehold` returns `version`.
- [ ] GREEN: implement `listHouseholds`, `readHouseholdDetail` (restricted flag passed in by the caller, derived from a permission check, never from input), `renameHousehold`.
- [ ] Commit `feat(people): list, read and rename households`.

Must not break: §1 rules 3, 4, 5.

### Task 3: Guardian link and unlink hardening

**Files:** `modules/core/people/infrastructure/guardian.ts` and `guardian.integration.test.ts`, `public/index.ts`, (audit actions registered in `public/index.ts`).

- [ ] RED: tests for pins 3 and 4, plus audit events on link and unlink and the household check on unlink (the `person_activity` rows are kept as today).
- [ ] GREEN: `unlinkGuardian` takes `householdId` and `linkId`, locks the child row `for update`, counts remaining links in the same transaction, deletes and audits. `linkGuardian` appends an audit event and takes `for share` on the guardian and child rows (pin 23); its audit action names are `people.guardian.linked` and `people.guardian.unlinked`.
- [ ] Commit `feat(people): audit guardian links and refuse to unlink the last guardian`.

### Task 4: Move adult and add minor (checkpoint)

**Files:** new `modules/core/people/infrastructure/household-members.ts` and integration test, `domain/error.ts` (`PeopleErrorCode`: `last_guardian`, `adult_cannot_move_with_links`, `minor_not_movable`), `public/index.ts`, (audit action `people.person.household_moved` registered in `public/index.ts`).

- [ ] RED: tests for pins 5, 6, 7, 8 and the version bump on a successful move; add-minor writes the person, the link and the audit events in one transaction, rights default view and consent, no email or phone accepted.
- [ ] GREEN: `moveAdult`, `addMinor` (reuses `createPerson` for the key work and `linkGuardian` inside the same transaction; `createPerson` still records the `people.directory` usage fact). 
- [ ] Commit `feat(people): move adults between households and add minors`.

Checkpoint here; see above. `moveAdult` locks the person row `for update` before it checks links (pin 23) and verifies the target household inside the scope. `addMinor` checks the date of birth before calling `createPerson` (pin 6) and calls the Task 3 `linkGuardian`.


### Task 5: Contracts

**Files:** `packages/contracts/src/households.ts` and `households.test.ts`, `packages/contracts/package.json` (`./households` export), `access.ts` and `access.test.ts`, package exports.

- [ ] RED: tests that every body schema is `.strict()` (pin 10), `limit` ≤ 25, `dateOfBirth` required for add-minor, `rights` needs at least one true, the capabilities body is `communitySlug` only, the response key set equals the constant allow-list (pin 17).
- [ ] GREEN: Zod schemas for the nine routes. OpenAPI regenerated if the repo generates it; no OpenAPI diff check exists yet.
- [ ] Commit `feat(contracts): household and capabilities schemas`.

### Task 6: Capabilities route

**Files:** `apps/api/src/access-routes.ts`, `access-routes.test.ts`, `access-flow.integration.test.ts`, `index.test.ts` (route-class table).

- [ ] RED: tests for pins 17, 18, 19 and the response shape; the route is listed in the route-class table as `tenant`, `billing: read`. The old `/v1/people/access` stays in this task.
- [ ] GREEN: `POST /v1/access/capabilities`, derived from `holdsPermission` and `checkEntitlement`; no role grant → empty 403.
- [ ] Commit `feat(api): add the capabilities route`.

### Task 7: Admin moves onto capabilities

**Files:** `apps/admin/src/people-access.tsx` (renamed or reduced to a capabilities provider), `nav.tsx`, `shell.tsx`, `all-contacts.tsx`, `all-contacts.test.tsx`, `shell.test.tsx`, `visible-labels` tests.

- [ ] RED: tests that the provider posts `/v1/access/capabilities`, non-200 means all false, Contacts needs `people.directory`, Family Records needs `people.households` and `people.view` (pin 21), the item stays a plain label until Task 11. The roughly 50 `all-contacts.test.tsx` mock branches move to the new route and response shape through one shared test helper.
- [ ] GREEN: provider, nav `entitlementMap` extended with a permission requirement, All Contacts reads `permissions` and `entitlements`.
- [ ] Commit `refactor(admin): read access from the capabilities route`.

### Task 8: Retire `/v1/people/access`

**Files:** `apps/api/src/people-routes.ts`, `people-routes.test.ts`, `people-routes.integration.test.ts`, `index.test.ts`, `packages/contracts/src/people.ts` and `people.test.ts`.

- [ ] RED: pin 20; the old tests for the route are deleted, their behaviour already covered by pins 18 and 19.
- [ ] GREEN: remove the handler, route entry, contract schema and `DIRECTORY_ENTITLEMENT` use for it. `communityScope` and the other four people routes are unchanged. Nothing is disabled to get green.
- [ ] Commit `refactor(api): retire the people access route`.

### Task 9: Household read routes

**Files:** new `apps/api/src/household-routes.ts` and tests, route registration in `apps/api/src/index.ts`, `index.test.ts`, `apps/api/Dockerfile` and `image.test.ts` re-checked only.

- [ ] RED: pins 9–16 for `households/list` and `households/read`: permission matrix, restricted derivation, entitlement guard on `people.households`, identical 404, empty error bodies, log/audit hygiene.
- [ ] GREEN: handlers built on the Task 2 functions; the task also measures a 25-household page on synthetic data and writes the time in its report for the PR; a household-specific scope helper (the people helper is hard-wired to `people.directory`).
- [ ] Commit `feat(api): household list and read routes`.

### Task 10: Household write routes

**Files:** `apps/api/src/household-routes.ts` and tests, `statusForPeople` (or a household equivalent), `index.test.ts`.

- [ ] RED: pins 10–15 for create, rename, move-adult, add-minor, link, unlink: matrix rows, 402 for a read-only organisation, status mapping for every new code, stale version 409, cross-scope 404.
- [ ] GREEN: six handlers. `statusForPeople` maps `invalid_guardian` 400, duplicate link 409, `last_guardian` 409, `adult_cannot_move_with_links` 409, `minor_not_movable` 400.
- [ ] Commit `feat(api): household write routes`.

### Task 11: Admin — Family Records list and detail

**Files:** new `apps/admin/src/family-records.tsx`, `family-records.test.tsx`, `nav.tsx`, `shell.tsx` (the Family Records route), `labels.ts` if needed.

- [ ] RED: list with empty state ("No households yet"), keyset "next", detail with adults, guardians, and a minors section only with `people.restricted.read`; retry on network failure; axe test; pin 21.
- [ ] GREEN: the screen composes `packages/ui`; Family Records becomes a link. No new component without an axe test.
- [ ] Commit `feat(admin): Family Records list and detail`.

### Task 12: Admin — household actions

**Files:** `apps/admin/src/family-records.tsx` and test.

- [ ] RED: create and rename with the version and a 409 reload flow (discard the stale draft on conflict, as All Contacts does), move adult with the guardian-link refusal message, add minor with a guardian, link and unlink with the last-guardian refusal; controls absent without `people.manage` and `people.restricted.read` (pin 21).
- [ ] GREEN: the forms and actions; no minor name in any URL, title or log.
- [ ] Commit `feat(admin): Family Records actions`.

### Task 13: Architecture records the decisions

**Files:** `architecture.md`.

- [ ] §9 row 564: the access route is now `/v1/access/capabilities`, the People surface drops `/v1/people/access`, and the `people.households` guard is recorded. Row 565 (Family Records) is filled: household routes, the permission matrix, the minor-omission rule, the trigger, and that life events are the next chunk. Line 350 is left for the life-events chunk. No test.
- [ ] Commit `docs(architecture): record the Family Records decisions`.

### Task 14: Catalogue (last task on this branch)

**Files:** `docs/roadmap.md`.

- [ ] `Family Records` **done**; snapshot (last shipped, next chunk, counts); the capabilities open item removed; a new open item that the next chunk that unparks staging verifies migration `0016` (`households.version`, the trigger, RLS flags, `app` lacks DELETE, UPDATE only on the named columns); record the sequential scan on `persons(household_id)`, the 25-household KMS cost with the measured page time, and that life events are the next chunk with their decisions.
- [ ] Run the §5 cleanup: `rm -f docs/plans/*-report.md; git status --short`.
- [ ] Commit `docs: mark Family Records done`.

---

## Definition of done (AGENTS.md §8)

- All tasks 1–14 done, or dropped with a note. `pnpm gate` green, CI Stages 1–3 green on the pull request.
- Tenant-isolation tests green for every household function and route. Residency unaffected (no new outbound call).
- Manifest updated (audit actions, `version`). `architecture.md` and `docs/roadmap.md` updated in the same pull request, roadmap last.
- The 25-household list page time is measured (Task 9 owns it) on synthetic data and recorded in the PR.
- Reviewer sign-off recorded in the PR. This chunk touches children's data, tenancy and the database, so the second fresh-context review is required before merge and starts when the PR opens.
- Staging verified parked in the committed var files; the roadmap line carries `0016` to the next unparking chunk, as for `0013`–`0015`.
- Session scratch cleaned: no `docs/plans/*-report.md`; nothing under `.superpowers/` staged.

## Probe record

None. No Terraform in this chunk.
