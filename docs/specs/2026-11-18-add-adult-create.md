# Spec: Add Adult create

Slug: add-adult-create
Status: approved (2026-11-18, Adnan Bin Hossen)
Architecture refs: §6.3, §11.1, §12.1, §12.2.1, §12.3; ADR 0017; AGENTS.md §1 rules 2, 3, 4, 5; §2; §6; §8; §13. Follows decision D1 of `docs/specs/2026-11-07-admin-screens-restyle.md` and the Family Records spec `docs/specs/2026-11-01-family-records.md`.

**Sensitive chunk** (tenancy, encryption of personal data, a new write route). It needs a second fresh-context review on a model that differs from every implementer model used in this chunk and from the reviewer agent's (AGENTS.md §2).

## Problem

A staff member looking at a household in Family Records cannot add a new adult to it. Add Adult (`apps/admin/src/family-records.tsx:1575-1641`) only searches existing contacts (`POST /v1/people/list`) and moves one in (`POST /v1/households/members/move-adult`). To add someone new, staff must leave the household, add the contact in All Contacts, come back and add them with Add Adult.

Decision D1 of the restyle spec rejected doing this with the two existing routes from the client: if the second call fails, the contact exists without a household, a retry can create a duplicate, and the client must guess the new person's version. This chunk adds one server route that creates the adult and places them in the household in a single transaction, and a create form inside Add Adult that uses it.

## Scope

In:

- `POST /v1/households/members/add-adult`: create an adult contact already in the given household, in one app transaction.
- A domain function `addAdult` in `modules/core/people/infrastructure/household-members.ts`, exported from `modules/core/people/public/index.ts` next to `addMinor`. It validates its own input as `addMinor` does (`household-members.ts:157-176`): a `householdId` that is not a UUID string → `invalid_input` before any SQL, and `email`, `phone`, `dateOfBirth` must be a string or `null` (the route sends `null` for an omitted field).
- The contract `addAdultBody` in `packages/contracts/src/households.ts`, with a contract test in `packages/contracts/src/households.test.ts`.
- `statusForHouseholds` (`apps/api/src/household-routes.ts:60-84`) extended with four codes no household route maps today.
- `communityScope` / `prepare` in `household-routes.ts` taking extra entitlement keys, used by `add-adult` only, so this route checks a second entitlement before billing. Every other household route still checks `people.households` alone (owner check M1).
- In Family Records → Household Details → Add Adult: a **Create new adult** action that opens a form (given name, family name, email, phone, date of birth) and saves through the new route.
- `ContactFields` and `ContactFormData` (`apps/admin/src/all-contacts.tsx:48-54`, `:111-164`) moved to a shared admin file and exported, with an optional date-of-birth help prop and a wider `prefix` type. All Contacts renders the same output, pinned by its existing tests.
- Tests: contract, domain integration, route unit, route integration with two organisations and with two communities of one organisation, billing guard, admin screen.
- `architecture.md` (the household routes line, about line 564): nine routes, this route's two entitlements and permission pair, and that it is atomic (AGENTS.md §13).
- Last commit: `docs/roadmap.md` (the Phase 2 `Add Adult create` row marked done, about `:175`; the Where we are snapshot, about `:25`; the Phase 1 line naming the next chunk, about `:99`; the Next spec sentence, about `:415`; the open items this chunk leaves) and the `AGENTS.md` Repository state row (`Add Adult create` added to the done list, Next updated).

Out:

- Creating a minor from Add Adult. Add Minor already does that, with a guardian link (`household-members.ts:150-230`).
- Any behaviour change to All Contacts or to `POST /v1/people/create`. The only All Contacts change is the `ContactFields` move above.
- Any change to `move-adult`, including the `people.directory` / `people.households` entitlement mismatch between the Add adult button and the move route (open item, below).
- Idempotency keys (owner decision 2).
- A success notice on Household Details. Move-adult has none; focus already returns to the heading (`family-records.tsx:558-562`, `:1100-1104`).
- Laravel parity items under `People screens: Laravel parity` (emergency contacts, family status, and so on).
- A staging run. Staging stays parked (owner decision 5).

## Behaviour

### Route

`POST /v1/households/members/add-adult`, surface `tenant`, `billing: "write"`.

Body (strict, unknown keys refused with 400):

