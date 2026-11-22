# Spec: Contact delete

Slug: contact-delete
Status: approved (2026-11-22, Adnan Bin Hossen)
Architecture refs: §6.3, §12.1, §12.2.1, §12.3, §12.4; ADR 0004, ADR 0017, new ADR 0020; AGENTS.md §1 rules 2, 3, 4, 5; §2; §3; §6; §7; §8; §12; §13. Phase 2 row `Contact delete`. Behaviour: the owner's answer of 2026-11-20 (checked in the Laravel code) and his message on the merge of PR #91 (2026-11-22).

**Sensitive chunk** (tenancy, children's data through guardian links, a database migration with a grant change and the repository's first `SECURITY DEFINER` function, permanent deletion of personal data). It needs a second fresh-context review on a model that differs from every implementer model used in this chunk and from the reviewer agent's (AGENTS.md §2).

Revision 2 (2026-11-22) applies the fresh-context spec check (Claude Sonnet, READY WITH CHANGES, 3 High, 8 Medium, 7 Low).

**AGENTS.md §3 deviation, stated here and in the PR.** The chunk touches three modules: `core/people` (contacts, guardian links, history, life events, the purge function), `features/groups` (memberships point at contacts) and `core/access` (the permission, user link and invitation checks). §3 says to split above two modules. The hide-and-restore half alone touches all three; the purge half is people plus `apps/api`. Hide without purge would ship a delete that never deletes, against the owner's 30-day rule, and both halves share one migration wave and one test fixture. The chunk owner chose one chunk (2026-11-22).

## Problem

In Laravel, staff can delete a contact. Core cannot remove a contact at all: every foreign key to `app.persons` is `ON DELETE RESTRICT`, and the `app` role has no `DELETE` on `app.persons`, `app.person_activity`, `app.life_events` or `app.households` (`0005_people_households.sql:191-197`, `0017_adorable_anthem.sql:19`). A parish cannot remove a duplicate, a contact entered by mistake, or a person who asks to be removed. The owner decided (2026-11-20, 2026-11-22): a delete first hides the contact; staff with the delete permission can restore it for 30 days; after that it is deleted permanently with its group memberships and history, with family and life-event references cleaned up, and audit rows keep ids only.

## Scope

In:

- New permission `people.delete`, held by `org_owner`, `org_admin` and `community_admin` through `CATALOGUE` (`packages/policy/src/decide.ts:1-30`) and grantable to custom roles. Touch points: `access/domain/role.ts` `CATALOGUE_PERMISSIONS`, `access/db/schema.ts:176` CHECK, `packages/contracts/src/access.ts:117` and `:141` (capabilities response), `apps/admin/src/people-access.tsx:16-69`, the people `module.manifest.ts`, and their tests (`decide.test.ts`, `role.test.ts`, `access/db/schema.test.ts`, `contracts/access.test.ts`, `access-routes.test.ts`).
- `POST /v1/people/delete` hides an adult contact; `POST /v1/people/restore` brings it back.
- A hidden contact is left out of every read and refused by every write listed under Behaviour.
- All Contacts gains a `Deleted` filter for `people.delete` holders, with the permanent-delete date and a Restore button.
- A purge sweep that permanently deletes contacts of the current community hidden for 720 hours (30 days) or more, through one `SECURITY DEFINER` function, at most 50 per run.
- ADR 0020 recording the purge design.

Out:

- Deleting a child (a minor). Children have no row on All Contacts; deleting, moving and editing a child belong to `Family Records parity`. The API refuses a minor, and the database refuses `deleted_at` on a minor.
- Deleting a family (`Family Records parity`). A family whose last adult is purged stays, with its key, showing 0 adults as Family Records already does.
- A regional scheduler. Until it exists, a community with no contact activity keeps a hidden contact past 30 days (Risks, ADR 0020).
- Privacy requests (`core/privacy`, §12.4): access, export, legal holds.
- Bulk delete.
- Deleting life events on their own (`Life events: Laravel parity`).
- Delete and restore entries in the contact's History: `person_activity.kind` allows `created, tagged, untagged, guardian_linked, guardian_unlinked` only (`people/db/schema.ts:375-378`); the audit log is the record.

## Behaviour

### Response shape

