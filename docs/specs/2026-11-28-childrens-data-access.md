# Spec: Children's data access

Slug: childrens-data-access
Status: approved (2026-11-28, Adnan Bin Hossen)
Architecture refs: §7.3, §11.3, §11.4, §12.1, §12.2, §12.2.1, §12.3, §12.4; ADR 0017 (implemented by this chunk; status note on point 2); ADR 0022 (status note on point 2); ADR 0009 (support-operator case, already narrowed by ADR 0017 point 4). AGENTS.md §1 rules 2, 3, 4, 5, 7; §2; §6; §8; §12. Phase 2 row `Children's data access`.

**Sensitive chunk** (children's data, authentication, tenancy). It needs a second fresh-context review on a model that differs from the implementer's (Antigravity) and from the reviewer agent's (Claude Opus 5.5), so Claude Haiku 5.5 or Fable (AGENTS.md §2).

**Decisions.**

- Chunk owner (Adnan Bin Hossen, 2026-11-28):
  - D1. One fresh second-factor check per View. A View uses up the session's fresh check, so the next View needs a new check (ADR 0017 point 5 as written).
  - D2. A Community Admin sees every child field hidden by default, the name too. Each field has its own View.
  - D3. Adding a child from the admin needs the `community_admin` role. Guardian self-entry (ADR 0017 point 2) ships with the member portal / Parish Hub (approved by the project owner as O2).
  - D4. Strict roles: only the child's guardian and a holder of the `community_admin` role in that community. `org_owner`, `org_admin`, `safeguarding_officer` and custom roles holding `people.restricted.read` no longer read a minor's details (ADR 0017 point 3 as written; confirmed by the project owner).
  - D5. A family's label stays an adult-level `restricted` field, read as today, and must never contain a child's given name. It is enforced as O3 decides (option C), because any server check that compares a label with a child's name is itself a name oracle for whoever can trigger it.
  - D6 (with O4). This chunk ships only the Community Admin part of the rule. There is no guardian read path in the product until member surfaces exist. Today a guardian who holds `people.view` reaches the guardian branch through `POST /v1/people/read` (`people-routes.ts:415-416,429`); this chunk closes that path. So the guardian branch of `readPersonForActor` (`modules/core/access/infrastructure/restricted-read.ts:78-105`) stops returning a minor's fields, and the member-portal chunk builds guardian read against ADR 0017 point 3. This is narrower than ADR 0017 allows, never wider. It also removes the `links[0]` question (`restricted-read.ts:85`).
- Project owner (Abdus Salam, 2026-11-28), decided:
  - O1, approved. A successful fresh check (`freshCheckTotp`, `verifyFreshPasskey`) returns the session attempt it took, so only refused codes count. The 5-failure session limit and the 10-failure hourly limit are unchanged. It is recorded as a status note on ADR 0022 point 2.
  - O2, approved. Until member surfaces ship, admin Add minor is restricted to `community_admin` only. It is recorded as a status note on ADR 0017 point 2.
  - ADR 0017 point 3 is confirmed as written. An `org_owner` or `org_admin` reads children's details only in a community where they also hold `community_admin`. `bootstrapOwner` already grants that role in the first community (`modules/core/access/infrastructure/grants.ts:396-407`).
  - O3, option C (2026-11-28). In a family that has a child, only a `community_admin` may rename it, and the server refuses a label that contains a child's given name in that family. Both the create and rename forms carry the guidance "Use the family name. Don't include a child's name." `addMinor` checks the family's existing label against the new child's given name, so "Nguyen (Tom)" set at `createHousehold` cannot be kept when Tom is added. Only the minor's `given_name` is checked, never `family_name`. Recorded on ADR 0017 point 7.
  - O4, approved (2026-11-28). Children's fields are removed from `readPersonForActor` until the member-portal chunk builds guardian read. This also closes the `main` case where a guardian holding `people.view` reaches that path through `POST /v1/people/read`. Recorded as a status note on ADR 0017 point 3.

Revision 5 (2026-11-28) records the project owner's O3 (option C, with the existing-label check on `addMinor` and given-name-only matching) and O4.

Revision 4 (2026-11-28) applied the third check: the export table completed, the D5 check moved to the shared minor writer, the users-list minor flag, groups on the adult list, test flips, and the Low items.

Revision 3 (2026-11-28) applied the second fresh-context spec check (Claude Haiku 5.5, NOT READY, 3 High, 8 Medium, 10 Low):

- H1 became D5's server check. The third check (Claude Haiku 5.5, NOT READY, 1 High, 6 Medium, 6 Low) showed that check is a name oracle, so it is now O3. Its M3 is O4, and the rest are applied in revision 4.
- H2 and M7 are closed by the project owner's approval of O1 and O2.
- M5, M8 and the guardian half of M1 became D6 (minor fields are removed from every reader, not guarded).
- Everything else was applied as asked.

Revision 2 applied the first check (Claude Haiku 5.5, NOT READY, 2 High, 4 Medium, 11 Low).

## Problem

ADR 0017 point 8 is open on `main`: any caller holding `people.restricted.read` reads a minor's name, date of birth, email, phone and life events. That covers `org_owner`, `org_admin`, `community_admin`, `safeguarding_officer` and any custom role holding the permission (`packages/policy/src/decide.ts:19-31,64-75`). The paths are:

- `/v1/people/list` with `kind=minors` (`apps/api/src/people-routes.ts:292-313`);
- `/v1/people/read` (`people-routes.ts:405-433`, `restricted-read.ts:78-105`);
- `/v1/households/read` (`apps/api/src/household-routes.ts:378-394`, `modules/core/people/infrastructure/household.ts:484-531,576-577`);
- `/v1/people/life-events/list` (`apps/api/src/life-event-routes.ts:189-214`).

Below the routes, the people module's exported readers either take an `includeRestricted` flag from whoever calls them or take no actor at all:

- `modules/core/people/public/index.ts:63-129`;
- `readRosterNames` used by `modules/features/groups/infrastructure/export.ts:3`;
- `openPersonFieldKeys` hands out a minor's household keys to any caller (`person-keys.ts:96-109,123-150`).

A family's free-text label is readable by every `people.restricted.read` holder and can carry a child's name.

No View control and no fresh-check requirement exist. No client data may be imported until this closes, and Family Records: children and Pastoral notes wait on it.

## Scope

In:

1. **Only one reader decrypts a minor's field.** It is the new View reader, behind `isCommunityAdmin(tx, actorUserId, communityId)`, which is true only for a `community_admin` grant in that community in `app.community_role_grants`. A custom role cannot use that key (`modules/core/access/db/schema.ts:101`), and a grant in another community of the same organisation does not count. Every other function stops decrypting a minor's fields. This removes the paths rather than guarding them.

   | Export (`@community-hub/people` / `@community-hub/groups` `public/`)                                                                                 | After this chunk                                                                                                                                                    |
   | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `readPerson`, `readPersonForActor` (access)                                                                                                          | minor → `not_found` for every caller (D6)                                                                                                                           |
   | `listPersons` minors mode                                                                                                                            | Community Admin only; rows `{ personId, label, householdId }`, no decrypt; `deleted_at is null` added (`list-persons.ts:550-555`)                                   |
   | `listDeletedPersons`                                                                                                                                 | minors never returned                                                                                                                                               |
   | `summarisePersons`, `readLinkedContacts`, `visiblePersonIds`                                                                                         | minors never returned with fields; the plan lists each one's current minor handling and pins it                                                                     |
   | `readHousehold`, `readHouseholdDetail`                                                                                                               | `childCount`; plus `children: [{ personId, label }]` for a Community Admin; no minor field, no `ageBasis`, no `birthdayMd`                                          |
   | `listHouseholds`, `listDeletedHouseholds`                                                                                                            | unchanged (no minor fields today); in the sweep                                                                                                                     |
   | `readRosterNames`                                                                                                                                    | minor rows omitted for non-admins, with a `minorCount`; `{ personId, label }` for a Community Admin; never a name                                                   |
   | `openPersonFieldKeys`                                                                                                                                | refuses a minor (`null`) for every caller; the View reader opens the household key itself, internally                                                               |
   | `listPersonActivity`, `listPersonTags`                                                                                                               | refuse a minor (`not_found`) for every caller                                                                                                                       |
   | `listLifeEvents`                                                                                                                                     | for a minor: Community Admin only, ids only; adults unchanged                                                                                                       |
   | `readEmergencyContacts`                                                                                                                              | unchanged (adults only); in the sweep                                                                                                                               |
   | `hidePerson`, `setPersonStatus`, `moveAdult`, `updatePerson`                                                                                         | unchanged minor refusals; the plan pins each                                                                                                                        |
   | `addMinor`, `linkGuardian` / `unlinkGuardian` (minor child), `createLifeEvent` / `updateLifeEvent` (minor)                                           | Community Admin only (Scope 6); answers carry ids only                                                                                                              |
   | `createHousehold`                                                                                                                                    | no check (no children yet); form guidance                                                                                                                           |
   | `renameHousehold`, `addMinor`                                                                                                                        | O3 label check; rename of a family with a child is Community Admin only                                                                                             |
   | groups `listMembers`, `personIdsInGroup`, `activeGroupsForPersons`                                                                                   | minor rows and ids omitted for non-admins, with a `minorCount` where members are counted; ids and labels for a Community Admin                                      |
   | groups `exportRosterCsv` (module, no route)                                                                                                          | children omitted for non-admins; label only for a Community Admin                                                                                                   |
   | `readLinkedContacts`, `/v1/access/users/list`                                                                                                        | a minor-linked user's `minor` flag only for a Community Admin; others see the user with no linked contact (`linked-contacts.ts:97-111`, `access-routes.ts:586-597`) |
   | `createPerson`                                                                                                                                       | `declaredAdult: false` (a minor) only through `addMinor`; its minor branch runs the O3 label check. `/v1/people/create` keeps `declaredAdult: true`                 |
   | `addAdult`, `saveEmergencyContacts`, `setHouseholdStatus`, `hideHousehold`, `restoreHousehold`                                                       | adult-only or household-level; unchanged; in the sweep                                                                                                              |
   | `lockPersonForDelete`, `restorePerson`, `purgeDeletedPersons`, `purgeDeletedHouseholds`                                                              | unchanged (no fields returned); the plan pins that no minor field is returned                                                                                       |
   | `attachTag`, `createTag`, `detachTag`                                                                                                                | refuse a minor target (`not_found`), as `listPersonTags`                                                                                                            |
   | `hasGuardianView`, `personIsMinor`                                                                                                                   | kept as facts (no fields); `hasGuardianView` stays for adult person-scoped reads                                                                                    |
   | `ensureCommunityKey`, `ensureOrganisationKey`                                                                                                        | key setup, no person data; out                                                                                                                                      |
   | groups `createGroup`, `updateGroup`, `archiveGroup`, `restoreGroup`, `listGroups`, `readGroup`, `groupLeaderFact`                                    | no person fields; unchanged                                                                                                                                         |
   | groups `addMember`, `removeMember`, `setMemberRole`                                                                                                  | for a minor person: Community Admin only; answers carry ids only                                                                                                    |
   | `/v1/people/list` `groupId` filter and group column (`people-routes.ts:354,375`, through `personIdsInGroup`, `activeGroupsForPersons`, `listGroups`) | adults only, as today; in the route sweep                                                                                                                           |

   Every exported function in both `public/` indexes is in this table. Each reader is also in the function sweep (Risks). A new export fails a test until it is classified.

   Status note (2026-11-28, written with the last task): two things differ from the text above. `isCommunityAdmin(tx, userId)` takes no community argument and relies on the `community_isolation` policy (migration `0007`), where Scope 1 shows a `communityId` parameter. `readPersonForActor` throws `AccessError("forbidden")` for a minor, the same as for a missing, hidden or cross-community person, where the table says `not_found` (plan amendment A1); `/v1/people/read` still answers 404 with an empty body. Later differences are in plan amendments A5 to A7: the audit purposes have three segments (`people.minor_view.<field>`), the View entitlement refusal is the shared empty 403, a child's id answers as a missing person on every route, the label check also folds accents, and the capabilities answer carries `roles.communityAdmin`.

2. **Presence only for everyone else.** Other staff who can see the household see only the number of children in it. They get no id, label, name, date of birth, age, email, phone, guardian link, group membership or life event of a child. Guardian links to minors stay omitted for them, as today (`household.ts:589-616`).
3. **The Community Admin's View.** A Community Admin sees each child as an id and a label with every field hidden.
   - The label is `Child n`, numbered within the child's own household over the children not hidden, in order of `created_at`, then id. At any one moment it is the same on every screen, including list rows and an adult's guardian links. It is a display label only and may change when a sibling is hidden, restored or added. Every request uses `personId`.
   - The fields are name, date of birth, email and phone, and each of the child's life events' type, date, place and notes.
   - A View reveals one field after a fresh second-factor check and uses up that check.
   - The second app transaction that reads the field runs `isCommunityAdmin` again, so a role revoked after the check returns no value.
4. **Using up the fresh check.** Identity gets a public `consumeFreshFactor({ accessToken, now })`. It resolves the session inside identity, as `freshCheckTotp` does (`modules/core/identity/infrastructure/second-factor.ts:971-980,985-987`), because routes hold only the user id today. Its answer is one of:
   - `recovery` if `recovery_until` is set (checked first);
   - `not_fresh` if the session is not `tenant`, is revoked, or its check is older than 5 minutes or absent;
   - otherwise `consumed`, after clearing `fresh_factor_at` in one conditional update.

   Two Views racing on one check get one `consumed`. The sign-in second step by app or passkey, or a passkey sign-in, already counts as a fresh check for 5 minutes (ADR 0022 point 4). So the first View soon after sign-in needs no panel.

   Status note (2026-11-28, written with the last task): `consumeFreshFactor` takes `{ sql, kms, keyArn, accessToken, now }`, the same dependencies as `freshCheckTotp`, where Scope 4 shows `{ accessToken, now }` (plan P4b). The View routes' entitlement refusal and audit purposes differ as recorded in plan amendment A5; see the note under Scope 1.

5. **Attempt limit (O1, approved).** A correct fresh check gives back the attempt it took, never below 0, for both `freshCheckTotp` and `verifyFreshPasskey`. A refused code still counts. After 5 refused codes in a session, fresh checks answer `limited` for the rest of that session and the session is not ended, as today (`second-factor.ts:993-996,1584-1587`). The hourly limit of 10 failures per user and the sign-in second step are unchanged.
6. **Writes about a child (D3, O2).** These need the `community_admin` role in that community instead of `people.manage` plus `people.restricted.read`, under the `people.households` entitlement (`household-routes.ts:555-561,655-657,717-719`):
   - `add-minor` (`:1100`);
   - guardian link and unlink where the child is a minor (`:1114,1121`);
   - life-event create and update on a minor.

   Their answers carry ids only. `/v1/people/update` already refuses a minor (`update-person.ts:166-167`) and stays so. For link, unlink and life-event writes the route looks the person up first. A caller who is not a Community Admin gets the same 404 for a minor as for a missing person. Children's ids are hidden from non-admins, so this is not an oracle.

7. **`people.restricted.read` means adults only.** The Users & Roles permission list and role description gain new copy: `people.restricted.read` is "Restricted details of adults", and `community_admin` is "Can view children's details (a second-factor check for each field)" (`apps/admin/src/role-labels.ts` and the role description component the plan names). `modules/core/people/module.manifest.ts:11` keeps the key; architecture §11.3 states the meaning.
8. **Family labels (D5, O3 option C).** The create and rename forms carry the guidance. In addition:
   - Renaming a family with a child (hidden children counted) needs `community_admin`. Others get 403 and no rename control.
   - The check runs in one shared helper, called by `renameHousehold` and by the minor branch of `createPerson`, so `addMinor` and any direct caller are covered.
   - The check compares the label with the minor's `given_name` only, never `family_name`. Each part of the given name of two letters or more (split on spaces and hyphens, case-folded, NFKC) is matched as a whole word in the label.
   - Shared first names: a part that equals a given-name part of an adult member of the same family is skipped. So "Tom and Mary Nguyen" stays allowed when the father and a son are both Tom. Such a label reveals only the adult's name, and anyone who can read the label can already read that adult's name. A test pins both the skip and the refusal of a name held only by the child.
   - `addMinor` checks the family's existing label against the new child's given name before it inserts (the shared helper in `createPerson`'s minor branch), so a label set at `createHousehold` before the child existed cannot keep a child's name.
   - A refusal is `422 { code: "label_contains_child_name" }`, shown in the destructive `Alert` (`apps/admin/src/family-records.tsx:1790,1841`).
   - Must-fail tests cover rename, `addMinor` onto a label that already names the child, and a direct `createPerson` call. A further test shows that a `people.manage` + `people.restricted.read` caller who is not a Community Admin gets the same 403 whatever label they send.
   - Labels keep their `people.restricted.read` gate for reading. The Laravel import chunk runs the same check on imported labels, and the roadmap records that.
9. **Groups.** Rule 1's table applies. There is no `/v1/groups` route yet. Groups do reach HTTP through `/v1/people/list` (the `groupId` filter and the group column, `people-routes.ts:354,375`). Both list adults only and are in the route sweep. The Groups screen chunk adds the route and must not take minor inclusion from request input.
10. **Admin UI.** Family Records, All Contacts and the life-events panel follow rules 2 and 3 (see Behaviour). The "Confirm it's you" panel inside `apps/admin/src/security.tsx:241,822,828` is extracted into a shared component, used by both Security and View.
11. **Support operators.** There is still no support grant or break-glass code (`apps/api/src/ops-routes.ts` has no people reads). A support read will use the `app` role with the tenant scope set (`architecture.md:704`). So the control is rule 1 itself: no reader returns a minor's field to an actor without a `community_admin` grant, and an operator never has one. Two tests add to this:
    - a static test that `apps/api/src/ops-routes.ts` and the ops modules import nothing from `@community-hub/people` or `@community-hub/groups`;
    - a catalogue test (`has_table_privilege`, following `modules/core/access/infrastructure/privileges.integration.test.ts:45-60`) that the `platform` and `identity` roles have no privilege on `app.persons`, `app.households`, `app.guardian_links` or `app.life_events`.

    The Support access row carries ADR 0017 point 4 when grants are built.

12. **Docs.**
    - ADR 0017: status notes on point 2 (O2), point 3 (O4) and point 7 (O3), and an implemented note (D1–D6).
    - ADR 0022: a status note on point 2 (O1).
    - architecture.md: §11.3, §12.3 and §12.4, the module table rows for contacts and families (`architecture.md:563-564`), and `:693`, `:802` and `:805`.
    - roadmap: this row done; the `people.restricted.read` text in the Family Records rows (`docs/roadmap.md:167,179`); a note on the member-portal row that guardian self-entry and guardian read move there; a note on the Laravel import row for the D5 label check; and open items (a staging check of a View at the next unpark, org owners needing `community_admin` to view children, and nickname labels as a residual).
    - AGENTS.md repository state.
13. **Existing tests that flip.** These pass today on behaviour this chunk removes. The plan names each one, what it becomes, and the task that changes it, in the same PR:
    - `restricted-read.integration.test.ts:157,232`;
    - `people-routes.test.ts:581` and the minors cases in `people-routes.integration.test.ts`;
    - `household-routes.integration.test.ts:618`;
    - `household-routes.test.ts:540,1023,1094,1180`;
    - `household-detail.integration.test.ts:129`;
    - `list-persons.integration.test.ts:691`;
    - `roster-names.integration.test.ts:232`, `members.integration.test.ts:734`, `export.integration.test.ts:149,611`;
    - `life-event-routes.integration.test.ts:736`;
    - `access-routes.test.ts:1226`, `users-list.integration.test.ts:644,780`;
    - `all-contacts.test.tsx:916,934`;
    - `family-records.test.tsx:1415,1453,1689,1763,2615,2639,2839`.

    The plan's own search may add more. No flipped test is deleted without a replacement that pins the new behaviour.

Out:

- Guardian self-entry and any guardian read (D6). A staff member who is also a guardian sees their own child in the admin as presence only unless they are a Community Admin.
- Moving, editing and deleting a child (`Family Records: children`), and pastoral notes.
- The age-out job (roadmap open item), and changing `is_minor`.
- Support grants and break-glass (Support access row).
- A View in any export or report.
- Staging. It stays parked. Behaviour is verified by tests and a local browser check, and the roadmap records that the next proof chunk checks a View on the staging hostname.

## Behaviour

**Who sees what for a household with two children:**

| Caller                                                            | Family Records detail                              | All Contacts Minors tab                                                               | Child's life events     |
| ----------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------- |
| `community_admin` in that community                               | `Child 1`, `Child 2`, all fields hidden, View each | shown when `people.households` is on; rows `Child n · <family label>`, View per field | listed by id, View each |
| `org_owner` / `org_admin` without `community_admin`               | "2 children in this family"                        | hidden                                                                                | hidden                  |
| `safeguarding_officer`, custom role with `people.restricted.read` | "2 children in this family"                        | hidden                                                                                | hidden                  |
| other staff with `people.view`                                    | "2 children in this family"                        | hidden                                                                                | hidden                  |
| any caller, a household without children                          | no children line                                   | as above                                                                              | —                       |

For a Community Admin, an adult's guardian links list each child by their household label (`Child n`, with the family label when the child lives in another household). For everyone else they are omitted, as today.

**View flow (Community Admin):**

1. The admin presses View on one field.
2. The API answers in this order: entitlement (402), role (403), existence (404), then the session state:
   - `recovery` gives `recovery_session`, and the UI shows "Sign in again with your authenticator app or passkey to view children's details" with no panel;
   - `not_fresh` gives `fresh_required`, and the shared "Confirm it's you" panel opens (authenticator code or passkey). Cancel leaves the field hidden.
3. With a fresh check, the API uses it up, reads that one field, writes one audit event and answers the value with `Cache-Control: no-store`.
4. The value shows in place of the mask. Viewing another field, closing the family or leaving the page hides it again. Only one field shows at a time. Nothing is kept in storage, the URL or the query cache.
5. The next View asks for a fresh check again. TOTP refuses a reused code (`last_used_step`, `second-factor.ts:888-895`), so each View needs the next code (up to 30 seconds) or a passkey touch.

**View errors:**

| Case                                                                          | Answer                                                                        | UI                                                            | Fresh check used? |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------- |
| `people.households` off                                                       | 402, as other household routes                                                | View is never rendered there                                  | no                |
| Not a Community Admin in that community                                       | 403, empty body, denial audited                                               | "Not allowed" alert, as today (`family-records.tsx:1774`)     | no                |
| Child not in that community, not a minor, or no such life event of that child | 404, empty body                                                               | the field shows "Not found", and the family reloads           | no                |
| Session in the recovery window                                                | 403 `{ code: "recovery_session" }`                                            | the sign-in-again message, no panel                           | no                |
| Session has no fresh check                                                    | 403 `{ code: "fresh_required" }`                                              | the panel opens                                               | no (none held)    |
| Fresh checks limited for this session (5 refused codes)                       | the panel's existing limited message                                          | the field stays hidden                                        | no                |
| Child hidden, moved or deleted after the check was used                       | 404, empty body                                                               | the field shows "Not found", and the family reloads           | yes (accepted)    |
| Session revoked or expired before the consume                                 | 403 `{ code: "fresh_required" }` (`consumeFreshFactor` answers `not_fresh`)   | the panel opens; the next call gets 401 and the usual sign-in | no                |
| Two Views on one check                                                        | one 200, one `fresh_required`                                                 | the second opens the panel                                    | once              |
| Role revoked between the check and the read                                   | 403, empty body                                                               | "Not allowed", and the family reloads                         | yes (accepted)    |
| Database or KMS failure after the check was used                              | 500, empty body                                                               | the destructive `Alert`; the field stays hidden               | yes (accepted)    |
| Field empty (no email, or a name part missing)                                | 200 `{ value: null }`, or `{ given: null \| string, family: null \| string }` | "Not recorded"                                                | yes               |

The entitlement check is community-level and the role check runs before any lookup, so a non-admin cannot tell whether an id is a child. Every View answer, errors included, carries `no-store`.

**Empty and error states:** a family with no children shows no children line. A network error on View shows the destructive `Alert` and leaves the field hidden. There is no separate offline state; an offline View fails like any network error.

## Data

No new table, column or migration.

- `identity.sessions.fresh_factor_at` (existing, identity schema, no `org_id`): now also cleared by `consumeFreshFactor`.
- `identity.sessions.second_factor_attempts` (existing): one attempt given back after a correct fresh check, never below 0 (O1).
- `app.persons`, `app.households`, `app.guardian_links`, `app.life_events` (existing, `org_id`, RLS + FORCE RLS): read under the new rule. There is no classification change. A minor's `confidential*` fields stay under the household key (§1 rule 4).
- Nothing new is filtered, sorted or aggregated on an encrypted column (§1 rule 3):
  - the child count is `count(*)` on clear `is_minor`, `household_id` and `deleted_at`;
  - the label order is clear `created_at` and `id`;
  - the D5 check compares decrypted values in memory inside the write transaction, never in SQL.
- `app.persons.birthday_md` and `age_basis` are clear (`confidential-queryable`, `module.manifest.ts:50-51`) and hold values derived from a child's date of birth. After this chunk no reader returns them for a minor; they stay for the age-out job. §12.3 minimum data applies.
- Audit action `people.minor.field_viewed`, registered with purposes `people.minor.view.name`, `.date_of_birth`, `.email`, `.phone`, `.life_event.type`, `.life_event.date`, `.life_event.place` and `.life_event.notes`. Its target ids are the person id, plus the life event id for a life-event field. It carries no values.

## Rules touched

- **Permissions:** `people.restricted.read` narrows to adults. No new permission key: the rule is a role, as ADR 0017 point 3 says. A helper `isCommunityAdmin(tx, userId, communityId)` is added in `core/access` `public/`. `decide`'s guardian override stays for adult person-scoped reads and no longer reaches a minor (D6).
- **Second factor:** the fresh check (ADR 0022) is used up by a View. The recovery window never allows a View. The attempt rule changes as in O1.
- **Audit:** one event per successful View, ids only. A refused View is audited as a denial, as today.
- **Children (§1 rule 4):** this chunk is that rule's access half.
- **No personal data in URLs or logs (§1 rule 5):** View is a POST with ids in the body. Errors log codes only. The D5 refusal names no value.
- **Entitlements:** both View routes and the Minors tab sit behind `people.households`. Other gates are unchanged.
- **Tenancy:** `isCommunityAdmin` takes the community from the route's directory lookup and the person from the body. It checks inside the same RLS-scoped transaction that the person is in that organisation and community. It never trusts a pair it was given.

## Contracts

New:

- `POST /v1/people/minors/view`. Body `{ communitySlug, personId, field }`, where `field` is one of `name | dateOfBirth | email | phone`. Answer `{ value }`: `{ given, family }` (each a string or `null`) for name, a string or `null` otherwise.
- `POST /v1/people/minors/life-events/view`. Body `{ communitySlug, personId, lifeEventId, field }`, where `field` is one of `type | date | place | notes`. Answer `{ value: string | null }`.
- Identity `public/`: `consumeFreshFactor`. The second-factor routes are unchanged, except for the O1 give-back.

Changed answers (Zod in `packages/contracts`, OpenAPI regenerated):

- `/v1/households/read`: `minors` becomes `{ childCount }` for non-admins and `{ childCount, children: [{ personId, label }] }` for a Community Admin. The minor fields are removed.
- `/v1/households/list`: unchanged (minors were never listed). It is in the sweep.
- `/v1/households/rename`, `add-minor`: new refusal `422 { code: "label_contains_child_name" }` (O3). `/v1/households/rename` of a family with a child: 403 for a caller who is not a Community Admin, whatever the label.
- `/v1/people/list` `kind=minors`: Community Admin only (403 otherwise). Rows become `{ personId, label, householdId, householdLabel }`.
- `/v1/people/read` of a minor: 404 for every caller (D6).
- `/v1/people/life-events/list` for a minor: Community Admin only. Rows are `{ lifeEventId }`. Adult behaviour is unchanged.
- `add-minor`, the minor guardian link and unlink, and minor life-event create and update: role check as in Scope 6. Answers carry ids only.

This is a breaking narrowing of internal admin contracts. The only client is `apps/admin` in the same PR and there is no external consumer, so there's no `/v2`.

No events, no website collection, island or block.

## Risks

- **A path missed.** Mitigation: two sweep tests.
  - A route sweep seeds two organisations, two communities, a household with two minors and an adult, and callers holding each role. It calls every people, household, life-event and access route the non-admin callers can reach, plus the Community Admin's list and read routes. It asserts that no seeded minor's given name, family name, email, phone, date of birth or `birthdayMd` appears in any response body. For non-admins it also asserts that no seeded minor's person id appears. It fails when a route is added to those route files and not to its list.
  - A function sweep does the same for every function exported from `@community-hub/people` and `@community-hub/groups` `public/`, called as each actor, and fails on an unclassified export (Scope 1).
  - The View routes are covered by their own tests.
- **Freshness reused.** Two tabs racing, or a retry, could reveal two fields on one check. Mitigation: a single conditional update, and a concurrency test that uses a barrier, not timing.
- **The check used up and nothing shown** (a database error or revoked role after consume). Accepted. The admin checks again.
- **An existence oracle** (403 vs 404 tells a non-admin an id is a child). Mitigation: the role check runs first, then 404.
- **Lockout.** Mitigation: O1, with tests that 7 correct fresh checks in a row all pass and that 5 wrong codes still give `limited`.
- **The recovery session.** Mitigation: a test that a recovery session's first View returns `recovery_session` and the panel does not open.
- **Leaks through caching or logs.** Mitigation: `no-store` on every View answer, no value in any error, and a log-scan test for the seeded synthetic names.
- **The client keeps a value.** Mitigation: an admin test that the value is gone after the next View, after closing, and from the query cache.
- **A child's name in a family label (D5).** Mitigation: O3 option C. Non-admins cannot rename a family with a child and never see an answer that depends on a name, and `addMinor` checks the existing label. Residual: nicknames and misspellings, which the guidance covers.
- **Org owners surprised by losing access (D4).** Mitigation: the Users & Roles copy and the roadmap open item.
- **Tenancy.** Mitigation: the sweeps use two organisations and two communities, and a test shows `isCommunityAdmin` refuses a `community_admin` grant from another community.

## Out-of-band

- Project owner: O1, O2, O3 (option C) and O4 decided on 2026-11-28. There is nothing for him to run, and staging stays parked.
- Legal: none new. ADR 0017 is already accepted.
- Architecture: no new ADR. D1 and D4 are ADR 0017 as written. O1, O2 and O4 are status notes on ADR 0022 point 2 and ADR 0017 points 2 and 3. O3 is recorded on ADR 0017 point 7.
- No new subprocessor, AWS resource, cost or dependency.
