Spec: docs/specs/2026-11-28-childrens-data-access.md

# Children's data access Implementation Plan

Slug: childrens-data-access
Status: approved (2026-11-28, Adnan Bin Hossen)

Revision 3 (2026-11-28) applied a delta check of revision 2 (Claude Haiku 5.5, NOT READY, 3 High, 6 Medium, 9 Low). All were applied:

- H1, M1, L9. Each task now names every test file that calls a signature it changes or asserts a behaviour it removes ("Test files to classify"). The implementer classifies each test in them in the report (kept, flipped old → new, or replaced).
- H2. The life-event list route refuses a child's events to a caller who is not a Community Admin. That is pin 37b, and the route sweep now checks event ids.
- H3, M4. `consumeFreshFactorInTx` puts every guard in its one conditional update, and the public function alone takes the advisory lock.
- M2. The label check is named as the one decrypt outside the View path. It is write-only and never returned (spec Data).
- M3. Pin 33 seeds ids against creation order.
- M5. The call-site test checks that `isCommunityAdmin` runs earlier in the same function, and it starts in Task 3.
- M6. A refused View's denial audit is pin 67b.
- L1. The two signature changes are recorded as spec deviations in Task 10.
- L2 to L8. Applied.

Revision 2 (2026-11-28) applied the fresh-context plan check (Claude Haiku 5.5, NOT READY, 5 High, 8 Medium, 11 Low). Every finding was applied except M12, the branded proof. A brand's constructor would have to be exported from people for access to mint it, so anyone could mint it; the import allow-list (pins 41, 42) is the real guard. The changes:

- H1. Each task now changes every caller of a signature it changes, and the route answers, contracts and test flips that follow, so the gate is green after every task. Groups' use of `readRosterNames` moves to Task 5 with it.
- H2. There is no `hidden_at`. Hiding sets `deleted_at` (`person-delete.ts:160`).
- H3. `isCommunityAdmin` takes no community argument. It reads only the RLS scope, which `community_isolation` already limits (`packages/db/drizzle/0007_fast_gorilla_man.sql:63`). The cross-community and cross-organisation cases stay as tests, guarded by the policy and the schema-rls checker, not as source pins. Former pins 14, 15, 18 and 67 are tests only.
- H4. Pin 12 now asserts that the attempt is not given back.
- H5. Pin 44 targets a real leak, and pin 44b covers `visiblePersonIds`.
- M6. The route calls `consumeFreshFactor` between the two access calls, so access gains no identity dependency.
- M7, M8. Pins 10 and 63 are removed: the database check (`0024`, `sessions_second_factor_attempts`) and the new MF pin 39b cover them.
- M9. Pin 2's ordering is spelled out.
- M10, M11. The missing flips and `detachTag` are added.
- M13. The static test lives in the people package's own tests.
- Lows: all applied.

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** Only a `community_admin` in that community reads a child's details. They read one field at a time, through a View that uses up a fresh second factor and writes one ids-only audit event. Everyone else sees how many children a family has and nothing more. `people.restricted.read` covers adults only. No exported function outside the View path decrypts a minor's field. Family labels cannot carry a child's given name. ADR 0017, with the status notes for O2, O3 and O4, and ADR 0022, with O1, are the design record.

**Architecture:**

- `modules/core/identity`: `consumeFreshFactor` and the O1 attempt give-back.
- `modules/core/access`: `isCommunityAdmin`, `readPersonForActor` without the minor branch, and the View service (`minor-view.ts`), which is the only caller of people's field opener.
- `modules/core/people`: minor fields removed from every reader; child labels; `openMinorField` (import-allow-listed); the label check.
- `modules/features/groups`: minor rows and ids omitted for non-admins; minor membership writes Community Admin only.
- `packages/contracts`: the View bodies and answers, and the changed household, people and life-event answers.
- `apps/api`: the two View routes, the changed answers, the write gates, the rename rule, the users-list flag, and the route sweep.
- `apps/admin`: the shared "Confirm it's you" panel, Family Records, All Contacts, the life-events panel, Users & Roles copy, and the label guidance.
- `architecture.md`, `docs/adr/0017-*.md`, `docs/adr/0022-*.md`, `docs/roadmap.md`, `AGENTS.md`.

Ten tasks, matching AGENTS.md §3's upper guide. No migration, no Terraform, no Dockerfile change, and no new dependency.

## Who does what

- **Implementer:** Antigravity on **Gemini 4 Hydrogen xhigh** (`agy --model gemini-4-hydrogen-xhigh`), in `C:\Recovered\Taftech\wt-children` on the chunk branch. Fallback when it is out of quota or fails twice: Claude Sonnet 5.5. Each model used is named in the task report.
  - Tests first, one commit per task. It commits locally and never pushes. One plan task per run.
  - For every Security pins row its task names, it writes the weakening as a `.patch` under `.superpowers/sdd/pins/` (with `git diff --output`, UTF-8, LF), plus a row in `.superpowers/sdd/pins/manifest.json` in the `pinrun.mjs` format. That row has a `"build"` list where the pin weakens a package another package's test reads through `dist`. It checks that each hunk header names the right function.
  - Every test result it claims points to a log it wrote with `tee` under `.superpowers/sdd/task-N-logs/`, UTF-8. A claim without a log counts as not run.
  - It starts with no AWS credentials. Pushes are blocked by the push URL and the pre-push hook.
- **Reviewer agent:** this session, on Claude Opus 5.5 for the whole chunk. Each task is reviewed by its diff, with the named tests re-run and every named pin run through `pinrun.mjs`. The reviewer pushes each accepted task.
- **Owner's checks and the second review:** a fresh session on a model that is not Opus, not Gemini, and not Sonnet if the fallback ran: Claude Haiku 5.5 or Fable. The spec checks ran on Claude Haiku 5.5.
- **Docker test database:** one run at a time. Tasks 1 to 8 need it, as does any full local gate. `pinrun` never runs while an implementer is editing the tree.

## Checkpoints

