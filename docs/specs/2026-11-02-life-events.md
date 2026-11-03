# Spec: Life events

Slug: life-events
Status: approved (2026-11-02, Adnan Bin Hossen)
Amended after approval (2026-11-03): the allowed types are baptism, first_communion, marriage, funeral, birth, death, graduation, anniversary and other, keeping every type from the previous system. Decided by the owner, Abdus.
Amended at approval (2026-11-02): the six defaults are confirmed. Audit actions use the past-participle convention and are registered with `defineAuditAction` and `defineAuditPurpose` in `modules/core/people/public/index.ts`. Migration `0017` carries an explicit `ALTER TABLE "app"."life_events" FORCE ROW LEVEL SECURITY;`. `derivePersonFieldKeys` returns `keyId` with `enc` and `bidx`, because the ciphertext envelope needs it. `is_minor` has no UPDATE grant (pinned by `privileges.integration.test.ts`), so no code path can flip it.
Architecture refs: §9 (family, `core/people`), §12.1, §12.2.1, §12.3, §13; roadmap Phase 2 row "Family Records" (life events inside this item)

## Problem

A parish administrator can manage contacts and households but cannot record a sacrament or life event (baptism, marriage, first communion, funeral) against a person. Parishes keep these records on paper or in spreadsheets. They are religious information about identifiable people, and sometimes about children, so they must not live in an unprotected place.

## Scope

In:

- A new table `app.life_events` in `core/people`: one row per event, attached to one person (adult or minor).
- Regional-service routes to list a person's events, add one, and correct one.
- Field encryption: community key for an adult subject, household key for a minor subject.
- Admin UI: a "Life events" panel on the Family Records household detail, one per member.
- Audit events for every read, write and denial.
- `architecture.md` corrections (see Out-of-band).

Out (explicitly):

- Deleting or voiding an event. The `app` role has no DELETE. Retraction and erasure belong with the retention design.
- A second person on an event (marriage partner, godparent, officiant as a person). The event holds one subject. Free text in `notes` may name others; no link is made.
- Certificates, PDFs, attachments, or any file upload.
- Reports, search, or filtering by event type or date across people (the fields are encrypted; §1 rule 3).
- Any public, Parish Hub or website exposure. No website collection, island or block. Children never appear.
- Guardian or member self-view in a portal.
- Re-keying when a minor turns 18. `app` has no UPDATE on `is_minor`, so no code path changes it today; see Risks.
- Events on a person with `age_basis = 'unknown'` beyond what the existing minor rules already allow.

## Behaviour

**Event fields.** `type` (one of `baptism`, `first_communion`, `marriage`, `funeral`, `birth`, `death`, `graduation`, `anniversary`, `other`), `date` (a calendar date, not in the future, not before 1900), `place` (optional, up to 200 characters), `notes` (optional, up to 2,000 characters). All four are `restricted` and encrypted.

**List.** Takes `personId`. Returns that person's events, ordered newest date first, sorted in the service after decryption (the date is encrypted, so SQL cannot order by it). Capped at 50 per person; the route refuses to return a truncated list silently (returns 409 `too_many` if a person has more, which is an operator problem and not expected). One audit event per call with the event ids in `targetIds`, or the person id when the list is empty.

**Create.** Takes `personId`, `type`, `date`, optional `place`, `notes`. One transaction writes the row and the audit event. A person may have more than one event of the same type (a funeral cannot repeat, but the service does not rule on that, because the type is encrypted and a duplicate rule would need a plaintext column).

**Update.** Takes `eventId`, expected `version`, and the full set of fields. 409 on version mismatch; bumps `version`. The person cannot be changed.

**Keying.** An adult subject's event is sealed under the community key. A minor subject's event is sealed under that minor's household key. The key is chosen from the subject's `is_minor` and `household_id` on every read and write, through `derivePersonFieldKeys`.

**States.** No events: "No life events recorded". Person in another community or organisation, or missing: 404 with no existence leak. Caller without permission: 403, and the panel is not rendered (never a control that only 403s). Stale version 409. All error bodies are empty and carry no person identity, no field value and no event type. Offline is not supported; the panel shows a retry state.

## Permission matrix

