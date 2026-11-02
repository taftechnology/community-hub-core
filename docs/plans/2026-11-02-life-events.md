Spec: docs/specs/2026-11-02-life-events.md

# Life Events Implementation Plan

Slug: life-events
Status: approved (2026-11-02, Adnan Bin Hossen)

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** An administrator holding `people.manage` and `people.restricted.read` can record, read and correct a baptism, marriage, first communion or funeral against any person from the Family Records screen. Every field is encrypted: community key for an adult, household key for a minor. Nobody without `people.restricted.read` can read one, and every access is audited.

**Architecture:** `modules/core/people` gains `app.life_events` (migration `0017`), `life-event.ts` (list, create, update), three audit actions, and a `keyId` on `derivePersonFieldKeys`. `packages/contracts` gets `life-events.ts`. `apps/api` gets three routes. `apps/admin` gets a life events panel on the household detail. `architecture.md` moves life events from `engagement` to `core/people`.

## Who does what

Implementer: Antigravity, in its own worktree on the chunk branch, test first, one commit per task, commits locally and never pushes. Reviewer: fresh-context Claude session reviewing each task by diff. Only one run at a time uses the Docker test database.

## Checkpoint

After Task 3 (key derivation and all life event functions, before any contract or route) the reviewer runs the full weaken-and-fail table for pins 1–12 and accepts or returns the work before Task 4 starts.

## Global constraints

- Branch `feat/2026-11-02-life-events`, created from `origin/main` after this plan is approved, with the spec as its first commit. Migration `0017` is the only migration. Expand-only.
- Every query goes through `packages/db` helpers inside `withAppTransaction`. `orgId` and `communityId` come from `findCommunityBySlug`, never from the request body.
- Every body schema is `.strict()`. `orgId`, `communityId`, `isMinor` and the key choice are never request fields.
- No personal data, event type, date, place or note in paths, query strings, logs, audit values, traces or error text. Error bodies are empty.
- Fixtures are synthetic. Fixture strings that look like secrets are split so scanners never match. No real names of people, parishes or children.
- Staging stays parked. No Terraform, Dockerfile, workflow or dependency change. No new workspace package, so `apps/api/Dockerfile` and `image.test.ts` are re-checked in Task 5 and not changed.
- The schema file imports no values from `@community-hub/db` (the generator loads it with `require()`; a test guards it).
- Nothing is disabled to get green. Any new `packages/ui` component carries an axe test.
- Local gate per task: `pnpm gate` (after `pnpm install --frozen-lockfile` and `pnpm build` in a fresh worktree; `--force` where a test reads a file outside its package; rebuild `@community-hub/db` after changing it).

## Decisions fixed by the spec (do not reopen)

- Table `app.life_events`: `id`, `org_id`, `community_id`, `person_id`, `version`, and encrypted `event_type`, `event_date`, `place`, `notes`. Primary key `(org_id, id)`, one non-unique index `(org_id, person_id)`, no `created_at`.
- Type is one of `baptism`, `marriage`, `first_communion`, `funeral`, validated by Zod and the domain, not the database. Date is a calendar date, not in the future, not before 1900. `place` at most 200 characters, `notes` at most 2,000.
- Adult subject: community key. Minor subject: that minor's household key. Chosen from the subject's `is_minor` and `household_id` on every read and write.
- List: per person, cap 50 (409 `too_many` beyond), sorted newest date first in the service, one audit event per call. Update: full field set plus `version`, 409 on mismatch, the person cannot change. No delete, no void.
- List needs `people.restricted.read`. Create and update need `people.manage` and `people.restricted.read`. Every route needs the `people.households` entitlement.
- Audit actions `people.life_event.listed`, `.created`, `.updated`, registered with `defineAuditAction` and `defineAuditPurpose` in `modules/core/people/public/index.ts`. Denials reuse `people.permission.denied`. `targetIds` hold ids only.
- Create records a `people.households` usage fact, following the household producer pattern.
- Migration `0017` carries `ALTER TABLE "app"."life_events" FORCE ROW LEVEL SECURITY;` explicitly.

## Security pins

Each row is run once by the implementer: weaken the source, see the named test fail, restore, report the failure. The weakened tree is never committed.