- **After Task 4** (identity, access, people readers): every pin named in Tasks 1 to 4, and an owner's check of `git diff <plan-sha>..<task-4-sha>`. Task 5 starts after that check.
- **After Task 8** (groups, labels, contracts, routes): every pin named in Tasks 5 to 8, including 82a (manual). `index.test.ts`, `users-list.integration.test.ts`, `household-routes.integration.test.ts`, `people-routes.integration.test.ts` and `life-event-routes.integration.test.ts` re-run, the route sweep five times green, and an owner's check of `git diff <task-4-sha>..<task-8-sha>`.
- **After Task 9** (admin): pins 83 to 95, and `family-records.test.tsx`, `all-contacts.test.tsx`, `security.test.tsx` and `fresh-check.test.tsx` five times green. Then a browser check by the reviewer at 1280px and 375px, light and dark, through Playwriter on Brave against a scratch API stub:
  - a Community Admin sees `Child 1` and `Child 2` hidden, Views a name with an authenticator code, Views a date of birth and is asked again, and sees the value hidden after closing;
  - a backup-code session gets the sign-in-again message;
  - a safeguarding officer sees "2 children in this family" only;
  - a rename refused for a child's name;
  - axe is 0 on each screen.

  Screenshots for the pull request use synthetic names only.

## Global constraints

- AGENTS.md §1 throughout. Synthetic data only, with names ending in `.example.test` for any email. Fixtures with a minor use invented names, and the sweep's seeded names are unusual enough that a substring hit is never a coincidence (for example `Zephyrine`, `Quillon`).
- No migration. Do not touch `packages/db/drizzle/`, `infra/`, the Dockerfile or `package.json` dependencies. A task that finds it needs one stops and reports.
- No exported function decrypts a minor's field except `openMinorField`, and only `modules/core/access/infrastructure/minor-view.ts` imports it (pin 41). There is one exception, and it returns nothing. The label check (P4) decrypts a family's given names in memory inside `label-check.ts`, which the spec's Data section names ("the D5 check compares decrypted values in memory inside the write transaction"). It is reached only through `renameHousehold` and `createPerson`'s minor branch, and it never returns, logs or audits a value (pin 60).
- The chunk ships as one pull request. Between Tasks 3 and 9, the admin's minor screens show what the narrowed API returns: a 403 on the Minors tab for non-admins, and no child fields. That is acceptable because the branch is never deployed before Task 9. Every task's gate is still green.
- Each task's gate includes `pnpm typecheck`, which covers test files (`tsconfig.test.json`), so a test caller of a changed signature is updated in the same commit.
- Tenant scope through `packages/db` helpers only. No session-level `SET`.
- Every refusal before the transaction keeps today's empty body. Every View answer, errors included, carries `Cache-Control: no-store`.
- No value, name, label or SQL text in a log line or an error message. Codes only.
- A flipped test (spec Scope 13) is changed in the task that changes its behaviour, never deleted without a replacement that pins the new behaviour. The task report lists each flip as old title → new title.
- LF line endings. `pnpm gate` before each report. Allowed failures are the known Windows ones (drizzle `generate.test.ts` ENOENT), named as such in the report.

## Decisions fixed by the spec (do not reopen)

D1 to D6 and O1 to O4 in the spec header. In short:

- every View uses up the fresh check;
- everything is hidden by default, the name too;
- Add minor is Community Admin only;
- the role rule is strict;
- labels are checked against given names, with Community Admin-only rename of a family with a child;
- there is no guardian read.

## Plan additions to the spec

- **P1. Where the role check lives.** `@community-hub/access` depends on `@community-hub/people`, not the other way (`modules/core/access/package.json:24`), and people cannot read `app.community_role_grants`, which access owns. So the spec's "readers decide themselves" (Scope 1) is met this way:
  - (a) No people reader decrypts a minor's field at all.
  - (b) The one field opener, `openMinorField`, is exported from people `public/` and import-allow-listed to `modules/core/access/infrastructure/minor-view.ts` by a static test (pin 41).
  - (c) `minor-view.ts` runs `isCommunityAdmin` in the same transaction before every call.

  The admin and presence shapes of the people readers differ only in ids and labels, never fields. They take `childView: "admin" | "presence"`, and only access and `apps/api` route code that has just run `isCommunityAdmin` pass `"admin"`. A static test (pin 42) lists those call sites. A branded proof type was considered and rejected (revision 2, M12).

- **P2. Child labels.** One SQL helper, `childLabels(tx, householdIds)`, in people. It numbers children over `is_minor and deleted_at is null` by `created_at, id`. Hiding a person sets `deleted_at` (`person-delete.ts:160`); there is no other hidden column. Every reader that shows a child label calls it, including an adult's guardian links for a Community Admin.
- **P3. The View order.** `minor-view.ts` exports two functions, and the route calls them in this order:
  1. The entitlement guard (402).
  2. Transaction A, `prepareMinorView`: `isCommunityAdmin`, else `forbidden`. Then load the child (a minor, not deleted, in the scoped community; the life event must belong to the child), else `not_found`.
  3. `consumeFreshFactor({ sql, kms, keyArn, accessToken, now })` (the same dependencies as `freshCheckTotp`, `second-factor.ts:971`): `recovery`, `not_fresh` or `consumed`.
  4. Transaction B, `finishMinorView`: `isCommunityAdmin` again, else `forbidden`. Then `openMinorField` (which refuses a deleted child or a mismatched event), then `appendAuditEvent`.

  `@community-hub/access` gains no `@community-hub/identity` dependency. `apps/api` already holds both.

- **P4. The label check** is `assertLabelFreeOfChildNames(tx, { householdId, label, newChildGivenName? })` in people. It decrypts in memory the given names of the household's minors, including hidden ones (`deleted_at` set, not yet purged), and of its adults. It applies the spec's rule (Scope 8) and throws `PeopleError("label_contains_child_name")`. `renameHousehold` and `createPerson`'s minor branch call it. `addMinor` reaches it through `createPerson` (`household-members.ts:179`) and needs no change of its own. The rename route's Community Admin rule for a family with a child is in `apps/api`, before the call, so a non-admin never reaches the check.
- **P4b. Spec deviations**, recorded in Task 10 as spec status notes:
  - `consumeFreshFactor` takes `{ sql, kms, keyArn, accessToken, now }`, the same dependencies as `freshCheckTotp`, where the spec showed `{ accessToken, now }`;
  - `isCommunityAdmin(tx, userId)` takes no community argument and relies on the `community_isolation` policy (migration `0007:63`), where the spec showed a `communityId` parameter.