| Field           | Type                              | Rule                                  |
| --------------- | --------------------------------- | ------------------------------------- |
| `communitySlug` | slug                              | as every household route              |
| `householdId`   | uuid                              | required, not nullable                |
| `givenName`     | name                              | required, same schema as create       |
| `familyName`    | name                              | required, same schema as create       |
| `email`         | email, nullable, optional         | the same schema as `createPersonBody` |
| `phone`         | phone, nullable, optional         | the same schema as `createPersonBody` |
| `dateOfBirth`   | date of birth, nullable, optional | the same schema as `createPersonBody` |

The `email` and `phone` schemas are private to `packages/contracts/src/people.ts:8-9` today. They are exported from there and imported by `households.ts`, not copied, so the two bodies cannot drift. `households.ts` already has its own `name` and `dateOfBirth` (`households.ts:5,7`), so only `email` and `phone` are newly exported. A name of 81–100 characters passes the contract and is refused by `normaliseName` (`invalid_name` → 400); a route test pins it.

There is no `isMinor`, `declaredAdult`, `personId`, `orgId`, `communityId` or `version` field. Both ids of the scope come from `findCommunityBySlug`, as every household route does (`household-routes.ts:162-196`); none comes from the body.

Order of checks, each before the next. This is the existing household route order (`household-routes.ts:138-224`) with one addition at step 5:

1. Host not the tenant API host → 404.
2. Body schema → 400.
3. No or invalid session → 401.
4. Community by slug absent → 403 (as every household route; `prepare` maps it to 403).
5. Entitlement `people.households` **and**, for this route only, `people.directory`. Either missing → 403 (bare, as `guardEntitlement` returns; it fails closed, so a failed snapshot read is also 403). Both are checked inside `communityScope`, before billing, so a community without `people.directory` gets 403 and writes no billing log line. The two checks cost two platform reads per request, as two calls to `guardEntitlement` do; that is accepted.
6. Billing write guard → 402 when read-only, 503 when the guard itself fails.
7. In the app transaction: `people.manage` **and** `people.restricted.read`. Either missing → 403 and one audit row `people.permission.denied` whose purpose names the missing permission, as move-adult does (`household-routes.ts:416-429`). The pair is required for screen parity: `canAddAdult` builds on `canMoveAdult` (`family-records.tsx:632-633`), and the household screen that hosts this form is the restricted view. A later chunk must not drop `people.restricted.read` as unnecessary without changing the screen rule too.
8. `addAdult`, in this order. The order of refusals is fixed by the code, so tests expect the earlier refusal when two apply: `invalid_input` → `not_found` → `invalid_declaration` / `invalid_date` → `invalid_name` / `invalid_email` / `invalid_phone` → `duplicate_email` / `duplicate_phone`.
   - Select the household with explicit `org_id = current_setting('app.org_id')::uuid` and `community_id = current_setting('app.community_id')::uuid` filters, as `addMinor` does (`household-members.ts:183-193`, "Pin 12"). Absent → `not_found` → 404, before any age or field check. RLS on `app.households` (org and community, forced) is the second layer, not the only one, because `persons_household_fk` is `(org_id, household_id)` and ignores both RLS and community.
   - `createPerson` with `declaredAdult: true` and the household id. A date of birth under 18 (Sydney civil date) → `invalid_declaration` → 400. A future date → `invalid_date` → 400. No date of birth → `age_basis = declared_adult`.
   - An email or phone already held by an adult in this community is found only by the unique-index violation on the insert inside `createPerson` (`person.ts:238-284`; indexes `persons_adult_email_bidx`, `persons_adult_phone_bidx`), not by a separate check → `duplicate_email` / `duplicate_phone` → 409. So a duplicate email with an under-18 date of birth is a 400, not a 409.
   - Only after a successful insert: one audit row `people.person.household_moved` with targets `[personId, householdId]` (owner decision 1), after the `people.person.created` row that `createPerson` writes.
9. 201 `{ "personId": "<uuid>" }`.

Everything in step 8 is one transaction. The handler's `catch` stays outside `withAppTransaction`, as the household routes do (`household-routes.ts:440-447`), so any throw rolls the whole transaction back (`packages/db/src/app-transaction.ts:5-15`): no person, activity row, audit row or usage fact remains.

The new person is stored exactly as `createPerson` stores any adult today: clear `given_name` / `family_name`; `date_of_birth`, `email`, `phone` sealed under the **community** key; community-scoped blind indexes; `is_minor = false`; `household_id` set; `version = 1`; one `person_activity` row `created`; one `people.directory` usage fact.

`statusForHouseholds` gains `duplicate_email` → 409, `duplicate_phone` → 409, `invalid_email` → 400, `invalid_phone` → 400. Without them those codes fall through to 500 today. No other household route raises them. Anything unmapped → 500 with an empty body. Every refusal body is empty. No response body or log line carries a name, email, phone, date of birth, SQL text or stack (AGENTS.md §1 rule 5).