Routes record `people.permission.denied` audit with 403, as `household-routes.ts` does.

| Route                       | Needs                                            | Notes                                                          |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `people/life-events/list`   | `people.restricted.read`                         | Owner-confirmed. No guardian path and no `people.view` path.   |
| `people/life-events/create` | `people.manage` **and** `people.restricted.read` | Same pairing as the Family Records writes                      |
| `people/life-events/update` | `people.manage` **and** `people.restricted.read` | A caller who cannot read the event must not overwrite it blind |

Every route also requires the `people.households` entitlement (Owner decision 2).

## Data

New table `app.life_events`:

| Column         | Type                                                  | Class (§12.1)                                                              |
| -------------- | ----------------------------------------------------- | -------------------------------------------------------------------------- |
| `id`           | uuid                                                  | `internal` identifier                                                      |
| `org_id`       | uuid, not null                                        | `internal`; RLS key                                                        |
| `community_id` | uuid, not null                                        | `internal`; RLS key                                                        |
| `person_id`    | uuid, not null                                        | `internal` identifier; FK `(org_id, person_id)` to `app.persons`, restrict |
| `version`      | integer, not null, default 1                          | `internal`                                                                 |
| `event_type`   | encrypted (label `people.life_event_type`)            | `restricted`; no blind index, no SQL filter                                |
| `event_date`   | encrypted (label `people.life_event_date`)            | `restricted`; no blind index, no SQL filter, no derived clear column       |
| `place`        | encrypted, nullable (label `people.life_event_place`) | `restricted`                                                               |
| `notes`        | encrypted, nullable (label `people.life_event_notes`) | `restricted`                                                               |

- Primary key `(org_id, id)`. No other unique key, so no unique key that fails to start with `org_id`. One non-unique index `(org_id, person_id)` for the list.
- RLS enabled and `FORCE ROW LEVEL SECURITY`, policy `community_isolation` by `communityPredicate`, as the other people tables.
- The event type is encrypted on purpose: the type alone ("baptism") is religious information about a named person. The cost is that the database cannot CHECK the allowed types; Zod validates on write and the domain validates after decrypt.
- The event row carries no `created_at`. Audit holds the time.

Migration `0017`, expand-only:

- `CREATE TABLE app.life_events` with the policy and an explicit `ALTER TABLE "app"."life_events" FORCE ROW LEVEL SECURITY;` (the `schema-rls` checker requires it).
- `GRANT SELECT, INSERT ON app.life_events TO app;` and `GRANT UPDATE (event_type, event_date, place, notes, version) ON app.life_events TO app;`. No DELETE. No UPDATE on `person_id`, so an event cannot move to another person (that would break its key).
- Recovery note: the table is new and empty on first deploy; rollback is `DROP TABLE` in a later contract PR once no code reads it.