- **P5. The users-list flag.** `readLinkedContacts` takes `childView` (P1). With `"presence"`, a minor-linked user's contact is `null`, as for an unlinked user.
- **P6. Return shapes.** For a minor, `readPerson` returns `null`, its existing not-found value (`person.ts:380`). Life-event rows keep the existing field name `eventId` (`life-event.ts:21-28`). The spec's `lifeEventId` is the same value, and the View body field is named `lifeEventId`. `readPersonForActor` throws `AccessError("not_found")`, as it does for a missing person. `readHousehold` gains `childCount`, like `readHouseholdDetail`.
- **P7. `decide`.** After Task 2, the guardian override (`decide.ts:64-67`) no longer reaches a minor. Guardian links only ever point at minors (`guardian.ts:108-109`), so it is dead. It is left in place, with a comment pointing at the member-portal chunk, which rebuilds guardian read. Removing it would change `packages/policy`, which this chunk otherwise does not touch.

## Security pins

Rows without a source pin, which are tests only: the cross-community and cross-organisation `isCommunityAdmin` cases, a deleted grant, a View of a child in another community, and the attempt counter floor. Each is a named test in its task, guarded by RLS or a database check rather than by source the implementer could weaken.

Each row is a weakening the implementer writes as a patch and the reviewer runs with `node ~/.claude/crew/bin/pinrun.mjs .superpowers/sdd/pins/manifest.json --only <id>`. The weakened run must fail **on an assertion** in the named test; the restored run must pass. The weakened tree is never committed. Exact `it` titles are the implementer's, written into the manifest; the column below says what each must assert.

Files:

- **FC** = `modules/core/identity/infrastructure/fresh-consume.integration.test.ts` (new)
- **SF** = `modules/core/identity/infrastructure/second-factor.integration.test.ts`
- **CA** = `modules/core/access/infrastructure/community-admin.integration.test.ts` (new)
- **RR** = `modules/core/access/infrastructure/restricted-read.integration.test.ts`
- **PR** = `modules/core/people/infrastructure/minor-readers.integration.test.ts` (new)
- **HD** = `modules/core/people/infrastructure/household-detail.integration.test.ts`
- **MF** = `modules/core/people/infrastructure/minor-field.integration.test.ts` (new)
- **FS** = `modules/core/people/infrastructure/function-sweep.integration.test.ts` (new; it covers people and groups)
- **IS** = `modules/core/people/infrastructure/minor-field-imports.test.ts` (new static test: it reads the repository's `.ts` files with `node:fs` and runs in the people package's `pnpm test`)
- **GR** = `modules/features/groups/infrastructure/minor-members.integration.test.ts` (new)
- **LB** = `modules/core/people/infrastructure/label-check.integration.test.ts` (new)
- **MV** = `modules/core/access/infrastructure/minor-view.integration.test.ts` (new)
- **CT** = `packages/contracts/src/people.test.ts`
- **VR** = `apps/api/src/minor-view-routes.integration.test.ts` (new)
- **HR** = `apps/api/src/household-routes.integration.test.ts`
- **SW** = `apps/api/src/minor-sweep.integration.test.ts` (new)
- **UL** = `apps/api/src/users-list.integration.test.ts`
- **OP** = `apps/api/src/ops-isolation.test.ts` (new)
- **PV** = `modules/core/access/infrastructure/privileges.integration.test.ts`
- **AF** = `apps/admin/src/fresh-check.test.tsx` (new)
- **AR** = `apps/admin/src/family-records.test.tsx`
- **AC** = `apps/admin/src/all-contacts.test.tsx`
- **AU** = `apps/admin/src/users-roles.test.tsx`
- **LR** = `apps/api/src/life-event-routes.integration.test.ts`
- **PI** = `apps/api/src/people-routes.integration.test.ts`