### Admin screen

The new strings say "household", as the screen does ("Household Details", "Add to household").

In the Add Adult view, above the search, a secondary button **Create new adult**. It shows only when `canAddAdult` is true (`family-records.tsx:633`), the same rule as the Add adult button.

Pressing it replaces the search with a form titled **New adult in this household**, using the shared `ContactFields`: given name and family name required; email, phone and date of birth optional. Help text under date of birth, through `Field`'s `help` (`packages/ui/src/field.tsx`): "Under 18? Use Add minor instead."

- **Before sending**, if a date of birth is entered, the admin works out completed years from that date against today's date in `Australia/Sydney` (the server's rule, `modules/core/people/domain/person.ts:42-54, 95-105`). Under 18 → "This person is under 18. Use Add minor instead." and nothing is sent.
- **Save** posts the route. Empty optional fields are omitted. A submit guard stops a double press (as `all-contacts.tsx:483-527` does).
- **Cancel** returns to the search with nothing sent.
- 201 → back to Household Details, which reloads; the new adult is in the Adults list, and focus is on the heading as after a move.
- 409 → "A contact with this email or phone already exists. Search for them instead." The form keeps its values (owner decision 3).
- 400 → "Check the details and try again." (Every server refusal body is empty, so the admin cannot tell which field; the under-18 case is caught before sending.)
- 404 → "Household not found" with the screen's existing back-to-list button.
- 401 → `post` in `apps/admin/src/api.ts:107-109` clears the stored token; the form shows the generic message below, as move-adult does. The screen has no other 401 handling and none is added.
- 402 → the read-only billing message the screen already shows; the form is hidden while `hideWrites` is true.
- 401, 403, 503, 500, network failure → "Unable to add this adult. Try again." The form keeps its values.

The form meets WCAG 2.2 AA: labelled fields, errors announced, help text tied by `aria-describedby`, every control reachable by keyboard, axe clean in the screen test. On phones it is one column.

### Empty, error and offline states

The form has no empty state. Offline is a network failure (message above). The Adults list empty state is unchanged.

## Data

No new table, column, index or migration. Classifications unchanged (`modules/core/people/module.manifest.ts` `dataClasses`): `email`, `phone` confidential-blind; `date_of_birth` restricted; `given_name`, `family_name` clear for adults; `is_minor` confidential-queryable; `household_id` unchanged. Nothing new is encrypted, and nothing encrypted is filtered, sorted or aggregated (§1 rule 3). The duplicate check uses the existing community-scoped blind indexes (`0005_people_households.sql:153,155`).

## Rules touched

Each setting below is pinned by a named test in the plan, with the source change that must make it fail.

- **Tenancy (§1 rule 2).** No org or community id from input. `addAdult` selects the household with explicit org and community filters, then RLS backs it. Pinned by integration tests: a household in another community of the same organisation → 404 and no row; a household in another organisation → 404 and no row; a foreign household with an under-18 date of birth → 404 (not 400).
- **Minors (§1 rule 4).** The route can never create a minor: `declaredAdult: true` is fixed in code, a date of birth under 18 is refused, and the body has no age field. Pinned by a domain test, a route test and a contract test that refuses `isMinor` and `declaredAdult`.
- **Permissions.** `people.manage` and `people.restricted.read`; each missing → 403 with the right denial purpose.
- **Entitlements.** `people.households` and `people.directory` for `add-adult`; each missing → 403, with no billing log line for a missing `people.directory`, and a thrown `people.directory` read → 403. A sibling test shows `create` and `move-adult` still succeed with `people.households` on and `people.directory` off, so the extra key cannot spread to every route. The test at `household-routes.test.ts:756` ("allows write routes when people.directory is disabled…") calls only `create`; it is retitled to say so.
- **Billing.** `billing: "write"` in the route table, pinned in both route tables in `apps/api/src/index.test.ts` and in `apps/api/src/billing-guard.integration.test.ts`.
- **Atomicity.** Pinned in the real-Postgres integration suite (`apps/api/src/household-routes.integration.test.ts`, beside its existing no-orphan-row cases, or `household-members.integration.test.ts`), not in a mocked route unit test. A partial mock of `@community-hub/db` (`vi.mock` with `importActual`) makes `appendAuditEvent` throw for action `people.person.household_moved` only; the route answers 500, and no row for the new person is left in `app.persons`, `app.person_activity`, the audit table, and no `people.directory` count is added to `app.usage_facts_daily`. The weakening for this pin is moving the `try`/`catch` inside `withAppTransaction`.
- **Audit.** `people.person.created` (existing) and `people.person.household_moved` (existing action, new caller). Audit targets are ids only.
- **Personal data in logs (§1 rule 5).** Empty error bodies; a route test asserts that no body and no guard log line carries a field value.
- No consent, retention or residency change. The route runs in the regional service; no outbound call.

