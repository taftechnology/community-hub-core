Spec: docs/specs/2026-11-22-contact-delete.md

# Contact delete Implementation Plan

Slug: contact-delete
Status: approved (2026-11-22, Adnan Bin Hossen)

Revision 2 (2026-11-22) applies the fresh-context plan check (Claude Sonnet, READY WITH CHANGES, 3 High, 14 Medium, 10 Low) and the chunk owner's choice of a shared confirm dialog in `packages/ui`.

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** Staff with `people.delete` can delete an adult contact, which hides it everywhere for 720 hours, restore it in that time, and see it under a Deleted filter on All Contacts. After 720 hours the contact is purged with its group memberships, guardian links, tags, history and life events, through one `SECURITY DEFINER` function, by a sweep that runs after contact list, delete and restore. No child is deleted or left without a guardian. ADR 0020 is the design record.

**Architecture:**

- `packages/db`: migration `0022` (two columns, an index, a column grant, the `persons_before_update` rules and an insert rule, the widened permission CHECK, `app.purge_deleted_persons`) and its tests.
- `packages/policy`, `modules/core/access`: `people.delete` in `CATALOGUE` and `CATALOGUE_PERMISSIONS`; `deleteBlockers`; hidden-aware `personIsMinor` callers; the `createInvitation` share lock; `readPersonForActor`.
- `modules/core/people`: schema, manifest, error codes, `lockPersonForDelete`, `hidePerson`, `restorePerson`, `purgeDeletedPersons`, `listDeletedPersons`, `visiblePersonIds`, and `deleted_at is null` in every read and write the spec names, plus `duplicate_deleted`.
- `modules/features/groups`: hidden contacts left out of members and lookups; member writes answer not found.
- `packages/ui`: a `ConfirmDialog` on `@base-ui/react/dialog` (already a `packages/ui` dependency, used by `drawer.tsx`).
- `packages/contracts`: delete, restore, Deleted list, error body, the `people.delete` capability.
- `apps/api`: two routes, the list's `deleted` filter, error-body mapping in the people and household routes, the sweep.
- `apps/admin`: Delete dialog, Deleted filter, Restore, refusal and duplicate messages, `people-access.tsx`.
- `architecture.md`, `docs/roadmap.md`, `AGENTS.md`.

## Who does what