| #   | Setting                                                     | Weakening                                                                                                              | File | The failing test asserts                                                                                                                                                                               |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Consume clears freshness                                    | Skip the `fresh_factor_at = null` update                                                                               | FC   | a second consume after one success answers `not_fresh`                                                                                                                                                 |
| 2   | Consume is one conditional update                           | Read, then update without the freshness condition                                                                      | FC   | ordered race, no timing and no advisory lock: tx1 runs `consumeFreshFactorInTx` and holds its row lock uncommitted; tx2 starts the same call (its update blocks); tx1 commits; tx2 answers `not_fresh` |
| 2b  | The public function takes the advisory lock                 | Drop `lockSecondFactor` from `consumeFreshFactor`                                                                      | FC   | while another transaction holds the user's second-factor lock, `consumeFreshFactor` waits (asserted by lock state in `pg_locks`, not by time)                                                          |
| 3   | Recovery checked first                                      | Drop the `recovery_until` branch                                                                                       | FC   | a recovery session answers `recovery`, never `not_fresh` or `consumed`                                                                                                                                 |
| 4   | Tenant sessions only                                        | Drop `kind = 'tenant'` from the one update (the only kind guard in `consumeFreshFactorInTx`)                           | FC   | a `second_factor` (pre-2FA) session with a fresh time answers `not_fresh`                                                                                                                              |
| 5   | Revoked sessions refused                                    | Drop `revoked_at is null` from the one update (the only revoked guard)                                                 | FC   | a revoked session answers `not_fresh`                                                                                                                                                                  |
| 6   | Five-minute window                                          | Widen the update's window to 10 minutes (the only window guard)                                                        | FC   | a check 5 minutes and 1 second old answers `not_fresh`                                                                                                                                                 |
| 7   | O1 give-back on a correct TOTP fresh check                  | Remove the give-back in `freshCheckTotp`                                                                               | SF   | seven correct TOTP fresh checks in one session, `now` advanced 30 s each (the `last_used_step` guard), all answer `fresh`                                                                              |
| 8   | O1 give-back on a correct passkey fresh check               | Remove the give-back in `verifyFreshPasskey`                                                                           | SF   | seven correct passkey fresh checks in one session, each with a new challenge and a rising sign count, all answer `fresh`                                                                               |
| 9   | Wrong codes still count                                     | Give back on refusal too                                                                                               | SF   | five wrong TOTP codes, then a correct one, answers `limited`                                                                                                                                           |
| 11  | Hourly limit unchanged                                      | Skip the hourly check in `freshCheckTotp`                                                                              | SF   | ten wrong codes across sessions in an hour, then a correct one, answers `limited`                                                                                                                      |
| 12  | Sign-in second step unchanged                               | Add the give-back to `verifySecondStep`                                                                                | SF   | after one refused and one correct second step, `second_factor_attempts` is 2                                                                                                                           |
| 13  | Community Admin grant required                              | Accept any community role                                                                                              | CA   | `staff` in the community is not a Community Admin                                                                                                                                                      |
| 16  | Organisation roles do not count                             | Also accept `org_owner` / `org_admin` grants                                                                           | CA   | an `org_owner` with no community grant is not a Community Admin                                                                                                                                        |
| 17  | Custom permissions do not count                             | Accept a custom role holding `people.restricted.read`                                                                  | CA   | a custom role with every permission is not a Community Admin                                                                                                                                           |
| 19  | `readPersonForActor` refuses a minor (O4)                   | Restore the minor branch                                                                                               | RR   | a guardian with `view = true` gets `not_found` for their child                                                                                                                                         |
| 20  | Refusal holds for every role                                | Return the minor for `community_admin`                                                                                 | RR   | a Community Admin gets `not_found` from `readPersonForActor` for a minor                                                                                                                               |
| 21  | `readPerson` refuses a minor                                | Return the decrypted minor                                                                                             | PR   | `readPerson` of a minor answers `null`                                                                                                                                                                 |
| 22  | Minors list carries no fields                               | Restore the name decrypt in minors mode                                                                                | PR   | minors-mode rows have only `personId`, `label` and `householdId`                                                                                                                                       |
| 23  | Minors list skips deleted                                   | Drop `deleted_at is null`                                                                                              | PR   | a deleted minor is not in minors mode                                                                                                                                                                  |
| 24  | `listDeletedPersons` skips minors                           | Drop the `is_minor = false` condition                                                                                  | PR   | a deleted minor is not listed                                                                                                                                                                          |
| 25  | `openPersonFieldKeys` refuses a minor                       | Return the household keys                                                                                              | PR   | `openPersonFieldKeys` of a minor answers `null`, both with `actorUserId` set to a Community Admin and with `actorUserId: null`                                                                         |
| 26  | Activity refuses a minor                                    | Drop the minor check in `listPersonActivity`                                                                           | PR   | `listPersonActivity` of a minor answers `not_found`                                                                                                                                                    |
| 27  | Tags refuse a minor                                         | Drop the minor check in `listPersonTags`                                                                               | PR   | `listPersonTags` of a minor answers `not_found`                                                                                                                                                        |
| 28  | Tag writes refuse a minor                                   | Drop the minor check in `attachTag`                                                                                    | PR   | `attachTag` on a minor answers `not_found`                                                                                                                                                             |
| 28b | Tag removal refuses a minor                                 | Drop the minor check in `detachTag`                                                                                    | PR   | `detachTag` on a minor answers `not_found`                                                                                                                                                             |
| 29  | Linked contacts, presence                                   | Return `{ minor: true }` under `"presence"`                                                                            | PR   | a minor-linked user has a `null` contact under `"presence"`                                                                                                                                            |
| 30  | Household detail, presence                                  | Return `children` under `"presence"`                                                                                   | HD   | presence answers `{ childCount }` only                                                                                                                                                                 |
| 31  | Household detail, no fields for an admin                    | Decrypt a name under `"admin"`                                                                                         | HD   | admin answers `children` with `personId` and `label` only                                                                                                                                              |
| 32  | Child count excludes hidden and deleted                     | Count all minors                                                                                                       | HD   | a hidden child is not counted                                                                                                                                                                          |
| 33  | Labels per household by `created_at`, `id`                  | Order by `id` only                                                                                                     | HD   | two children inserted in SQL so that the earlier `created_at` has the larger id (ids carry a time prefix, `packages/db/src/ids.ts:3-11`) get `Child 1` for the earlier `created_at`                    |
| 34  | Guardian links to minors, presence                          | Include minor links under `"presence"`                                                                                 | HD   | an adult's guardian links omit children under `"presence"`                                                                                                                                             |
| 34b | Guardian links to minors, admin labels                      | Return the child's name under `"admin"`                                                                                | HD   | an adult's guardian links show the child as `Child n` under `"admin"`                                                                                                                                  |
| 34c | `readHousehold` presence                                    | Omit `childCount`                                                                                                      | HD   | `readHousehold` answers `childCount` and no child row under `"presence"`                                                                                                                               |
| 35  | Roster omits minors, presence                               | Return minor rows under `"presence"`                                                                                   | PR   | `readRosterNames` under `"presence"` has no minor row and reports `minorCount`                                                                                                                         |
| 36  | Roster never names a minor                                  | Decrypt a minor name under `"admin"`                                                                                   | PR   | `readRosterNames` under `"admin"` returns minors as `personId` and `label` only                                                                                                                        |
| 37  | Life events of a minor, ids only                            | Decrypt a minor's event                                                                                                | PR   | `listLifeEvents` of a minor returns `eventId` only                                                                                                                                                     |
| 37b | Life-event list of a minor needs an admin                   | Skip the minor check in the list route                                                                                 | LR   | a safeguarding officer gets 404 for a child's life events and no `eventId`                                                                                                                             |
| 38  | `openMinorField` opens one field                            | Return the whole record                                                                                                | MF   | opening `dateOfBirth` returns a string and nothing else                                                                                                                                                |
| 39  | `openMinorField` refuses an adult                           | Drop the `is_minor` check                                                                                              | MF   | opening a field of an adult answers `not_found`                                                                                                                                                        |
| 39b | `openMinorField` refuses a hidden child                     | Drop the `deleted_at is null` check                                                                                    | MF   | opening a field of a hidden child answers `not_found`                                                                                                                                                  |
| 40  | `openMinorField` life event belongs to the child            | Drop the `person_id` match                                                                                             | MF   | another child's life event answers `not_found`                                                                                                                                                         |
| 41  | Field opener import allow-list                              | Import `openMinorField` from a second file                                                                             | IS   | only `minor-view.ts` imports `openMinorField`                                                                                                                                                          |
| 42  | `"admin"` call sites                                        | Pass `"admin"` from an unlisted file, or from a listed function without the check                                      | IS   | only the listed files pass `childView: "admin"`, each from a `const` set from an `isCommunityAdmin(` call earlier in the same function body                                                            |
| 43  | Function sweep covers every export                          | Add an unclassified export                                                                                             | FS   | every export of people and groups `public/` is classified                                                                                                                                              |
| 44  | Function sweep finds a leak                                 | Return a minor's given name from `readHouseholdDetail` under `"presence"`                                              | FS   | no export returns a seeded minor's name, email, phone, DOB or `birthdayMd`                                                                                                                             |
| 44b | `visiblePersonIds` presence                                 | Drop the new minor filter                                                                                              | PR   | `visiblePersonIds` under `"presence"` has no minor id                                                                                                                                                  |
| 45  | Groups members, presence                                    | Return minor rows from `listMembers` under `"presence"`                                                                | GR   | `listMembers` under `"presence"` has no minor row or id                                                                                                                                                |
| 46  | `personIdsInGroup` presence                                 | Include minor ids                                                                                                      | GR   | `personIdsInGroup` under `"presence"` has no minor id                                                                                                                                                  |
| 47  | Export, presence                                            | Keep minors when not admin                                                                                             | GR   | `exportRosterCsv` under `"presence"` has no child row                                                                                                                                                  |
| 48  | Export, admin labels only                                   | Decrypt a minor name for an admin                                                                                      | GR   | `exportRosterCsv` under `"admin"` shows `Child n` and no name                                                                                                                                          |
| 49  | Minor membership writes need an admin                       | Skip the admin check in `addMember` for a minor                                                                        | GR   | `addMember` of a minor under `"presence"` is refused                                                                                                                                                   |
| 50  | Label check on rename                                       | Skip the call in `renameHousehold`                                                                                     | LB   | renaming to a label holding a child's given name is refused                                                                                                                                            |
| 51  | Label check on `addMinor`                                   | Skip the call in `createPerson`'s minor branch                                                                         | LB   | adding Tom to "Nguyen (Tom)" is refused                                                                                                                                                                |
| 52  | Label check on direct `createPerson`                        | Call it only from `addMinor`                                                                                           | LB   | a direct minor `createPerson` into "Nguyen (Tom)" is refused                                                                                                                                           |
| 53  | Given name only                                             | Also match `family_name`                                                                                               | LB   | "Nguyen family" is allowed when the child is Tom Nguyen                                                                                                                                                |
| 54  | Whole word                                                  | Match substrings                                                                                                       | LB   | "Tomlinson" is allowed when the child is Tom                                                                                                                                                           |
| 55  | Case and NFKC                                               | Compare raw strings                                                                                                    | LB   | "TOM" and a full-width "Ｔom" are refused                                                                                                                                                              |
| 56  | Each part of a multi-part given name                        | Match the whole given name only                                                                                        | LB   | "Mary Jane" refuses a label holding "Jane"                                                                                                                                                             |
| 57  | Shared adult name skipped                                   | Drop the adult skip                                                                                                    | LB   | "Tom and Mary Nguyen" is allowed when the father is Tom too                                                                                                                                            |
| 58  | Name held only by the child                                 | Skip every part any member holds                                                                                       | LB   | "Mia" is refused when only the child is Mia                                                                                                                                                            |
| 59  | One-letter parts not matched                                | Match single letters                                                                                                   | LB   | a child named "J" does not refuse "J and K Nguyen"                                                                                                                                                     |
| 60  | Refusal carries no value                                    | Put the matched name in the error                                                                                      | LB   | the error has only the code                                                                                                                                                                            |
| 61  | View: admin first                                           | Load the child before the role check                                                                                   | MV   | a non-admin gets `forbidden` for a missing id and for a child's id alike                                                                                                                               |
| 62  | View: role re-checked after consume                         | Skip the transaction B role check                                                                                      | MV   | a grant revoked after the consume answers `forbidden` and no value                                                                                                                                     |
| 64  | View: no consume on refusal                                 | Call `consumeFreshFactor` before `prepareMinorView`                                                                    | VR   | a refused View leaves the fresh check in place                                                                                                                                                         |
| 65  | View: audit per success                                     | Skip the audit append                                                                                                  | MV   | one `people.minor.field_viewed` row with the right purpose per View                                                                                                                                    |
| 66  | View: audit ids only                                        | Add the value to the audit row                                                                                         | MV   | the audit row holds only the person id (and the life event id)                                                                                                                                         |
| 67b | View: refusal audited                                       | Skip the denial audit on a 403                                                                                         | VR   | a non-admin's refused View writes one denial row with the person id and no value                                                                                                                       |
| 68  | View route: no-store                                        | Drop the header on a 403                                                                                               | VR   | every View answer, 200, 402, 403 and 404, carries `no-store`                                                                                                                                           |
| 69  | View route: recovery message                                | Map `recovery` to `fresh_required`                                                                                     | VR   | a backup-code session's first View answers `recovery_session`                                                                                                                                          |
| 70  | View route: fresh required                                  | Treat `not_fresh` as `consumed`                                                                                        | VR   | a session with no fresh check answers `fresh_required`                                                                                                                                                 |
| 71  | View route: entitlement                                     | Skip the `people.households` guard                                                                                     | VR   | a community without households answers 402                                                                                                                                                             |
| 72  | View route: body shape                                      | Accept a `field` outside the enum                                                                                      | CT   | `field: "notes"` on the person route is refused                                                                                                                                                        |
| 73  | Household read: presence for restricted holders             | Use `people.restricted.read` for `"admin"`                                                                             | HR   | a safeguarding officer gets `{ childCount }`                                                                                                                                                           |
| 74  | Add minor is admin only (O2)                                | Keep the old `manage` + `restricted` gate                                                                              | HR   | an `org_admin` without `community_admin` gets 403 from add-minor                                                                                                                                       |
| 75  | Minor guardian link is admin only                           | Skip the minor check in link                                                                                           | HR   | a non-admin linking a minor gets the same 404 as for a missing person                                                                                                                                  |
| 76  | Rename of a family with a child is admin only               | Skip the rule                                                                                                          | HR   | a non-admin rename of a family with a child answers 403 whatever the label                                                                                                                             |
| 77  | Minors list admin only                                      | Gate on `people.restricted.read`                                                                                       | PI   | a safeguarding officer gets 403 from `kind=minors`                                                                                                                                                     |
| 78  | Minor life-event writes admin only                          | Keep the old gate                                                                                                      | HR   | a non-admin creating a minor's life event gets 404                                                                                                                                                     |
| 79  | Route sweep covers every route                              | Add a route to a people route file and not the sweep                                                                   | SW   | every route in the people, household, life-event and access route files is in the sweep                                                                                                                |
| 80  | Route sweep finds a leak                                    | Return a minor's given name in the household read                                                                      | SW   | no non-admin response carries a seeded minor's name, id, life-event id, email, phone or DOB                                                                                                            |
| 81  | Users list flag, presence                                   | Return `minor: true` to `staff`                                                                                        | UL   | `staff` sees a minor-linked user with no linked contact                                                                                                                                                |
| 82  | Ops never imports people or groups                          | Import `@community-hub/people` in `ops-routes.ts`                                                                      | OP   | no ops file imports people or groups                                                                                                                                                                   |
| 82a | `platform` and `identity` hold nothing on the people tables | Manual (the reviewer, not `pinrun`): `grant select on app.persons to platform` in a scratch test database, then revoke | PV   | `has_table_privilege` is false for both roles on the four tables                                                                                                                                       |
| 83  | Panel extracted and shared                                  | Inline a copy in Family Records                                                                                        | AF   | Security and Family Records render the same `FreshCheck` component                                                                                                                                     |
| 84  | View hidden by default                                      | Render the value on load                                                                                               | AR   | no child value is in the DOM before View                                                                                                                                                               |
| 85  | One field at a time                                         | Keep the previous value                                                                                                | AR   | Viewing a second field hides the first                                                                                                                                                                 |
| 86  | Hidden after close                                          | Keep the value in state across close                                                                                   | AR   | closing and reopening the family shows the mask                                                                                                                                                        |
| 87  | No value in the query cache                                 | Cache the View answer                                                                                                  | AR   | the query cache holds no View answer                                                                                                                                                                   |
| 88  | `fresh_required` opens the panel                            | Show an error instead                                                                                                  | AR   | a `fresh_required` answer opens "Confirm it's you"                                                                                                                                                     |
| 89  | `recovery_session` shows the message                        | Open the panel                                                                                                         | AR   | a `recovery_session` answer shows the sign-in-again text and no panel                                                                                                                                  |
| 90  | Presence line for non-admins                                | Render child rows                                                                                                      | AR   | a non-admin sees "2 children in this family" and no `Child` label                                                                                                                                      |
| 91  | Rename hidden for a non-admin in a family with a child      | Render the control                                                                                                     | AR   | no rename control for a non-admin when the family has a child                                                                                                                                          |
| 92  | Label guidance on create and rename                         | Drop the text                                                                                                          | AR   | both forms show "Use the family name. Don't include a child's name."                                                                                                                                   |
| 93  | Minors tab admin only                                       | Gate on `people.restricted.read`                                                                                       | AC   | the Minors tab is hidden for a safeguarding officer                                                                                                                                                    |
| 94  | Minors tab needs households                                 | Drop the entitlement condition                                                                                         | AC   | the Minors tab is hidden without `people.households`                                                                                                                                                   |
| 95  | Users & Roles copy                                          | Old text                                                                                                               | AU   | the role description says "Can view children's details (a second-factor check for each field)"                                                                                                         |