## Contracts

- New route `POST /v1/households/members/add-adult` in the route table of `apps/api/src/household-routes.ts`. Pins updated: both route tables in `apps/api/src/index.test.ts` (around `:729` and `:858`), the write-route list in `apps/api/src/household-routes.test.ts` (around `:618`, "all six write routes"), and the write-route list in `apps/api/src/billing-guard.integration.test.ts` (around `:956`, `:1006`).
- New `addAdultBody` in `packages/contracts/src/households.ts`; `email` and `phone` exported from `packages/contracts/src/people.ts`. The repo generates no OpenAPI.
- `addAdult` exported from `modules/core/people/public/index.ts`.
- `architecture.md` household routes line updated.
- No event, entitlement key, permission, website collection, island or block. `module.manifest.ts` unchanged. No new workspace package, so no Dockerfile change.

## Risks

| Risk                                                                                                              | Mitigation                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A household in another community of the same organisation is accepted, because the foreign key ignores community  | Explicit org and community filter in `addAdult`, RLS behind it; integration test with two communities of one organisation expects 404 and no row                                                                                          |
| Another organisation's household id is accepted                                                                   | The same filter; integration test with two organisations expects 404 and no row                                                                                                                                                           |
| A minor is created without a guardian link                                                                        | `declaredAdult: true` fixed; under-18 date refused by the server and before sending in the admin; strict body; tests for each                                                                                                             |
| Partial write: person created, then the audit or usage fact fails                                                 | One transaction, catch outside it; integration test that forces the `household_moved` audit append to throw and finds no person row                                                                                                       |
| A lost response and a retry create a second contact with no email or phone                                        | Accepted residual (owner decision 2). The submit guard stops double presses. With an email or phone, the retry is a 409; "Search for them" then finds nothing, because search hides current members, so the person is already in the list |
| Error handling leaks a field value                                                                                | Empty error bodies; route test asserts bodies and the guard log carry no field value                                                                                                                                                      |
| A permission swapped (manage for view) or one of the two dropped, or an entitlement dropped, with no test failing | Route unit tests for each missing permission and each missing entitlement; the plan weakens each check once and records the failing test                                                                                                  |
| Admin and server disagree about the under-18 boundary                                                             | Both use the Sydney civil date; admin test at the 18th birthday and the day before                                                                                                                                                        |

## Out-of-band

None. No legal sign-off, ADR, vendor, AWS resource or cost. `architecture.md` changes in this PR only to describe the new route. Staging stays parked; the behaviour is verified by tests, and the roadmap records that the next proof chunk that unparks should add an adult this way on the staging hostname. The PR states this deviation from the AGENTS.md §8 staging check, as `users-roles-people-details` and `user-invitations` did.

Open item recorded in the roadmap, not changed here: the existing Add adult button (`family-records.tsx:633`) requires `people.directory`, while `move-adult` checks only `people.households`.

## Owner decisions

Chunk owner (Adnan Bin Hossen), accepted 2026-11-18 as proposed:

1. **Household audit row.** Write `people.person.household_moved` with `[personId, householdId]` after `people.person.created`, so "who put this adult in this household" has the same answer whether the adult was new or moved. Alternatives: only `people.person.created`, whose targets hold the person id only; or add `householdId` to `people.person.created` targets when set, which changes Add Minor's audit too.
2. **No idempotency key.** The submit guard and the email and phone uniqueness cover the likely retries. A name-only retry after a lost response can create a duplicate contact, recorded as a residual. Alternative: a client-generated request id stored for a short window, which needs a table and a migration.
3. **Specific 409 message** ("A contact with this email or phone already exists. Search for them instead."). All Contacts shows a generic "Unable to save contact". The caller already holds `people.manage` and `people.restricted.read`, and exact email and phone search already exists, so the message reveals nothing new.
4. **Entry point.** Create new adult is always shown in Add Adult when allowed, not only after a search finds nothing.
5. **Staging stays parked.** Verified by tests; the staging check is an open item for the next proof chunk.
6. **Laravel parity.** Laravel's behaviour for adding a new adult to a family is not confirmed in the repo. This design stands unless it turns out to differ.
