# Spec: Family Records

Slug: family-records
Status: approved (2026-11-01, Adnan Bin Hossen)
Amended after approval (2026-11-01): move-adult also requires `people.restricted.read`, because its guardian-link refusal reveals that an adult has a dependant. Confirmed by the approver, Adnan Bin Hossen.
Architecture refs: §9 (family — Family Records, `core/people`; access routes), §12.1, §12.2.1, §12.3, §13; roadmap Phase 2 row "Family Records"

## Problem

An administrator can manage adult contacts (All Contacts) but cannot see or manage a household. Households, guardian links and minors exist in `core/people`, but no HTTP route reaches them, so staff cannot group family members, record who a child's guardian is, or see who is in a household. The nav item "Family Records" is a plain label that goes nowhere. Nav gating also depends on a people-specific `/v1/people/access` route that the roadmap says must be replaced before the next module needs gating.

## Scope

In:

- Household routes in the regional service: list, read (members and guardian links), create, rename.
- Membership: move an existing adult into or out of a household; add a new minor with a guardian; link and unlink a guardian.
- Admin "Family Records" screen: household list, household detail, create and rename, member and guardian actions.
- One capabilities route in the access module (`apps/api/src/access-routes.ts`). `/v1/people/access` is retired in the same chunk and All Contacts moves onto the new route.
- Nav hide/show for Family Records through that route.
- `architecture.md` §9 updated in the same PR (see Out-of-band).

Out (explicitly):

- **Life events (baptism, marriage, first communion, funeral).** Confirmed by the owner as the next chunk. Decisions already taken for it: they live in `core/people` (not `engagement`; `architecture.md` line 350 is corrected in that chunk), are `restricted` and field-encrypted, household-keyed for a minor, and read needs `people.restricted.read`.
- Public or Parish Hub exposure of any household or child. No website collection in this chunk.
- Guardian read by a guardian (member portal/app).
- Bulk import of households. The foreign-key hardening in the roadmap open items applies before any second writer ships.
- Deleting a household. The `app` role has no DELETE.
- Re-homing a minor to another household. A minor's fields are sealed under their household key; moving one needs a re-encryption design that is not part of this chunk.
- Minors with `age_basis = 'unknown'`.

## Behaviour

**Household list.** Ordered and keyset-paged by `id` alone. `app.households` has no creation timestamp column, and the label is restricted and encrypted (§1 rule 3), so the list neither sorts nor searches by label or creation time. Page size defaults to 25, maximum 25. Each row: `householdId`, `version`, `label` (only if the caller holds `people.restricted.read`; otherwise `null`), and `adultCount`. The list writes **one** audit event with all returned ids in `targetIds` (the `listed_minors` pattern), not one per row.

**Household read.** `householdId`, `version`, `label` (restricted callers only), adult members (names under the same rules as All Contacts), guardian links (`guardianId`, `childId`, rights). For a caller holding `people.restricted.read`: minor members with names and dates of birth. For a caller without it: no minor appears, no minor count, no minor flag, and guardian links that reference a minor are omitted. (Chosen default for §1 rule 4; see Owner decisions.)

**Create household.** Optional label. **Rename.** Takes the household `version`; 409 on mismatch; bumps `version`.

**Move adult.** Sets or clears an adult's household. Takes the person's expected `version`; 409 on mismatch; bumps `version`. Refused with 409 while the adult is the guardian on any link: the caller must unlink first, and that unlink is itself subject to the last-guardian rule. A minor is refused (400) and never moved.

**Add minor.** One request, one transaction: creates the person, the guardian link and the audit events, or nothing.

- A date of birth is required and must resolve to under 18. A date that resolves to an adult is rejected (400) and no row is written.
- Given and family name required.
- The minor has no email or phone in this chunk (the fields are not accepted).
- The request names one guardian: an adult already in that household. `linkGuardian` enforces this.
- Guardian rights default to view and consent true, others false; the request may set rights, and at least one right must be true (existing CHECK).

**Link guardian.** Adult and minor in the same household. Duplicate triple → 409. **Unlink guardian.** Body is `householdId` and `linkId`; the route verifies the link belongs to that household. The transaction first locks the child's person row (`select … for update`), counts the child's remaining links, and refuses with 409 if the unlink would leave none. Any link counts as a guardian, whatever rights it carries.

**States.** No households: "No households yet". Household with no members: shown with an empty member list. A caller lacking permission sees the nav item hidden, and a refused route returns 403. Stale version 409. Missing household, person or link 404. A household, person or link in another community or organisation 404, with no existence leak. All error bodies are empty and carry no minor identity. Offline is not supported; the screen shows a retry state, as All Contacts does.

## Permission matrix

Routes record `people.permission.denied` audit with 403, as `people-routes.ts` does. Today only owner, admin and community_admin hold `people.view` and `people.manage`; `safeguarding_officer` holds only `people.restricted.read`; `staff` holds none (`packages/policy/src/decide.ts:19-31`).