## Tasks

### Task 1: `consumeFreshFactor` and the attempt give-back (O1)

**Files:** `modules/core/identity/infrastructure/second-factor.ts` (`consumeFreshFactor` beside `freshCheckTotp`; the give-back in `freshCheckTotp` at the success path near `:1011-1013` and in `verifyFreshPasskey` near `:1615`); `modules/core/identity/public/index.ts`; FC (new); SF.

- [ ] Write FC and the SF additions first: pins 1 to 9, 2b, 11 and 12, plus the floor test (attempts stay at 0 after a correct first check, with `now` advanced 30 seconds between TOTP checks).
- [ ] Test files to classify: `second-factor.integration.test.ts`, `second-factor-manage.integration.test.ts`, `apps/api/src/second-factor-routes.integration.test.ts` (any assertion on `second_factor_attempts` after a correct fresh check).
- [ ] The public `consumeFreshFactor({ sql, kms, keyArn, accessToken, now })` resolves the access token to a session id and user id, as `freshCheckTotp` does (`:971-980`). It takes `lockSecondFactor` for the user, then calls `consumeFreshFactorInTx`, which is exported for tests only and takes no lock.
- [ ] `consumeFreshFactorInTx(tx, { sessionId, now })` does not call `readActiveSessionInTx` and has no kind, revoked or window check in code. It runs one `update identity.sessions set fresh_factor_at = null where id = … and kind = 'tenant' and revoked_at is null and recovery_until is null and fresh_factor_at >= now - 5 min returning id`. When no row comes back, one `select recovery_until is not null … where id = …` decides `recovery` against `not_fresh`. So the update is the only guard for pins 4, 5 and 6, and recovery is answered first in effect (pin 3).
- [ ] The give-back: `second_factor_attempts = greatest(second_factor_attempts - 1, 0)` in the same transaction as the success.
- [ ] Gate.