| #   | Setting                                                                                       | Pinning test                                                                                                                                                                  | Source change that must make it fail                                                  |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `life_events` has RLS and FORCE RLS                                                           | `privileges.integration.test.ts`: `relrowsecurity` and `relforcerowsecurity` true                                                                                             | remove the `FORCE ROW LEVEL SECURITY` statement from `0017`                           |
| 2   | `app` has no DELETE on `life_events` and UPDATE only on the five named columns                | same file: `has_column_privilege` for each column; `person_id`, `org_id`, `community_id`, `id` not updatable; DELETE absent                                                   | widen the `GRANT UPDATE` to the whole table, or add `DELETE`                          |
| 3   | A minor's event opens only with the household key                                             | `life-event.integration.test.ts`: read the stored `event_type` ciphertext, decrypt with the community key → fails, with the household key → succeeds                          | make `derivePersonFieldKeys` ignore `isMinor` for life events                         |
| 4   | An adult's event opens only with the community key                                            | same file, mirror case                                                                                                                                                        | seal adults under a household key                                                     |
| 5   | AAD binds the row: ciphertext copied to another row does not open                             | same file: copy `event_type` between two rows by direct SQL as the owner role, read as the service → error and no value returned                                              | pass a constant row id in the AAD                                                     |
| 6   | List refuses without `people.restricted.read`                                                 | `life-event-routes.integration.test.ts`: `people.view` only, `people.manage` only, and no role → 403; denial audit row written; no `life_event.listed` row                     | change the guard to `people.view`                                                     |
| 7   | Create and update need both `people.manage` and `people.restricted.read`                      | same file: `people.manage` only → 403 and no row; `people.restricted.read` only (safeguarding officer) → 403 and no row                                                       | drop either half of the guard                                                         |
| 8   | Entitlement `people.households` is required                                                   | same file: community without the entitlement → refused on all three routes                                                                                                    | guard on `people.directory` instead                                                   |
| 9   | Tenancy: person and event ids in another community or organisation give 404                   | `life-event.integration.test.ts` and routes test: two communities in one organisation, and two organisations, for list, create and update; no existence leak (empty 404)      | remove the community or organisation check in the person lookup                       |
| 10  | Update takes `version` and bumps it                                                           | integration: stale version → conflict, row unchanged, no audit row                                                                                                            | drop `where version = $n`                                                             |
| 11  | Audit row written for list, create and update, holding ids only                               | integration: one row per call; `targetIds` equal the expected ids; serialised row contains none of the fixture type, date, place, note                                        | skip the audit append, or put a field value in `targetIds`                            |
| 12  | Date and type validation                                                                      | domain unit tests plus a Zod test: future date, 1899, unknown type, `place` of 201 characters, `notes` of 2,001 → rejected, and no row written (the check runs before the key) | loosen the future-date check                                                          |
| 13  | Cap of 50 events per person                                                                   | integration: 51 events → 409 `too_many`, body empty                                                                                                                           | remove the cap                                                                        |
| 14  | Error bodies are empty and carry no identity or field value                                   | routes test: every 400, 403, 404, 409 body is empty; log capture contains no fixture value                                                                                    | return `error.message` in a body                                                      |
| 15  | Strict bodies: unknown or request-supplied `orgId`, `communityId`, `isMinor` rejected         | contracts test and routes test                                                                                                                                                | remove `.strict()`                                                                    |
| 16  | Admin renders the panel only with `people.restricted.read` and `people.households`            | `family-records.test.tsx`: caps without either → no panel and no request sent                                                                                                 | render the panel unconditionally                                                      |
| 17  | `life_events` columns are classified                                                          | `manifest.test.ts` full equality over `dataClasses`: type, date, place, notes `restricted`; ids and version `internal`                                                        | remove one `dataClasses` entry                                                        |
| 18  | The schema file imports no values from `@community-hub/db`; the new columns are not filtered  | existing boundary test and the `no-encrypted-column-query` lint rule run over the new files                                                                                   | import a value from `@community-hub/db` in the schema file                            |
| 19  | Create is atomic with its audit event and usage fact                                          | integration: force the audit append to fail → no `life_events` row exists, checked from a second connection                                                                   | write the row outside the transaction                                                 |

## Rollback

Revert the pull request. If `0017` is deployed, first `REVOKE UPDATE (event_type, event_date, place, notes, version) ON app.life_events FROM app` and `REVOKE INSERT, SELECT ON app.life_events FROM app`. The table stays (dropping it is a later contract PR, once no code reads it). The admin and API revert together.