| Route                      | Needs                                            | Notes                                                          |
| -------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `households/list`          | `people.view`                                    | Label and minors shown only with `people.restricted.read` also |
| `households/read`          | `people.view` or `people.restricted.read`        | Same field rules as above                                      |
| `households/create`        | `people.manage`                                  |                                                                |
| `households/rename`        | `people.manage`                                  |                                                                |
| `members/move-adult`       | `people.manage` **and** `people.restricted.read` | Its guardian-link refusal would otherwise reveal a dependant   |
| `members/add-minor`        | `people.manage` **and** `people.restricted.read` | Owner-confirmed                                                |
| `guardians/link`, `unlink` | `people.manage` **and** `people.restricted.read` | They change a child's access; default, see Owner decisions     |
| `access/capabilities`      | a session with any role grant in the community   |                                                                |

Every household route also requires the `people.households` entitlement (see Owner decisions).

## Data

| Table.column                                            | Change                                      | Class (§12.1)                                                        |
| ------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `app.households.version` (integer, not null, default 1) | new, optimistic concurrency                 | `internal`; not personal data                                        |
| `app.households.label`                                  | existing, now updatable                     | `restricted`, household-key encrypted; no blind index, no SQL filter |
| `app.persons.household_id`                              | existing, now updatable (adults only)       | `internal` identifier, clear; join key                               |
| `app.guardian_links`                                    | rows inserted and deleted; no column change | existing classes                                                     |

Migration `0016`, expand-only, verified by the owner and the review against 0005, 0015 and 0000:

- `GRANT UPDATE (label, version) ON app.households TO app;`
- `GRANT UPDATE (household_id) ON app.persons TO app;`
- A `BEFORE UPDATE` trigger on `app.persons` that raises when `old.is_minor` and `new.household_id is distinct from old.household_id`. A column grant cannot be limited by row, so "adults only" is enforced at the database as well as in the application. The application keeps `where is_minor = false`.
- No `guardian_links` grant: `app` already has INSERT and DELETE there from the default privileges (0000), and no UPDATE.
- `app` still has no DELETE on `households`, `persons` or `household_keys`.

Every grant and the trigger are named in the plan with the test that pins it and the source change that makes that test fail, including a must-fail test that runs the `UPDATE` as the `app` role against a minor.