**Must not break:** the sign-in second step; operator sessions; ADR 0022 points other than 2.

### Task 2: `isCommunityAdmin` and `readPersonForActor` without minors (O4)

**Files:** `modules/core/access/infrastructure/community-admin.ts` (new); `modules/core/access/public/index.ts`; `modules/core/access/infrastructure/restricted-read.ts` (`:78-105`); CA (new); RR; `packages/policy/src/decide.ts` (comment only, P7).

- [ ] CA first: pins 13, 16 and 17, plus the tests-only rows (two organisations, two communities, a deleted grant, every role key).
- [ ] RR changes first: pins 19 and 20, with flips `:157` and `:232`.
- [ ] `isCommunityAdmin(tx, userId)` takes no community argument. It reads `app.community_role_grants` for that user with `role_key = 'community_admin'`, and RLS limits it to the scoped organisation and community.
- [ ] `readPersonForActor`: a minor answers `not_found` for every actor, and the refusal is audited as a denial, as today. Add the P7 comment in `decide.ts`.
- [ ] Test files to classify: `restricted-read.integration.test.ts`, `apps/api/src/people-delete-routes.integration.test.ts` (`:1085` calls `/v1/people/read`), and any `/v1/people/read` minor case in `people-routes.integration.test.ts`.
- [ ] Gate.

**Must not break:** the adult branch of `readPersonForActor`, `hasGuardianView`, and the access route tests.

### Task 3: People readers carry no minor fields, with their routes

**Files:** `modules/core/people/infrastructure/person.ts` (`readPerson`), `list-persons.ts` (minors mode, which stops calling `readRosterNames` for minors; `listDeletedPersons`), `person-keys.ts` (`openPersonFieldKeys`), `activity.ts`, `tags.ts`, `linked-contacts.ts`, `life-event.ts` (list), `child-labels.ts` (new, P2); `modules/core/people/public/index.ts`; PR (new).

