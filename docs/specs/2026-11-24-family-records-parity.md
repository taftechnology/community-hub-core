# Spec: Family Records parity

Slug: family-records-parity
Status: approved (2026-11-24, Adnan Bin Hossen)
Architecture refs: §6.3, §9, §11.1, §12.1, §12.2, §12.2.1, §12.3, §12.4; ADR 0004, ADR 0017, ADR 0020, new ADR 0021; AGENTS.md §1 rules 2, 3, 4, 5; §2; §6; §7; §8; §12; §13. Phase 2 row `Family Records parity`. Feature list: the Admin UI handoff (2 Nov 2026, People gaps, groups A and B). Scope: the chunk owner's split and the project owner's four answers (2026-11-24, relayed by the chunk owner).

**Sensitive chunk** (tenancy, encryption, children's data through the family, a database migration with grant changes and the second `SECURITY DEFINER` function, permanent deletion of a family and its key). It needs a second fresh-context review on a model that differs from every implementer model used in this chunk and from the reviewer agent's (AGENTS.md §2). Reviewer agent: Claude Opus 5.5.

Revision 2 (2026-11-24) applies the fresh-context spec check (Claude Haiku 5.5, NOT READY, 2 High, 7 Medium, 12 Low) and the project owner's answers. Not applied, with reasons: M2 (a caller-restricted sweep would lengthen retention; the function takes no choice from the caller, and ADR 0020 already sweeps after a list), M5 (one domain module, `core/people`; `apps/`, `packages/` and docs are not modules in §3, and size alone is not a reason to split), L1 (both roadmap rows exist, `docs/roadmap.md:186-187`).

Revision 3 (2026-11-24) applies a second fresh-context check (Claude Haiku 5.5, NOT READY, run before the project owner's answer on emergency contacts was in this file) and that answer. Its new High, that `readHouseholdDetail` shows minors' fields to `people.restricted.read` holders, is the known gap ADR 0017 point 8 already records. It belongs to `Children's data access`, and Rules touched now says so.

## Problem

In Laravel, staff can set a family's status, delete a family and record emergency contacts for it. Core has none of these. `app.households` holds a label and a version only (`modules/core/people/db/schema.ts:97-116`), the `app` role has no `DELETE` on `app.households` or `app.household_keys` (`0005_people_households.sql:189-191`), and no code destroys a household key. Separately, Add Adult answers every 409 with "A contact with this email or phone already exists. Search for them instead." (`apps/admin/src/family-records.tsx:1198-1202`), including when the contact is deleted and cannot be found by searching.

## Scope

In:

- Family status: `active` or `inactive`, a switch on the Family Records row, a status filter.
- Delete a family: hide it, restore it within 720 hours, then permanently purge the family and its household key through a definer function. Refused while a child is in the family. Adults stay as contacts.
- Emergency contacts for a family.
- The Add Adult message for `duplicate_deleted`.
- The fix for family list and read answering 500 instead of 403.
- ADR 0021 for the family purge.

Out:

- Moving, editing and deleting a child. A new roadmap row, after `Two-factor for staff` and `Children's data access`. ADR 0017 is not amended (project owner, 2026-11-24).
- Pastoral notes. A new roadmap row, after the same two chunks (project owner, 2026-11-24).
- Family photos, family-level life events, bulk actions, CSV export.
- Moving the adults of a deleted family to another family. They are moved one by one with Add Adult, as today.
- The regional scheduler, and the request-scoped key cache.
- Closing the ADR 0017 gap on existing reads. This chunk adds no new read of a minor's field.

## Behaviour

All routes are `POST`, need the `people.households` entitlement, take `communitySlug`, derive the organisation and community from `findCommunityBySlug`, and keep the existing answers: 400 bad body, 403 denied with a `people.permission.denied` audit event, 404 not found, 409 version conflict with an empty body. Writes are marked `billing: "write"`. A missing `people.manage` is audited with purpose `people.person.manage`, a missing `people.view` with `people.person.view`, a missing `people.restricted.read` with `people.restricted.read`, and a missing `people.delete` with `people.permission.denied`. All four are registered purposes. Every new route, and every `/v1/households/list` response to a body with `status: "deleted"`, answers with `no-store`, refusals included.

Each new route, and the Deleted filter, has a real-database test (no mocked audit) that a caller missing each key gets the stated status, the denial row with the stated purpose, and `no-store`. One parameterised test over the routes is enough.

**Fix to existing code.** `/v1/households/list` and `/read` audit a denial with purpose `people.view` (`household-routes.ts:39`, `:269-278`, `:313-324`). That name is not a registered audit purpose, so `appendAuditEvent` throws (`audit-append.ts:81-83`) and the caller gets 500 with no denial row, not 403. Both move to `people.person.view`, with a real-database test for each that asserts 403 and the denial row. No data is exposed today.

### Status (`/v1/households/status`)

Body `{ householdId, version, status }`. Needs `people.view` and `people.manage`. Sets `status`, bumps `version`, audit event `people.household.status_changed`. Status changes nothing else: the adults' contact status, lists, groups and emails are untouched.

### List (`/v1/households/list`)

Items gain `status`. The body gains optional `status`: `active`, `inactive` or `deleted`. Without it the list returns every family that is not hidden.

`deleted` is a filter value, not a stored status. It needs `people.view`, `people.delete` and `people.restricted.read`; the order is the people list's (`people-routes.ts:314-337`): without `people.view`, 403 and a denial row; with it but without both others, 400 and a denial row with purpose `people.permission.denied`. It is a separate query path: hidden families only, sorted `deleted_at desc, id`, its own cursor, returning `householdId`, `label`, `adultCount`, `version`, `deletedAt` and `purgeAfter`, with one audit event per call, also for an empty page, `people.household.listed_deleted`.

### Delete (`/v1/households/delete`)

Body `{ householdId, version }`. Needs `people.view`, `people.delete` and `people.restricted.read` (the confirmation names the family, and the label is restricted).

- The household row is locked `FOR UPDATE`. It must be in the current community with `deleted_at` null, else 404 (the same answer for a hidden family, an unknown id and another tenant's id). `version` must match, else 409 with an empty body. This is checked before the child check.
- Inside the same transaction, after the lock: 409 `{ "code": "household_has_children" }` when any person with `is_minor = true` has this `household_id`. A person whose `age_basis` is `unknown` is a minor and refuses the delete.
- On success: `deleted_at = now()`, `deleted_by` = the actor, `version` bumped, audit event `people.household.deleted`. Response `{ householdId, version, purgeAfter }`, with `purgeAfter` computed in SQL.
- Adult members keep their `household_id` while the family is hidden, so a restore brings them back. Until then they behave as contacts without a family.

### Restore (`/v1/households/restore`)

Body `{ householdId, version }`. Same permissions as delete. Row locked `FOR UPDATE`; it must be hidden in the current community and hidden for less than 720 hours by the database clock, else 404. `version` must match, else 409. Clears `deleted_at` and `deleted_by`, bumps `version`, writes `people.household.restored`. The family returns with its label, status, emergency contacts and the adults whose `household_id` still points at it. An adult who was moved elsewhere, or out of the family, while it was hidden does not return.

### What "hidden" means

Each line has a must-fail test with a hidden family in the fixture.

- Reads: `listHouseholds` (`household-list.ts:88-112`), `readHouseholdDetail`, `openHouseholdLabel` and the exported `readHousehold` in `household.ts`, and the emergency contacts read leave it out or answer not found. The filter sits in the first `select`, before any audit append, so a hidden family writes no read event. `readPerson` (`person.ts:347-445`) and the person detail response return `householdId: null` for an adult in it (`packages/contracts/src/people.ts:271-273`); the person list carries no household id. A deep link to its Family Details shows the existing not-found state.
- Writes: rename, family status, emergency contacts save, add-adult and add-minor (`household-members.ts:152-296`), move-adult with it as the target (`:61-73`), `requireHousehold` (`person.ts:120-126`), guardian link and unlink (`guardian.ts:57-66`, `:188-263`) answer 404. Moving an adult out of it, to another family or to none, is allowed. Editing, contact status, contact delete and contact restore of an adult in it work as for any contact, the family stays hidden, and a test names all four.
- Locks: add-adult, add-minor, move-adult (target), link-guardian and unlink-guardian read the household `FOR SHARE` with `deleted_at is null`, before any person lock. Today link and move-adult read it without a lock and unlink does not read it. Delete, restore and purge take `FOR UPDATE`. One order, household then person, everywhere.

### Emergency contacts

Stored on the family as one encrypted value: an ordered list of 0 to 5 entries, each `name` (1 to 100), `relationship` (optional) and `phone` (the existing contact phone rule). No notes field. `relationship` is one of a fixed list, not free text: `spouse`, `grandparent`, `relative`, `neighbour`, `friend`, `carer`, `other`. No value means a child, and any other value is refused with 400. The panel label and help text say: "Adult to contact if guardians cannot be reached". The help text adds: "Do not enter a child's name."

**Emergency contacts are adult data** (project owner, 2026-11-24, owner item 3): an emergency contact is by definition an adult responder, reached when guardians are unavailable. The importer maps any unknown Laravel relationship to `other`.

- `/v1/households/emergency-contacts/read`. Body `{ householdId }`. Needs `people.restricted.read`. Writes one audit event `people.household.emergency_contacts_read` with the household id, in the same transaction as the read, also when the list is empty. A hidden family, an unknown id and another tenant's id answer 404 with no read event. Response `{ householdId, version, contacts }`.
- `/v1/households/emergency-contacts/save`. Body `{ householdId, version, contacts }`. Needs `people.restricted.read` and `people.manage`. Replaces the whole list; an empty list stores null. `version` must match, else 409. Audit event `people.household.emergency_contacts_updated`.
- `/v1/households/read` and `/list` never return emergency contacts or whether there are any.

### Purge sweep

- `app.purge_deleted_households(p_limit integer) returns setof uuid`, `SECURITY DEFINER`, owned by the migrator, `SET search_path = pg_catalog, app`, schema-qualified names, `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO app`, the same shape as `app.purge_deleted_persons`.
- It raises when `app.org_id` or `app.community_id` is unset or empty, and when `p_limit` is null or outside 1 to 50.
- It selects at most `p_limit` households of that org and community with `deleted_at <= now() - interval '720 hours'`, oldest first, `FOR UPDATE SKIP LOCKED`, skipping any household that has a person with `is_minor = true`. The minor check runs as a second statement after the rows are locked, with its own `org_id` and `community_id` predicates, so it does not rest on the locking statement's snapshot.
- For those ids, in this order: set `household_id = null` and bump `version` on `app.persons` with that `household_id`, hidden contacts included; delete `app.guardian_links` with that `household_id`; delete `app.household_keys` with that `household_id`; delete the `app.households` rows. These cover all three foreign keys to `app.households`. It returns the purged ids.
- The tables keep `FORCE ROW LEVEL SECURITY` and the migrator has no `BYPASSRLS`, so the function is scoped by its own predicates and by RLS.
- A run that purges at least one family writes one `people.household.purged` event in the same transaction, actor `system`, ids only.
- When it runs: after a 200 from household list (any caller with `people.view`), delete or restore, in a writable community, in its own `withAppTransaction` after the route commits, awaited. A failure is logged by error class only and does not change the answer (as `contact-sweep.ts`). The sweep is not an authority check: the caller chooses nothing, and only the 720-hour rule decides what is purged.

### Screen (`apps/admin/src/family-records.tsx`)

- List: a status `Switch` per row for `people.manage` holders, a `StatusBadge` for others, a `FilterBar` status `Select` (All, Active, Inactive, and Deleted for holders of the three keys).
- Delete on Family Details, rendered only for the three keys and not in a read-only community. `ConfirmDialog`, tone danger: "Delete <family name>? It is hidden now and deleted permanently on <date>. Its adults stay in All Contacts. Staff with the delete and restricted read permissions can restore it until then." Button "Delete family". A family without a label reads "this family".
- Refusals: `household_has_children` "This family has a child in it, so it can't be deleted."; a 409 without a body "Someone else changed this family. Reload and try again." A network failure on any of the new actions, the status switch included: "Unable to save. Try again.", and the switch returns to its stored value.
- Deleted rows show the label, "Deleted <date>, deleted permanently on <date>" and Restore; no View, no switch. A row past its date shows "Permanent deletion pending" and no Restore. A 404 on restore: "This family can't be restored. It may already be restored or deleted permanently.", and the list reloads. Empty state: "No deleted families."
- Emergency contacts panel on Family Details, rendered only for `people.restricted.read`. It loads on a "Show emergency contacts" button, so a read is audited only when someone looks. Empty state: "No emergency contacts." Load failure: "Unable to load emergency contacts. Try again." `people.manage` holders get Edit, with rows to add and remove. Errors keep the typed values: "Someone else changed this family. Your changes are still here. Check them and save again."
- Add Adult: a 409 with `duplicate_deleted` shows the All Contacts text (`all-contacts.tsx:233-237`) through a shared helper; every other 409 keeps today's message.
- Switching community, closing the panel or leaving the screen drops the decrypted contacts; a late response for the previous community is ignored, as `detailGeneration` does.
- WCAG 2.2 AA: focus returns after each dialog, axe clean at 1280 and 375, light and dark.

## Data

Migration `0023`, expand only, one wave, one table:

| Column                          | Type                             | Class      | Notes                                                                                           |
| ------------------------------- | -------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `households.status`             | `text not null default 'active'` | internal   | clear: filtered. CHECK `active`, `inactive`                                                     |
| `households.deleted_at`         | `timestamptz null`               | internal   | clear: filtered and compared                                                                    |
| `households.deleted_by`         | `uuid null`                      | internal   | clear: the acting user's id                                                                     |
| `households.emergency_contacts` | `bytea null` (encrypted)         | restricted | household key, AAD label `people.household_emergency_contacts`; never filtered, sorted, counted |

- Index `households_deleted_idx` on `(org_id, community_id, deleted_at) where deleted_at is not null`.
- `GRANT UPDATE (status, deleted_at, deleted_by, emergency_contacts) ON app.households TO app`, which adds four columns to `label` and `version` (`0016:2`), so `app` then updates six. No `DELETE` grant on any table.
- `households_before_update` and `households_before_insert` triggers: `deleted_at` is null on insert, may change only from null to `now()` with `deleted_by` set, or back to null with `deleted_by` null, and may not be set while a minor is in the household.
- `persons_before_insert` (when `household_id` is not null) and `persons_before_update` (only when `NEW.household_id IS DISTINCT FROM OLD.household_id` and the new value is not null) gain: the target must be a household visible in the current scope with `deleted_at` null, read `FOR SHARE`, else raise. No visible row raises too. An update that leaves `household_id` alone takes no household lock, so editing, deleting or restoring an adult in a hidden family works and cannot deadlock with the purge. `FOR SHARE` needs `UPDATE` on a column of `app.households`, which `app` has (`0016:2`). This is the database backstop for a child or adult being placed in a family while it is being deleted.
- No data change and no backfill: the default is a constant.
- The four columns go in the people `module.manifest.ts` `dataClasses`, with the `manifest.test.ts` pins, in the migration task.
- No new table, key, permission, entitlement, event or collection.

**Why one encrypted column and not a table.** The list is read and saved whole, at most five entries, never queried. One value means one decrypt, one version check, no `DELETE` grant, and it dies with the household row and key.

Recovery: reverting the code leaves the columns unused, and hidden families appear again. `DROP FUNCTION app.purge_deleted_households`, drop the two household triggers, restore the `0022` bodies of the persons triggers, and revoke the column grants. A purged family cannot be recovered except from backup.

## Rules touched

- Permissions: no new key. `people.delete` now also covers families. Emergency contacts use `people.restricted.read`, and `people.manage` to edit (project owner, 2026-11-24, owner item 3). ADR 0017 governs a minor's details and is not amended, because an emergency contact is adult data.
- Entitlement: `people.households` on every route.
- Audit: `people.household.status_changed`, `.listed_deleted`, `.deleted`, `.restored`, `.purged`, `.emergency_contacts_read`, `.emergency_contacts_updated`, each registered with both `defineAuditAction` and `defineAuditPurpose` in `modules/core/people/public/index.ts`, ids only.
- Children (§1 rule 4, ADR 0017): a family with a child cannot be hidden or purged, by the route, by the trigger and by the function. The refusal tells a holder of `people.delete` and `people.restricted.read` that the family has a child, which ADR 0017 point 7 allows. The new routes read and write no minor's field. `/v1/households/read`, which this chunk changes only to leave out a hidden family, still returns minors' names and dates of birth to `people.restricted.read` holders. That is ADR 0017's known gap (point 8), it stays with `Children's data access`, and no client data is imported until it closes.
- Encryption (§1 rule 3): the new column is never in a `WHERE`, `ORDER BY` or aggregate.
- Retention: hidden 720 hours, then purged at the next swept family action. Backups keep the rows, and the wrapped key with them, until backup retention ends.
- Tenancy: every query and the function run under per-transaction scope and FORCE RLS.
- Residency: no outbound call. Cost: none. Staging stays parked.

## Contracts

- `packages/contracts/src/households.ts`: the status, delete, restore, emergency contacts read and save bodies and responses; list `status` and the deleted item with its cursor; the `{ code }` error body with `household_has_children`.
- `household_has_children` joins the closed `PeopleErrorCode` union, mapped in both `statusForPeople` and `statusForHouseholds`.
- People `public/`: the new functions and `purgeDeletedHouseholds(tx, limit)`.

## Risks

- **A child's data lost by destroying the household key.** A minor's fields and life events are sealed under it. Mitigation: refusal after the lock, two triggers, the function's skip; two-transaction tests for delete against add-minor in both orders, ordered by locks; must-fail tests for each household trigger refusal (back-dated hide, hide with a minor present, `deleted_by` mismatch, non-null on insert) and for both persons trigger refusals as `app`; a test that a minor placed with the migrator stops the purge; a route test that delete answers 409 `household_has_children` with a minor and with an `age_basis = unknown` minor, and leaves the family unchanged.
- **`is_minor` stops being write-once.** The purge is safe because `is_minor` never changes, so nothing of a former child's is sealed under the key. The planned turned-18 job must re-key the person and their life events first. Mitigation: a test that pins no `app` `UPDATE` on `persons.is_minor`, and ADR 0021 records the dependency.
- **Cross-tenant purge or save.** Mitigation: tests with two organisations and two communities of one organisation, each with a family hidden 721 hours; the raise tests for scope and limit; cross-community ids answer 404 on every new route.
- **Permanent loss by mistake.** Mitigation: no `DELETE` grant; the trigger stops a back-dated hide; tests at 719 and 721 hours with rows aged by the migrator inside `ALTER TABLE ... DISABLE TRIGGER USER` on `app.households` (and `app.persons` where a minor is placed), as `purge.integration.test.ts:116-122` does; the privileges test pins exactly six updatable `households` columns and no `DELETE` on `households`, `household_keys` or `persons`; `PUBLIC` has no `EXECUTE`, and `proconfig` holds the search path.
- **Purge blocked by a new foreign key to households.** Mitigation: a catalog test that fails on an unhandled foreign key.
- **Emergency contacts visible to the wrong role.** Mitigation: route tests with each permission swapped or missing, no contact field in list or detail, no value in any log or audit row.
- **A child's name typed into a contact's name field.** It would be readable by `people.restricted.read` holders, who are not all allowed a minor's details (§1 rule 4, ADR 0017). Mitigation: a fixed relationship list, no notes field, the form text, an audited read. Form text is not a control, so the residual was put to the project owner, who decided Option A (owner item 3): a child's name there is misuse of an adult field, not a reading path.
- **Deadlock between family delete, move-adult and contact delete.** Mitigation: one lock order and forced-order tests, ordered by locks: add-adult, add-minor, move-adult in, link-guardian and unlink-guardian, each in both orders against family delete; contact delete of an adult in the family, move-adult out and move-adult in, each against the purge.
- **Idle community.** As ADR 0020: a community with no family list, delete or restore keeps a hidden family past 720 hours until the scheduler.

## Architecture

- New ADR 0021 "Family deletion and household key purge": the second definer function, the child refusal, and the deferral of the child items that ADR 0020 point 4 left to this chunk.
- §12.1: the six updatable `households` columns and the function. §12.4: the family retention rule. §9 family row: the new routes.
- §12.2 "Deletion by key destruction" says destroying the household key makes backups unreadable. The wrapped household key is in the same database backups, so a backup taken before the purge stays readable to a holder of the envelope key until backup retention ends. Approved correction (project owner, 2026-11-24). New text: "**Deletion by key destruction:** erasing a household destroys its household key in the live database, making restricted copies outside database backups (including restricted files) unreadable. A database backup taken before the erasure also holds the wrapped household key, so it stays readable to a holder of that backup who can use the envelope key, until backup retention ends." The payment ledger sentences stay. The blind-index sentence ends: "A minor's `confidential-blind` indexes use the household key, so they die with it in the live database; backups keep both until backup retention ends."

## Roadmap

The last commit marks `Family Records parity` done; adds rows `Family Records: children` (move, edit, delete a child) and `Pastoral notes`, both after `Children's data access`; adds the importer mapping (family status, emergency contacts) to the `Laravel importer` row; adds the scheduler and staging-check open items; updates the snapshot and the `AGENTS.md` Repository state.

## Out-of-band

- No legal sign-off, vendor, AWS resource or cost.
- ADR 0021 signed off by the project owner (2026-11-24), committed with this spec.
- Verified by tests and a local browser check, not on the staging hostname.

## Owner items (project owner, AGENTS.md §12)

Answered 2026-11-24, relayed by the chunk owner: children to a later chunk, ADR 0017 not amended; family delete as above; emergency contacts classification and permissions; pastoral notes deferred. Then:

1. Laravel values. Confirmed 2026-11-24: status `active` and `inactive`; at most 5 emergency contacts with `name`, optional `relationship` and `phone`, no notes; family status does not change contacts.
2. The §12.2 correction. Approved 2026-11-24. ADR 0021: signed off 2026-11-24.
3. Emergency contacts and §1 rule 4. Decided 2026-11-24, Option A: emergency contacts are by definition designated adult responders to reach when guardians are unavailable, so they are adult data. `people.restricted.read` to view, with a read audit event; `relationship` is the fixed list above; unknown Laravel values map to `other`; the label text above. Put to the project owner with the risk stated: the name field is free text, and `safeguarding_officer`, `org_admin`, `org_owner` and any custom role with the permission can read it.
4. The 500 on family list and read. Approved 2026-11-24 for this pull request.

## Chunk owner decisions

1. Split: adults and families now, children later. (Decided, 2026-11-24.)
2. Adults keep `household_id` while hidden, so a restore brings them back. (Decided, 2026-11-24.)
3. Delete, restore and the Deleted filter need `people.restricted.read` as well as `people.delete`. (Decided, 2026-11-24.)
4. Family status does not change the adults' contact status. (Decided, 2026-11-24.)
5. Emergency contacts are one encrypted value of at most five entries, shown on demand. (Decided, 2026-11-24.)
6. Implementer: Antigravity, with a change to Claude Sonnet if needed. The independent checks use a model that is neither, nor Opus. (Decided, 2026-11-24.)
