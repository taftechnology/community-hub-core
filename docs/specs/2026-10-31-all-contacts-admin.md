# Spec: All Contacts admin

Slug: all-contacts-admin
Status: approved (2026-10-31, Adnan Bin Hossen)
Amended after approval (2026-10-31): the access route, the column-level `UPDATE` grant, `version` on reads, the audit row carrying the person id only, and the nav rule are recorded in plan Deviations 3–14. The approver confirms these amendments before merge.
Architecture refs: §6.3, §10, §12.1, §12.3, AGENTS.md §1 rules 2–5, plan key `people.directory`. Implements the `All Contacts admin` row, the second Phase 2 journey. Depends on `people-households`, `access-roles`, `usage-facts` and `Groups`, all on `main`. Staging stays parked.

## Problem

A parish administrator cannot see, search, add or correct the people in their community. The `people` module stores persons, households and guardian links, but it has no list, no search, no update, no HTTP route and no admin screen. `createPerson` has no production caller, so `usage-facts` writes nothing in production. The nav item `Contacts & Members → All Contacts` does not exist.

## Scope

**In**

- `modules/core/people`: new public functions `listPersons`, `updatePerson`. `createPerson` and `readPerson` stay as they are. `readPerson` stays exported ungated from `people/public` (owner decision); permissions are enforced only by the access gate and the API layer, and routes call only `readPersonForActor`.
- `modules/core/access/infrastructure/restricted-read.ts`: `readPersonForActor` hardcodes `permission: "people.restricted.read"` (line 34, constant at line 10) for every person. It changes to check `people.view` for an adult and `people.restricted.read` for a minor, so a `people.view` holder can read an adult contact and no one else's minor. The gate looks up `is_minor` first, in the same transaction, and an unknown or cross-community id is the same denial as an unreadable minor. The existing guardian-view override for minors stays. Its denial audit keeps recording the permission that was actually required.
- Two new permissions, `people.view` and `people.manage`, added in the three places that hold the permission list: `packages/policy/src/decide.ts`, `modules/core/access/domain/role.ts`, and the CHECK constraint in `modules/core/access/db/schema.ts`. The CHECK change and the `version` column below are one expand-only migration, `0015` (`0014` is `groups`). Built-in grants in `CATALOGUE` (`modules/core/access/domain/role.ts`): `org_owner`, `org_admin` and `community_admin` receive both `people.view` and `people.manage`. No other built-in role changes; custom roles can grant either.
- Five routes in `apps/api`, in a new `people-routes.ts` shaped like `access-routes.ts`, with Zod bodies in `packages/contracts`.
- Admin: an `All Contacts` screen under `Contacts & Members` in `apps/admin`, with a list, search, a detail view, an add form and an edit form. This also fills the empty `entitlementMap` in `apps/admin/src/nav.tsx` for the people item.
- `apps/api/package.json` gains the `@community-hub/people` workspace dependency (with the lockfile update). `apps/api/Dockerfile` and `apps/api/src/image.test.ts` already list people, so neither changes; the plan re-checks.
- `module.manifest.ts` for people: the two permissions, the audit actions below. `dataClasses` and `manifest.test.ts` gain the `version` column.
- `architecture.md`: module catalogue and §12 note say what shipped. The last commit updates `docs/roadmap.md`: `All Contacts admin` **done**, snapshot, next chunk.

**Out**

- Creating or editing a **minor**. A minor needs a household and a guardian link, so it belongs to `Family Records` (household UI). This chunk lists and reads minors for privileged callers only.
- Households, guardian links, life events, tags UI, bulk import, export, merge or delete of a person. No delete route in this chunk.
- Any public or website exposure of contacts. No Public Content API collection; children never appear in public content (§1 rule 4).
- Searching a minor by name. Their names are encrypted (§1 rule 3); there is no blind index on name and this chunk adds none.
- Changing `readPerson`, or the Groups tables' cross-community key hardening (separate open item).