Callers changed in the same task: `apps/api/src/people-routes.ts` (the minors list is Community Admin only, and a minor read is 404, `:292-313,405-436`); `life-event-routes.ts` (the minor list, `:189-214`); `access-routes.ts:586` (the users list passes `childView`). Contracts for those answers go in `packages/contracts` (the implementer confirms the file), with OpenAPI regenerated.

Flips: `list-persons.integration.test.ts:691`, `people-routes.test.ts:581`, the minors cases in `people-routes.integration.test.ts`, `life-event-routes.integration.test.ts:736`, `users-list.integration.test.ts:644,780`, `access-routes.test.ts:1226`.

`summarisePersons` already skips minors (`person-summary.ts:40`). It is pinned by the function sweep in Task 4 and not changed.

- [ ] PR first: pins 21 to 29, 28b, 37 and 37b, 77 and 81 (both moved here), plus the minor-read route test. Start IS (pin 42) with Task 3's `"admin"` call sites: the minors list in `people-routes.ts`, the users list in `access-routes.ts:586`, and the life-event list.
- [ ] The life-event list route (`life-event-routes.ts:189-214`) checks whether the person is a minor. If so, a caller who is not a Community Admin (by `isCommunityAdmin`) gets the same 404 as for a missing person, before `listLifeEvents` runs.
- [ ] Test files to classify (callers of `readPerson`, `listPersons`, `readLinkedContacts`, `listLifeEvents`, `openPersonFieldKeys`, `listPersonActivity`, `listPersonTags`, or tests asserting their old minor behaviour):
  - `person.integration.test.ts:1057-1090`;
  - `person-keys.integration.test.ts:79`;
  - `life-event.integration.test.ts:95,231`;
  - `linked-contacts.integration.test.ts`, `linked-contacts.test.ts`;
  - `hidden-reads.integration.test.ts`, `hidden-writes.integration.test.ts`;
  - `update-person.integration.test.ts`, `list-persons.integration.test.ts`;
  - `apps/api/src/people-routes.integration.test.ts`, `people-routes.test.ts`, `life-event-routes.integration.test.ts`, `users-list.integration.test.ts`, `access-routes.test.ts`.

  Before writing code, the implementer runs `grep -il minor` across the people module's and `apps/api`'s tests and pastes the result into the report. Any further file found is classified too.

- [ ] `childView: "admin" | "presence"` replaces `includeRestricted` wherever it governed minors, in the functions this task changes. It is required, with no default. Adults keep `includeRestricted` for their restricted fields. Every caller in the repository is updated in this task, so the gate is green.
- [ ] Minor rows, where a reader returns them at all, are `{ personId, label, householdId }` from `childLabels`.
- [ ] Gate.

**Must not break:** every adult path (the existing adult tests stay green unchanged), §1 rule 3.

### Task 4: Household detail, `openMinorField`, and the function sweep

**Files:** `modules/core/people/infrastructure/household.ts` (`readHouseholdDetail` `:484-531,576-617`, `readHousehold`); `minor-field.ts` (new, `openMinorField(tx, { personId, field } | { personId, lifeEventId, field })`); `modules/core/people/public/index.ts`; HD; MF (new); FS (new); IS (new, with its call-site list for pin 42).

Callers changed in the same task: `apps/api/src/household-routes.ts:394`, where the read passes `childView` from `isCommunityAdmin`. The household list (`:338`, `listHouseholds`) keeps `includeRestricted` for the adult label and is unchanged. The household read contract (`minors` becomes `{ childCount, children? }`) moves here from Task 7, with OpenAPI regenerated.

Flips: `household-detail.integration.test.ts:129`, `household-routes.integration.test.ts:618`, `household-routes.test.ts:540`.

- [ ] HD, MF, FS and IS first: pins 30 to 34c, 38 to 39b, 40, 41 to 44, and 73 (moved here). IS gains Task 4's `"admin"` call sites.
- [ ] Test files to classify (callers of `readHouseholdDetail` and `readHousehold`, or tests asserting their old minor behaviour): `household-detail.integration.test.ts`, `household.integration.test.ts`, `emergency-contacts.integration.test.ts`, `hidden-family-reads.integration.test.ts`, `hidden-reads.integration.test.ts`, `household-members.integration.test.ts`, `apps/api/src/household-routes.integration.test.ts`, `household-routes.test.ts`, `family-routes.integration.test.ts`.
- [ ] FS's export list excludes the type-only and constant exports (`PeopleError` and similar), each named with its reason.
- [ ] `openMinorField` opens one field under the household key and returns it alone. A missing name part is `null`; there is no throw like `person.ts:400-402`. It refuses an adult, a deleted or hidden child, and a life event of another person.
- [ ] FS seeds two organisations and two communities, each with a household holding two minors (unusual synthetic names) and an adult. It calls every export of people and groups `public/` that takes an actor or `childView`, with `"presence"` and with `"admin"`. It fails on a seeded minor value in any answer. It also keeps a list of every export with its class (spec Scope 1), and fails on an export not in the list.
- [ ] Gate.

**Checkpoint 1 follows this task.**

**Must not break:** adult household detail; emergency contacts; the household key purge (`purgeDeletedHouseholds`).

### Task 5: Groups

**Files:** `modules/core/people/infrastructure/roster-names.ts` (`readRosterNames`, `visiblePersonIds`, moved here from Task 3 with its callers); `modules/features/groups/infrastructure/members.ts` (`listMembers`, `addMember`, `removeMember`, `setMemberRole`, `personIdsInGroup`, `activeGroupsForPersons`), `export.ts`; `modules/features/groups/public/index.ts`; any `apps/api` caller (`people-routes.ts:354` `personIdsInGroup` and `:375` `activeGroupsForPersons`, which pass `"presence"`, since that list is adults only); GR (new); PR additions; flips `roster-names.integration.test.ts:232`, `members.integration.test.ts:734`, `export.integration.test.ts:149,611`; FS extended to the new groups signatures.

- [ ] GR and the PR additions first: pins 35, 36, 44b and 45 to 49.
- [ ] Test files to classify: `roster-names.integration.test.ts`, `members.integration.test.ts`, `export.integration.test.ts`, `hidden-reads.integration.test.ts`, and the groups module's other tests found by `grep -il minor`.
- [ ] Each takes `childView`. Under `"presence"`, minor rows and ids are omitted, with `minorCount` where members are counted. Under `"admin"`, a minor is a label (`childLabels`). Minor membership writes under `"presence"` are refused with the module's not-found error.
- [ ] Gate.