`module.manifest.ts` `dataClasses` and `manifest.test.ts` gain `households.version` in the migration task (roadmap note on PR #58). No new encrypted column. No new unique key on an `app` table. Pre-existing unique indexes that start with `household_id` or `community_id` (not `org_id`) are unchanged; cross-community safety rests on RLS and the in-code checks under the scoped transaction.

`persons` has no index on `(org_id, household_id)`. Member counts scan `persons`. This chunk accepts the sequential scan, as All Contacts did; an `org_id`-led index is added when a community passes a few tens of thousands of contacts or the list is measured slow.

## Rules touched

- **Permissions:** existing keys only (matrix above). No new permission key.
- **Entitlement:** the feature key is `people.households` (`module.manifest.ts:10`; Growth plan only, `architecture.md:613`). `communityScope` is hard-wired to `people.directory` today, so household routes take their own guard on `people.households`. Add-minor goes through `createPerson`, which still records the `people.directory` usage fact. The first household producer records a `people.households` usage fact, following the usage-facts pattern.
- **Minors:** §1 rule 4. Minor `confidential*` fields stay under the household key. Every restricted read and write appends an audit event. New audit actions: household list, household update (rename), person household move, guardian link, guardian unlink. `linkGuardian` and `unlinkGuardian` gain an audit event; they write only `person_activity` today. A household move is audit-only (no new `person_activity` kind, so no CHECK change).
- **Scope:** `orgId` and `communityId` come from `findCommunityBySlug` and the session, never from request input. `includeRestricted` is derived from `people.restricted.read`, never from input.
- **Errors:** `statusForPeople` maps the guardian cases that return 500 today. `invalid_guardian` → 400, `duplicate_guardian_link` → 409, new `last_guardian` → 409, new `adult_cannot_move_with_links` → 409, new `minor_not_movable` → 400. All empty bodies.
- **Residency, cost:** no new outbound call, subprocessor, AWS resource or recurring charge. Each household in a list page costs one KMS Decrypt request (see Risks). Staging stays parked; migration `0016` joins the list the next unparking chunk verifies (`relrowsecurity` and `relforcerowsecurity` true, `app` lacks DELETE, UPDATE only on the named columns, trigger present).

## Contracts

Zod in `packages/contracts`, all `POST`, no personal data in paths or query strings. Reads use `billing: read`, writes `billing: write`. The new routes are added to the route-class table at `apps/api/src/index.test.ts:748`.

- `/v1/households/list` (body: `communitySlug`, `cursor?`, `limit?` ≤ 25) → `{ items: [{ householdId, version, label|null, adultCount }], nextCursor|null }`
- `/v1/households/read` (body: `communitySlug`, `householdId`) → `{ householdId, version, label|null, adults: [...], minors?: [...], guardians: [...] }`; `minors` is absent, not empty, for a caller without `people.restricted.read`
- `/v1/households/create` → `{ householdId, version }`; `/v1/households/rename` (body: `householdId`, `version`, `label`) → `{ version }`
- `/v1/households/members/move-adult` (body: `householdId|null`, `personId`, `version`) → `{ version }`
- `/v1/households/members/add-minor` (body: `householdId`, `givenName`, `familyName`, `dateOfBirth`, `guardianId`, `rights?`) → `{ personId, linkId }`
- `/v1/households/guardians/link` and `/unlink` (body as above)
- `POST /v1/access/capabilities` replaces `/v1/people/access`. Body: `communitySlug` only. The server always returns the whole allow-list; the caller cannot request keys. Response: `{ permissions: { "people.view": bool, "people.manage": bool, "people.restricted.read": bool }, entitlements: { "people.directory": bool, "people.households": bool } }`. A caller with no role grant in the community gets 403, as today (the admin treats non-200 as all false). Entitlements are evaluated through `checkEntitlement`. The allow-list is a constant with a test that an unknown key is neither returned nor accepted.
- Admin nav: `nav.tsx` `entitlementMap` maps Contacts → `people.directory` and Family Records → `people.households`; the item also needs `people.view` from `permissions`. Items that fail either test are hidden.

Callers of `/v1/people/access` that the plan must move or remove: `apps/admin/src/people-access.tsx`, `nav.tsx`, `all-contacts.tsx`, `shell.tsx`, `all-contacts.test.tsx` (about 50 mock branches), `apps/api/src/people-routes.ts` (handler and route entry), `people-routes.test.ts`, `people-routes.integration.test.ts`, `packages/contracts/src/people.ts` and `people.test.ts`, and `docs/roadmap.md` (open item on the capabilities route).

No events published or consumed, no port changes, no website collection, island or block. No new workspace package is planned, so no Dockerfile or `image.test.ts` change; if the plan finds one is needed, it stops and reports.

## Risks

- **Children's data.** Household read is the first HTTP path that lists minors together. Mitigations: the restricted gate before any minor decrypt; must-fail tests for a caller with `people.view` only and a caller with neither; a minor fixture in every list and read test; no minor identity, count or flag for a caller without `people.restricted.read`; no minor identity in any error body or log.
- **Stale guardian access.** Moving an adult out of a household while they hold guardian links would leave `hasGuardianView` (which ignores the household) granting access to the child. The move is refused while links exist; must-fail test.
- **Re-homing a minor.** A column grant cannot be limited by row, and a minor's fields stay sealed under the old household key. The database trigger blocks it; must-fail test as the `app` role.
- **Last guardian race.** Two concurrent unlinks could each see two links and leave none. The unlink locks the child row and counts inside the same transaction; concurrent-unlink test that does not depend on timing (two transactions, the second blocked on the lock).
- **Tenancy.** Household, person and link ids come from request bodies and are resolved inside the scoped transaction. Must-fail tests with two communities in one organisation and with two organisations. The person foreign keys carry `org_id` but not `community_id`; the in-code checks under RLS are the control, and the roadmap open item stays open.
- **KMS cost and latency.** A list page of N households makes N KMS Decrypt requests and N key unwraps (`keys.ts:116-135`). The cap is 25 and a request-scoped key cache is out of scope. The plan measures a 25-household page; if it is too slow the cache becomes a follow-up chunk, not a hidden change.
- **Capabilities allow-list.** An allow-list that grows by accident would leak permission names. Constant plus a rejecting test.
- **Money:** none.

## Out-of-band

- **Architecture change: yes, in this PR.** `architecture.md:564` documents the People surface including the `access` route and the `people.directory` guard; retiring `/v1/people/access` changes it. `architecture.md:565` (Family Records row) is empty and is filled. The plan has a task for it. No ADR is needed unless Abdus decides otherwise.
- Legal sign-off: none expected. New subprocessor: none.
- Second independent review: required (children's data, tenancy, database).
- **Owner decisions already confirmed (2026-11-01):** life events split to the next chunk; add-minor needs `people.manage` and `people.restricted.read`, and unlinking the last guardian is refused with 409; `/v1/access/capabilities` replaces `/v1/people/access` in this chunk; the household list is keyset-paged by `id` alone.
- **Owner decisions still open, with the default this draft uses:**
  1. Whether a `people.view`-only caller may see that a household has children or how many. Default: no (rule 4); minors and any trace of them are shown only with `people.restricted.read`.
  2. Whether link and unlink need `people.restricted.read` as well as `people.manage`. Default: yes, same as add-minor.
  3. Whether household routes require `people.households` only, or both `people.households` and `people.directory`. Default: `people.households` only, which exists in Growth and not in Starter.
  4. Whether `safeguarding_officer`, who holds `people.restricted.read` but not `people.view`, may open Family Records. Default: no; the nav needs `people.view`, as All Contacts does.
