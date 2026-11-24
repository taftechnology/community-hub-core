Spec: docs/specs/2026-11-24-family-records-parity.md

# Family Records parity Implementation Plan

Slug: family-records-parity
Status: approved (2026-11-24, Adnan Bin Hossen)

Revision 2 (2026-11-24) applies the fresh-context plan check (Claude Haiku 5.5, READY WITH CHANGES, 2 High, 10 Medium, 18 Low). Not applied: M7 (a throwaway Postgres 17 probe showed that a `BEFORE UPDATE` row trigger runs after the row-lock wait with a fresh snapshot, so the hide waits for an add-minor and is refused; pin 90 keeps that), L15 (one screen, one commit). M8 needs no change.

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** Staff can set a family Active or Inactive, delete a family with no child in it, restore it within 720 hours, and keep up to five emergency contacts per family. After 720 hours the family and its household key are purged through one `SECURITY DEFINER` function. Add Adult names a deleted duplicate. ADR 0021 is the design record.

**Architecture:**

- `packages/db`: migration `0023` (four columns, an index, a column grant, household insert and update triggers, the persons triggers' household rule, `app.purge_deleted_households`) and its tests.
- `modules/core/people`: schema, manifest, error code, hide, restore, status, deleted list, purge wrapper, emergency contacts, hidden-family filters and the household lock.
- `packages/contracts`: the new bodies and responses.
- `apps/api`: five routes, the list's `status`, the sweep, the denial purpose fix.
- `apps/admin`: Family Records screen and an emergency contacts panel.
- `architecture.md`, `docs/roadmap.md`, `AGENTS.md`.

## Who does what

- **Implementer:** Antigravity (Gemini 3.8 Flash High), in `C:\Recovered\Taftech\wt-family-parity` on the chunk branch. Fallback when it is out of quota or fails twice: Claude Sonnet 5.5. Each model used is named in the task report.
  - Tests first, one commit per task, commits locally, never pushes. One plan task per run.
  - For every Security pins row its task names, it writes the weakening as a `.patch` under `.superpowers/sdd/pins/` (with `git diff --output`, UTF-8, LF) and a row in `.superpowers/sdd/pins/manifest.json` (the `pinrun.mjs` format, with a `"build"` list where the pin weakens a package another package's test reads through `dist`). It checks that each hunk header names the right function. The reviewer runs them. This departs from AGENTS.md §4 Phase 2, as in the last four chunks, because the reviewer re-runs every pin anyway.
  - Every test result it claims points to a log it wrote with `tee` under `.superpowers/sdd/task-N-logs/`, UTF-8. A claim without a log counts as not run.
  - It starts with no AWS credentials; pushes are blocked by the push URL and the pre-push hook.
- **Reviewer agent:** this session, on Claude Opus 5.5 for the whole chunk. Each task is reviewed by its diff, the named tests re-run, and every named pin run through `pinrun.mjs`.
- **Owner's checks and second review:** the chunk owner runs them in a fresh session on a model that is not Opus, Gemini or Sonnet. The spec checks ran on Claude Haiku 5.5.
- **Docker test database:** one run at a time. Tasks 1 to 7 need it, as does any full local gate. `pinrun` never runs while an implementer is editing the tree.

## Checkpoints

- **After Task 3** (database, purge, hide): pins 1 to 36, 34b, 84 and 90; an owner's check of `git diff <plan-sha>..<task-3-sha>`. Task 4 starts after that check.
- **After Task 7** (reads, writes, emergency contacts, routes): pins 37 to 70, 51b, 85, 86 and 91; `index.test.ts`, `billing-guard.integration.test.ts`, `access-flow.integration.test.ts` and `image.test.ts` re-run; an owner's check of `git diff <task-3-sha>..<task-7-sha>`.
- **After Task 9** (admin): pins 71 to 83 and 87 to 89; `family-records.test.tsx` and `emergency-contacts-panel.test.tsx` five times green; a browser check at 1280px and 375px, light and dark, of the status switch, the Delete dialog, the Deleted filter and the emergency contacts panel, screenshots for the pull request.

## Global constraints

- **Branch:** `feat/2026-11-24-family-records-parity`, from `origin/main` at `26a021d`. The spec and ADR 0021 are its first commit (`f1f58cb`), this plan its second.
- **Migration:** one file, `0023`. Until the pull request merges, later tasks may edit `0023`'s hand SQL (and regenerate its snapshot); each such edit is named in that task's report. `0022` and earlier are not edited. No `0024`.
- **Untouched:** identity, tenancy, billing, entitlements, policy, groups and access source; Terraform, workflows, `infra/`; the Dockerfile; the contact purge function and `person-delete.ts`; `FilterBar`, `ConfirmDialog` and every other `packages/ui` component; life-event routes.
- **Dependencies:** none added. No new workspace package, permission, entitlement or event.
- **Never disabled to get green:** a check, a lint rule (no `eslint-disable`), an axe rule other than the repo's existing `color-contrast` exclusion, RLS, a test or a CI gate. No `@ts-ignore` or `@ts-expect-error`.
- **Fixtures** are synthetic: invented names, `example.test` addresses, `+61 4xx 555 xxx` phones.
- **Seeding hidden and aged families:** in a short **committed** transaction as `migrator`, scope set by `set_config(..., true)`, fresh organisation and community ids per test. A family that must be aged is updated inside `ALTER TABLE app.households DISABLE TRIGGER USER; ...; ENABLE TRIGGER USER;` in that one transaction; the same for `app.persons` where a minor is placed in a hidden family. A hidden family that need not be aged is hidden through `hideHousehold`, or before Task 3 by a raw `app` update to `now()`, which the trigger allows. Never through `app` with a forged time.
- **No personal data** in logs, error bodies, URLs or audit rows. Audit rows carry ids only. Emergency contact values never reach a log, an error, a URL, an audit row, a page title or a toast.
- **Encrypted column:** `emergency_contacts` is written the way `renameHousehold` writes `label` (`household.ts:329-339`) and never appears in a `WHERE`, `ORDER BY`, aggregate or `RETURNING` filter.
- **Lock order:** household, then person, everywhere a path takes both.
- **Build order:** `apps/api` imports the built `dist` of `@community-hub/contracts`, `@community-hub/people` and `@community-hub/db`. After changing one, run `pnpm --filter <pkg> build` before the dependent tests. Pins that weaken a package read through `dist` list it in `"build"`.
- **Local gate per task:** `pnpm format && pnpm lint && pnpm typecheck && pnpm exec turbo run test --continue --force --concurrency=1; pnpm check:boundaries`, teed, and the turbo summary read for any failure other than the allowed ones.
- **Allowed failures on this Windows machine,** and only these: `packages/db/src/generate.test.ts` drizzle ENOENT; the `image-publish` symlink EPERM; the `migrate.integration` and `plaintext-dist` timeouts; the identity `tsbuildinfo.test` 5 s timing flake.
- **Concurrency tests** order two transactions by locks: one holds the lock; the other is started and proven blocked through `pg_locks` (`granted = false` for its pid), or runs with `set local lock_timeout = '1s'`. Never sleeps. A wait on the audit chain is not a proof; join `pg_stat_activity` on the household or person row.
- **Thrown errors as assertions:** every call a pin may turn into a throw is wrapped in `await expect(...).resolves` or `.rejects.toMatchObject({ code: ... })`, or matches the constraint or trigger message, and the test asserts the rows are unchanged where it says "refused". No bare `rejects.toThrow()`. Purge calls use `.resolves`, so pins 17 and 22, whose weakening throws in SQL, fail on the assertion. The new people source files contain no literal `set_config` (`person.test.ts:168-175`).
- **Admin tests:** no real waits; exact fetch call counts; each new section repeated five times green before the task is reported.
- **Line endings:** LF.

## Decisions fixed by the spec (do not reopen)

1. Hide is `deleted_at` + `deleted_by`; 720 hours; database clock only; triggers refuse any other transition and any hide with a minor present.
2. One `SECURITY DEFINER` function is the only way a family or its key is erased; no new `DELETE` grant; foreign keys stay `RESTRICT`.
3. A family with a person whose `is_minor` is true cannot be hidden or purged. `age_basis = 'unknown'` is a minor.
4. Adults keep `household_id` while the family is hidden, so restore brings them back; until then they read as contacts without a family.
5. Delete, restore and the Deleted filter need `people.view`, `people.delete` and `people.restricted.read`. Status needs `people.view` and `people.manage`. Emergency contacts need `people.restricted.read`, and `people.manage` to save.
6. Status changes nothing but the family row.
7. Emergency contacts are one encrypted value, at most five entries, adult data (project owner). `relationship` is optional, one of `spouse`, `grandparent`, `relative`, `neighbour`, `friend`, `carer`, `other`. No notes.
8. The sweep runs after a 200 from household list, delete or restore, in a writable community, in its own transaction, awaited, at most 50, one `people.household.purged` event with actor `system`, failures logged by class only. Any caller with `people.view` may trigger it.
9. `/v1/households/list` and `/read` denials move from the unregistered purpose `people.view` to `people.person.view`.
10. ADR 0017's known gap in `readHouseholdDetail` is not changed here.

## Plan additions to the spec

- **Purge selection.** The locking `SELECT` carries a `NOT EXISTS` minor predicate (so a family that can never be purged does not fill the limit), and a second statement rechecks under the lock, as the spec requires.
- **Detail response.** `/v1/households/read` gains `status`, so Family Details can show it. No other detail field changes.
- **Rolling deploy.** The admin list and detail parsers treat a missing `status` as `active`, so a newer admin works against an older API for the length of a deploy.
- **`no-store`.** The five new routes set it in one wrapper around the handler, so refusals before the transaction carry it. `/v1/households/list` sets it when the parsed body has `status: "deleted"`.
- **Order of permission checks.** Delete, restore: `people.view` (purpose `people.person.view`), `people.delete` (`people.permission.denied`), `people.restricted.read`. Status: `people.view`, then `people.manage` (`people.person.manage`). Emergency contacts save: `people.manage`, then `people.restricted.read`, as rename does.
- **Persons trigger scope.** The household rule looks the household up by the new row's own `org_id`, `community_id` and `household_id`, not by `current_setting`. RLS limits `app` to its scope, and a direct connection without a scope still reaches the CHECK constraints, so `person.integration.test.ts:735-820` keeps its `23514` assertions unchanged.
- **Version checks.** `hideHousehold`, `restoreHousehold`, `setHouseholdStatus` and `saveEmergencyContacts` lock the row `FOR UPDATE` and compare the version once, in code, after the lock. The update carries no version predicate, so each version pin has one guard to weaken.
- **Purge recheck has no pin.** Under the lock order no transaction can place a minor between the two statements: every path takes a lock that conflicts with the purge's `FOR UPDATE`. The spec and ADR 0021 require the recheck, so it stays as defence in depth. Pin 22 drops both predicates.
- **Status select.** `FilterBar` has no slot for one, so the `Select` sits beside it, as on All Contacts.
- **Refusal status.** Delete and restore without a key answer 403. Only the Deleted filter answers 400.
- **Relationship list.** `modules/core/people` does not depend on `packages/contracts`, so each has the list and pin 91 compares them.
- **Old API, new admin.** The admin sends `status` to the list only when a filter is chosen. An older API answers 400 to it, for the length of a deploy (noted in the pull request).
- **Foreign key tests.** A test that today inserts a person with an unknown household as `app` and expects a foreign key error will meet the trigger first. Such a test may change its expected message only, and the report names it.
- **`roster-names.ts` and `life-event.ts`** read the household key for minors only. A minor is never in a hidden family, so they are unchanged.

## Security pins

Each row is a weakening the implementer writes as a patch and the reviewer runs through `node ~/.claude/crew/bin/pinrun.mjs .superpowers/sdd/pins/manifest.json --only <id>`. The weakened run must fail **on an assertion** in the named test; the restored run must pass. The weakened tree is never committed.

Files: **FM** = `packages/db/test/family-delete-migration.integration.test.ts` (new); **P** = `modules/core/people/infrastructure/privileges.integration.test.ts`; **FP** = `modules/core/people/infrastructure/household-purge.integration.test.ts` (new); **FH** = `modules/core/people/infrastructure/household-delete.integration.test.ts` (new); **FR** = `modules/core/people/infrastructure/hidden-family-reads.integration.test.ts` (new); **FW** = `modules/core/people/infrastructure/hidden-family-writes.integration.test.ts` (new); **EC** = `modules/core/people/infrastructure/emergency-contacts.integration.test.ts` (new); **C** = `packages/contracts/src/households.test.ts`; **R** = `apps/api/src/family-routes.integration.test.ts` (new); **BG** = `apps/api/src/billing-guard.integration.test.ts`; **AD** = `apps/admin/src/family-records.test.tsx`; **AE** = `apps/admin/src/emergency-contacts-panel.test.tsx` (new).

| #   | Setting                                                                           | Weakening                                                                                      | File | Test that must fail (exact `it` title)                                                                          |
| --- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Household trigger: `deleted_at` set only to `now()`                               | Drop the `now()` condition                                                                     | FM   | migration 0023: refuses a back-dated household deleted_at from app                                              |
| 2   | Household trigger: no hide with a minor present                                   | Drop the minor condition                                                                       | FM   | migration 0023: refuses deleted_at while a minor is in the household                                            |
| 3   | Household trigger: `deleted_by` set with `deleted_at`, cleared with it            | Drop the `deleted_by` conditions                                                               | FM   | migration 0023: refuses household deleted_at without deleted_by                                                 |
| 4   | Household trigger: non-null to another non-null refused                           | Allow any change when the old value is set                                                     | FM   | migration 0023: refuses moving a household deleted_at from one time to another                                  |
| 5   | Household insert rule                                                             | Drop the insert trigger                                                                        | FM   | migration 0023: refuses a new household inserted with deleted_at                                                |
| 6   | Persons insert into a hidden household refused                                    | Drop the insert check                                                                          | FM   | migration 0023: refuses a person inserted into a hidden household                                               |
| 7   | Persons move into a hidden household refused                                      | Drop the update check                                                                          | FM   | migration 0023: refuses moving an adult into a hidden household                                                 |
| 8   | Persons check fires only when `household_id` changes                              | Check on every update                                                                          | FM   | migration 0023: an adult in a hidden household can still be updated                                             |
| 9   | Persons check refuses a household not visible in scope                            | Pass when no row is visible                                                                    | FM   | migration 0023: refuses a household of another community of the organisation                                    |
| 10  | Persons check locks the household `FOR SHARE`                                     | Plain read                                                                                     | FM   | migration 0023: a person insert waits for a hide in progress and is refused                                     |
| 11  | Status CHECK                                                                      | Drop the CHECK                                                                                 | FM   | migration 0023: refuses an unknown household status                                                             |
| 12  | Column grant: exactly six columns                                                 | `GRANT UPDATE ON app.households TO app`                                                        | P    | grants app update on app.households only by column for the six allowed columns                                  |
| 13  | No `DELETE` on households or household_keys                                       | `GRANT DELETE ON app.households, app.household_keys TO app`                                    | P    | takes update and truncate from app everywhere, and delete except on the two link tables (existing `it`, reused) |
| 14  | No `UPDATE` on `persons.is_minor`                                                 | `GRANT UPDATE (is_minor) ON app.persons TO app`                                                | P    | app has no update on persons.is_minor                                                                           |
| 15  | `EXECUTE` revoked from `PUBLIC`                                                   | Drop the `REVOKE`                                                                              | FM   | migration 0023: PUBLIC cannot execute purge_deleted_households                                                  |
| 16  | `search_path` pinned                                                              | Drop `SET search_path`                                                                         | FM   | migration 0023: purge_deleted_households pins its search_path                                                   |
| 17  | `SECURITY DEFINER`                                                                | Make it `SECURITY INVOKER`                                                                     | FP   | app can purge a family through the function without a DELETE grant                                              |
| 18  | Raises with no scope or an empty scope                                            | Drop the scope check (asserts the function's own message)                                      | FM   | migration 0023: family purge raises when the tenant scope is unset or empty                                     |
| 19  | Raises on `p_limit` null, 0, 51                                                   | Drop the limit check                                                                           | FM   | migration 0023: family purge raises on a limit outside 1 to 50                                                  |
| 20  | 720-hour threshold on the database clock                                          | `interval '1 hour'`                                                                            | FP   | family purge leaves a family hidden 719 hours                                                                   |
| 21  | A visible family is never purged                                                  | Drop the `deleted_at` predicate                                                                | FP   | family purge leaves a visible family                                                                            |
| 22  | Minor present stops the purge                                                     | Drop both minor predicates                                                                     | FP   | family purge never erases a family with a minor in it                                                           |
| 90  | Persons check lock, the other order                                               | Plain read in the persons trigger (the foreign key's lock does not conflict with a raw update) | FM   | migration 0023: a raw hide waits for an add-minor in progress and is refused                                    |
| 24  | Community scope, function and RLS together (joint: RLS alone hides the predicate) | Drop the org and community predicates and the households `community_isolation` policy          | FP   | family purge erases only the scoped community's families                                                        |
| 24b | Organisation scope, same joint weakening                                          | As 24                                                                                          | FP   | family purge leaves another organisation's families untouched                                                   |
| 25  | Hidden contacts are cleared too                                                   | Clear only persons with `deleted_at` null                                                      | FP   | family purge clears household_id on hidden contacts too                                                         |
| 26  | Adults kept as contacts                                                           | Delete the persons rows                                                                        | FP   | family purge keeps the adults as contacts and bumps their version                                               |
| 27  | Key and label erased                                                              | Skip the `household_keys` delete and the household delete                                      | FP   | family purge erases the household key and the household row                                                     |
| 28  | `SKIP LOCKED`                                                                     | Drop `SKIP LOCKED`                                                                             | FP   | family purge skips a family another transaction has locked                                                      |
| 29  | One purged event, actor system, ids only                                          | One event per family                                                                           | FP   | family purge writes one people.household.purged event with all purged ids                                       |
| 30  | Every foreign key to households handled                                           | Add to `0023` a table with a foreign key to `app.households`                                   | FP   | every foreign key to app.households is handled by the family purge                                              |
| 31  | Hide locks the household `FOR UPDATE` and checks for a child after it             | Check for a child before the lock, without `FOR UPDATE`                                        | FH   | a delete waits for an add-minor in progress, answers household_has_children and leaves the family visible       |
| 32  | Restore only within 720 hours                                                     | Drop the cutoff                                                                                | FH   | restore answers not found at 721 hours                                                                          |
| 33  | `household_has_children` for a minor and for `age_basis` unknown                  | Count only `date_of_birth` minors                                                              | FH   | delete refuses a family with a minor and with a minor of unknown age                                            |
| 34  | Version compare on delete                                                         | Skip the compare in `hideHousehold`                                                            | FH   | a stale version on family delete or restore answers conflict and changes nothing                                |
| 34b | Version before the child check                                                    | Check for a child first                                                                        | FH   | a stale version with a child present answers conflict                                                           |
| 35  | Deleted and restored events, ids only                                             | Drop the restored append                                                                       | FH   | family delete and restore each write one event with the household id only                                       |
| 36  | Version compare on status                                                         | Skip the compare                                                                               | FH   | a stale version on family status answers conflict and changes nothing                                           |
| 84  | Status changes nothing else                                                       | Set the adults' contact status too                                                             | FH   | family status leaves its adults' status unchanged                                                               |
| 37  | Family list                                                                       | Drop `deleted_at is null` from the list                                                        | FR   | the family list leaves out a hidden family                                                                      |
| 38  | Family detail, and no read event                                                  | Move the filter after the audit append                                                         | FR   | family detail answers null for a hidden family and writes no read event                                         |
| 39  | Label open                                                                        | Drop it from `openHouseholdLabel`                                                              | FR   | openHouseholdLabel answers null for a hidden family                                                             |
| 40  | `readPerson`                                                                      | Return the stored `household_id`                                                               | FR   | readPerson returns no household for an adult in a hidden family                                                 |
| 41  | Status filter                                                                     | Ignore the status value                                                                        | FR   | the family list filters by status                                                                               |
| 42  | Deleted list: hidden families only                                                | Drop `deleted_at is not null`                                                                  | FR   | the deleted family list returns hidden families only                                                            |
| 43  | Deleted list cursor keeps microseconds                                            | Carry a JS `Date` in the cursor                                                                | FR   | the deleted family list pages rows that share a millisecond without repeats or gaps                             |
| 44  | Deleted list audit, one per call                                                  | Skip it on an empty page                                                                       | FR   | the deleted family list audits each call once, an empty page too                                                |
| 45  | `lockVisibleHousehold` filter                                                     | Drop `deleted_at is null` (the trigger then raises, which is not `not_found`)                  | FW   | add adult, add minor and move adult answer not found for a hidden family                                        |
| 46  | `requireHousehold` in `createPerson`                                              | Unfiltered plain read                                                                          | FW   | createPerson answers not found for a hidden family                                                              |
| 47  | Move adult in                                                                     | `moveAdult` reads the target without the helper                                                | FW   | move adult answers not found for a hidden target family                                                         |
| 48  | Move adult out is allowed                                                         | Require the source family visible                                                              | FW   | an adult can be moved out of a hidden family                                                                    |
| 49  | Link locks the household first                                                    | `linkGuardian` uses the plain read                                                             | FW   | a guardian link waits on the family before it locks the guardian                                                |
| 50  | Unlink locks the household first                                                  | Drop the household lock from `unlinkGuardian`                                                  | FW   | a guardian unlink waits on the family before it locks the guardian                                              |
| 51  | Rename                                                                            | Drop `deleted_at is null` from `renameHousehold`'s select                                      | FW   | rename answers not found for a hidden family                                                                    |
| 51b | Family status                                                                     | Drop it from `setHouseholdStatus`'s lock                                                       | FW   | status answers not found for a hidden family                                                                    |
| 52  | Adult in a hidden family works as a contact                                       | Refuse `updatePerson` when the family is hidden                                                | FW   | an adult in a hidden family can be edited, switched, deleted and restored and the family stays hidden           |
| 53  | Move-adult locks the target family first                                          | Lock the person first                                                                          | FW   | move adult waits on the target family before it locks the person                                                |
| 54  | Emergency contacts sealed under the household key                                 | Seal under the community key                                                                   | EC   | emergency contacts are sealed under the household key and bound to the household row                            |
| 55  | AAD label                                                                         | Use the label's AAD for the contacts                                                           | EC   | emergency contacts cannot be opened as a family label                                                           |
| 56  | Cap of five                                                                       | Raise to six                                                                                   | EC   | refuses a sixth emergency contact                                                                               |
| 57  | Relationship list                                                                 | Accept any text                                                                                | EC   | refuses a relationship outside the list, a child included                                                       |
| 58  | Version compare on save                                                           | Skip the compare                                                                               | EC   | a stale version on emergency contacts save answers conflict and changes nothing                                 |
| 59  | Read event, also when empty                                                       | Skip it on an empty list                                                                       | EC   | an emergency contacts read writes one event, an empty list too                                                  |
| 60  | Hidden family: not found, no event                                                | Drop the filter from the read                                                                  | EC   | an emergency contacts read of a hidden family answers null and writes no event                                  |
| 61  | Not in list or detail                                                             | Add `emergencyContacts` to the detail result                                                   | EC   | family list and detail carry no emergency contact field                                                         |
| 62  | Contract: unknown fields refused                                                  | Drop `.strict()` from a contact entry                                                          | C    | emergency contacts refuse an unknown field                                                                      |
| 63  | Denials: status and purpose for every new route                                   | Use `people.view` as the delete denial purpose                                                 | R    | each family route refuses each missing permission with its status and denial row                                |
| 64  | List and read denials answer 403                                                  | Restore the `people.view` purpose                                                              | R    | family list and read without people.view answer 403 with a denial row                                           |
| 65  | Deleted filter needs all three keys                                               | Skip the `people.restricted.read` check                                                        | R    | the deleted filter without all three keys answers 400 with a denial row                                         |
| 66  | Another tenant's id (joint: RLS follows the scope the route sets)                 | Set `app.community_id` from the household row instead of the slug                              | R    | every family route answers 404 for another community's household id                                             |
| 67  | `no-store`, refusals included                                                     | Drop the wrapper                                                                               | R    | every family route and the deleted list answer no-store, refusals included                                      |
| 68  | Sweep only in a writable community                                                | Skip `guardWrite`                                                                              | R    | the family sweep does not run in a read-only community                                                          |
| 69  | Sweep in its own transaction, failure quiet                                       | Let the sweep failure reach the answer                                                         | R    | a failing family sweep does not change the answer and logs the class only                                       |
| 85  | Sweep runs after list, delete and restore                                         | Drop the call from restore                                                                     | R    | a family past 720 hours is purged after a list, a delete and a restore                                          |
| 86  | No contact value in a log or audit row                                            | Add the first name to the save route's log fields                                              | R    | no emergency contact value reaches a log or an audit row                                                        |
| 91  | One relationship list                                                             | Add `child` to the contract enum                                                               | R    | the contract and domain relationship lists are equal                                                            |
| 70  | The four new write routes marked `billing: "write"`                               | Mark delete `read`                                                                             | BG   | (existing read-only table test, with the four new write routes added)                                           |
| 71  | Delete rendered only for the three keys                                           | Drop the `people.restricted.read` condition                                                    | AD   | Delete family is not rendered without all three keys                                                            |
| 72  | Deleted filter option only for the three keys                                     | Always render it                                                                               | AD   | the Deleted option is not rendered without all three keys                                                       |
| 73  | Writes hidden in a read-only community                                            | Drop `hideWrites` from the switch                                                              | AD   | a read-only community renders no status switch, Delete or Restore                                               |
| 74  | Switch rolls back on failure                                                      | Keep the optimistic value                                                                      | AD   | the status switch returns to its stored value when the save fails                                               |
| 75  | Refusal text for a child                                                          | Show the conflict text                                                                         | AD   | a family with a child shows its refusal in the dialog                                                           |
| 76  | Past-date row has no Restore                                                      | Always render Restore                                                                          | AD   | a deleted family past its date shows pending and no Restore                                                     |
| 77  | Add Adult names a deleted duplicate                                               | Ignore the code                                                                                | AD   | Add Adult names a deleted duplicate and keeps the old message for a visible one                                 |
| 78  | Late response after a community change ignored                                    | Drop the generation check                                                                      | AD   | a late delete answer after a community change is ignored                                                        |
| 87  | Restore of a family that is gone                                                  | Keep the row after a 404                                                                       | AD   | a restore that answers 404 shows its message and reloads the list                                               |
| 79  | Panel loads only on the button                                                    | Fetch on mount                                                                                 | AE   | emergency contacts are not requested until Show is pressed                                                      |
| 80  | Panel only for `people.restricted.read`                                           | Drop the condition                                                                             | AE   | the panel is not rendered without people.restricted.read                                                        |
| 81  | Contacts dropped on close and community change                                    | Keep the state                                                                                 | AE   | closing the panel or changing community drops the contacts                                                      |
| 82  | Late read ignored                                                                 | Drop the generation check                                                                      | AE   | a late emergency contacts answer after a community change is ignored                                            |
| 83  | Label text and no child value in the list (copy pin)                              | Rename the label                                                                               | AE   | the panel says Adult to contact if guardians cannot be reached and offers no child relationship                 |
| 88  | Typed values kept                                                                 | Reset the form on a 409                                                                        | AE   | a conflict or a network failure keeps the typed contacts                                                        |
| 89  | Edit only for `people.manage`                                                     | Drop the condition                                                                             | AE   | Edit is not rendered without people.manage                                                                      |

## Rollback

Reverting the merge leaves the columns unused; hidden families appear again in lists. To undo the database: `DROP FUNCTION app.purge_deleted_households(integer)`; drop the household triggers and their functions; restore the `0022` bodies of `app.persons_before_insert` and `app.persons_before_update`; `REVOKE UPDATE (status, deleted_at, deleted_by, emergency_contacts) ON app.households FROM app`. The columns may stay. A purged family cannot be recovered except from backup. `0023` carries these as a `-- Recovery note`.

## Stop and ask (AGENTS.md §12)

The implementer stops and reports, without improvising, when:

- the plan is wrong or ambiguous, or the code does not match a pointer in it;
- a migration other than `0023`, a change to a file listed as untouched, a dependency, a workspace package, a workflow or a Terraform change looks necessary;
- a production seam would be needed only so a test can run;
- a test it wrote passes before the source change it is meant to drive, except pins 13, 14, 21, 26, 30 and 84 and the existing `it`s of pins 13 and 70; the report lists them as "passes before the change, by design";
- the same step fails twice;
- anything would put personal data in a log, an error body, a URL, or an audit row;
- a secret, token or account identifier appears in any file or output.

### Task 1: Migration 0023, schema and guards

**Commit:** `feat(people): add family status, deleted_at and emergency_contacts columns`

**Files:**

- `modules/core/people/db/schema.ts` (`households`, `:97-116`): `status` text not null default `active` with CHECK `households_status_check`; `deleted_at`, `deleted_by`; `emergency_contacts` as `encryptedColumn` with label `people.household_emergency_contacts`; index `households_deleted_idx`. `db/schema.test.ts`.
- `packages/db/drizzle/0023_<generated>.sql`, `meta/_journal.json` (idx 23), `meta/0023_snapshot.json`: generated by drizzle-kit, then hand SQL: the column grant; `app.households_before_insert()` and `app.households_before_update()` (`SECURITY INVOKER`, `SET search_path = pg_catalog, app`, revoked from `PUBLIC`, granted to `app`) and their triggers; `CREATE OR REPLACE` of `app.persons_before_insert()` and `app.persons_before_update()` with the `0022` bodies plus the household rule (a private helper function is allowed, same attributes); `app.purge_deleted_households(p_limit integer)` with **the guards only** and a body that returns no rows; the Recovery note.
- `modules/core/people/module.manifest.ts` and `domain/manifest.test.ts`: the four columns (`status`, `deleted_at`, `deleted_by` internal; `emergency_contacts` restricted).
- `privileges.integration.test.ts`: the six updatable columns (replaces the Pin 2 `it` at `:210`), the `is_minor` pin.
- `packages/db/test/family-delete-migration.integration.test.ts` (new), on the pattern of `contact-delete-migration.integration.test.ts`.

**Test first:** migration, schema, manifest and privileges tests (RED), then the source.

**Rule it must not break:** expand only; every existing people and db suite unchanged except as the plan additions allow; `drizzle-kit generate` run by hand reports no changes.

**Pins:** 1 to 16, 18, 19, 90.

### Task 2: Family purge

**Commit:** `feat(people): purge families hidden for 720 hours`

**Files:**

- `0023_*.sql`: the function body per the spec's Purge sweep section and the plan addition on selection.
- `modules/core/people/infrastructure/household-purge.ts` (new): `purgeDeletedHouseholds(tx, limit)`, shaped like `purge.ts`.
- `public/index.ts`: export; register `people.household.purged` (action and purpose).
- `household-purge.integration.test.ts` (new): eligibility (visible, 719 h, 721 h, with a minor), two organisations and two communities of one organisation, hidden and visible adults, key and row gone, the label no longer openable, `SKIP LOCKED` with `lock_timeout`, limit and order, one event, no event when nothing is eligible, the foreign key guard and its probe. Families are hidden by seeding here; `hideHousehold` is Task 3.

**Test first:** the purge tests, then the body and wrapper.

**Rule it must not break:** no `DELETE` grant; the function is the only erase path; a minor's key is never erased.

**Pins:** 17, 20 to 22, 24 to 30.

### Task 3: Hide, restore and status

**Commit:** `feat(people): hide, restore and set the status of a family`

**Files:**

- `domain/error.ts`: `household_has_children`. `statusForHouseholds` and `statusForPeople` map it to 409 with `{ code }` in this task, so no build has an unmapped code.
- `infrastructure/household-delete.ts` (new): `hideHousehold(tx, { householdId, version, actorUserId })` and `restoreHousehold(tx, ...)` per the spec; `purgeAfter` from SQL.
- `infrastructure/household-status.ts` (new): `setHouseholdStatus(tx, { householdId, version, status, actorUserId })`.
- `public/index.ts`: exports; register `people.household.deleted`, `.restored`, `.status_changed`.
- `household-delete.integration.test.ts` (new): not-found cases (unknown, hidden, other community, other organisation), version first, minor and unknown age, delete against add-minor in both orders through `pg_locks`, restore at 719 and 721 hours, an adult moved out while hidden does not return, status, audit ids only.

**Test first:** that file.

**Rule it must not break:** the child check runs after the lock; nothing changes an adult row.

**Pins:** 31 to 36, 34b, 84. Checkpoint 1 follows this task.

### Task 4: Hidden families left out of reads, the status filter and the Deleted list

**Commit:** `feat(people): leave hidden families out of reads and list deleted families`

**Files:** `household-list.ts` (`deleted_at is null`, the status filter, `status` in items, `listDeletedHouseholds` with its own cursor carrying `deleted_at::text` and the id, label opened for each row, one `people.household.listed_deleted` event per call, registered in `public/index.ts` as action and purpose); `household.ts` (`openHouseholdLabel`, `readHousehold`, `readHouseholdDetail` first `select` with explicit scope predicates, `status` in the detail); `person.ts` `readPerson` (`householdId` null when the family is hidden, by a join or a scoped subquery); `public/index.ts`; `hidden-family-reads.integration.test.ts` (new). `listDeletedHouseholds` opens the label of a hidden family through its own internal path, not through `openHouseholdLabel`.

**Test first:** that file.

**Rule it must not break:** existing household list, detail and person reads unchanged for a visible family; no minor field added anywhere.

**Pins:** 37 to 44.

### Task 5: Hidden families refused by writes, and one lock order

**Commit:** `feat(people): refuse writes to a hidden family and lock the family first`

**Files:** a `lockVisibleHousehold(tx, householdId)` helper (`FOR SHARE`, scope predicates, `deleted_at is null`, `not_found` otherwise) used by `addAdult`, `addMinor`, `moveAdult` (target, before the person lock), `createPerson`'s `requireHousehold`, `linkGuardian` (before both persons) and `unlinkGuardian` (before the guardian); `deleted_at is null` in `renameHousehold`'s select and update; `hidden-family-writes.integration.test.ts` (new), including forced-order tests, each in both orders against `hideHousehold` (add-adult, add-minor, move-adult in, link, unlink) and against `purgeDeletedHouseholds` (contact delete of an adult in the family, move-adult out, move-adult in). Pins 49, 50 and 53 use one probe: T1 holds the household `FOR UPDATE`; T2 runs the call and is proven blocked; T3 takes the person `FOR UPDATE NOWAIT` and succeeds, because T2 holds no person lock yet. A link or unlink is never raced against a successful delete, because its child makes the delete refuse; the hidden-family 404 for both uses a minor seeded with the triggers disabled.

**Test first:** that file.

**Rule it must not break:** existing guardian lock order (guardian, then child) and the contact-delete tests.

**Pins:** 45 to 53, 51b.

### Task 6: Emergency contacts in the people module

**Commit:** `feat(people): store emergency contacts under the household key`

**Files:** `domain/emergency-contact.ts` (new: the relationship list, the cap, entry validation) and its unit test; `infrastructure/emergency-contacts.ts` (new): `readEmergencyContacts(tx, kms, keyArn, { householdId, actorUserId })` returns `{ householdId, version, contacts }` or null, with one read event, and `saveEmergencyContacts(tx, kms, keyArn, { householdId, version, contacts, actorUserId })` locks nothing but the household row, stores null for an empty list, bumps `version`; `public/index.ts` (exports, `people.household.emergency_contacts_read` and `.emergency_contacts_updated`); the save and read paths call the domain validation; `person.test.ts`'s ciphertext scanner gains `emergency_contacts`; the absence from list and detail is an exact-object `toEqual`; `emergency-contacts.integration.test.ts` (new), including two communities, a hidden family, and no plaintext value in the row bytes or the audit rows.

**Test first:** both test files.

**Rule it must not break:** the encrypted column lint; no new read in list or detail.

**Pins:** 54 to 61.

### Task 7: Contracts, routes and the sweep

**Commit:** `feat(api): family status, delete, restore and emergency contacts routes`

**Files:**

- `packages/contracts/src/households.ts` and `households.test.ts`: bodies and responses (strict), list `status`, deleted item, error body; `name` trimmed 1 to 100, `phone` the existing contract, `relationship` the enum, at most five.
- `apps/api/src/household-routes.ts`: `/v1/households/status`, `/delete`, `/restore`, `/emergency-contacts/read` (`billing: "read"`), `/emergency-contacts/save`; list `status`; the denial purpose fix; the `no-store` wrapper; the sweep after list, delete and restore.
- `apps/api/src/family-sweep.ts` (new), shaped like `contact-sweep.ts`, which changes only to export `errorClassFor`.
- `apps/api/src/family-routes.integration.test.ts` (new, real database, no mocked audit); `household-routes.test.ts` (`:437`, `:478` purposes); `index.test.ts` (the household block at `:725`, and `toHaveLength(62)` at `:815` becomes 67), `billing-guard.integration.test.ts` (four write entries with fixtures beside `:1045-1290`).

**Test first:** contracts and route tests.

**Rule it must not break:** the route ids come from `findCommunityBySlug` only; responses and logs carry no contact value except the read and save answers.

**Pins:** 62 to 70, 85, 86, 91. Checkpoint 2 follows this task.

### Task 8: Family Records screen

**Commit:** `feat(admin): family status, delete and restore on Family Records`

**Files:** `apps/admin/src/family-records.tsx` and `family-records.test.tsx`; `apps/admin/src/duplicate-deleted.ts` (new: `readErrorCode`, with the `isRecord` it uses, and `duplicateDeletedMessage` moved from `all-contacts.tsx:223-237`), `all-contacts.tsx` importing it. The new list parts go in `apps/admin/src/family-status.tsx` (new) so `family-records.tsx` does not grow by more than about 250 lines. Copy exactly as the spec's Screen section.

**Test first:** the admin tests.

**Rule it must not break:** the minors redaction tests; `all-contacts.test.tsx` unchanged and green.

**Pins:** 71 to 78, 87.

### Task 9: Emergency contacts panel

**Commit:** `feat(admin): emergency contacts panel on Family Details`

**Files:** `apps/admin/src/emergency-contacts-panel.tsx` and its test (new); `family-records.tsx` renders it. Show, empty, load failure, edit rows (add, remove, five at most), save, 409 and network failure keeping typed values, focus after each action, axe at both widths in light and dark.

**Test first:** the panel test.

**Rule it must not break:** no contact value in a title, URL, toast or stored state after close.

**Pins:** 79 to 83, 88, 89. Checkpoint 3 follows this task.

### Task 10: Architecture, roadmap and repository state

**Commit:** `docs: mark family-records-parity done`

**Files:** `architecture.md` (§9 family row, §12.1 household columns and the function, §12.2 the two approved corrections word for word from the spec, §12.4 the family retention rule, §12.3 that emergency contacts are adult data); `docs/roadmap.md` (as the spec's Roadmap section, next chunk as the chunk owner decides, open items); `AGENTS.md` Repository state. Then AGENTS.md §5 scratch cleanup.

**Rule it must not break:** no decision beyond the spec and ADR 0021.

## Dispatch order

Sequential, 1 to 10. No two tasks run together: they share `household.ts`, `public/index.ts` and `0023`.

## Definition of done (AGENTS.md §8)

- All tasks accepted, all 93 pins run by the reviewer, three checkpoints passed.
- Full local gate green with allowed failures only; CI green.
- Not verified on the staging hostname (staging stays parked): tests and a local browser check, recorded as a roadmap open item.
- Pull request opened only after the chunk owner says so; second review on a model that is not Opus, Gemini or Sonnet; the project owner merges.

## Amendments during implementation

### A1 (2026-11-25, after checkpoint 1): test strength for Tasks 1 to 3

Status: approved (2026-11-25, Adnan Bin Hossen)

The owner's check (Claude Haiku 5.5, CHANGES NEEDED, five Low findings, read only: free memory was under its floor, so it ran nothing) found no High or Medium issue. The reviewer agent ran the 41 pins of Tasks 1 to 3 and the people and API suites. No source changes; one commit.

**Commit:** `test(people): pin the family purge limit, trigger functions and delete facts`

- `household-purge.integration.test.ts`: `family purge is not starved by an older family with a minor` (a minor family aged 723 hours, an eligible one aged 721, limit 1, resolves to the eligible one).
- `family-delete-migration.integration.test.ts`: `migration 0023: the household and person trigger functions are invoker, pinned and closed to PUBLIC` (four functions: `prosecdef` false, `proconfig` equals `search_path=pg_catalog, app`, no `EXECUTE` for `PUBLIC`, `EXECUTE` for `app`); and the test at `:571` renamed `migration 0023: purge_deleted_households is SECURITY DEFINER and app has no DELETE grant`.
- `household-delete.integration.test.ts`: `family delete returns purgeAfter 720 hours after deleted_at and records the actor` (`purgeAfter` equals the row's `deleted_at` plus 720 hours, computed in SQL; `deleted_by` and the deleted and restored events' `actor_id` are the actor, `actor_kind` is `user`).

| #   | Setting                                      | Weakening                                               | File | Test that must fail (exact `it` title)                                                              |
| --- | -------------------------------------------- | ------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------- |
| 22b | A minor family does not fill the purge limit | Drop the minor predicate from the locking select only   | FP   | family purge is not starved by an older family with a minor                                         |
| 15b | Trigger function closed to `PUBLIC`          | Drop the `REVOKE` on `app.households_before_update`     | FM   | migration 0023: the household and person trigger functions are invoker, pinned and closed to PUBLIC |
| 16b | Trigger function `search_path`               | Drop `SET search_path` from `app.persons_before_update` | FM   | migration 0023: the household and person trigger functions are invoker, pinned and closed to PUBLIC |
| 35b | `purgeAfter` is 720 hours after `deleted_at` | Return `deleted_at + interval '719 hours'`              | FH   | family delete returns purgeAfter 720 hours after deleted_at and records the actor                   |
| 35c | `deleted_by` is the actor                    | Set `deleted_by` to the household id                    | FH   | family delete returns purgeAfter 720 hours after deleted_at and records the actor                   |
| 35d | The audit actor is the acting user           | Pass a null actor to `actor()` in `hideHousehold`       | FH   | family delete returns purgeAfter 720 hours after deleted_at and records the actor                   |

Also added by the reviewer: pin 34c (the version compare in `restoreHousehold`) and, from Task 3, pin 27b (the purge's `guardian_links` delete).

Not acted on: Low 4 (the code's scope predicates in hide, restore and status are covered only through RLS). Defence in depth; RLS is forced and tested, and the two-organisation and two-community tests stay.