## Behaviour

**List.** `POST /v1/people/list` returns one page of persons for the caller's community. Two modes, chosen by the request's `kind` field:

- `adults` (default). Needs `people.view`. Rows are `is_minor = false` only, filtered in SQL. Columns come from the clear `given_name` and `family_name`. Ordered by family name, given name, id; keyset pagination on that tuple; page size 1–100, default 50. Search is a case-insensitive **prefix** match on the clear name columns, or an **exact** match on email or phone through the blind index (the server detects `@` vs digits and never echoes the term back in an error or log). No decryption happens in this mode.
- `minors`. Needs `people.restricted.read`. A caller without it gets 403 and a `people.permission.denied` audit row. The caller never sees a "minors hidden" count. `listPersons` first queries `app.persons` for the community's minor ids (`is_minor = true`, keyset on creation time then id, page size capped), and only then resolves names by passing that page of ids to `readRosterNames` with `includeRestricted` set by the server. That decrypts under the household key, ordered by creation time then id (names are encrypted so name order is impossible). No name search in this mode.

`includeRestricted` is **never** a request field. Contract schemas are `.strict()`, so a body that carries it is a 400. The server computes it from `decide(people.restricted.read)` for the actor on every request.

An unprivileged caller therefore cannot learn whether a minor exists: the adult list omits minors in SQL (not blank rows, unlike `readRosterNames` today), and the minors mode is refused.

**Read.** `POST /v1/people/read` takes a person id. It calls `readPersonForActor`, the gate, as changed above: it decides, audits a denial, decrypts, and audits the read. Adults: `people.view` returns the clear and confidential fields of an adult. Minors: needs `people.restricted.read` or a guardian view, as `decide` already encodes. A caller without it, or an id from another community or organisation, gets the **same** 404, so the response does not say whether the id exists. Every read that decrypts writes an audit row carrying ids only. Detail returns the person's fields and `version`, including email and phone (decrypted). Tags and the activity log are not shown in this chunk (Deviation 14).

**Create.** `POST /v1/people/create` needs `people.manage` and creates an **adult** (`isMinor` is not a request field; the route passes `false`). Fields: given name, family name, optional email, phone, date of birth. A duplicate email or phone (the partial unique blind-index) returns 409 with no hint which field matched. `createPerson` already writes its audit row and the `people.directory` usage fact; this is the first production caller.