**Must not break:** adult membership, `groupLeaderFact`, and the `/v1/people/list` `groupId` filter and group column.

### Task 6: The label check (O3)

**Files:** `modules/core/people/infrastructure/label-check.ts` (new, P4); `household.ts` (`renameHousehold`); `person.ts` (`createPerson` minor branch, `:178-243`); LB (new). `addMinor` is unchanged (P4).

- [ ] LB first: pins 50 to 60.
- [ ] Normalise with `normalize("NFKC")` then `toLocaleLowerCase("und")`. Split on Unicode whitespace and hyphens, and keep parts of two or more letters. A part matches as a whole word when it is bounded by a non-letter or the string edge (`\p{L}` with the `u` flag). Skip a part equal to any adult member's given-name part.
- [ ] Gate.

**Must not break:** `createHousehold` (no check); adult creation; the family name of the child never checked.

### Task 7: Write gates, the View contracts, and isolation tests

**Files:** `packages/contracts` (the View bodies and answers, and `label_contains_child_name`); CT; OpenAPI regenerated. In `apps/api/src/`:

- `household-routes.ts`: add-minor, link, unlink and rename follow the spec's rules (Scope 6 and Scope 8, the order in Scope 6);
- `life-event-routes.ts`: minor writes are Community Admin only.

Tests: HR, `household-routes.test.ts` (flips `:1023,1094,1180`), OP (new) and PV (pin 82a).

- [ ] Tests first: pins 72, 74 to 76, 78, 82 and 82a.
- [ ] Test files to classify: `family-routes.integration.test.ts` (`:698-760`, the permission tests for add-minor and link), `household-members.integration.test.ts`, `life-event-routes.integration.test.ts` (writes on a minor).
- [ ] Gate.

**Must not break:** every adult answer; the 402, 401 and 403 empty bodies; OpenAPI regenerated and committed.

### Task 8: The View service, the routes, the audit action, and the route sweep

**Files:**

- `modules/core/access/infrastructure/minor-view.ts` (new, P3), and `modules/core/access/public/index.ts`;
- the audit action and purposes registered where `people.person.read` is (`modules/core/access/public/index.ts:39` and the people manifest);
- `apps/api/src/minor-view-routes.ts` (new), mounted where people routes are mounted, and the deps wiring for `consumeFreshFactor` (the route calls it between `prepareMinorView` and `finishMinorView`, P3);
- MV, VR and SW (all new);
- a log-scan assertion in SW: the captured logger output of the whole sweep holds no seeded name.

- [ ] Tests first: pins 61, 62, 64 to 66, 67b, 68 to 71, 79 and 80, plus the tests-only row (a child of another community answers `not_found`).
- [ ] SW calls every route the non-admin roles can reach in `people-routes.ts`, `household-routes.ts`, `life-event-routes.ts`, `access-routes.ts` and `minor-view-routes.ts`, and the Community Admin's list and read routes. It reads the route list from the route files (method plus path, parsed or registered) and fails on a route not in its table.
- [ ] Gate.

**Checkpoint 2 follows this task.**

**Must not break:** existing route behaviour outside the spec; the second-factor routes.

### Task 9: Admin

**Files:** `apps/admin/src/fresh-check.tsx` (new, extracted from `security.tsx:241,822,828`); `security.tsx`; `family-records.tsx` (the minors section `:317-460`, the rename and create forms, and the guidance); `all-contacts.tsx` (the Minors tab `:1523,1572`); `life-events.tsx`; `role-labels.ts` (if Users & Roles has no role-description component, the copy goes as a hint under the role choice in the grant form, `people-access.tsx`); `api.ts`; AF (new), AR, AC, AU, `security.test.tsx`, `life-events.test.tsx`; flips `family-records.test.tsx:1415,1453,1689,1763,2615,2639,2839` and `all-contacts.test.tsx:916,934`.

- [ ] Tests first: pins 83 to 95, plus axe on each changed screen.
- [ ] The View value lives only in the component's state for that one field. The View request is a mutation with no cache entry, never a query.
- [ ] Gate.

**Checkpoint 3 (the browser check) follows this task.**

**Must not break:** Security's own fresh check; the adult screens; WCAG 2.2 AA.

### Task 10: Documents and roadmap

**Files:**

- `docs/adr/0017-childrens-data-access.md`: status notes on points 2 (O2), 3 (O4) and 7 (O3), and an implemented note;
- `docs/adr/0022-second-factor-for-staff.md`: a status note on point 2 (O1);
- `architecture.md`: §11.3, §12.3 and §12.4, the module rows `:563-564`, and `:693`, `:802` and `:805`;
- `docs/roadmap.md`:
  - `Children's data access` done, with the snapshot (last shipped, next chunk `Staff 2FA recovery`);
  - the `people.restricted.read` text at `:167,179`;
  - the member-portal row gaining guardian self-entry and guardian read;
  - the Laravel import row gaining the label check;
  - open items: a View on the staging hostname at the next unpark; org owners need `community_admin`; nickname labels as a residual; the guardian narrowing; and the existing group-name guidance;
- `AGENTS.md`: the repository-state line;
- `docs/specs/2026-11-28-childrens-data-access.md`: a status note on Scope 1 and Scope 4 for the P4b deviations (a note only; the approved text stays).

- [ ] Prettier and the docs checks in the gate. No test.
- [ ] `rm -f docs/plans/*-report.md`, and `git status --short` shows no scratch.

**Must not break:** ADR 0017's other points; nothing in §1.

## Owner decisions

- Next chunk after this one: `Staff 2FA recovery` (the next not-started row that is gated before client import).
- Implementer: Antigravity Gemini 4 Hydrogen xhigh, with Claude Sonnet 5.5 as fallback. Reviewer agent: Claude Opus 5.5. Owner's checks and the second review: Claude Haiku 5.5 or Fable.
- Deviations (extra attempts, a fallback model, a fix commit between tasks) are recorded as amendments in this plan and in the pull request.
- Staging stays parked. There is no apply.

## Rollback

Revert the merge. Nothing in the database changed, so there is nothing to undo there. Sessions whose `fresh_factor_at` was cleared by a View simply need a new fresh check under the old code.