## Stop and ask (AGENTS.md §12)

Stop and report, do not improvise, when: a task grows past about 400 changed lines excluding tests (split it and ask); the plan is wrong; a task needs a migration other than `0017`, or a Dockerfile, workflow, Terraform or dependency change not named here; the same step fails twice; a test needs real data; a CI checker rejects the table, grants or audit names; the `keyId` change to `derivePersonFieldKeys` breaks a caller whose behaviour would change; anything looks like a security issue.

---

### Task 1: Migration 0017 and schema

**Files:** `modules/core/people/db/schema.ts`, `schema.test.ts`, `module.manifest.ts`, `domain/manifest.test.ts`, `infrastructure/privileges.integration.test.ts`, `packages/db/drizzle.schema.ts`, `packages/db/drizzle/0017_*.sql` and `meta`, plus any boundary test that lists tables or columns.

- [ ] RED: tests for pins 1, 2, 17, 18: table exists with the named columns and types, RLS and FORCE RLS on, the `(org_id, person_id)` index exists, the primary key starts with `org_id`, `app` privileges are exactly as the spec, `manifest.test.ts` equality includes every column.
- [ ] GREEN: add `life_events` to `peopleTables` with `encryptedColumn` labels `people.life_event_type`, `people.life_event_date`, `people.life_event_place`, `people.life_event_notes`; generate `0017` with the repo's generator; hand-add the explicit `FORCE ROW LEVEL SECURITY` statement and the grants; add `dataClasses` entries; wire the factory. No value import from `@community-hub/db`.
- [ ] Migration wave: **expand**. Recovery note under Rollback.
- [ ] Commit `feat(db): migration 0017 for life events`.

Must not break: RLS and FORCE RLS on every people table; no UPDATE on `is_minor`.

### Task 2: Key derivation returns keyId

**Files:** `modules/core/people/infrastructure/person-keys.ts`, its tests, and every caller of `derivePersonFieldKeys` and `openPersonFieldKeys`.

- [ ] RED: unit and integration tests that `derivePersonFieldKeys` returns `keyId` equal to the community key id for an adult and the household key id for a minor (pins 3, 4 groundwork); an existing-caller regression test that read paths for persons still return the same results.
- [ ] GREEN: return `{ enc, bidx, keyId }`. Callers that destructure are unchanged. `openPersonFieldKeys` keeps its audit behaviour and its return shape unless a caller needs `keyId`.
- [ ] Commit `refactor(people): return the key id from person field key derivation`.