`module.manifest.ts` `dataClasses` and `manifest.test.ts` gain every `life_events` column in the migration task (roadmap note on PR #58). The schema file exports a factory wired in `packages/db/drizzle.schema.ts` and does not import values from `@community-hub/db`.

## Rules touched

- **Permissions:** existing keys only. No new permission key.
- **Entitlement:** `people.households`.
- **Minors (§1 rule 4):** a minor's events are held under the household key. They are never returned to a caller without `people.restricted.read`, and they appear in no listing, count or flag for anyone else. Every read and write appends an audit event.
- **Audit actions (new):** `people.life_event.listed`, `people.life_event.created`, `people.life_event.updated`. Denials reuse `people.permission.denied`. `targetIds` hold event and person ids only. No field value, type or date enters an audit row, a log or a trace (§1 rule 5).
- **Usage facts:** create records a `people.households` usage fact, following the household producer pattern.
- **Scope:** `orgId` and `communityId` come from `findCommunityBySlug` and the session. `personId` and `eventId` come from the body and are resolved inside the scoped transaction. The repository does not trust a pair it was handed.
- **Errors:** empty bodies; new `PeopleError` codes `life_event_not_found` (404), `invalid_life_event` (400), `too_many` (409), stale version reuses the existing 409.
- **Residency, cost:** no new outbound call, subprocessor, AWS resource or recurring charge. A list for one person costs one community-key unwrap, plus one household-key unwrap for a minor, so at most two KMS Decrypt requests per call. Staging stays parked; migration `0017` joins the list the next unparking chunk verifies (`relrowsecurity` and `relforcerowsecurity` true, `app` lacks DELETE, UPDATE only on the named columns).

## Contracts

Zod in `packages/contracts`, all `POST`, no personal data in paths or query strings. Reads `billing: read`, writes `billing: write`. The routes are added to the route-class table at `apps/api/src/index.test.ts`.

- `/v1/people/life-events/list` (body: `communitySlug`, `personId`) → `{ items: [{ eventId, version, type, date, place|null, notes|null }] }`
- `/v1/people/life-events/create` (body: `communitySlug`, `personId`, `type`, `date`, `place?`, `notes?`) → `{ eventId, version }`
- `/v1/people/life-events/update` (body: `communitySlug`, `eventId`, `version`, `type`, `date`, `place?`, `notes?`) → `{ version }`
- Admin: `apps/admin/src/family-records.tsx` gains a life events panel per member. It renders only when `/v1/access/capabilities` reports `people.restricted.read` and `people.households`. No new nav item and no change to the capabilities allow-list.

No events published or consumed, no port changes, no website collection, island or block. No new workspace package is planned, so no Dockerfile or `image.test.ts` change; if the plan finds one is needed, it stops and reports.

## Risks

- **Children's data.** Life events on a minor are the most sensitive rows in the system so far. Mitigations: the restricted gate before any decrypt; must-fail tests for a caller with `people.view` only, `people.manage` only, and neither; a minor fixture in every test; the minor's ciphertext opens only with the household key (a test that decrypts a minor's event with the community key must fail); no identity in any error body or log.
- **Wrong key.** If the key were chosen from the caller instead of the subject, a minor's event could be sealed under the community key. Pinned by a test that reads the stored ciphertext with each key.
- **Minor turns 18.** The event stays sealed under the household key. Today nothing flips `is_minor`; if a later chunk does, it must re-key these rows. The plan records this as a note on the roadmap open items.
- **Tenancy.** Person and event ids are request-supplied. Must-fail tests with two communities in one organisation and with two organisations, for list, create and update. The foreign key carries `org_id` but not `community_id`; RLS plus the in-code check under the scoped transaction are the control, and the roadmap hardening item stays open.
- **Cross-person tampering.** The update cannot change `person_id` (no column grant) and AAD binds the row id and community, so a ciphertext copied to another row will not open. Must-fail test for the grant, run as the `app` role.
- **Audit gap.** A read path that forgets its audit event. Each route has a test that the audit row exists and holds no field value.
- **Encrypted-column filtering.** The new columns are listed for the `no-encrypted-column-query` lint rule. The list sorts in memory.
- **Money:** none.

## Out-of-band

- **Architecture change: yes, in this PR.** `architecture.md:350` lists life events under `engagement`, and `architecture.md:1346` puts `life_events` in the engagement row of the module table. Both move to `core/people`. The People surface (around `architecture.md:564-565`) and §12.1 gain the life events class. No ADR is planned unless the approver wants one.
- Legal sign-off: sacramental records are religious information, which the Australian Privacy Act treats as sensitive information. No sign-off is requested for this chunk, because it only stores what the parish already holds, in Australia, encrypted, behind a restricted permission. The approver may want a legal read before the first real parish loads data.
- New subprocessor: none.
- Second independent review: required (children's data, encryption, tenancy, database). The owner's assistant is the same model family as the reviewer agent; flag this in the PR.
- **Owner decisions already confirmed:** the module is `core/people`; the class is `restricted` and field-encrypted; household-keyed for a minor and community-keyed for an adult; read needs `people.restricted.read`; the UI sits inside Family Records; every restricted access is audited.
- **Defaults chosen in this draft, for the approver to confirm or change:**
  1. Event type is encrypted, not a clear column (cost: no DB CHECK, no filtering).
  2. Routes require the `people.households` entitlement, not `people.directory`, because the UI lives in Family Records.
  3. Writes need `people.manage` and `people.restricted.read`.
  4. No delete or void in this chunk.
  5. One subject per event; no partner or godparent link.
  6. The date cannot be in the future.