- **Implementer:** Antigravity (Gemini 3.8 Flash High), in `C:\Recovered\Taftech\wt-contact-delete` on the chunk branch. Fallback when it is out of quota: Cursor (grok-4.7-high), then a Claude Sonnet agent. Each fallback model used is named in the task report and excluded from the second review.
  - Tests first, one commit per task, commits locally, never pushes.
  - One plan task per run.
  - For every Security pins row its task names, it writes the weakening as a `.patch` under `.superpowers/sdd/pins/` (with `git diff --output`, UTF-8, LF) and a row in `.superpowers/sdd/pins/manifest.json` (the `pinrun.mjs` format, with a `"build"` list where the pin weakens a package another package's test reads through `dist`). The reviewer runs them. This departs from AGENTS.md §4 Phase 2 ("the implementer runs each change once"), as in the last three chunks, because the reviewer re-runs every pin anyway.
  - Every test result it claims points to a log it wrote with `tee` under `.superpowers/sdd/task-N-logs/`, UTF-8. A claim without a log counts as not run.
  - It starts with no AWS credentials; pushes are blocked by the push URL and the pre-push hook.
- **Reviewer agent:** this session, on Claude Opus 5.5 for the whole chunk. Each task is reviewed by its diff, the named tests re-run, and every named pin run through `pinrun.mjs`.
- **Owner's checks and second review:** the chunk owner runs them in a fresh session on a model that is not Opus and not any implementer model used (Gemini 3.8 Flash High; grok-4.7-high or Sonnet if a fallback ran). The spec and plan checks ran on Claude Sonnet.
- **Docker test database:** one run at a time. Tasks 1 to 6 and 8 need it, as does any full local gate. `pinrun` never runs while an implementer is editing the tree.

## Checkpoints

- **After Task 3** (database and the hide itself): the reviewer runs pins 1 to 32; the chunk owner runs an owner's check of `git diff <plan-sha>..<task-3-sha>`. Task 4 starts after that check.
- **After Task 8** (reads, writes, groups, dialog, routes): pins 33 to 87; `index.test.ts`, `billing-guard.integration.test.ts`, `access-flow.integration.test.ts` and `image.test.ts` re-run; an owner's check of `git diff <task-3-sha>..<task-8-sha>`.
- **After Task 9** (admin): pins 88 to 93; `all-contacts.test.tsx` five times green; a browser check at 1280px and 375px, light and dark, of the Delete dialog, the Deleted filter and Restore, screenshots for the pull request.

## Global constraints

- **Branch:** `feat/2026-11-22-contact-delete`, from `origin/main` at `6a3a1bb`. The spec and ADR 0020 are its first commit (`e63cb82`), this plan its second.
- **Migration:** one file, `0022`. It has not been applied anywhere, so Task 2 completes the function body in `0022` and later tasks may edit `0022`'s hand SQL (and regenerate its snapshot) until the pull request merges; each such edit is named in that task's report. No `0023`.
- **Untouched:** identity, tenancy, billing and entitlement source; Terraform, workflows, `infra/`; the Dockerfile (no new workspace package or dependency); `FilterBar`; Family Records screens; `apps/api/src/access-routes.ts` (the capabilities route maps `CAPABILITIES_ALLOW_LIST` already, `:710-716`); `groupLeaderFact` (`members.ts:353-370`, no consumer; unchanged on purpose); the life-event and household routes except the error mapping named in Task 8.
- **Dependencies:** none added. No new workspace package.
- **Module boundaries:** people does not import groups or access. The delete route composes people and access in one transaction in `apps/api`. Only the migration's SQL function touches `group_members`, `user_links` and `invitations` from people's purge, as ADR 0020 records. Groups never queries `app.persons`; it uses people `public/`.
- **Never disabled to get green:** a check, a lint rule (no `eslint-disable`), an axe rule other than the repo's existing `color-contrast` exclusion, RLS, a test or a CI gate. No `@ts-ignore` or `@ts-expect-error`.
- **Fixtures** are synthetic: invented names, `example.test` addresses, `+61 4xx 555 xxx` phones. No real person.
- **Seeding hidden and aged rows:** in a short **committed** transaction as `migrator`, with the scope set by `set_config(..., true)` and fresh organisation and community ids per test, as the existing suites do. A contact is created normally (through the module or an insert), then aged with `ALTER TABLE app.persons DISABLE TRIGGER USER; UPDATE ... SET deleted_at = now() - interval '721 hours', deleted_by = ...; ALTER TABLE app.persons ENABLE TRIGGER USER;` inside that one committed transaction. A hidden contact that need not be aged is hidden through `hidePerson`. Never through `app` with a forged time.
- **No personal data** in logs, error bodies, URLs or audit rows. Audit rows carry ids only. Error bodies carry `{ code }` only. A failure logs the error class only.
- **Build order:** `apps/api` imports the built `dist` of `@community-hub/contracts`, `@community-hub/people`, `@community-hub/access`, `@community-hub/groups`, `@community-hub/policy` and `@community-hub/ui` (admin); `modules/core/access` and `modules/features/groups` import the built `@community-hub/people`; access tests read the built `@community-hub/policy`. After changing one, run `pnpm --filter <pkg> build` before the dependent tests. Pins that weaken a package read through `dist` list it in `"build"`.
- **Local gate per task:** `pnpm format && pnpm lint && pnpm typecheck && pnpm exec turbo run test --continue --force --concurrency=1; pnpm check:boundaries`, teed, and the turbo summary read for any failure other than the allowed ones.
- **Allowed failures on this Windows machine,** and only these: `packages/db/src/generate.test.ts` drizzle ENOENT; the `image-publish` symlink EPERM; the `migrate.integration` and `plaintext-dist` timeouts; the identity `tsbuildinfo.test` 5 s timing flake.
- **Concurrency tests** order two transactions by locks: one holds the lock; the other is started and proven blocked through `pg_locks` (`granted = false` for its pid), or runs with `set local lock_timeout = '1s'` and is expected to resolve or reject. Never sleeps.
- **Thrown errors as assertions:** every call a pin may turn into a throw is wrapped in `await expect(...).resolves` or `.rejects.toMatchObject({ code: ... })` with the exact code, and the test asserts the rows are unchanged where it says "refused".
- **Admin tests:** no real waits; exact fetch call counts; each new section repeated five times green before the task is reported.
- **Line endings:** LF.

## Decisions fixed by the spec (do not reopen)

1. Hide is `deleted_at` + `deleted_by`; 720 hours; database clock only; the trigger refuses any other transition and any `deleted_at` on a minor.
2. One `SECURITY DEFINER` function is the only way a contact is deleted; no new `DELETE` grant to `app`; foreign keys stay `RESTRICT`.
3. Delete refuses `linked_user`, `pending_invitation` (live: `status = 'pending' and expires_at > now()`) and `sole_guardian`, with a JSON `{ code }` body; everything else stays status-only.
4. Children are refused by delete and restore and never in the Deleted list.
5. A hidden contact is not found in every read and write the spec lists; `personIsMinor` is the access choke point.
6. `duplicate_deleted` on create, update and add-adult; email first.
7. The Deleted filter: `people.view` + `people.delete`, name search only, `deleted_at desc, id`, no decrypt, one `people.person.listed_deleted` audit per non-empty page.
8. The sweep: after a 200 from the adult list, the Deleted list, delete or restore, for a permitted caller, in a writable community, in its own transaction, awaited, at most 50, one `people.person.purged` audit with actor `system`; failure logged by class only.
9. Delete and restore need `people.view` and `people.delete`, and are `billing: "write"`.
10. Expired pending invitations are voided at purge; accepted, revoked and void ones lose `person_id`.
11. (Chunk owner, plan revision 2.) The confirm is a new `packages/ui` `ConfirmDialog`, reusable by later delete screens.

## Spec pointer corrections and additions

- **Insert rule (addition, plan check L6).** `app` has table-level `INSERT` on `app.persons`, so a buggy insert could create a row with `deleted_at` set. `0022` adds a `BEFORE INSERT` rule: `deleted_at` and `deleted_by` must be null on insert. The trigger function's `0016` grants and attributes are kept.
- **Sole guardian holes (addition, plan check H3).** `hidePerson` locks the contact's child rows `FOR UPDATE` in id order after the contact's own lock (lock order: contact, then children by id; `linkGuardian` locks both persons `FOR SHARE` in id order, so a deadlock is possible only when the contact's id sorts after a child's: the route maps Postgres `40P01` to an empty 409, tested). `unlinkGuardian`'s remaining-links count joins `app.persons` and counts only guardians with `deleted_at` null, so unlinking the last unhidden guardian is refused with the existing `last_guardian`. `unlinkGuardian` on a hidden guardian's link answers not found.
- **Update duplicates.** `updatePerson` maps any unique violation to `conflict` today (`update-person.ts:58-67`, `:327-329`). After this chunk it looks for a hidden holder of the new email or phone bidx (email first) and throws `duplicate_deleted` if one exists, else keeps `conflict`. `createPerson`'s throw site is its catch at `person.ts:287-293` (`duplicateError` at `:84-104` is pure). `addAdult` inherits through `createPerson` (`household-members.ts:255` needs no edit).
- **Voided invitations** at purge are not audited one by one (the function cannot append audit rows); the `people.person.purged` event's `targetIds` are the purged person ids only.
- **Which calls sweep:** the adult list and the Deleted list, delete and restore. Not the minors list, summary or read.
- **The sweep's cost:** three checkouts after each such call (grant check, `assertWritable`, purge transaction). Recorded in the pull request.
- **Pointers:** `household.ts` guardian links `:528-545` (both sides; the non-restricted branch `:560-567`); `life-event.ts` list `:160`, create `:274`, update join `:406`; `roster-names.ts:111`; `linked-contacts.ts:99`; `activity.ts:10-13` and `tags.ts:26` each have a local `personExists`; `openPersonFieldKeys` is `person-keys.ts:123-151`; `guardian.ts` locks `:96-104` (link) and `:206-211` (unlink, child row); `moveAdult` `household-members.ts:89-95` (`addAdult` and `addMinor` target households only).
- **`readPersonForActor`** throws `AccessError("forbidden")` and appends the denied event for a hidden id, as for an unknown id; the route maps it to 404 (`restricted-read.ts:35-42`, `people-routes.ts:368-370`).

## Security pins

Each row is a weakening the implementer writes as a patch and the reviewer runs through `node ~/.claude/crew/bin/pinrun.mjs .superpowers/sdd/pins/manifest.json --only <id>`. The weakened run must fail **on an assertion** in the named test; the restored run must pass. The weakened tree is never committed.

Files: **DM** = `packages/db/test/contact-delete-migration.integration.test.ts` (new); **P** = `modules/core/people/infrastructure/privileges.integration.test.ts`; **PO** = `packages/policy/src/decide.test.ts`; **PG** = `modules/core/people/infrastructure/purge.integration.test.ts` (new); **H** = `modules/core/people/infrastructure/person-delete.integration.test.ts` (new); **AL** = `modules/core/access/infrastructure/delete-blockers.integration.test.ts` (new); **HR** = `modules/core/people/infrastructure/hidden-reads.integration.test.ts` (new); **HW** = `modules/core/people/infrastructure/hidden-writes.integration.test.ts` (new); **AI** = `modules/core/access/infrastructure/hidden-contact.integration.test.ts` (new); **G** = `modules/features/groups/infrastructure/hidden-members.integration.test.ts` (new); **UI** = `packages/ui/src/confirm-dialog.test.tsx` and `confirm-dialog.a11y.test.tsx` (new); **C** = `packages/contracts/src/people.test.ts`; **CA** = `packages/contracts/src/access.test.ts`; **R** = `apps/api/src/people-delete-routes.integration.test.ts` (new); **BG** = `apps/api/src/billing-guard.integration.test.ts`; **AD** = `apps/admin/src/all-contacts.test.tsx`.

| #   | Setting                                                          | Weakening                                                                       | File | Test that must fail (exact `it` title)                                                                                                   |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Trigger: `deleted_at` set only to `now()`                        | Drop the `new.deleted_at = now()` condition                                     | DM   | migration 0022: refuses a back-dated deleted_at from app                                                                                 |
| 2   | Trigger: no `deleted_at` on a minor                              | Drop the `is_minor` condition                                                   | DM   | migration 0022: refuses deleted_at on a minor                                                                                            |
| 3   | Trigger: `deleted_by` set with `deleted_at`, cleared with it     | Drop the `deleted_by` conditions                                                | DM   | migration 0022: refuses deleted_at without deleted_by                                                                                    |
| 4   | Trigger: non-null to another non-null refused                    | Allow any change when `old.deleted_at` is not null                              | DM   | migration 0022: refuses moving deleted_at from one time to another                                                                       |
| 5   | Insert rule: no `deleted_at` on insert                           | Drop the insert rule                                                            | DM   | migration 0022: refuses a new contact inserted with deleted_at                                                                           |
| 6   | Column grant only on the allowed columns                         | `GRANT UPDATE ON app.persons TO app` (whole table)                              | P    | grants app update on app.persons only by column for allowed columns (Deviation 3)                                                        |
| 7   | No `DELETE` on persons, person_activity, life_events, households | `GRANT DELETE ON app.persons TO app`                                            | P    | takes update and truncate from app everywhere, and delete except on the two link tables (existing `it`, reused)                          |
| 8   | `EXECUTE` revoked from `PUBLIC`                                  | Drop the `REVOKE ... FROM PUBLIC`                                               | DM   | migration 0022: PUBLIC cannot execute purge_deleted_persons                                                                              |
| 9   | `SET search_path = pg_catalog, app` on the function              | Drop the `SET search_path` clause                                               | DM   | migration 0022: purge_deleted_persons pins its search_path                                                                               |
| 10  | Function is `SECURITY DEFINER` owned by migrator                 | Make it `SECURITY INVOKER`                                                      | DM   | migration 0022: app can purge through the function without a DELETE grant                                                                |
| 11  | Raises with no scope or an empty scope                           | Drop the scope check (the test asserts the function's own message)              | DM   | migration 0022: purge raises when the tenant scope is unset or empty                                                                     |
| 12  | Raises on `p_limit` null, 0, 51                                  | Drop the limit check                                                            | DM   | migration 0022: purge raises on a limit outside 1 to 50                                                                                  |
| 13  | CHECK accepts `people.delete`, still refuses unknown keys        | Keep the ten-key CHECK                                                          | DM   | migration 0022: a custom role may hold people.delete                                                                                     |
| 14  | `people.delete` held by owner, org admin, community admin only   | Add `people.delete` to `staff`                                                  | PO   | only org_owner, org_admin and community_admin hold people.delete                                                                         |
| 15  | 720-hour threshold on the database clock                         | `interval '1 hour'`                                                             | PG   | purge leaves a contact hidden 719 hours                                                                                                  |
| 16  | Adults only in the function                                      | Drop `is_minor = false`                                                         | PG   | purge never deletes a minor even with deleted_at set                                                                                     |
| 17  | Community scope, function and RLS together                       | Drop the community predicate and the persons `community_isolation` policy       | PG   | purge deletes only the scoped community's contacts                                                                                       |
| 18  | Skip a contact with a user link                                  | Drop the `user_links` skip                                                      | PG   | purge skips a contact with a user link                                                                                                   |
| 19  | Live pending skipped, expired pending voided                     | Drop the `expires_at > now()` term                                              | PG   | purge voids an expired pending invitation and deletes the contact                                                                        |
| 20  | Skip a sole guardian                                             | Drop the sole-guardian skip                                                     | PG   | purge skips the only guardian of a child                                                                                                 |
| 21  | Dependants deleted before persons                                | Drop the `life_events` delete                                                   | PG   | purge deletes memberships, guardian links, tags, history and life events                                                                 |
| 22  | `FOR UPDATE SKIP LOCKED`                                         | Drop `SKIP LOCKED`                                                              | PG   | purge skips a contact another transaction has locked                                                                                     |
| 23  | One purged audit event, actor system, ids only                   | Write one event per contact                                                     | PG   | purge writes one people.person.purged event with all purged ids                                                                          |
| 24  | Every foreign key to persons handled                             | Add to `0022` a table with a foreign key to `app.persons`                       | PG   | every foreign key to app.persons is handled by the purge                                                                                 |
| 25  | Delete locks the person `FOR UPDATE`                             | Read without `FOR UPDATE`                                                       | H    | delete blocks a concurrent writer that holds the person for share                                                                        |
| 26  | Delete locks the contact's children                              | Drop the child-row lock                                                         | H    | two concurrent deletes of a child's two guardians leave one guardian                                                                     |
| 27  | Sole guardian counts only unhidden other guardians               | Count hidden guardians too                                                      | H    | delete refuses the only unhidden guardian of a child                                                                                     |
| 28  | Minor and other-tenant id are not found                          | Drop `is_minor = false` from the lock query                                     | H    | delete answers not found for a minor and for another organisation's contact                                                              |
| 29  | Version checked on delete and restore                            | Skip the version compare in `restorePerson`                                     | H    | a stale version on delete or restore answers conflict and changes nothing                                                                |
| 30  | Deleted and restored audit events, ids only                      | Drop the restored append                                                        | H    | delete and restore each write one event with the person id only                                                                          |
| 31  | Expired pending invitation does not block                        | Drop the `expires_at > now()` term                                              | AL   | an expired pending invitation does not block delete                                                                                      |
| 32  | User link blocks                                                 | Return no user link                                                             | AL   | a user link blocks delete                                                                                                                |
| 33  | Adult list                                                       | Drop `deleted_at is null` from the adult list                                   | HR   | the adult list leaves out a hidden contact                                                                                               |
| 34  | Summary counts                                                   | Drop it from the summary                                                        | HR   | the summary does not count a hidden contact                                                                                              |
| 35  | `readPerson`                                                     | Drop it from `readPerson`                                                       | HR   | readPerson answers not found for a hidden contact                                                                                        |
| 36  | Family detail guardian links, both sides                         | Drop it from the guardian side of `household.ts:528-545`                        | HR   | family detail leaves out a hidden guardian's link                                                                                        |
| 37  | Family list adult count                                          | Drop it from `household-list.ts:102-108`                                        | HR   | the family list does not count a hidden adult                                                                                            |
| 38  | Linked contacts                                                  | Drop it from `linked-contacts.ts:99`                                            | HR   | linked contacts leave out a hidden contact                                                                                               |
| 39  | Roster names                                                     | Drop it from `roster-names.ts:111`                                              | HR   | roster names leave out a hidden contact                                                                                                  |
| 40  | Life-event list                                                  | Drop it from `life-event.ts:160`                                                | HR   | the life-event list leaves out a hidden contact's events                                                                                 |
| 41  | `openPersonFieldKeys`                                            | Drop it from `person-keys.ts:123-151`                                           | HR   | openPersonFieldKeys answers null for a hidden contact                                                                                    |
| 42  | Deleted list: no decrypt, no KMS call, no key rows               | Return the adult list item shape                                                | HR   | the deleted list returns names and dates only, with no KMS call                                                                          |
| 43  | Deleted list cursor keeps microseconds                           | Carry `deleted_at` as a JS `Date` in the cursor                                 | HR   | the deleted list pages rows that share a millisecond without repeats or gaps                                                             |
| 44  | One `listed_deleted` per non-empty page, none on empty           | Append on an empty page too                                                     | HR   | the deleted list audits each non-empty page once and an empty page never                                                                 |
| 45  | Update                                                           | Drop it from `updatePerson`'s lock                                              | HW   | update answers not found for a hidden contact                                                                                            |
| 46  | Status                                                           | Drop it from `person-status.ts`                                                 | HW   | status answers not found for a hidden contact                                                                                            |
| 47  | Move to a family                                                 | Drop it from `moveAdult`                                                        | HW   | moveAdult answers not found for a hidden contact                                                                                         |
| 48  | Link a guardian                                                  | Drop it from `guardian.ts:96-104`                                               | HW   | linkGuardian answers not found for a hidden contact                                                                                      |
| 49  | Unlink a hidden guardian's link                                  | Drop the guardian check in `unlinkGuardian`                                     | HW   | unlinkGuardian answers not found for a hidden guardian                                                                                   |
| 50  | Last unhidden guardian kept                                      | Drop the `app.persons` join in the remaining-links count                        | HW   | unlinking the last unhidden guardian answers last_guardian                                                                               |
| 51  | Attach a tag and list tags                                       | Drop it from `tags.ts:26` `personExists`                                        | HW   | attachTag and listPersonTags answer not found for a hidden contact                                                                       |
| 52  | Detach a tag                                                     | Drop the new check in `detachTag`                                               | HW   | detachTag answers not found for a hidden contact                                                                                         |
| 53  | Activity                                                         | Drop it from `activity.ts:10` `personExists`                                    | HW   | listPersonActivity answers not found for a hidden contact                                                                                |
| 54  | Life-event create                                                | Drop it from `life-event.ts:274`                                                | HW   | a life event cannot be created for a hidden contact                                                                                      |
| 55  | Life-event update                                                | Drop it from the update join `life-event.ts:406`                                | HW   | a hidden contact's life event cannot be updated                                                                                          |
| 56  | `duplicate_deleted` on create, scoped to hidden                  | Drop `deleted_at is not null` from the create lookup                            | HW   | a create duplicate of a visible contact stays duplicate_email                                                                            |
| 57  | `duplicate_deleted` on update                                    | Drop `deleted_at is not null` from the update lookup                            | HW   | an update duplicate of a visible contact stays conflict                                                                                  |
| 58  | `personIsMinor` hidden-aware                                     | Drop `deleted_at is null` from `personIsMinor`                                  | AI   | an invitation cannot be created for a hidden contact                                                                                     |
| 59  | `createInvitation` takes the share lock                          | Drop `{ lock: "share" }`                                                        | AI   | createInvitation waits for a delete that holds the contact                                                                               |
| 60  | `writeUserLink` waits for a delete                               | Drop `FOR SHARE` at `grants.ts:249` (passes before the change, by design)       | AI   | writeUserLink waits for a delete that holds the contact                                                                                  |
| 61  | `readPersonForActor` for a hidden id                             | Drop the hidden check there                                                     | AI   | readPersonForActor throws forbidden and audits the denial for a hidden contact                                                           |
| 62  | `listMembers` filters rows itself                                | Map hidden members as minors (restore the `?? true` fallback without filtering) | G    | listMembers leaves out a hidden member                                                                                                   |
| 63  | `personIdsInGroup`                                               | Drop the `visiblePersonIds` step                                                | G    | personIdsInGroup leaves out a hidden contact                                                                                             |
| 64  | `activeGroupsForPersons`                                         | Drop the `visiblePersonIds` step                                                | G    | activeGroupsForPersons leaves out a hidden contact                                                                                       |
| 65  | Roster export                                                    | Drop it from `readRosterNames` (`"build": ["@community-hub/people"]`)           | G    | the roster export leaves out a hidden member                                                                                             |
| 66  | `addMember` not found, with the share lock                       | Drop the null check on `personIsMinor` in `addMember`                           | G    | addMember answers not found for a hidden contact                                                                                         |
| 67  | `removeMember`                                                   | Drop the hidden check                                                           | G    | removeMember answers not found for a hidden contact                                                                                      |
| 68  | `setMemberRole`                                                  | Drop the hidden check                                                           | G    | setMemberRole answers not found for a hidden contact                                                                                     |
| 69  | Focus returns to the trigger                                     | Drop the `finalFocus` return                                                    | UI   | ConfirmDialog returns focus to the trigger on cancel and on confirm                                                                      |
| 70  | Escape and Cancel never confirm                                  | Call `onConfirm` on close                                                       | UI   | ConfirmDialog does not confirm on Escape or Cancel                                                                                       |
| 71  | Accessible name and description                                  | Drop the title binding                                                          | UI   | ConfirmDialog has no axe violations and is named by its title                                                                            |
| 72  | Delete needs `people.delete`                                     | Check `people.manage` instead                                                   | R    | delete answers 403 to a people.manage holder without people.delete                                                                       |
| 73  | Delete needs `people.view`                                       | Drop the view check                                                             | R    | delete answers 403 to a people.delete holder without people.view                                                                         |
| 74  | Restore needs `people.delete`                                    | Check only `people.view`                                                        | R    | restore answers 403 without people.delete                                                                                                |
| 75  | Restore needs `people.view`                                      | Check only `people.delete`                                                      | R    | restore answers 403 without people.view                                                                                                  |
| 76  | `people.directory` entitlement on both routes                    | Skip the entitlement guard for delete                                           | R    | delete and restore answer 403 without the people.directory entitlement                                                                   |
| 77  | Blockers wired in the route                                      | Skip `deleteBlockers` in the route                                              | R    | delete answers 409 linked_user and 409 pending_invitation                                                                                |
| 78  | `sole_guardian` and `duplicate_deleted` carry their code         | Map `sole_guardian` to an empty 409                                             | R    | delete answers 409 sole_guardian with the code in the body                                                                               |
| 79  | Deleted filter needs `people.delete`                             | Drop the check                                                                  | R    | the deleted filter answers 400 without people.delete                                                                                     |
| 80  | Other answers stay status-only                                   | Return a body on a version conflict                                             | R    | a version conflict answers 409 with an empty body                                                                                        |
| 81  | Sweep only after a permitted 200                                 | Run the sweep before the permission check                                       | R    | a refused list does not purge                                                                                                            |
| 82  | Sweep skipped in a read-only community                           | Skip the writable check                                                         | R    | a read-only community is not swept                                                                                                       |
| 83  | Sweep failure: same answer, error class only in the log          | Log the error message                                                           | R    | a failing sweep keeps the 200 and logs the error class only                                                                              |
| 84  | Deleted filter contract refusals                                 | Drop the refinement                                                             | C    | the list body refuses status deleted with source, groupId or kind minors                                                                 |
| 85  | Capabilities response carries `people.delete`                    | Drop the key from the response schema                                           | CA   | capabilities response requires people.delete                                                                                             |
| 86  | Delete and restore are billing writes                            | Mark delete `billing: "read"`                                                   | BG   | guards every write route through the gate: 2xx and row count changes in ok, 402 with empty body and unchanged rows in read_only (pin 14) |
| 87  | Household routes map `duplicate_deleted`                         | Leave it unmapped in `statusForHouseholds`                                      | R    | add-adult answers 409 duplicate_deleted for a hidden holder                                                                              |
| 88  | Delete control hidden without `people.delete`                    | Render the Delete action for every row                                          | AD   | no Delete action without people.delete                                                                                                   |
| 89  | Deleted filter hidden without `people.delete`                    | Always offer the Deleted option                                                 | AD   | no Deleted filter without people.delete                                                                                                  |
| 90  | Delete and Restore hidden when billing is read-only              | Ignore `hideWrites` for them                                                    | AD   | Delete and Restore are hidden when billing is read-only                                                                                  |
| 91  | Refusal messages by code                                         | Show the generic message for every 409                                          | AD   | the dialog shows the message for each refusal code                                                                                       |
| 92  | Purged-meanwhile restore                                         | Keep the row after a 404                                                        | AD   | restore of a purged contact says so and reloads                                                                                          |
| 93  | Duplicate message by permission                                  | Show the restore hint to everyone                                               | AD   | the deleted-duplicate message offers restore only to people.delete holders                                                               |

Notes:

- Pin 11: with the scope check dropped, the RLS policy's cast still raises, with a different message; the test asserts the function's own message for both the unset and the empty-string scope.
- Pin 17 weakens both layers at once on purpose: with only the predicate dropped, RLS still holds and the test passes, which is the design; the report records that single-layer result too. The other community's contact is seeded as `migrator` with no dependants (a direct `app.persons` insert in its own committed transaction), so the weakened run deletes it and the assertion on the survivor fails, not a foreign-key error. Organisation scope has no separate pin: a community belongs to one organisation, so the community term covers it; the two-organisation test stays.
- Pin 22: the second transaction runs `set local lock_timeout = '1s'` and `await expect(purge()).resolves.toEqual([...])`; weakened, it rejects with `lock_not_available`.
- Pin 24: the guard reads `pg_constraint` for foreign keys to `app.persons` and compares with the function's handled set, parsed from `pg_get_functiondef` as the table names after `delete from app.` and `update app.`, plus the `app.user_links` skip; a comment cannot satisfy it (comments are stripped before parsing). A second `it` creates a real table `app.zz_probe` with a foreign key to `app.persons (org_id, id)` as `migrator` inside a transaction it rolls back, and expects the guard to name it. The pin's patch adds such a table to `0022`.
- Pin 28: `rejects.toMatchObject({ code: "not_found" })` on a `PeopleError` and the minor's row unchanged; a bare `rejects.toThrow()` would pass for the wrong reason (the trigger).
- Pin 60 passes before Task 5's change, by design (`writeUserLink` already takes `FOR SHARE`); the test is the race the spec's Risks name.
- Pin 86: the `fixtureMap` gains `"POST /v1/people/delete"` and `"POST /v1/people/restore"`; the restore fixture hides a contact through `hidePerson` first; `count()` returns the number of rows with `deleted_at` set.

## Rollback

- Revert the pull request's merge commit. Routes, the reads' hidden filters, the dialog and the screen changes disappear; hidden contacts appear again in lists.
- Migration `0022` stays applied (expand only). To withdraw the database changes: `DROP FUNCTION app.purge_deleted_persons(integer)`, drop the insert rule, restore the `0016` body of `app.persons_before_update`, `REVOKE UPDATE (deleted_at, deleted_by) ON app.persons FROM app`; delete `custom_role_permissions` rows with `people.delete` before re-adding the ten-key CHECK.
- Purged contacts are recoverable only from backup. Audit rows written stay (append-only, ids only).

## Stop and ask (AGENTS.md §12)

The implementer stops and reports, without improvising, when:

- the plan is wrong or ambiguous, or the code does not match a pointer in it;
- a migration other than `0022`, a change to a file listed as untouched, a dependency, a workspace package, a workflow or a Terraform change looks necessary;
- a production seam would be needed only so a test can run;
- a test it wrote passes before the source change it is meant to drive, except pin 24's guard on the real schema, pin 60, and the existing `it` of pin 7; the report lists them as "passes before the change, by design";
- the same step fails twice;
- anything would put personal data in a log, an error body, a URL path or query, or an audit row;
- a secret, token or account identifier appears in any file or output.

### Task 1: Migration 0022, schema and the people.delete catalogue key

**Commit:** `feat(people): add deleted_at, the purge function guards and people.delete`

**Files:**

- `modules/core/people/db/schema.ts` (`app.persons`, about `:148-253`): `deleted_at` `timestamptz`, `deleted_by` `uuid`, index `persons_deleted_idx` on `(org_id, community_id, deleted_at)` where `deleted_at is not null`.
- `modules/core/access/db/schema.ts:176`: the CHECK with eleven keys.
- `packages/db/drizzle/0022_<generated>.sql`, `meta/_journal.json` (idx 22), `meta/0022_snapshot.json`: generated by drizzle-kit, then hand SQL appended: `GRANT UPDATE (deleted_at, deleted_by) ON app.persons TO app`; `CREATE OR REPLACE FUNCTION app.persons_before_update()` with the `0016` body plus the spec's `deleted_at` rules; the insert rule (`deleted_at` and `deleted_by` null on insert, a `BEFORE INSERT` trigger on the same function or its own `SECURITY INVOKER` function with the `0016` attributes); `app.purge_deleted_persons(p_limit integer) RETURNS SETOF uuid`, `SECURITY DEFINER`, `SET search_path = pg_catalog, app`, `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO app`, with **the guards only** (scope unset or empty, limit outside 1 to 50) and a body that returns no rows; a `-- Recovery note` comment with the Rollback steps.
- `packages/policy/src/decide.ts` `CATALOGUE` and `decide.test.ts`; `modules/core/access/domain/role.ts` `CATALOGUE_PERMISSIONS` and `role.test.ts`; `modules/core/access/db/schema.test.ts:205-218` (eleven keys); `apps/api/src/access-routes.test.ts:371-381` (the catalogue list).
- `modules/core/people/module.manifest.ts`: `persons.deleted_at`, `persons.deleted_by` as `internal`, `people.delete` in `permissions`; `modules/core/people/domain/manifest.test.ts`: the exact object.
- `modules/core/people/infrastructure/privileges.integration.test.ts`: `deleted_at`, `deleted_by` in `allowedColumns` (fifteen).
- `packages/db/test/contact-delete-migration.integration.test.ts` (new), on the pattern of `membership-backfill.integration.test.ts`: the trigger and insert rules (as `app`, with `rejects`), the function's grants, `prosecdef`, `proconfig`, the guards, the CHECK.

**Test first:** the migration, policy, role, schema and privileges tests (RED), then the source. Rebuild `@community-hub/policy` before the access tests.

**Rule it must not break:** expand only; every existing people, access, policy and db suite unchanged; `generate.test.ts` reports no schema changes (allowed ENOENT on this machine; CI runs it). The capabilities contract does not change here (Task 8).

**Pins:** 1 to 14.

### Task 2: Purge behaviour

**Commit:** `feat(people): purge contacts hidden for 720 hours`

**Files:**

- `packages/db/drizzle/0022_*.sql`: the function body per the spec's Purge sweep section (selection with `is_minor = false`, `deleted_at <= now() - interval '720 hours'`, the user-link, live-invitation and sole-guardian skips, oldest first, `FOR UPDATE SKIP LOCKED`; the delete order; the invitation updates; `app.persons` last; return the ids). Named in the report.
- `modules/core/people/infrastructure/purge.ts` (new): `purgeDeletedPersons(tx, limit)` calls the function and, when it returns ids, writes one `people.person.purged` audit event, actor `system`, `targetIds` the ids; returns the ids.
- `modules/core/people/public/index.ts`: export it; register `people.person.purged` with `defineAuditAction` and `defineAuditPurpose`.
- `modules/core/people/infrastructure/purge.integration.test.ts` (new): eligibility (visible, 719 h, 721 h, a minor seeded with `deleted_at` via the trigger-disabled seed), two organisations and two communities of one organisation, user link, live and expired pending, accepted and revoked invitations, sole guardian and one of two guardians, every dependant table, `SKIP LOCKED` with `lock_timeout`, one audit event with 50 ids, the foreign-key guard and its probe. Every call wrapped in `resolves` or `rejects`.

**Test first:** the purge tests (RED: the body returns nothing), then the body and the wrapper.

**Rule it must not break:** no `DELETE` grant; the function is the only delete path; audit ids only.

**Pins:** 15 to 24.

### Task 3: Hide and restore

**Commit:** `feat(people): hide and restore a contact`

**Files:**

- `modules/core/people/domain/error.ts`: `linked_user`, `pending_invitation`, `sole_guardian`, `duplicate_deleted` in `PeopleErrorCode`.
- `modules/core/people/infrastructure/person-delete.ts` (new): `lockPersonForDelete(tx, { personId, version })` reads the adult `FOR UPDATE` in the current community with `deleted_at` null (else `not_found`) and checks the version (else `conflict`); `hidePerson(tx, { personId, actorUserId })` then locks the contact's children `FOR UPDATE` in id order, refuses `sole_guardian` when a child has no other guardian with `deleted_at` null, sets `deleted_at = now()` and `deleted_by`, bumps `version`, writes `people.person.deleted`, returns `{ personId, version, purgeAfter }` with `purgeAfter` from SQL; `restorePerson(tx, { personId, version, actorUserId })` locks a hidden adult `FOR UPDATE`, checks the version, clears both columns, bumps `version`, writes `people.person.restored`.
- `modules/core/people/public/index.ts`: export them; register `people.person.deleted` and `people.person.restored`.
- `modules/core/access/infrastructure/delete-blockers.ts` (new) and `modules/core/access/public/index.ts`: `deleteBlockers(tx, personId)` returns `{ userLink: boolean, pendingInvitation: boolean }`, live pending only.
- `person-delete.integration.test.ts` and `delete-blockers.integration.test.ts` (new): version and not-found cases (`rejects.toMatchObject({ code })`, rows unchanged), two organisations, minor, sole guardian (with the other guardian hidden first), two concurrent deletes of a child's two guardians (the second proven blocked on the child row through `pg_locks`, then `sole_guardian`), restore, audit ids only, and a two-transaction test that a `personIsMinor(..., { lock: "share" })` reader waits for `lockPersonForDelete`.

**Test first:** both test files.

**Rule it must not break:** people does not import access; `apps/api` composes them (Task 8).

**Pins:** 25 to 32. Checkpoint 1 follows this task.

### Task 4: Hidden contacts left out of people reads, and the Deleted list

**Commit:** `feat(people): leave hidden contacts out of every read`

**Files:** `deleted_at is null` in `list-persons.ts:289` (adult list; the minors list needs none, minors cannot be hidden); `person-summary.ts:37`; `person.ts:361` (`readPerson`); `household-list.ts:102-108`; `household.ts:453`, `:480`, `:564` and the guardian links `:528-545` (both sides) and `:560-567`; `linked-contacts.ts:99`; `roster-names.ts:111`; `life-event.ts:160`; `person-keys.ts:123-151` (`openPersonFieldKeys`). Not here: the local `personExists` in `activity.ts` and `tags.ts`, life-event create and update (Task 5).

A new `listDeletedPersons(tx, { search, cursor, limit })` in `list-persons.ts`: hidden adults, `deleted_at desc, id`; the cursor carries `deleted_at::text` (microseconds) and the id and compares with `::timestamptz`; name prefix search; no key derive, no decrypt, no KMS call; returns name, `deletedAt`, `purgeAfter` (both from SQL) and `version`; one `people.person.listed_deleted` audit per non-empty page (registered in `public/index.ts`).

A new `visiblePersonIds(tx, ids)` in `roster-names.ts`, exported from `public/index.ts`: the subset of ids with `deleted_at` null in the current scope (used by groups in Task 6).

`hidden-reads.integration.test.ts` (new): one `it` per path with a hidden and a visible contact in the fixture; the Deleted list paging test with three rows sharing a millisecond, page sizes 1 and 2; `visiblePersonIds`.

**Test first:** the hidden-reads tests.

**Rule it must not break:** every existing people read test unchanged; the adult list's sort and cursor untouched.

**Pins:** 33 to 44.

### Task 5: Hidden contacts refused by writes; duplicate_deleted; access

**Commit:** `feat(people): refuse writes for hidden contacts and name a deleted duplicate`

**Files:**

- `deleted_at is null` in the locks of `update-person.ts`, `person-status.ts`, `household-members.ts:89-95` (`moveAdult`), `guardian.ts:96-104` (`linkGuardian`), `tags.ts:26` (`personExists`, used by `attachTag` and `listPersonTags`), `activity.ts:10-13` (`personExists`), `life-event.ts:274` (create) and `:406` (update join).
- `guardian.ts` `unlinkGuardian`: read the link's guardian and require `deleted_at` null (not found otherwise), locked `FOR UPDATE` after the child; the remaining-links count joins `app.persons` and counts only guardians with `deleted_at` null.
- `tags.ts:105-118` `detachTag`: a hidden-contact check (new; it reads no person today).
- `access-facts.ts:3-26` `personIsMinor`: `deleted_at is null`.
- `person.ts:287-293` (`createPerson`'s catch): after `duplicateError`, look the holder up with the bidx values in scope (`deleted_at is not null`, same scope, email first) and throw `duplicate_deleted` when hidden. `update-person.ts:327-329`: on a unique violation, the same lookup with the new bidx values; `duplicate_deleted` when a hidden holder exists, else `conflict` as today.
- `modules/core/access/infrastructure/invitations.ts:197`: `{ lock: "share" }`; `restricted-read.ts:26-40`: a hidden contact throws `forbidden` with the existing denied audit, as an unknown id does. `grants.ts:249`, `:455` and `invitations.ts:779`, `:807` change only through `personIsMinor` (the tests prove it).
- `hidden-writes.integration.test.ts` and `access/infrastructure/hidden-contact.integration.test.ts` (new), including the update-duplicate cases (visible holder stays `conflict`, hidden holder gives `duplicate_deleted`) and the `writeUserLink` and `createInvitation` races. Rebuild `@community-hub/people` before the access tests.

**Test first:** both test files.

**Rule it must not break:** existing duplicate answers unchanged for visible holders; existing invitation, grant and guardian tests unchanged.

**Pins:** 45 to 61.

### Task 6: Groups

**Commit:** `feat(groups): leave hidden contacts out of members and refuse member writes`

**Files:** `modules/features/groups/infrastructure/members.ts`: `listMembers` (`:278-335`) keeps only rows whose person is in the `readRosterNames` result (no `?? true` fallback for an absent person); `personIdsInGroup` and `activeGroupsForPersons` filter through people `visiblePersonIds`; `addMember` (`:108`) takes existence and `isMinor` from `personIsMinor(..., { lock: "share" })` instead of `readRosterNames` and answers not found on null; `removeMember` (`:161`) and `setMemberRole` (`:212`) answer not found for a hidden contact through `visiblePersonIds`. `export.ts` is unchanged (it already skips people absent from `readRosterNames`, `:93-100`); its behaviour is proven by a database test. `hidden-members.integration.test.ts` (new). Rebuild `@community-hub/people` first.

**Test first:** the groups test.

**Rule it must not break:** groups never imports people infrastructure, only `public/`; existing groups tests unchanged.

**Pins:** 62 to 68.

### Task 7: Confirm dialog in packages/ui

**Commit:** `feat(ui): add ConfirmDialog`

**Files:** `packages/ui/src/confirm-dialog.tsx` (new) on `@base-ui/react/dialog` as `drawer.tsx` uses it: props `open`, `onOpenChange`, `title`, `description`, `confirmLabel`, `cancelLabel`, `tone` (`danger` or `default`), `onConfirm`, `pending`, an optional `error` line; modal, focus trapped, Escape and Cancel close without confirming, focus returns to the trigger; tokens only (`check-tokens`); `confirm-dialog.test.tsx` and `confirm-dialog.a11y.test.tsx` (axe, light and dark); `packages/ui/src/index.ts` and `exports.test.ts`.

**Test first:** both test files.

**Rule it must not break:** no new dependency; existing `packages/ui` tests unchanged; WCAG 2.2 AA.

**Pins:** 69 to 71.

### Task 8: Contracts and routes, with the sweep

**Commit:** `feat(api): delete and restore routes, the deleted filter and the purge sweep`

**Files:**

- `packages/contracts/src/people.ts` and `people.test.ts`: `personDeleteBody` and response, `personRestoreBody` and response, list `status: "deleted"` (refusing `source`, `groupId` and `kind: "minors"`), the deleted list item and cursor, `peopleErrorBody` `{ code }` with the four codes.
- `packages/contracts/src/access.ts:117`, `:141` and `access.test.ts`: `people.delete` in `CAPABILITIES_ALLOW_LIST`; `apps/api/src/access-flow.integration.test.ts:329-390`: the three capability blocks gain `people.delete` (true for the owner, false for the member).
- `apps/api/src/people-routes.ts`: `POST /v1/people/delete` (`people.view` and `people.delete`, `lockPersonForDelete` → `deleteBlockers` → `hidePerson` in one transaction, `billing: "write"`, `40P01` mapped to an empty 409), `POST /v1/people/restore` (`billing: "write"`), the list's `deleted` branch (needs `people.delete`, else 400); `statusForPeople` maps the four codes to 409 with `{ code }`, others unchanged.
- `apps/api/src/household-routes.ts`: `statusForHouseholds` maps `duplicate_deleted` to 409 with `{ code }`.
- `apps/api/src/contact-sweep.ts` (new): `sweepDeletedContacts(deps, scope, userId, context)`: returns at once unless `guardWrite(deps, scope, userId, { billing: "write", pattern: context.pattern })` answers null; else `deps.checkout("app", ...)` + `withAppTransaction` + `purgeDeletedPersons(tx, 50)`; any error logged with its class only. Called after the adult list, the Deleted list, delete and restore resolved with 200 (after the route's `deps.checkout` has resolved, so its transaction has committed), awaited, before the response is returned.
- `apps/api/src/people-delete-routes.integration.test.ts` (new); `billing-guard.integration.test.ts` fixtures; `index.test.ts` route list.

**Test first:** contracts, route and billing-guard tests.

**Rule it must not break:** existing people, household and life-event route answers unchanged (`statusForPeople` is also used by `life-event-routes.ts:220`, `:268`, `:317`); no personal data in the error body or the logs.

**Pins:** 72 to 87. Checkpoint 2 follows this task.

### Task 9: All Contacts screen

**Commit:** `feat(admin): delete, restore and the Deleted filter on All Contacts`

**Files:** `apps/admin/src/all-contacts.tsx` (Delete row action opening `ConfirmDialog` with the spec's text; refusal messages per code and for a 409 without a body; `Deleted` status option; deleted rows with dates and Restore; purged-meanwhile message and reload; empty state "No deleted contacts."; the duplicate messages on create and edit, the restore hint only for `people.delete` holders; Delete and Restore hidden when `hideWrites` or without `people.delete`; the Deleted filter hidden without `people.delete`, shown in read-only billing); `apps/admin/src/people-access.tsx` (`people.delete`) and `people-access.test.ts` (`parseAccess`, `defaultAccess`); the typed `PeopleAccess` fixtures gain `"people.delete": false` in `family-records.test.tsx`, `nav.test.tsx`, `service-times.test.tsx`, `shell.test.tsx`; `apps/admin/src/all-contacts.test.tsx`: a test per Screen bullet of the spec, including a deep link to a hidden contact answering as unknown and axe in the dialog and Deleted states.

**Test first:** the screen tests.

**Rule it must not break:** controls hidden, never rendered to 403 or 402 (AGENTS.md §6); axe clean; existing screen tests unchanged apart from the typed fixtures.

**Pins:** 88 to 93. Checkpoint 3 (browser check) follows this task.

### Task 10: Architecture, roadmap and repository state

**Commit:** `docs: mark contact-delete done`

**Files:** `architecture.md` (§12.1 grant sentence, `:731`, to fifteen columns, `EXECUTE` and the definer function; §12.4 the contact retention rule; the people routes line); `docs/roadmap.md` (`Contact delete` done with spec and plan paths; open item for the scheduler sweep of hidden contacts; snapshot; Phase 2 counts); `AGENTS.md` Repository state.

**Test first:** none (docs); `pnpm format` clean.

**Pins:** none.

## Dispatch order

Tasks 1 to 10 in order, one run each. Checkpoints after Tasks 3, 8 and 9.

## Definition of done (AGENTS.md §8)

- Every task committed and accepted; pins 1 to 93 and the amendment pins fail weakened and pass restored, run by the reviewer.
- Full local gate green apart from the allowed Windows failures; CI green on the pull request.
- Browser check screenshots in the pull request; staging stays parked, recorded as an open item.
- The pull request body states the AGENTS.md §3 deviation (three modules) and why, as the spec requires, and the sweep's extra checkouts.
- Reviewer sign-off and the second review line in the pull request; no `docs/plans/*-report.md`; nothing under `.superpowers/` staged.

## Amendments during implementation

### A1 (2026-11-22, after checkpoint 1): sole guardian of a minor only, and test strength for Tasks 1 to 3

Source: the reviewer's Task 3 review and checkpoint pin run (pins 1 to 32 all fail weakened; pin 12's patch was rebuilt after Task 2 moved `0022`), and the checkpoint 1 owner's check (Claude Sonnet 5.5, CHANGES NEEDED, 0 High, 3 Medium, 4 Low; no source defect found, nine uncaught weakenings). Three commits, in this order.

- **Source fix (Task 3), commit `fix(people): refuse sole_guardian only for a minor child`:** `hidePerson` counted every child in `app.guardian_links`. The spec (Behaviour → Delete) refuses only "a guardian of a minor", and the purge already joins `child.is_minor = true`. A child who turns 18 keeps their links, so deleting their parent was refused. The children read and the child-row lock take minors only. File **H**:

| #   | Setting                                  | Weakening                                     | Test that must fail (exact `it` title)                     |
| --- | ---------------------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| 27b | Sole guardian counts minor children only | Drop `is_minor = true` from the children read | delete does not refuse the only guardian of an adult child |

- **Tests (Tasks 1 to 3), commit `test(people): pin the deleted_by rules, purge limit and order, and hidden guardians`:**

| #   | Setting                                    | Weakening                                                         | File | Test that must fail (exact `it` title)                          |
| --- | ------------------------------------------ | ----------------------------------------------------------------- | ---- | --------------------------------------------------------------- |
| 3b  | `deleted_by` cleared with `deleted_at`     | The `deleted_by must be null when deleted_at is cleared` rule off | DM   | migration 0022: refuses a restore that leaves deleted_by set    |
| 3c  | `deleted_by` fixed on a hidden contact     | The `cannot change deleted_by on a deleted person` rule off       | DM   | migration 0022: refuses changing deleted_by on a hidden contact |
| 3d  | No `deleted_by` on a visible contact       | The `cannot set deleted_by when deleted_at is null` rule off      | DM   | migration 0022: refuses deleted_by on a visible contact         |
| 20b | A co-guardian who is hidden does not count | `other_g.deleted_at IS NULL` replaced by `true`                   | PG   | purge skips a guardian whose only co-guardian is hidden         |
| 23b | At most `p_limit` contacts per call        | Drop `LIMIT p_limit`                                              | PG   | purge takes the oldest contacts up to the limit                 |
| 23c | Oldest first                               | Drop the `ORDER BY` of the selection                              | PG   | purge takes the oldest contacts up to the limit                 |
| 23d | No purged event when nothing is purged     | Append the event when `ids` is empty                              | PG   | purge writes no event when nothing is eligible                  |
| 28b | A hidden contact is not found on delete    | Drop `deleted_at is null` from `lockPersonForDelete`              | H    | delete answers not found for a contact that is already hidden   |
| 28c | A hidden minor is not found on restore     | Drop `is_minor = false` from `restorePerson`                      | H    | restore answers not found for a hidden minor                    |

- Each DM test runs as `app` and asserts `rejects.toThrow("<the rule's exact message>")`.
- 23b and 23c: three eligible contacts aged 723, 722 and 721 hours; `purgeDeletedPersons(tx, 2)` resolves to exactly the two oldest, in that order, and the third survives.
- 20b: guardians A (aged 721 hours) and B (hidden 1 hour) of one minor; the purge resolves to `[]` and both guardians and both links survive.
- 28c: the hidden minor is seeded as `migrator` with `DISABLE TRIGGER USER`, as Global constraints describe; `restorePerson` rejects with `{ code: "not_found" }` and the row is unchanged.
- The existing DM test `migration 0022: a custom role may hold people.delete` asserts its unknown-key half with `rejects.toThrow(/custom_role_permissions_permission/)`, not a bare `toThrow()`.
- **Test timing, commit `test(people): give the household detail read time under the serial gate`:** `household-detail.integration.test.ts` "pin 9" timed out at the default 5 s in the Task 3 gate (`--concurrency=1`) and passed three times alone in about 5 s of test time. Its `it` gets an explicit 20 000 ms timeout, as the concurrency tests in `person-delete.integration.test.ts` do. No assertion changes. The file is outside this chunk's named files; the pull request names it.
- Not acted on, recorded for the pull request:
  - F6: the insert rule (`persons_before_insert`) is in this plan (Spec pointer corrections) but not in the spec's Data section or ADR 0020. It also means a later import has to disable the trigger to insert a pre-hidden row. The pull request body says so.
  - F7: the function's `search_path` has no trailing `pg_temp`. The spec fixes it as `pg_catalog, app`, as `0016` does, and `app` has no `TEMP` privilege (probed), so nothing can be shadowed today. It matters only if `TEMP` is ever granted to `app`.
  - `hidePerson` relies on `lockPersonForDelete` running first in the same transaction (the plan's design); Task 8's route test keeps that order.

### A2 (2026-11-23, after checkpoint 2): writes wait for a delete, and test timing

Source: the checkpoint 2 pin run (pins 33 to 87 all fail weakened and pass restored) and the checkpoint 2 owner's check (Claude Haiku 5.5, CHANGES NEEDED, 1 Medium, 3 Low, 1 Nit). F1 was shown by a two-transaction probe. The reviewer then read every write that names a contact: `detachTag` (also in F1), `updateLifeEvent`, `removeMember` and `setMemberRole` check `deleted_at` without a lock too. Create, update, status, move, the guardian writes, `createLifeEvent`, `addMember`, `createInvitation` and `writeUserLink` already lock the contact or check its state or version in the write itself. Three commits, in this order.

- **People, commit `fix(people): make tag, life event and hide writes wait for or refuse a hidden contact`:** `attachTag` and `detachTag` read the contact `FOR SHARE` (`listPersonTags` stays unlocked); `updateLifeEvent` reads it `FOR SHARE OF p`; the update in `hidePerson` gains `deleted_at is null and is_minor = false`, so a caller that skips `lockPersonForDelete` gets `not_found` instead of the trigger's error. Files **HW** and **H**.
- **Groups, commit `fix(groups): make member removal and role changes wait for a delete`:** `visiblePersonIds` takes an optional `{ lock: "share" }`, which `removeMember` and `setMemberRole` pass; its read callers stay unlocked. File `hidden-members.integration.test.ts`.

| #   | Setting                               | Weakening                                         | Package | Test that must fail (exact `it` title)                    |
| --- | ------------------------------------- | ------------------------------------------------- | ------- | --------------------------------------------------------- |
| 28d | `hidePerson` refuses a hidden contact | Drop `deleted_at is null` from its update         | people  | hidePerson alone answers not found for a hidden contact   |
| 28e | `hidePerson` refuses a minor          | Drop `is_minor = false` from its update           | people  | hidePerson alone answers not found for a minor            |
| 51b | Attach waits for a delete             | Drop the lock from `attachTag`'s contact read     | people  | attachTag waits for a delete that holds the contact       |
| 52b | Detach waits for a delete             | Drop the lock from `detachTag`'s contact read     | people  | detachTag waits for a delete that holds the contact       |
| 55b | Life event update waits for a delete  | Drop `for share of p` from `updateLifeEvent`      | people  | updateLifeEvent waits for a delete that holds the contact |
| 67b | Member removal waits for a delete     | Drop the lock from `removeMember`'s contact read  | groups  | removeMember waits for a delete that holds the contact    |
| 68b | Role change waits for a delete        | Drop the lock from `setMemberRole`'s contact read | groups  | setMemberRole waits for a delete that holds the contact   |

- 51b, 52b, 55b, 67b and 68b: transaction 1 runs `lockPersonForDelete` and `hidePerson` and stays open. Transaction 2's call is proven blocked through `pg_locks`, as pins 59 and 60 do (race the promise, poll with a 10 s cap, never hang). Transaction 1 commits. The call rejects as not found, and the rows it would change (link, history, life event, membership) are unchanged. Each `it` has an explicit 20 000 ms timeout. Without the lock, attach and detach still block on the history row's foreign key and then succeed, so their tests fail on the rejection, not on the wait.
- 28d and 28e: `hidePerson` is called without `lockPersonForDelete`, in its own transaction, and rejects with `{ code: "not_found" }`; the row is unchanged and no audit event is added.
- **Test timing, commit `test(people): raise the test timeout for the serial gate`:** `modules/core/people/vitest.config.ts` sets `testTimeout: 20_000`. Two existing tests have exceeded the default 5 s under the serial gate: household-detail "pin 9" (A1) and list-persons "filters by status…". No assertion changes. The file is outside this chunk's named files; the pull request names it.
- Not acted on, recorded for the pull request:
  - F2: the duplicate lookup checks email first whichever index fired. The spec fixes email first; Postgres checks the email index first today (the owner's probes 1a and 1b passed). If that order changed, the worst case is `duplicate_phone` where `duplicate_email` is due.
  - F4: `updatePerson`'s update has no `deleted_at is null`. A hide adds one to `version`, so the version check already refuses a stale write; the extra predicate could not be pinned, because removing it changes nothing.
  - F5: the Deleted item's `givenName` is `min(1)` and the server falls back to `""`. `normaliseName` refuses an empty name and the table's check refuses a null one for an adult.