**Update.** `POST /v1/people/update` needs `people.manage`. It changes the same adult fields, recomputes the blind indexes, and writes one audit row carrying the person id only, never values or field names (the audit API records action, purpose and target ids; see the plan's Deviation 5). Updating a minor returns 404 as above. Optimistic concurrency: the body carries the `version` read earlier; the update runs `where version = $1` and sets `version = version + 1`, so a mismatch returns 409 and nothing is written.

**Billing.** `list` and `read` are `billing: "read"`. `create` and `update` are `billing: "write"`, so a read-only organisation gets the existing 402.

**Entitlement and nav.** The routes check the `people.directory` entitlement on the server. The admin hides `All Contacts` when the community lacks it and when the user lacks `people.view` (the list needs it; Deviation 14); no control is rendered that would only return 403. `Add` and `Edit` show only with `people.manage`. The `minors` tab shows only with `people.restricted.read`.

**States.** Empty community: "No contacts yet" with an Add button when permitted. Search with no match: "No contacts match". Network or 5xx: an alert with retry, no raw error text. 402: the existing billing banner. Offline: not supported; the screen shows the error state.

**Accessibility.** The screen composes `packages/ui`; if the table, input or dialog needed does not exist, the plan adds only those components to `packages/ui` with axe tests. WCAG 2.2 AA is a merge gate (D16).

## Data

No new tables. One expand-only migration, `0015`, does three things:

1. Widens the permission CHECK in `modules/core/access/db/schema.ts` (line ~153) to admit `people.view` and `people.manage`.
2. Adds `version integer not null default 1` to `app.persons`. `app.persons` has neither `version` nor `updated_at` today. The default fills existing rows, so it is backward compatible with the deployed service. The column is classified `internal` in `dataClasses` in `modules/core/people/module.manifest.ts` and in `modules/core/people/manifest.test.ts`, in the migration task.

3. Grants `UPDATE` on `app.persons` to `app` for the columns `updatePerson` writes only (`given_name`, `family_name`, `email`, `email_bidx`, `phone`, `phone_bidx`, `date_of_birth`, `birthday_md`, `age_basis`, `version`). `0005` had revoked `UPDATE`; `is_minor`, `household_id`, scope ids and ciphertext name columns stay unwritable. `app` still lacks `DELETE`.

Recovery note for the plan: the CHECK is restored once no grant uses the new keys; the column `UPDATE` grant is revoked (`REVOKE UPDATE (...) ON app.persons FROM app`); the `version` column is left in place (dropping it is a later contract PR).

Possibly one index on `app.persons (org_id, community_id, family_name, given_name, id)` for the keyset page, with a lower-cased prefix variant if the query needs it, and one for the minors page on `(org_id, community_id, created_at, id)` if `persons` has such a column. The plan confirms with `EXPLAIN` on synthetic data; any index starts with `org_id`. Other columns involved are already classified: `given_name`, `family_name` clear (adults only), `is_minor` clear; `email`, `phone`, `date_of_birth` and minors' names are confidential or restricted and are decrypted only by the existing functions.

## Rules touched

- Permissions: new `people.view`, `people.manage`; existing `people.restricted.read`. Checked in the API and mirrored in the admin; jobs do not touch contacts.
- Entitlement key `people.directory`, checked in the routes and the nav.
- Consent, retention, residency: none changed. Everything runs in the regional service. No new outbound call.
- Safeguarding: minors never appear in an unprivileged list; their names are decrypted only under the household key by a caller holding `people.restricted.read`, and each such decrypt is audited.
- Tenancy: every query goes through `packages/db` helpers inside `withAppTransaction`. The community id comes from `findCommunityBySlug`, never from request input beyond the slug. A route never passes an organisation or community id it did not look up itself.

## Contracts

All `POST`, JSON, `.strict()`, body under the 4096-byte cap, no personal data in paths or query strings (search terms travel in the body; they are not logged).

| Route               | Permission                                           | Billing | Body (besides `communitySlug`)                                | Success                                                   |
| ------------------- | ---------------------------------------------------- | ------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| `/v1/people/list`   | `people.view`; `people.restricted.read` for `minors` | read    | `kind`, `search?`, `cursor?`, `limit?`                        | `{ items, nextCursor }`                                   |
| `/v1/people/read`   | `readPersonForActor`                                 | read    | `personId`                                                    | person detail                                             |
| `/v1/people/create` | `people.manage`                                      | write   | `givenName`, `familyName`, `email?`, `phone?`, `dateOfBirth?` | `{ personId }`, 201                                       |
| `/v1/people/update` | `people.manage`                                      | write   | `personId`, `version`, changed fields                         | new `version`                                             |
| `/v1/people/access` | any role in the community                            | read    | none                                                          | `{ directoryEnabled, canView, canManage, canReadMinors }` |

`/v1/people/access` (added after implementation found the admin had no way to learn the caller's own permissions or the community's entitlements without holding a user-admin permission) returns four booleans for the caller: whether the community has `people.directory`, and whether the caller holds `people.view`, `people.manage`, and `people.restricted.read`. It reports; it does not enforce. A caller with no role in the community, or an unknown slug, gets the same empty 403 as the other routes. It carries no personal data and nothing about other users.

Errors are empty-body status codes through `statusFor`: 400 shape, 401, 403, 404 (absent, cross-community and unreadable minor all identical), 409, 402.

Audit actions registered in people: `people.person.listed_minors`, `people.person.updated`, plus the existing created, read and denied actions. Events published: none. Port changes: none. No website collection, island or block.

## Decisions this chunk records

1. **Minors are omitted, not redacted, in the adult list.** `readRosterNames` returns blank rows for minors without the flag; the list does not use it for adults, so an unprivileged admin cannot count children.
2. **Adults are created and edited here; minors are not.** The household chunk owns that.
3. **Name search covers adults only**, by clear prefix. Email and phone are exact only.
4. **`readPersonForActor` checks `people.view` for adults and `people.restricted.read` for minors**, replacing the single hardcoded permission.

## Risks

- **Tenancy.** A list or update that trusts a supplied community id, or a missing `org_id` filter. Mitigation: ids come from the directory lookup; a two-organisation test for each route; weaken-and-fail checks on the filter.
- **Children's data.** A minor surfacing in an unprivileged list or search, in an error message, or in an audit row. Mitigation: SQL `is_minor = false`, identical 404, ids-only audit, must-fail tests with a minor fixture for list, search, read and update.
- **Permission swap** (`people.view` vs `people.manage` vs `people.restricted.read`). Each pinned by a test that fails when the key is swapped.
- **`includeRestricted` from input.** A strict-schema test and a test that a body carrying it is 400.
- **Low-count inference.** A prefix search that returns few rows can reveal who exists. Accepted for adults inside one community for staff who already hold `people.view`; named here so a reviewer can disagree.
- **Search term in logs.** Terms are personal data. A test asserts no log line, audit row or error carries the term.
- **Money.** None.

## Tests

- Unit and integration for `listPersons`, `updatePerson`: keyset order and paging, prefix search, blind-index exact match, duplicate email/phone, concurrency conflict, two-organisation isolation, cross-community id, minor fixture excluded from every adult path.
- Route tests per route: 401, 403, 404 identity, 400 on extra fields (including `includeRestricted`, `isMinor`, `orgId`), 402 on write routes for a read-only organisation, entitlement off, success.
- Security-setting table in the plan, each with the test that pins it and the source change that must make it fail: `is_minor = false` filter, `includeRestricted` derivation, permission keys per route, identical 404, audit-on-decrypt, org filter, billing marking of write routes.
- Admin: render tests per state, gated controls, axe on list, detail and form.
- No staging proof (see Cost).

## Size

Probably larger than the Groups chunk: two package functions, a migration, five routes, contracts, a screen with three views, and `packages/ui` additions. It stays one pull request; the plan orders it people functions → migration and permissions → contracts → routes → ui → admin → docs.

## Cost

No new billed resource. Staging stays parked. Live proof is not strictly required: routes run against the test database like the access routes did. A later chunk that unparks staging verifies migrations `0013`, `0014` and this chunk's permission migration together; that line goes into the roadmap open items.

## Out-of-band

- Legal: none. Contacts are already classified; no new subprocessor, no data leaves Australia.
- Architecture: §12 note and module catalogue row updated in the same pull request. No ADR unless Decisions 1–3 are changed by the owner.
- This chunk touches children's data, tenancy and the database, so it needs the second fresh-context review before merge.

## Human

Owner decisions recorded 2026-10-31 (review of the first draft):

1. Built-in roles: `org_owner`, `org_admin`, `community_admin` get `people.view` and `people.manage` via `CATALOGUE`; other built-in roles unchanged; custom roles can grant either.
2. The privileged `minors` list is in this chunk.
3. `readPerson` stays exported ungated from `people/public`; enforcement is the access gate and the API layer.

The admin UI stays minimal and focused (list, search, detail, add, edit) to respect the ~800 changed-line target. If the plan shows it will exceed that, the plan says so and the owner decides; line count alone is not a reason to split.

## Rollback

Revert the pull request. The permission migration is expand-only; if rolled back after a grant uses the new keys, delete those grants first, then restore the old CHECK. Nothing else is stored by this chunk.

## Next spec after this lands

`Family Records` (household UI, minor creation and guardian links).
