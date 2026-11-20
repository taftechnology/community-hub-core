# Spec: All Contacts parity

Slug: all-contacts-parity
Status: approved (2026-11-20, Adnan Bin Hossen)
Architecture refs: §6.3, §11.1, §12.1, §12.2.1, §12.3; ADR 0017; AGENTS.md §1 rules 2, 3, 4, 5; §2; §6; §7; §8; §13. Cut from the Phase 2 row `People screens: Laravel parity` (first of three chunks, chunk owner decision 2026-11-19). Feature list: the owner's Laravel feature decisions page, group A (All Contacts) and group B (contact source and status), and the owner's answers of 2026-11-20, checked in the Laravel code. Layout: the All Contacts board in the admin screens canvas.

**Sensitive chunk** (tenancy, bulk decryption of personal data, a database migration with a grant change). It needs a second fresh-context review on a model that differs from every implementer model used in this chunk and from the reviewer agent's (AGENTS.md §2).

Revision 2 (2026-11-20) applies the fresh-context spec check (Claude Sonnet, READY WITH CHANGES, 4 High, 7 Medium, 11 Low).

## Problem

Staff in Laravel see each contact's email, phone, age, date added, groups, source and status on All Contacts, can switch a contact Active or Inactive in the row, and can filter by status, source and group. Core's All Contacts (`apps/admin/src/all-contacts.tsx:776-815`) shows a given name, a family name and a View button, with a name prefix or exact email or phone search (`list-persons.ts:148-196`). A parish moving from Laravel loses all of that, and the importer has nowhere to put a contact's source and status (decisions page, group B).

## Scope

In:

- Migration `0021`: three clear columns on `app.persons` (`status`, `source`, `created_at`), a column `UPDATE` grant on `status` and `source`, and a backfill of `created_at` (Data, below).
- The adult list (`POST /v1/people/list`) returns, per adult: email, phone, age in whole years, date added, status, source, and the contact's active groups. It takes three new optional filters: `status`, `source`, `groupId`.
- `POST /v1/people/read` returns `status` and `source` too, so the edit form can show the current source.
- `POST /v1/people/status`: set one adult's status (the inline Active switch).
- `POST /v1/people/summary`: four counts for the cards, and the community's active groups for the group filter.
- `source` on create and update: staff pick **Manual** or **Family Records**. `add-adult` and `add-minor` record **Family Records**.
- Three read functions in the groups module's `public/`, composed by the API route: the active groups of a set of people, the people in one active group, and the community's active groups (`listGroups`, already exported).
- `@community-hub/groups` as a dependency of `apps/api`: `apps/api/package.json`, the Dockerfile build `--filter` (`apps/api/Dockerfile:8`) and the image test's package list (`apps/api/src/image.test.ts:157`), as the roadmap's open item on group routes requires.
- The All Contacts screen: the board's columns, the inline Active switch, the status, source and group filters, the four count cards, and a Source select on the add and edit forms.
- `architecture.md` (Architecture, below; AGENTS.md §13).
- Last commit: `docs/roadmap.md` and the `AGENTS.md` Repository state row (Roadmap, below).

Out:

- **CSV export and the print view. Removed on purpose (owner decision, 2026-11-20).** Laravel built a page-only CSV and a print view that included children. Core builds neither. The roadmap records it under "Intentionally dropped".
- Delete, hide and restore: the next chunk, `Contact delete`.
- Gender, address, and the groups list on Contact Details: a new row, `Contact Details parity`.
- Any change to the Minors tab or to what a minor's row returns (ADR 0017).
- Sending email to contacts. No such code exists. This chunk records the rule Broadcast Messages must follow.
- Any groups route, any `groups.*` permission check, and any change to the capabilities route. The Groups screen chunk adds `groups.manage` and `groups.export` to the permission catalogues and checks them.
- Numbered pages and "of 233". The list stays cursor-paged; the cards give the totals.
- Indexes on `app.persons` (open item, unchanged).
- A staging run. Staging stays parked.