The new refusals answer 409 with a JSON body `{ "code": "<code>" }` in the `jsonError` style of `apps/api/src/invitation-routes.ts:132-156`: `linked_user`, `pending_invitation`, `sole_guardian`, `duplicate_deleted`. Existing answers stay status-only with an empty body: 404 not found, 409 version conflict, 400 bad body, 403 denied. The new codes are added to the closed `PeopleErrorCode` union (`modules/core/people/domain/error.ts:3-24`) and mapped in both `statusForPeople` (`people-routes.ts:57-90`) and `statusForHouseholds` (`household-routes.ts:60-90`); an unmapped code would be rethrown and answer 500. The response schemas go in `packages/contracts/src/people.ts`.

### Delete (`POST /v1/people/delete`)

Body `{ personId, version }`. Needs `people.view` and `people.delete`, and the `people.directory` entitlement. Route marked `billing: "write"`.

- Without either permission: 403 and a `people.permission.denied` audit event, as the existing routes do.
- The person row is read `FOR UPDATE` (as `moveAdult` does, `household-members.ts:89-95`). It must be an adult in the current community with `deleted_at` null, else 404 (the same answer for a minor, a hidden contact, an unknown id and another tenant's id).
- `version` must match, else 409.
- Inside the same transaction, after the lock: 409 `linked_user` when a row in `app.user_links` points at the contact; 409 `pending_invitation` when an invitation has `status = 'pending' and expires_at > now()` for it; 409 `sole_guardian` when the contact is a guardian of a minor who has no other guardian with `deleted_at` null.
- On success: `deleted_at = now()`, `deleted_by` = the actor user id, `version` bumped, audit event `people.person.deleted` with `targetIds: [personId]`. Response `{ personId, version, purgeAfter }`, where `purgeAfter` is computed in SQL as `deleted_at + interval '720 hours'`.

### Restore (`POST /v1/people/restore`)

Body `{ personId, version }`. Needs `people.view` and `people.delete`, and `people.directory`. Route marked `billing: "write"`.

- Row read `FOR UPDATE`; it must be a hidden adult in the current community, else 404 (also when the sweep has already purged it).
- `version` must match, else 409.
- Clears `deleted_at` and `deleted_by`, bumps `version`, writes `people.person.restored` with `targetIds: [personId]`. The contact comes back with its status, source, groups, family, guardian links, tags, history and life events.

### What "hidden" means: reads

A contact with `deleted_at` set is left out of the following, each with a must-fail test that has a hidden contact in the fixture:

- the adult and minor lists (`list-persons.ts:289`, `:402`) and every filter on them, except `status: "deleted"`;
- the summary counts (`person-summary.ts:37`); there is no Deleted count;
- `readPerson` (`person.ts:361`) and `readPersonForActor` (`access/infrastructure/restricted-read.ts:26-40`): 404, with the same `access.permission.denied` audit event an unknown id writes today, so a hidden contact is indistinguishable from a missing one;
- family list counts and family detail (`household-list.ts:102-108`, `household.ts:453`, `:480`, `:564`), including the guardian-links query (`household.ts` about `:485-520`): a link whose guardian or child is hidden is not returned;
- linked contacts (`linked-contacts.ts:58`) and roster names (`roster-names.ts:67`);
- life-event lists and the update join (`life-event.ts:146-178`, `:266`, `:406`);
- group members, filtered in `listMembers` itself, not only through roster names (`groups/infrastructure/members.ts:278-335`); `personIdsInGroup` and `activeGroupsForPersons` (`:364`, `:386`); and the roster CSV export (`groups/infrastructure/export.ts:44-107`);
- `listPersonActivity` (`activity.ts:31-53`), `listPersonTags` (`tags.ts` about `:125-145`), `personExists` and `openPersonFieldKeys` (`person-keys.ts:123-151`): not found or null.

### What "hidden" means: writes

A write that names a hidden contact answers 404 as if it did not exist, each with a test: update, status, add to a family or move (`household-members.ts`), link or unlink a guardian (`guardian.ts:72`, `:176`), attach or detach a tag (`tags.ts:67`, `:105`), create or update a life event (`life-event.ts`), add, remove or set the role of a group member (`groups/infrastructure/members.ts:108-114`, `:161`, `:212`).

Access goes through one choke point: `personIsMinor` (`people/infrastructure/access-facts.ts:3-26`) adds `deleted_at is null`, so it returns null for a hidden contact, and its five callers treat it as not found: `writeUserLink` and `assertGrantSubjectAdult` (`access/infrastructure/grants.ts:249`, `:455`), `createInvitation` (`invitations.ts:197`) and the accept path (`invitations.ts:779`, `:807`). `createInvitation` now passes `{ lock: "share" }`, like `writeUserLink`, so it waits for a concurrent delete. Groups `addMember` reads the contact through the same people public function with `{ lock: "share" }`.

### Duplicate email or phone held by a hidden contact

The blind-index unique indexes stay as they are (`people/db/schema.ts:184-195`), so a hidden contact keeps its email and phone. When create (`person.ts:84-104`, `:288`), update (`update-person.ts:63`) or Family Records add-adult (`household-members.ts:255`) hits `duplicate_email` or `duplicate_phone`, the code looks the holder up after the rollback to the savepoint, with `where email_bidx = $1 and deleted_at is not null` (or phone) in the same scope. If the holder is hidden it answers 409 `duplicate_deleted`; email is checked first, as `duplicateError` does. The screen says "A deleted contact has this email (or phone). Restore it from the Deleted filter." to `people.delete` holders, and "A deleted contact has this email (or phone)." to others.

### Deleted filter (`POST /v1/people/list`, `status: "deleted"`)

- Needs `people.view` and `people.delete`; without `people.delete` the value is refused with 400.
- `deleted` is a filter value, not a stored status (`persons_status_check` stays `active`, `inactive`). It accepts `search` (name prefix only) and refuses `source` and `groupId` with 400.
- A separate query path from the adult list: hidden adults only, sorted `deleted_at desc, id`, with its own cursor. It returns name, `deletedAt`, `purgeAfter` and `version`, and does not decrypt or return email, phone or date of birth.
- One audit event per page, `people.person.listed_deleted`, ids only.

### Purge sweep

- `app.purge_deleted_persons(p_limit integer) returns setof uuid`, `SECURITY DEFINER`, owned by the migrator, `SET search_path = pg_catalog, app`, schema-qualified names, `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO app`, following `0016_smooth_forgotten_one.sql:4-20`.
- It raises when `app.org_id` or `app.community_id` is unset or empty, and when `p_limit` is null or outside 1 to 50.
- It selects at most `p_limit` persons of that org and community with `is_minor = false` and `deleted_at <= now() - interval '720 hours'` (database clock; the caller passes no time), oldest first, `FOR UPDATE SKIP LOCKED`, skipping a person with a row in `app.user_links`, a live pending invitation (`status = 'pending' and expires_at > now()`), or a minor for whom they are the only guardian not hidden.
- For those ids, in this order: delete `app.group_members`; delete `app.guardian_links` on either side; delete `app.person_tag_links`; delete `app.person_activity`; delete `app.life_events`; set `status = 'void', person_id = null, closed_at = now()` on their expired pending invitations (as `custom-roles.ts:155-165` does); set `person_id = null` on their accepted, revoked and void invitations; delete the `app.persons` rows last. It returns the purged ids. These cover all eight foreign keys to `app.persons` (`user_links` by skipping).
- The tables are owned by the migrator, which has no `BYPASSRLS`, and all have `FORCE ROW LEVEL SECURITY`, so the function is tenant-scoped twice: by its own predicates and by the `community_isolation` policies.
- `app.audit_events` rows are append-only and stay; they hold ids, purposes and actor ids only (`audit-events.ts:21-45`). A run that purges at least one contact writes one `people.person.purged` event in the same transaction as the function call, actor `system` with a null actor id, `targetIds` the purged ids.
- When it runs: only after list, delete or restore answered 200 to a caller who passed the permission check, and only when the community is writable (the check `guardWrite` uses, `billing-guard.ts:25-31`; a read-only community is not swept). It runs in its own `withAppTransaction` after the route's transaction commits, and the response waits for it. A failure is logged by error class only and does not change the answer.

### Screen (`apps/admin/src/all-contacts.tsx`)

- A Delete row action, rendered only for `people.delete` holders (AGENTS.md §6), opens a confirm dialog: "Delete <name>? They are hidden now and deleted permanently on <date>. Staff with the delete permission can restore them until then."
- Refusals in the dialog: `linked_user` "This contact is linked to a user account. Remove the user first."; `pending_invitation` "This contact has a pending invitation. Cancel it first."; `sole_guardian` "This contact is the only guardian of a child. Add another guardian in Family Records first."; 409 without a body "This contact was changed. Reload and try again."
- The status filter gains `Deleted` for `people.delete` holders. Deleted rows show the name, "Deleted <date>, deleted permanently on <date>" and a Restore button; no Active switch, no View.
- Restore or a row action on a contact the sweep has purged: 404, the message "This contact was deleted permanently.", and the list reloads.
- Empty state for the Deleted filter: "No deleted contacts."
- Contact Details of a hidden contact is not reachable; a deep link answers as for an unknown contact.
- WCAG 2.2 AA: the dialog traps focus and returns it to the row; axe shows no violations at 1280 and 375, light and dark.

## Data

Migration `0022`, expand only, one wave:

| Column               | Type               | Class    | Notes                                  |
| -------------------- | ------------------ | -------- | -------------------------------------- |
| `persons.deleted_at` | `timestamptz null` | internal | clear: filtered and compared (§12.2.1) |
| `persons.deleted_by` | `uuid null`        | internal | clear: the acting user's id            |

- Index `persons_deleted_idx` on `(org_id, community_id, deleted_at) where deleted_at is not null`.
- `GRANT UPDATE (deleted_at, deleted_by) ON app.persons TO app`. No new `DELETE` grant to `app` (it keeps the `DELETE` it already has on `guardian_links`, `person_tag_links`, `group_members` and `invitations`). The privileges integration test's updatable-column list (`privileges.integration.test.ts` about `:149-170`) goes from thirteen to fifteen, and it pins no `DELETE` on `persons`, `person_activity`, `life_events`, `households`.
- `app.persons_before_update()` (`0016_smooth_forgotten_one.sql:4-24`) gains: `deleted_at` may change only from null to `now()` with `deleted_by` not null, or from non-null to null with `deleted_by` null; and `deleted_at` may not be set on a row with `is_minor = true`. Any other change raises. So the `app` role cannot back-date a hide to make a contact due for purge.
- `app.purge_deleted_persons` as above. Its owner, the migrator, owns the tables it touches (ADR 0004).
- The `custom_role_permissions_permission` CHECK is dropped and re-added with eleven keys: the ten of `0018_wise_starfox.sql:11` plus `people.delete`.
- No data changes, so no backfill. (A later migration that changes real data runs as a job, AGENTS.md §7.)
- The two columns go in the people `module.manifest.ts` `dataClasses`, and `people.delete` in its `permissions`, with the `manifest.test.ts` pins, in the migration task.
- No new table, key, encrypted column or event.

Recovery: the columns are new. Reverting the code leaves them unused and every hidden contact appears again in lists; to keep them hidden, do not revert, or clear them on purpose per community. `DROP FUNCTION app.purge_deleted_persons`, restoring the previous `persons_before_update` body, and `REVOKE UPDATE (deleted_at, deleted_by)` undo the database changes. Before re-adding the ten-key CHECK, delete `custom_role_permissions` rows with `people.delete`. A purged contact cannot be recovered except from backup.

## Rules touched

- Permissions: new `people.delete`, always together with `people.view` (delete, restore, the Deleted filter, the restore hint on a duplicate).
- Entitlements: `people.directory` on both new routes.
- Billing: delete and restore are writes; the sweep does not run in a read-only community.
- Audit: `people.person.deleted`, `people.person.restored`, `people.person.listed_deleted`, `people.person.purged`, registered with `defineAuditAction` and `defineAuditPurpose` in `modules/core/people/public/index.ts`, ids only, passing the event-names check.
- Usage facts: none.
- Retention: hide for 720 hours, then purge at the next swept contact action. After the purge the rows are gone from the live database and remain in backups until backup retention ends. One exception: `identity.invitation_emails` can hold the address of a closed or expired contact invitation until the existing invitation sweep erases it (`identity/infrastructure/invitation-email.ts:218-255`); the `app` role cannot reach that schema. Accepted.
- Children (§1 rule 4, ADR 0017): a minor is refused by delete and restore, by the trigger, and by the function's predicate, and never appears in the Deleted filter. A contact who is a child's only guardian cannot be deleted, so the purge never leaves a child without a guardian. When the contact is one of several guardians, the link is hidden with the contact and deleted at purge.
- Tenancy: every new query and the function run under per-transaction `set_config(..., true)` scope and FORCE RLS.
- Residency: no new outbound call.
- No personal data in URLs, logs or audit payloads.

## Contracts

- `packages/contracts/src/people.ts`: `personDeleteBody` and response, `personRestoreBody` and response, list `status` gains `deleted` with the refused combinations, the deleted list item and its cursor, the error body `{ code }` with `linked_user`, `pending_invitation`, `sole_guardian`, `duplicate_deleted`.
- `packages/contracts/src/access.ts`: `people.delete` in the capabilities response.
- Routes: `POST /v1/people/delete`, `POST /v1/people/restore`.
- People `public/`: `personIsMinor` (now hidden-aware, already public), and `purgeDeletedPersons(tx, limit)` wrapping the function and writing the purged audit event.
- `apps/api` composes the sweep; people does not import groups.
- No new event, island, block or collection.

## Risks

- **Permanent loss by mistake.** Mitigation: no `DELETE` grant on `persons`; the trigger stops a back-dated or minor `deleted_at`; the function compares with the database clock; tests that it leaves a visible contact, one hidden 719 hours and a minor, and purges one hidden 721 hours (rows aged with the migrator in the test, not through `app`).
- **Cross-tenant purge through the definer function.** Mitigation: its own predicates plus FORCE RLS; a test with two organisations and two communities of one organisation, each with a contact hidden 721 hours, where one call purges only the scoped community; tests that it raises with no scope, an empty scope, and `p_limit` 0, 51 and null.
- **Search-path hijack.** Mitigation: `SET search_path`, qualified names, `REVOKE ... FROM PUBLIC`; a test that `PUBLIC` has no `EXECUTE`.
- **A hidden contact leaking into a read, or re-attached by a write.** Mitigation: the per-path tests above.
- **Race between delete and a new invitation, user link or group member.** Mitigation: delete locks the person `FOR UPDATE` and re-checks inside; the writers take `FOR SHARE`; two-transaction tests for delete against create-invitation and against user-link, ordered by locks, not by timing.
- **A child left without a guardian.** Mitigation: `sole_guardian` refusal and the function's skip; a test where the other guardian is hidden first.
- **Purge blocked by a new foreign key.** Any later table pointing at persons would make the function raise. Mitigation: the sweep's own transaction keeps lists working; a test that reads every foreign key to `app.persons` from the catalog and fails on one the function does not handle.
- **Sweep latency or lock contention.** Mitigation: 50 rows, `SKIP LOCKED`; a test that a 50-id run writes one purged event with all ids.
- **Idle community.** A community with no list, delete or restore keeps hidden contacts past 30 days. Mitigation: ADR 0020 and a roadmap open item for the scheduler chunk.

## Architecture

- New ADR 0020 "Contact deletion through a definer purge function": context, decision, consequences (including the idle-community gap until the scheduler), alternatives rejected (`DELETE` grants to `app`, `ON DELETE CASCADE` foreign keys, waiting for the scheduler).
- §12.1: `app` gains `UPDATE (deleted_at, deleted_by)` on `app.persons` (fifteen columns) and `EXECUTE` on `app.purge_deleted_persons`, the first `SECURITY DEFINER` function, which is the only way a contact is deleted.
- §12.4: the contact retention rule (hide 720 hours, then purge on contact activity until the scheduler exists).
- The people routes line: `delete` and `restore`, and the list's `deleted` filter.

## Roadmap

The last commit updates `docs/roadmap.md`: `Contact delete` done; the open item for the scheduler sweep of hidden contacts; snapshot (last shipped `contact-delete`, next chunk as the chunk owner decides); `AGENTS.md` Repository state.

## Out-of-band

- No legal sign-off, no new vendor, no new AWS resource, no cost.
- ADR 0020 signed off by the project owner (2026-11-22), committed with this spec.
- Verified by tests and a local browser check, not on the staging hostname (staging stays parked).

## Owner items (Abdus, AGENTS.md §12: all three approved 2026-11-22)

1. ADR 0020: the first `SECURITY DEFINER` function, the `app` role erasing contacts only through it, and permanent deletion triggered by contact activity until the scheduler exists, so an idle community keeps a hidden contact past 30 days. Approved; ADR 0020 accepted.
2. Children: a contact who is a child's only guardian cannot be deleted until another guardian is added; deleting a child is deferred to `Family Records parity`. Approved.
3. Laravel difference: delete is refused for a contact linked to a user account, with a live pending invitation, or who is a child's only guardian. Approved: keep all three refusals.

## Chunk owner decisions (Adnan, 2026-11-22: all ten as recommended)

1. One chunk, with the §3 deviation stated. (Decided.)
2. New `people.delete`, held by `org_owner`, `org_admin` and `community_admin` by default. (Decided.)
3. A contact linked to a user account or with a live pending invitation cannot be deleted. (Decided; owner item 3.)
4. The purge is one `SECURITY DEFINER` function; `app` gets `EXECUTE`, not `DELETE`. (Decided; owner item 1.)
5. Children are out of this chunk; the API and the database refuse a minor. (Recommended.)
6. The function deletes dependants explicitly and the foreign keys stay `RESTRICT`. (Recommended.)
7. Expired pending invitations are voided and other closed invitations lose `person_id` at purge. (Recommended.)
8. The sweep runs after a 200, in its own transaction, awaited, only in a writable community. (Recommended.)
9. Delete and restore need `people.view` as well as `people.delete`. (Recommended.)
10. The Deleted filter takes a name search only. (Recommended.)