Must not break: §1 rule 4 (a minor's keys still come from the household key).

### Task 3: Life event functions and audit actions (checkpoint)

**Files:** new `modules/core/people/infrastructure/life-event.ts`, `domain/life-event.ts` and tests, `domain/error.ts`, `public/index.ts` (audit actions, exports), `module.manifest.ts` if usage metrics require a key.

- [ ] RED: tests for pins 3–5, 9–13, 19: create and read round trip for an adult and a minor fixture; key isolation (community versus household) by decrypting the stored ciphertext; AAD binding; two-community and two-organisation not found; version conflict; cap of 50; one audit event per call with ids only; atomic create; domain validation of type and date. Audit action registration test that the three names are registered with action and purpose.
- [ ] GREEN: `domain/life-event.ts` validates and normalises input (`PeopleError("invalid_life_event")`). `life-event.ts` implements `listLifeEvents`, `createLifeEvent`, `updateLifeEvent`: the person is resolved inside the scoped transaction, the key comes from `derivePersonFieldKeys`, each field is encrypted with its own label and the row id and community id as AAD, the audit event is appended in the same transaction, create records the `people.households` usage fact. List sorts by decrypted date. New error codes `life_event_not_found`, `invalid_life_event`, `too_many`. Register `people.life_event.listed`, `.created`, `.updated`.
- [ ] Commit `feat(people): record, list and correct life events`.

Must not break: §1 rules 3, 4, 5. No filter or sort in SQL on an encrypted column.

### Task 4: Contracts

**Files:** `packages/contracts/src/life-events.ts`, `index.ts`, `life-events.test.ts`.

- [ ] RED: tests for pins 12 and 15 at the schema level: strict bodies, enum for type, date format and bounds, lengths, response shapes, rejected unknown keys.
- [ ] GREEN: Zod schemas for list, create and update, request and response, and the exported types.
- [ ] Commit `feat(contracts): life event request and response schemas`.

### Task 5: Routes

**Files:** `apps/api/src/life-event-routes.ts`, `index.ts` (registration), `index.test.ts` (route-class table), `statusForPeople` mapping, `life-event-routes.test.ts`, `life-event-routes.integration.test.ts`, `apps/api/Dockerfile` and `image.test.ts` (re-checked, not changed).

- [ ] RED: tests for pins 6–9, 11, 14: the permission matrix with callers holding exactly `people.view`, `people.manage`, `people.restricted.read`, both write permissions, and none; entitlement on and off; denial audit; empty error bodies; log capture; two-community and two-organisation cases; a minor fixture throughout; the route-class table entries (reads `billing: read`, writes `billing: write`).
- [ ] GREEN: three `POST` routes under `/v1/people/life-events/`. `communitySlug` resolves through `findCommunityBySlug`; permissions come from the session role grants, as the household routes do; the entitlement guard is `people.households`. `statusForPeople` maps `life_event_not_found` → 404, `invalid_life_event` → 400, `too_many` → 409. Empty bodies.
- [ ] Commit `feat(api): life event routes`.

Must not break: §1 rules 2 and 5. No personal data in paths or query strings.

### Task 6: Admin life events panel

**Files:** `apps/admin/src/family-records.tsx`, new `apps/admin/src/life-events.tsx`, `api.ts`, `family-records.test.tsx`, `life-events.test.tsx`.

- [ ] RED: tests for pin 16 and the spec states: panel hidden and no request sent without `people.restricted.read` or without `people.households`; empty state "No life events recorded"; list for an adult and a minor member; add form with type, date, place, notes; edit with version; 409 shows a refresh prompt; retry state on a failed load; a failing request shows no event content in the DOM text of an error. Accessibility: labelled controls, an axe test on the panel.
- [ ] GREEN: a panel per member on the household detail, composed from `packages/ui`. Capabilities already come from `/v1/access/capabilities`; no change to its allow-list. An in-flight request is dropped on community switch, as `detailGeneration` does.
- [ ] Commit `feat(admin): life events panel in Family Records`.

Must not break: WCAG 2.2 AA; no control that only 403s.

### Task 7: Architecture records the decisions

**Files:** `architecture.md`.

- [ ] Line 350: life events move from the `engagement` comment to `core/people`. Line 1346: `life_events` leaves the engagement row and joins a `core/people` row. The People surface (around lines 564–565) gains the life event routes, the permission matrix, the key choice and the audit actions. §12.1 gains the life event fields as `restricted`. No test.
- [ ] Commit `docs(architecture): record the Life events decisions`.

### Task 8: Catalogue (last task on this branch)

**Files:** `docs/roadmap.md`.

- [ ] `Life events` **done** inside the Family Records item; snapshot (last shipped, next chunk, counts); a new open item that the next chunk that unparks staging verifies migration `0017` (`app.life_events` exists, `relrowsecurity` and `relforcerowsecurity` true, `app` lacks DELETE, UPDATE only on the five named columns); an open item that a chunk that ever changes `is_minor` must re-key a minor's life events; the no-delete decision and the retraction and erasure follow-up; the next chunk and what is undecided.
- [ ] Run the §5 cleanup: `rm -f docs/plans/*-report.md; git status --short`.
- [ ] Commit `docs: mark Life events done`.

---

## Definition of done (AGENTS.md §8)

- All tasks 1–8 done, or dropped with a note. `pnpm gate` green, CI Stages 1–3 green on the pull request.
- Tenant-isolation tests green for every life event function and route. Residency unaffected (no new outbound call).
- Manifest updated (`dataClasses`). Audit actions registered. `architecture.md` and `docs/roadmap.md` updated in the same pull request, roadmap last.
- Reviewer sign-off recorded in the PR. This chunk touches children's data, encryption, tenancy and the database, so the second fresh-context review is required before merge and starts when the PR opens. The PR notes that the owner's assistant is the same model family as the reviewer agent.
- Staging verified parked in the committed var files; the roadmap line carries `0017` to the next unparking chunk.
- Session scratch cleaned: no `docs/plans/*-report.md`; nothing under `.superpowers/` staged.

## Probe record

None. No Terraform in this chunk.