## Behaviour

### List (`POST /v1/people/list`)

Same route and gates: `people.directory` entitlement, `people.view` for `kind: "adults"`, billing `read` (`apps/api/src/people-routes.ts:223-288`). The body gains three optional fields, all strict:

| Field     | Type                   | Effect                                    |
| --------- | ---------------------- | ----------------------------------------- |
| `status`  | `active` \| `inactive` | only adults with that status              |
| `source`  | one of the source keys | only adults with that source              |
| `groupId` | uuid                   | only adults who are members of that group |

They combine with each other and with the existing search (AND). `kind: "minors"` refuses all three with 400.

`groupId` is resolved inside the caller's tenant scope through `personIdsInGroup`. A group in another community or organisation, an unknown id, and an archived group all give the same empty page, never an error that confirms the id exists. A `groupId` sent when the community lacks `groups.basic` is refused with 403, like any entitlement miss. The people query applies the returned ids **and** `is_minor = false`, so a minor in the group never appears.

The list item becomes a discriminated union on `isMinor` (`packages/contracts/src/people.ts:58-65`). A minor's item is unchanged. An adult's item gains:

| Field       | Value                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`     | decrypted, or `null`                                                                                                                                                                                                                                  |
| `phone`     | decrypted, or `null`                                                                                                                                                                                                                                  |
| `age`       | whole completed years on today's civil date in `Australia/Sydney`, the zone the people domain already uses for age (`person.ts:42-52`), from an injected `now`; `null` when there is no date of birth. The date itself is never returned in the list. |
| `createdAt` | ISO instant                                                                                                                                                                                                                                           |
| `status`    | `active` \| `inactive`                                                                                                                                                                                                                                |
| `source`    | source key                                                                                                                                                                                                                                            |
| `groups`    | `[{ id, name }]`, active groups only, by name. The key is **absent** when the community lacks `groups.basic`, and `[]` when it has it and the contact is in no active group.                                                                          |

Keys and cost. Adults' fields are always under the community key (`person-keys.ts:32-40`, `person.ts:197`, `update-person.ts:228-231`). `listPersons` derives that key **at most once per request**, and reuses it for an email or phone search's blind index (today derived separately at `list-persons.ts:160` and `:181`) and for the page decrypt. It derives nothing when the page is empty or no row on it has an email, phone or date of birth and no search needs a blind index. The derive costs one KMS Decrypt of the organisation key, and the community key is then unwrapped locally (`keys.ts:116-180`). The list uses a read path that never creates keys (`openExistingCommunityHkdf`, `keys.ts:182-212`, or equivalent). A test counts KMS calls: one for a page with contact details, one for an email search with contact details, zero for an empty page.

If any ciphertext on the page fails to open, the whole request fails with 500 and the log carries the error class only, never a value, an id or SQL (§1 rule 5).

Each successful adult page with at least one row writes **one** audit event, `people.person.listed`, with the page's person ids as `targetIds` and nothing else. An empty page writes none. The minors list keeps `people.person.listed_minors` (`list-persons.ts:279-285`).

The response carries `cache-control: no-store`, as do `read` and `summary`.

### Read (`POST /v1/people/read`)

`readPerson` (`person.ts:297-387`) and `ReadPersonResponse` (`packages/contracts/src/people.ts:72-84`) gain `status` and `source`. The route passes `readPersonForActor` output through unchanged (`people-routes.ts:313-317`); only its type changes. For a minor, `status` and `source` are not returned (ADR 0017); the read response stays a union on `isMinor` as today.

### Status (`POST /v1/people/status`)

Body (strict): `communitySlug`, `personId`, `version`, `status`. Route entry: surface `tenant`, entitlement `people.directory`, permission `people.manage`, billing `write`. The SQL carries `org_id`, `community_id` and `is_minor = false` explicitly, as `update-person.ts:153-156` does, as well as RLS.

- A minor's id, or an id in another community or organisation, gives the same 404 as an unknown id.
- A stale `version` gives 409, including when the requested status equals the stored one.
- A changed status bumps `version`, returns `{ version, status }`, and writes audit `people.person.status_changed` with `targetIds: [personId]` only.
- A current `version` with the status already stored returns `{ version, status }` unchanged, bumps nothing and writes no audit.
- Because a change bumps `version`, an edit form opened before the switch gets 409 on save. That is intended.

Inactive changes nothing else today: the contact stays in lists, groups and pickers, and its status stays visible (Laravel: groups unchanged). Laravel sends contact emails only to status Active, so the Broadcast Messages row gains that rule.

### Summary (`POST /v1/people/summary`)

Body (strict): `communitySlug`, `addedSince` (ISO 8601 instant with offset; anything else is 400). Route entry: surface `tenant`, entitlement `people.directory`, permission `people.view`, billing `read`, `cache-control: no-store`.

Returns `{ total, active, inactive, addedSince, groups? }`: counts over the caller's community's adults only (explicit `org_id`, `community_id`, `is_minor = false`), and `addedSince` counts adults with `created_at >= addedSince` (a future instant gives 0). `groups` is `[{ id, name }]`, the community's active groups by name, present only when the community has `groups.basic`. The admin uses its presence to show the Groups column and filter, so no control can only 403 (AGENTS.md §6). Minors are never counted.

The admin sends the start of the current month in the browser's time zone, because no community time zone is stored and the viewer's month is what "this month" means on their screen. Age stays in `Australia/Sydney` because that is an existing domain rule that also decides who is a minor.

### Source

Keys: `manual`, `family_records`, `website`, `form`, `donation`, `event_rsvp`, `event_booking`, `volunteer_application`, `mobile_app`, `mobile_app_family`, `auto`. Labels are Laravel's: Manual, Family Records, Website, Form, Donation, Event RSVP, Event Booking, Volunteer Application, Mobile App, Mobile App Family, Auto. Laravel shows "Form: <title>"; the Forms chunk adds the form reference, and until then the label is "Form".

`POST /v1/people/create` and `POST /v1/people/update` take an optional `source` of `manual` or `family_records` only; any other key is 400. Create defaults to `manual`. Update without `source` leaves it unchanged. `source` joins `UpdatePersonChanges`, counts as a change for the "nothing to change" check (`update-person.ts:208-216`), and a source-only update derives no keys. `add-adult` and `add-minor` record `family_records`. The other keys are written only by later modules and the importer.

A minor's `status`, `source` and `created_at` are stored (defaults, and `family_records` from `add-minor`) and never returned or shown.

### Screen

All Contacts, adults tab, for a caller with `people.view`:

- Columns in the board's order: Name (given and family, the age under it when known, for example "42 years old"), Email, Phone, Date (en-AU in the browser's zone, for example 5 Jan 2026), Groups (chips; "None" when empty; the column is absent when the summary has no `groups` key), Source (label), Status. Empty email or phone shows "None".
- Status is a `Switch` with an accessible name that includes the contact's name, on when Active. It renders as a `StatusBadge` instead when the caller lacks `people.manage` **or** billing is read-only (`hideWrites`). While the request runs, the switch is disabled. On 409 the list reloads and an alert says the contact changed; on any other failure the switch returns to its old position and an alert names the failure.
- Search stays in `FilterBar` (`packages/ui/src/filter-bar.tsx`). Three `Select`s beside it: All statuses / Active / Inactive; All sources / each source label; All groups / each active group from the summary (absent with no `groups` key). Changing a filter resets the cursor. `FilterBar` is not changed.
- Four count cards above the table: Total contacts, Active, Inactive, Added this month. They load from the summary; a summary failure shows "Counts unavailable", hides the group filter and the Groups column, and leaves the list working.
- The add and edit forms gain a Source select with Manual and Family Records. `ContactFields` is shared with Family Records (`family-records.tsx:1792`), so the select is an optional prop that only All Contacts passes. On edit, when the current source is another key, the select's first option is "Keep current (<label>)" and is selected; the form sends `source` only when staff pick Manual or Family Records.
- A filter with no matches shows "No contacts match these filters" with a Clear filters button.
- 375px: the table scrolls inside its own container, never the page. Light and dark, WCAG 2.2 AA, 44px touch targets, checked in a browser at 1280px and 375px in both themes before the pull request.

## Data

Migration `0021`, expand only, one wave:

| Column               | Type                                                              | Class    | Notes                                 |
| -------------------- | ----------------------------------------------------------------- | -------- | ------------------------------------- |
| `persons.status`     | `text not null default 'active'`, check in (`active`, `inactive`) | internal | clear: filtered and counted (§12.2.1) |
| `persons.source`     | `text not null default 'manual'`, check in the eleven keys        | internal | clear: filtered                       |
| `persons.created_at` | `timestamptz not null default now()`                              | internal | clear: shown, counted                 |

- `GRANT UPDATE (status, source) ON app.persons TO app`. `created_at` is not granted. The privileges integration test (`privileges.integration.test.ts:149-200`) pins the new updatable set, with `created_at` not updatable.
- Backfill of `created_at` inside the migration, using the per-community `set_config(..., true)` loop of migration `0019` (`0019_spotty_cloak.sql:60-90`), because `app.persons` has FORCE RLS and the migrator has no BYPASSRLS; settings are reset afterwards. Value: `coalesce` of the earliest `person_activity` row of kind `created`, then the earliest activity row of any kind, then `now()`. A migration test covers two communities of one organisation, a person with no activity row, and a person with two activity rows. No customer data exists in any environment.
- `createPerson` writes `created_at` from its `now` input and `source` from a new input field.
- The three columns go in the people `module.manifest.ts` `dataClasses` as `persons.status`, `persons.source`, `persons.created_at`, with the `manifest.test.ts` pin, in the migration task.
- No new table, no new key, no encrypted column, no index.

Recovery: the columns are new and nothing outside this chunk reads them. Reverting the code leaves them unused; a later contract pull request may drop them. The grant is removed with `REVOKE UPDATE (status, source)`.

## Rules touched

- Permissions: `people.view` (list, read, summary), `people.manage` (status, source on create and update). No new permission. No `groups.*` permission is checked: group names are shown to `people.view` holders (chunk owner decision 7). The groups permissions are not in any of the three catalogues (`packages/policy/src/decide.ts`, `modules/core/access/domain/role.ts`, `packages/contracts/src/access.ts`) today, and this chunk leaves them out.
- Entitlements: `people.directory` on every route here; `groups.basic` for `groupId`, the `groups` item key and the summary's `groups`.
- Audit: `people.person.listed` and `people.person.status_changed`, registered with `defineAuditAction` and `defineAuditPurpose` in `modules/core/people/public/index.ts`, ids only, passing the event-names check.
- Usage facts: list, read, summary and status record none. Only `createPerson` records `people.directory`, as today.
- Children: a minor is never in the adult list, the counts, a group lookup result shown on screen, or the status route. The groups functions do not know who is a minor; the guarantee is that the people query applies `is_minor = false` after the group ids. Must-fail tests at the list level: a minor in the filtered group never appears, and a minor's group never appears on an adult's row.
- Residency: no new outbound call. KMS stays in `ap-southeast-2`.
- No personal data in URLs, logs or audit payloads: filters go in the POST body, audit carries ids, error logs carry the class only.

## Contracts

- `packages/contracts/src/people.ts`: list body (`status`, `source`, `groupId`, refused for minors), list item as a union on `isMinor`, read response (`status`, `source` for adults), `personStatusBody` and its response, `peopleSummaryBody` and its response, `source` on create and update. A contract test for each.
- Routes: `POST /v1/people/status`, `POST /v1/people/summary`.
- Groups `public/`: `activeGroupsForPersons(tx, personIds)` and `personIdsInGroup(tx, groupId)` (active groups only), plus the existing `listGroups`, all inside the transaction's tenant scope. The API route composes them; the people module does not import groups (groups already requires `core.people`).
- No new event, island, block or collection. The capabilities route does not change.

## Risks

- **Bulk decryption.** A page holds up to 100 emails and phones (`limit` maximum). Mitigation: the `people.view` gate used for a single read, one audit event per page, one key derive per request, no date of birth, `no-store`.
- **Cross-tenant group filter.** Mitigation: resolved inside RLS with explicit predicates; tests with two organisations and two communities of one organisation, including a `groupId` from the other community.
- **Minors through a group.** `addMember` has no minor check (`members.ts:105-118`). Mitigation: `is_minor = false` in the people query; the must-fail tests above.
- **Status race.** Mitigation: `version` check, 409, list reload.
- **Migration under FORCE RLS.** Mitigation: the `0019` loop and a migration test.
- **Counts reveal.** Adults only, for `people.view` holders who can already list them.

## Architecture

- §12.1: the `app` column `UPDATE` grant on `app.persons` now covers `status` and `source` as well (the sentence that says ten columns; the real count is already eleven with `household_id`).
- §12.2.1: `people.date_of_birth` is decrypted on the adult list to derive an age, and never returned there.
- The people routes line (about `architecture.md:563`): six routes under `/v1/people/`, the list's new fields and filters, `read` returning status and source.
- The rule that an inactive contact is left out of contact emails and broadcasts.

## Roadmap

The last commit updates `docs/roadmap.md`:

- Splits the row `People screens: Laravel parity` into `All Contacts parity` (done), `Contact delete` (not started: hide, restore within 30 days by staff with the delete permission, then permanent delete of the contact with its group memberships and history, family and life-event references cleaned up, audit keeps ids; a hidden contact is left out of every list, email, group and picker; the purge runs as a sweep on contact actions until the regional scheduler exists), `Groups screen` (not started: the screen, the routes, `groups.manage` and `groups.export` in the catalogues, group colour and category), and `Family Records parity` (not started: family status, delete a family, move a child, edit a child, emergency contacts, pastoral notes).
- Adds `Contact Details parity` (not started: gender, address, the groups list).
- Adds to "Intentionally dropped": All Contacts CSV export and print view (owner, 2026-11-20).
- Adds to the Broadcast Messages row: contacts with status Inactive are left out.
- Updates the open item on group routes: `apps/api` now depends on groups; the Groups screen chunk still checks `groups.manage` and `groups.export`.
- Snapshot: last shipped `all-contacts-parity`, next `Contact delete`; Phase 2 and `AGENTS.md` Repository state counts updated for the split.

## Out-of-band

- No legal sign-off, no new vendor, no new AWS resource, no cost.
- No ADR; architecture updates per §13.
- Verified by tests and a local browser check, not on the staging hostname (staging stays parked), as in the last four chunks.

## Chunk owner decisions (Adnan, 2026-11-20: all seven as recommended)

1. Status gets its own route rather than a field on update. The switch has only the row's version and status, and update's body carries names.
2. One audit event per adult list page, because the list now shows contact details for up to 100 people at a time.
3. The age, not the date of birth, in the list.
4. "Added this month" from the browser's month start, because there is no community time zone.
5. The Groups column and filter need `groups.basic` and show active groups only.
6. An automatic source is kept on edit unless staff pick Manual or Family Records.
7. (Revision 2.) Group names are shown to `people.view` holders with no `groups.*` permission check; the Groups screen chunk adds the groups permissions. The board shows a contact's groups to anyone who can open All Contacts.
