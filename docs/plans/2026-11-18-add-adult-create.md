Spec: docs/specs/2026-11-18-add-adult-create.md

# Add Adult create Implementation Plan

Slug: add-adult-create
Status: approved (2026-11-18, Adnan Bin Hossen)

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** staff can create a new adult straight into a household from Family Records → Household Details → Add Adult. One route creates the adult and places them in the household in one transaction; nothing is left behind on any failure; the route can never create a minor or touch another community's household.

**Architecture:** no table, column, migration, dependency, workspace package, Dockerfile, workflow or Terraform change.

- `packages/contracts`: `email` and `phone` exported from `people.ts`; `addAdultBody` in `households.ts`.
- `modules/core/people`: `addAdult` in `infrastructure/household-members.ts`, exported from `public/index.ts`.
- `apps/api/src/household-routes.ts`: extra entitlement keys for one route, the `add-adult` route, four codes in `statusForHouseholds`.
- `apps/admin`: `ContactFields` moved to a shared file; a Sydney age helper; the Create new adult form in Family Records.
- `architecture.md`, `docs/roadmap.md`, `AGENTS.md`: the route and this chunk done.

## Who does what

- **Implementer:** Antigravity (Gemini 3.8 Flash High), in `C:\Recovered\Taftech\wt-add-adult` on the chunk branch.
  - Tests first, one commit per task, commits locally, never pushes.
  - One plan task per run, except where a dispatch below names two (12 GB of RAM on this machine).
  - For every Security pins row its task names, it writes the weakening as a `.patch` file under `.superpowers/sdd/pins/` and a row in `.superpowers/sdd/pins/manifest.json` (the `pinrun.mjs` format). The reviewer runs them. It does not hand-run and report pin output. This departs from AGENTS.md §4 Phase 2 ("the implementer runs each change once"), by owner decision 3; the PR body records it.
  - Every test result it claims points to a log file it wrote with `tee` under `.superpowers/sdd/task-N-logs/`, UTF-8. A claim without a log counts as not run.
  - It starts with no AWS credentials; pushes are blocked by the push URL and the pre-push hook.
- **Reviewer agent:** this session, on Claude Opus 5.5 for the whole chunk. Each task is reviewed by its diff, the named tests re-run, and every named pin run through `pinrun.mjs`. A fresh-context reviewer subagent on the same model reviews task diffs. Plan check 1 is such a pass; it is not the owner's check.
- **Owner's check and second review:** the chunk owner runs these in a fresh session on Claude Sonnet 5.5, GPT or Grok. Never Opus, never Gemini 3.8 Flash. If a task falls back to another implementer model, that model is excluded too, and the reviewer says so before the next check.
- **Docker test database:** one run at a time. Tasks 2 and 4 need it, and so does the full local gate of any task (it runs the `apps/api`, people and db integration suites, whose global setup drives `docker compose`, `packages/db/test/global-setup.ts:11-18`). `pinrun` never runs while an implementer is editing the tree.

## Checkpoints

- **After Task 4** (all server work): the reviewer records the Task 4 SHA, runs pins 1 to 23 (with 9b, 19a, 19b, 20a to 20c and 22b) on it and pin 24's test with plain vitest, then the chunk owner runs an owner's check of `git diff 0d37114..<task-4-sha>`. Tasks 5 and 6 start only after that check ends (owner decision 2, revised after the owner's plan check: an implementer's `pnpm typecheck` rebuilds `dist` that the check's `apps/api` tests load, and new commits would move the target).
- **After Task 6** (the admin): the reviewer runs pins 25 to 31 and repeats `family-records.test.tsx`, `all-contacts.test.tsx` and `sydney-age.test.ts` five times.

## Global constraints

- **Branch:** `feat/2026-11-18-add-adult-create`, from `origin/main` at `0d37114` (PR #87 merged). The spec is its first commit (`d1efdd9`), this plan its second.
- **Untouched:** migrations and every `packages/db/drizzle` file; `createPerson` (`modules/core/people/infrastructure/person.ts`); `moveAdult`, `addMinor`; `POST /v1/people/create` and `people-routes.ts`; identity, tenancy, access, billing and entitlement source; Terraform, workflows, `infra/`, the Dockerfile; `module.manifest.ts`. Staging stays parked.
- **Dependencies:** none added. **Workspace packages:** none added. `apps/admin` does not gain a dependency on `@community-hub/contracts`.
- **Never disabled to get green:** a check, a lint rule (no `eslint-disable` of any kind), an axe rule other than the repo's existing `color-contrast` exclusion, RLS, a test or a CI gate. No `@ts-ignore` or `@ts-expect-error`.
- **Fixtures** are synthetic: invented names, `example.test` addresses, phone numbers in the `+61 4xx 555 xxx` style the existing tests use. No real person.
- **No personal data** in logs, error bodies, URLs or audit rows. Every refusal body is empty.
- **Build order:** `apps/api` imports the built `dist` of `@community-hub/contracts` and `@community-hub/people`. After changing either, run `pnpm --filter <pkg> build` before the `apps/api` tests. Pins that weaken `modules/core/people` and run an `apps/api` test list `"build": ["@community-hub/people"]`.
- **Local gate per task:** on this Windows machine `pnpm gate` stops at the allowed `@community-hub/db#test` failure, so each task runs `pnpm format && pnpm lint && pnpm typecheck && pnpm exec turbo run test --continue --force; pnpm check:boundaries`, tees it, and reads the turbo summary for any failure other than the allowed ones. When memory forces a narrower run, it still runs `pnpm exec prettier --check .`, `pnpm check:boundaries`, `pnpm lint`, `pnpm typecheck` and the named package tests, and says so.
- **Allowed failures on this Windows machine,** and only these: `packages/db/src/generate.test.ts` drizzle ENOENT; the `image-publish` symlink EPERM; the `migrate.integration` and `plaintext-dist` timeouts; the identity `tsbuildinfo.test` 5 s timing flake.
- **Admin tests:** no real waits; exact call counts; each new section repeated five times green before the task is reported.
- **Line endings:** LF (`.gitattributes`).

## Decisions fixed by the spec (do not reopen)

1. One route, one transaction. The client never chains `people/create` and `move-adult`.
2. `declaredAdult: true` is fixed in code; the body has no age field; under 18 is refused.
3. `addAdult` selects the household with explicit `org_id` and `community_id` filters before `createPerson`; absent → `not_found`.
4. Refusal order: `invalid_input` → `not_found` → `invalid_declaration` / `invalid_date` → `invalid_name` / `invalid_email` / `invalid_phone` → `duplicate_*`.
5. Audit: `people.person.created` (by `createPerson`) then `people.person.household_moved` with `[personId, householdId]`, only after a successful insert.
6. `people.manage` and `people.restricted.read`; `people.households` and, for `add-adult` only, `people.directory`, both before billing.
7. No idempotency key. Specific 409 message. Create new adult always shown when `canAddAdult`. No success notice. Staging parked.
8. The admin refuses an under-18 date of birth before sending, by the Sydney civil date; every server 400 shows "Check the details and try again."

## Security pins

Each row is a weakening the implementer writes as a patch and the reviewer runs through `node ~/.claude/crew/bin/pinrun.mjs .superpowers/sdd/pins/manifest.json --only <id>`. The weakened run must fail **on an assertion** in the named test; the restored run must pass. The weakened tree is never committed.

Files: **C** = `packages/contracts/src/households.test.ts`; **D** = `modules/core/people/infrastructure/household-members.integration.test.ts`; **DA** = `modules/core/people/infrastructure/add-adult-atomicity.integration.test.ts` (new); **R** = `apps/api/src/household-routes.test.ts`; **X** = `apps/api/src/index.test.ts`; **I** = `apps/api/src/household-routes.integration.test.ts`; **IA** = `apps/api/src/add-adult-atomicity.integration.test.ts` (new); **B** = `apps/api/src/billing-guard.integration.test.ts`; **U** = `apps/admin/src/family-records.test.tsx`; **S** = `apps/admin/src/sydney-age.test.ts` (new).

| #   | Setting                                                                  | Weakening                                                                                                                                             | File | Test that must fail (exact `it` title)                                                                                                   |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Body is strict, no age or scope field                                    | Remove `.strict()` from `addAdultBody`                                                                                                                | C    | addAdultBody refuses isMinor, declaredAdult, orgId, communityId, personId and version                                                    |
| 2   | `householdId` required, not nullable                                     | `householdId: uuid.nullable().optional()`                                                                                                             | C    | addAdultBody requires a non-null householdId                                                                                             |
| 3   | Household checked before age                                             | Delete the explicit household select in `addAdult`                                                                                                    | D    | addAdult: a foreign household with an under-18 date of birth throws not_found                                                            |
| 4   | Cross-community household refused (FK ignores community)                 | Delete the explicit select in `addAdult` and the `requireHousehold` call in `createPerson` (weakening only)                                           | D    | addAdult: a household in another community of the same organisation throws not_found, no row                                             |
| 5   | Cross-organisation household refused                                     | same as 4                                                                                                                                             | D    | addAdult: a household in another organisation throws not_found, no row                                                                   |
| 6   | `declaredAdult: true` fixed                                              | Pass `declaredAdult: false`                                                                                                                           | D    | addAdult: an under-18 date of birth throws invalid_declaration and writes nothing                                                        |
| 7   | No date of birth is a declared adult, never `unknown`                    | same as 6                                                                                                                                             | D    | addAdult: no date of birth stores a declared adult under the community key                                                               |
| 8   | Household audit row, ids only                                            | Delete the `household_moved` append                                                                                                                   | D    | addAdult: appends person.created then person.household_moved with ids only                                                               |
| 9   | Own input guard                                                          | Delete the UUID check on `householdId`                                                                                                                | D    | addAdult: a householdId that is not a UUID throws invalid_input before any SQL                                                           |
| 9b  | Explicit org and community filters on the household select               | Delete `and community_id = current_setting('app.community_id')::uuid` from the select                                                                 | D    | addAdult: the household select filters by org and community explicitly                                                                   |
| 10  | Domain atomicity                                                         | Wrap the `household_moved` append in a `try`/`catch` that swallows                                                                                    | DA   | addAdult: a failed household audit append leaves no person, activity, audit or usage row                                                 |
| 11  | `people.manage` required                                                 | Drop `!canManage` from the add-adult denial condition                                                                                                 | R    | add-adult: requires BOTH people.manage AND people.restricted.read                                                                        |
| 12  | `people.restricted.read` required                                        | Drop `!canRestricted` from the add-adult denial condition                                                                                             | R    | add-adult: requires BOTH people.manage AND people.restricted.read                                                                        |
| 13  | Denial purpose names the missing permission                              | Purpose always `people.manage`                                                                                                                        | R    | add-adult: requires BOTH people.manage AND people.restricted.read                                                                        |
| 14  | `people.households` checked                                              | Skip the base entitlement when extra keys are passed                                                                                                  | R    | add-adult: refuses 403 when people.households is disabled                                                                                |
| 15  | `people.directory` checked, before billing                               | Do not pass the extra key from the add-adult route                                                                                                    | R    | add-adult: refuses 403 before billing when people.directory is disabled                                                                  |
| 16  | Directory key only on add-adult                                          | Pass `people.directory` as an extra key from `prepare` for every route                                                                                | R    | create and move-adult succeed when people.directory is disabled                                                                          |
| 17  | Error map                                                                | Remove `duplicate_email` from `statusForHouseholds`                                                                                                   | R    | add-adult: maps duplicate email and phone to 409 and invalid email, phone and name to 400                                                |
| 18  | Every field forwarded exactly; omitted fields reach the domain as `null` | Swap two fields: `email: body.phone ?? null, phone: body.email ?? null`                                                                               | R    | add-adult: opens the transaction with the scope from the slug and forwards every field exactly, with nulls for omitted fields            |
| 19a | Empty refusal bodies                                                     | Answer the mapped 409 with `Response.json({ error: error.code }, { status: 409 })`                                                                    | R    | add-adult: refusals have empty bodies and the logs carry no field value                                                                  |
| 19b | No field value logged                                                    | In the add-adult catch, before `finish`, add `deps.log("request", { route, status, requestId, email: body.email })` (`finish` has no `body` in scope) | R    | add-adult: refusals have empty bodies and the logs carry no field value                                                                  |
| 20a | Billing `write`                                                          | Route table `billing: "read"` for add-adult                                                                                                           | R    | registers all seven write routes as tenant surface with billing: 'write'                                                                 |
| 20b | same                                                                     | same                                                                                                                                                  | X    | marks every production route as exempt, read, or write matching the spec exactly                                                         |
| 20c | same                                                                     | same                                                                                                                                                  | B    | guards every write route through the gate: 2xx and row count changes in ok, 402 with empty body and unchanged rows in read_only (pin 14) |
| 21  | Real-database tenancy through the route                                  | same as 4, `build: ["@community-hub/people"]`                                                                                                         | I    | add-adult: a household in another organisation or community answers 404 and writes no person                                             |
| 22  | Route stores an adult in the household                                   | Route passes `householdId: scope.communityId` (a valid UUID that is no household)                                                                     | I    | add-adult: creates an adult in the household with clear names, version 1 and two audit rows                                              |
| 22b | The route forwards the date of birth (§1 rule 4)                         | Route passes `dateOfBirth: null` to `addAdult`                                                                                                        | I    | add-adult: an under-18 date of birth answers 400 and writes no person                                                                    |
| 23  | Route rollback (catch outside the transaction)                           | Move the `try`/`catch` inside the `withAppTransaction` callback                                                                                       | IA   | add-adult: a throw after addAdult answers 500 and leaves no person row                                                                   |
| 24  | Contract name length matches the domain                                  | none: behaviour test (81-character name → 400 through the route); no pin                                                                              | I    | add-adult: an 81-character name answers 400                                                                                              |
| 25  | Create new adult hidden without the rights                               | Render the button without the `canAddAdult` condition                                                                                                 | U    | hides 'Create new adult' when people.manage, people.restricted.read or people.directory is removed                                       |
| 26  | Under-18 refused before sending                                          | Delete the pre-send age check                                                                                                                         | U    | refuses an under-18 date of birth before sending                                                                                         |
| 27  | Sydney civil date, not UTC                                               | Compute today from `toISOString().slice(0, 10)`                                                                                                       | S    | counts the 18th birthday on the Sydney date when the UTC date is still the day before                                                    |
| 28  | Exact body, empty optionals omitted                                      | Send empty strings for empty optional fields                                                                                                          | U    | posts add-adult with the household id and omits empty optional fields                                                                    |
| 29  | Double-submit guard                                                      | Remove the `submittingRef` check (and any second `submitting`-state check in the handler)                                                             | U    | guards Create new adult against double submission                                                                                        |
| 30  | 409 message keeps the values                                             | Reset the form on 409                                                                                                                                 | U    | shows the duplicate message on 409 and keeps the entered values                                                                          |
| 31  | Hidden while read-only                                                   | Gate the button on `canManage && canRestricted && people.directory` (no `hideWrites`)                                                                 | U    | returns to Add Adult with the read-only notice and no Create new adult button after a 402                                                |

Notes:

- Pins 11 to 13 share one `it` with three cases (manage missing, restricted missing, both held), as the move-adult test at `household-routes.test.ts:908-971` does; pinrun matches the exact `it` title. The success case grants exactly `people.manage` and `people.restricted.read` and not `people.view`, so swapping either check for `people.view` also fails it. Each weakening must fail it.
- Pin 18's test asserts the second argument of the mocked `withAppTransaction` (`{ orgId, communityId }` from the slug lookup), then the `addAdult` input: a full body (email, phone, adult date of birth) forwarded field by field, and a second call with the optional fields omitted giving `null` for each.
- Pin 15's test sets `people.directory` off **and** the organisation read-only, and expects 403 with a `guardLog` spy never called. If the directory check ran after billing, the answer would be 402.
- Pin 16's test uses the default snapshot (`people.households` only) and expects `create` 201 and `move-adult` 200. The existing test at `:756` is retitled to "allows household create when people.directory is disabled and people.households is enabled". Its body is unchanged.
- Pin 19's test (19a and 19b) captures `guardLog` and the request log (as `:595-613` does) for a 403, a 402, a 409 and a 400 on add-adult. For each it asserts `expect(await res.text()).toBe("")`, and that no given name, family name, email, phone or date of birth from the request appears in any log line.
- Pins 5 and 21: with both code checks removed, a cross-organisation insert fails on `persons_household_fk` (23503) and the route answers 500. The tests assert `code === "not_found"` (D) and status 404 exactly (I), not a bare `rejects.toThrow()`, so the weakening fails them on an assertion.
- Pin 25's test renders inside `PeopleAccessContext.Provider` with full access, opens Add Adult, then `rerender`s with each right removed (pattern at `family-records.test.tsx:5696-5721`) and asserts the button is gone each time; the view cannot be reached without the rights, so a test that starts without them would pass both ways. Pin 25's test sits inside the describe that defines `fullAccess` and `accessWithoutRestricted` (near `family-records.test.tsx:5559`) or defines its own access objects. Pin 31's test opens Add Adult with full access, presses Create new adult, saves into a mocked 402, and asserts the notice "Read-only until billing is settled", no "New adult in this household" heading and no Create new adult button. With the button ungated by `hideWrites`, the button reappears and the test fails on an assertion.
- Pin 29's test fires both submits inside a single `act(() => { ...; ... })` while the post promise is unresolved, and asserts exactly one add-adult call. Two separate `fireEvent.click` calls (as `all-contacts.test.tsx:2762-2819`) let the disabled Save button block the second click and hide the ref.
- Pins 3 to 10 use `createLocalKmsPort()` and `withTenant` (`household-members.integration.test.ts:62-91`). Pin 4 seeds two communities in one organisation; follow the moveAdult cross-community test at `:310`.
- Pins 9 and 9b use a stub `tx` (a `vi.fn()` tagged-template function), not a real transaction. Pin 9 asserts `invalid_input` and that the stub was never called. Pin 9b's stub records the SQL text of each call and returns `[]`; the test asserts `not_found` and that the first call's text contains both `current_setting('app.org_id')` and `current_setting('app.community_id')`. RLS answers the same as the filters, so this text check is the only test that sees them.
- **DA** has a file-wide partial mock: `vi.mock("@community-hub/db", async (importActual) => ({ ...(await importActual()), appendAuditEvent: <wrapper> }))`, where the wrapper throws only for action `people.person.household_moved` while a test flag is armed and otherwise calls the real function. That works because the people tests import the module source, so `household-members.ts`'s import is mocked. It lives in its own file so no other test is affected. After the throw, a fresh transaction counts rows in `app.persons`, `app.person_activity`, `app.audit_events` (actions `people.person.created` and `people.person.household_moved`) and `app.usage_facts_daily` (`people.directory`) for that community: all unchanged.
- **IA** has a file-wide partial mock of `@community-hub/people`: `addAdult` calls the real `addAdult` and then, while armed, throws `new Error("injected")`. `apps/api` imports the built people package, so a `@community-hub/db` mock would not reach it; mocking `@community-hub/people` from the route's own import does. The test answers 500 and finds the same counts unchanged. This replaces the spec's "for example a `vi.mock` of `@community-hub/db`" at the route level (spec pointer corrections, below).
- In DA and IA the armed flag lives in `vi.hoisted` state (as `household-routes.test.ts:11-33`), because `vi.mock` factories are hoisted above module variables. Partial-mock precedent in an integration file: `apps/api/src/billing-guard.integration.test.ts:35-44`. IA uses port 18489 (unused; 18451-18477, 18479 and 18485-18488 are taken).
- Pin 20c: the B fixture map gains `"POST /v1/households/members/add-adult"` (the exact-keys test at `:1351` requires it), whose `prepare` returns a body with a fresh household and a `count` of `countPersons` (`:365`).
- **Not pinned against a real database:** the explicit `org_id` / `community_id` filters on the household select. RLS on `app.households` (forced, org and community) gives the same answer, so only pin 9b's SQL-text test sees them; pin 4 covers the case where both code checks are gone.

## Rollback

- Revert the pull request's merge commit. The route disappears, the admin loses the Create new adult form, `ContactFields` returns to `all-contacts.tsx`.
- No migration or schema change. Adults created through the route stay as ordinary adults in their household (the same rows `people/create` plus `move-adult` would leave); their audit rows stay (append-only, ids only).

## Stop and ask (AGENTS.md §12)

The implementer stops and reports, without improvising, when:

- the plan is wrong or ambiguous, or the code does not match a pointer in it;
- a migration, a change to a file listed as untouched, a dependency, a workspace package, a Dockerfile, a workflow or a Terraform change looks necessary;
- a production seam would be needed only so a test can run (the DA and IA mocks live in the test files only);
- a test it wrote passes before the source change it is meant to drive, except: pin 24's test, the retitled test at `:756`, the All Contacts tests in Task 5, the "thrown people.directory read" test, and the tests of pins 4, 5 and 7, which can pass on the first `addAdult` draft (RLS filters `requireHousehold` by org and community; only pin 3 needs the explicit select). The report lists them as "passes before the change, by design";
- the same step fails twice;
- anything would put personal data in a log, an error body, a URL path or query, storage or an audit row;
- a secret, token or account identifier appears in any file or output.

### Task 1: Contract

**Commit:** `feat(contracts): add the add-adult household body`

**Files:**

- `packages/contracts/src/people.ts:8-9`: `export` on `email` and `phone`. Nothing else changes.
- `packages/contracts/src/households.ts`: import `email` and `phone` from `./people.js`; `addAdultBody` after `addMinorBody` (`:63-73`): `communitySlug: slug`, `householdId: uuid`, `givenName: name`, `familyName: name`, `email: email.nullable().optional()`, `phone: phone.nullable().optional()`, `dateOfBirth: dateOfBirth.nullable().optional()`, `.strict()`; export `type AddAdultBody` beside the other types (`:93-101`).
- `packages/contracts/src/households.test.ts`, inside `"household contract schemas (pin 10)"` (`:17`): the tests of pins 1 and 2; "addAdultBody accepts a body with only the required fields"; "addAdultBody accepts null and omitted optional fields"; "addAdultBody refuses an empty given or family name".

**Test first:** the five tests (RED: `addAdultBody` is not exported), then the source.

**Rule it must not break:** `createPersonBody` and every existing contract test unchanged.

**Pins:** 1, 2 (patches and manifest rows only).

### Task 2: Domain `addAdult`

**Commit:** `feat(people): create an adult directly in a household`

**Files:**

- `modules/core/people/infrastructure/household-members.ts`, after `addMinor` (`:229`):
  - `export type AddAdultInput = { now: Date; householdId: string; givenName: string; familyName: string; email: string | null; phone: string | null; dateOfBirth: string | null; actorUserId: string | null }`.
  - `export async function addAdult(tx, kms, keyArn, input): Promise<{ personId: string }>`:
    1. Input guard as `addMinor` (`:165-176`): `householdId` a string matching `UUID_RE`; names strings; `email`, `phone`, `dateOfBirth` each a string or `null` (not `undefined`). Else `PeopleError("invalid_input")`.
    2. The household select with explicit filters, as `addMinor` (`:183-193`). Absent → `PeopleError("not_found")`.
    3. `createPerson(tx, kms, keyArn, { now, declaredAdult: true, householdId, dateOfBirth, givenName, familyName, email, phone, actorUserId })`.
    4. `appendAuditEvent(tx, { actorKind, actorId, action: PERSON_HOUSEHOLD_MOVED, purpose: PERSON_HOUSEHOLD_MOVED, targetIds: [personId, householdId] })`, using the file's existing `actor` helper.
    5. Return `{ personId }`.
- `modules/core/people/public/index.ts:68-73`: export `addAdult` and `type AddAdultInput`.
- `modules/core/people/infrastructure/household-members.integration.test.ts`: a new `describe("household members: add adult")` after the add-minor block, with the tests of pins 3 to 9 and:
  - "addAdult: stores an adult with a date of birth under the community key with clear names" (reads the row back: `is_minor = false`, `age_basis = 'date_of_birth'`, `household_id`, `version = 1`, clear names, null restricted names, a `person_activity` `created` row, one `people.directory` usage fact);
  - "addAdult: a duplicate email or phone throws duplicate_email or duplicate_phone and writes nothing";
  - "addAdult: a duplicate email with an under-18 date of birth throws invalid_declaration";
  - "addAdult: an 81-character name throws invalid_name";
  - "addAdult: a future date of birth throws invalid_date and writes nothing";
  - the tests of pins 9 and 9b with a stub `tx` (note under Security pins);
  - "addAdult: undefined optional fields throw invalid_input".
- `modules/core/people/infrastructure/add-adult-atomicity.integration.test.ts` (new): the DA mock and the test of pin 10.

**Test first:** all new tests (RED: `addAdult` does not exist), then the source.

**Rule it must not break:** every existing people suite unchanged, including `addMinor` and `moveAdult` pins.

**Pins:** 3 to 10 (with 9b).

### Task 3: Route and unit tests

**Commit:** `feat(api): add an adult to a household in one transaction`

**Files:**

- `apps/api/src/household-routes.ts`:
  - `communityScope(slug, context, userId, extraEntitlements: readonly string[] = [])` (`:162-166`): after the `people.households` guard (`:173-177`), `for (const key of extraEntitlements)` call `guardEntitlement` and return its refusal; then billing as today.
  - `prepare(request, context, schema, extraEntitlements: readonly string[] = [])` (`:202-206`) passes it to `communityScope` (`:219`). The eight existing call sites stay as they are.
  - `const DIRECTORY_ENTITLEMENT = "people.directory"` beside `HOUSEHOLDS_ENTITLEMENT` (`:40`).
  - `statusForHouseholds` (`:60-84`): `duplicate_email`, `duplicate_phone` → 409; `invalid_email`, `invalid_phone` → 400.
  - `addAdultMember`, modelled on `moveAdultMember` (`:406-449`): `prepare(request, context, addAdultBody, [DIRECTORY_ENTITLEMENT])`; the permission pair and denial audit as `:416-429`; `addAdult(tx, deps.kms, deps.keyArn, { now: deps.now(), householdId: body.householdId, givenName: body.givenName, familyName: body.familyName, email: body.email ?? null, phone: body.phone ?? null, dateOfBirth: body.dateOfBirth ?? null, actorUserId: actor.userId })`; 201 `{ personId }`; the `try`/`catch` outside `deps.checkout`, as `:440-447`.
  - Route table (`:607-664`): `POST /v1/households/members/add-adult`, `surface: "tenant"`, `billing: "write"`, after add-minor.
- `apps/api/src/household-routes.test.ts`:
  - `addAdult` added to the hoisted `people` group (`:24-33`) and the `@community-hub/people` mock (`:71-85`).
  - The tests of pins 11 to 20a, and "add-adult: refuses 403 when the people.directory snapshot read throws" (`readSnapshot` resolves for households, then rejects; 403, empty body, `addAdult` not called, `guardLog` not called with `billing_write_blocked`). Add-adult tests pass per-test snapshot overrides with `people.directory` on; the `createSnapshot` defaults (`:124-139`, households only) are unchanged, because pin 16 relies on them. The 402 test (`:696`) gets a directory-on override for add-adult, or it would answer 403.
  - The write-route list (`:618-636`, `:620-627`) gains add-adult; its title becomes "registers all seven write routes…". The extra-keys test (`:640-692`) includes add-adult and sends each of `isMinor`, `declaredAdult`, `orgId`, `communityId`, `personId` and `version` as an extra key, expecting 400 each time. The 402 test (`:696-739`, retitled "blocks all seven write routes…") include add-adult.
  - The test at `:756` retitled (pin 16 note).
- `apps/api/src/index.test.ts`: a household row for add-adult in the table at `:725-732`; `toHaveLength(58)` at `:814`; the tuple at `:839-861`.

**Test first:** the unit tests (RED: route absent), then the source. Build `@community-hub/contracts` and `@community-hub/people` first.

**Rule it must not break:** every other household route's checks, statuses and audit unchanged; the existing unit suite green.

**Pins:** 11 to 20b (19a and 19b).

### Task 4: Route integration

**Commit:** `test(api): pin add-adult tenancy, rollback and billing on a real database`

**Files:**

- `apps/api/src/household-routes.integration.test.ts`, using its seeded orgs and communities (`:168-176`, `:255-284`) and an owner session: the tests of pins 21, 22, 22b and 24, plus "add-adult: a caller without people.restricted.read answers 403 and the denial is audited in the database".
- `apps/api/src/add-adult-atomicity.integration.test.ts` (new): the IA mock and the test of pin 23. It copies the minimum setup it needs from `household-routes.integration.test.ts` (env, migrations, one org, one community, one owner) and uses its own port.
- `apps/api/src/billing-guard.integration.test.ts`: the add-adult fixture (pin 20c note).

**Test first:** these are tests for Task 3's source; they pass on arrival except where a fixture is missing. The proof is the pins.

**Rule it must not break:** the existing integration suites green; `fileParallelism: false` kept.

**Pins:** 20c, 21, 22, 22b, 23.

### Task 4c: Register people.person.manage for household denials (spec amendment A1)

**Commit:** `fix(api): audit a missing people.manage on household routes`

**Files:**

- `modules/core/people/public/index.ts`: `defineAuditPurpose("people.person.manage")` beside the other people purposes (`:4-32`).
- `apps/api/src/household-routes.ts`: a `MANAGE_DENIAL_PURPOSE = "people.person.manage"` constant; every denial purpose that today is `MANAGE` (`:361`, and `!canManage ? MANAGE : RESTRICTED` at `:405, 450, 495, 544, 593` and the add-adult handler) uses it. `MANAGE` stays the permission key passed to `holdsPermission`.
- `apps/api/src/household-routes.test.ts`: the nine `purpose: "people.manage"` expectations become `"people.person.manage"`.
- `apps/api/src/household-routes.integration.test.ts`: "household write routes: a caller without people.manage answers 403 and the denial is audited as people.person.manage" — one `it` that, for each of the seven routes with a valid body, expects 403, an empty body, no change in the row it would write, and exactly one new `people.permission.denied` row with purpose `people.person.manage`.

**Test first:** the integration test (RED: 500 and no denial row), then the source.

**Rule it must not break:** a missing `people.restricted.read` still records `people.restricted.read`; every status and success path unchanged.

**Pins:** 4c-1 (weakening: `MANAGE_DENIAL_PURPOSE = "people.manage"`; test: the new integration test; must fail on an assertion).

Order: Task 4b (test-only) commits first, without its add-adult `people.manage` denial test, which this task's seven-route test replaces. Task 4c commits second.

### Task 5: Shared contact fields (refactor, no behaviour change)

**Commit:** `refactor(admin): share the contact fields between screens`

**Files:**

- `apps/admin/src/contact-fields.tsx` (new): `ContactFormData` (from `all-contacts.tsx:48-54`), `initialFormData` (`:56-62`) and `ContactFields` (`:111-164`), exported. `prefix` widens to `string`. A new optional `dobHelp?: string` reaches the date of birth `Field`'s `help` by a conditional spread (`{...(dobHelp !== undefined ? { help: dobHelp } : {})}`), because `exactOptionalPropertyTypes` is on (`tsconfig.base.json`). Ids stay `${prefix}-…`.
- `apps/admin/src/all-contacts.tsx`: import them from `./contact-fields`; delete the local copies. No other change.

**Test first:** none new. `all-contacts.test.tsx` must pass unchanged, five times. Its diff is empty.

**Rule it must not break:** All Contacts renders the same markup (ids, labels, order).

**Pins:** none.

### Task 6: Create new adult in Family Records

**Commit:** `feat(admin): create a new adult from Add Adult`

**Files:**

- `apps/admin/src/sydney-age.ts` (new): `isUnder18OnSydneyDate(dateOfBirth: string, now: Date): boolean`. Today in Sydney is computed with the server's `formatToParts` form (`en-US`, `calendar: "gregory"`, `timeZone: "Australia/Sydney"`, `modules/core/people/domain/person.ts:42-54`), copied, not `en-CA` string formatting, whose output depends on ICU locale data. Completed years are compared by year, month and day, with 29 February treated as the server does (`:95-105`; read it and match it).
- `apps/admin/src/sydney-age.test.ts` (new): the test of pin 27; "is under 18 the day before the 18th birthday"; "is not under 18 on the 18th birthday"; "treats a 29 February birthday as the server does".
- `apps/admin/src/family-records.tsx`:
  - `ViewMode` (`:79-88`) gains `"add-adult-new"`; state for the form (`ContactFormData`), a notice, and a `submittingRef`.
  - In the add-adult view (`:1575-1641`), above the search: a secondary `Button` "Create new adult", rendered only when `canAddAdult` (`:633`).
  - The new view: `Panel` titled "New adult in this household", `ContactFields` with `prefix="add-adult"` and `dobHelp="Under 18? Use Add minor instead."`, Save and Cancel. The heading gets its own ref and its own branch in the view-focus effect (`:558-576`), which has one branch per view.
  - Submit: the pre-send check with `isUnder18OnSydneyDate` (message "This person is under 18. Use Add minor instead.", nothing sent); the double-submit ref; `post("/v1/households/members/add-adult", body)` with empty optional fields omitted; the status table in spec Behaviour → Admin screen (201 → `reloadDetail()` and the detail view; 409, 400, 404 with the existing back-to-list button; 402 → `setPaymentRequired(true)`, `void refreshBilling()`, clear the form, `setView("add-adult")` and set `adultSearchNotice` to "Read-only until billing is settled", as the move handler does at `family-records.tsx:1083-1088`; 401/403/503/500/network). The `add-adult-new` view renders only while `canAddAdult` is true. The notice uses `role="alert"`, as the add-adult view's alert ref (`:553`).
  - Community switch clears the form, as `clearAdultSearch` (`:854-862`) does for search.
- `apps/admin/src/family-records.test.tsx`: the `mockApi` route branch for add-adult (beside move-adult at `:171-177`); the tests of pins 25, 26 and 28 to 31; and "opens Create new adult and returns to the search on Cancel without a request", "adds the new adult and reloads Household Details on 201 with focus on the heading", "shows 'Check the details and try again.' on 400", "shows 'Household not found' on 404 with the back button", "shows the generic message on 401, 403, 503, 500 and network failure and keeps the values", "clears the new adult form on community switch", and "passes axe scan on the new adult form and ties the date of birth help by aria-describedby" (inline `axe.run` as `:4574`).

**Test first:** the new tests (RED), then the source.

**Rule it must not break:** every existing Family Records test, including the add-adult search and move tests (`:2184-2480`) and the Task 10 focus tests (`:6007`).

**Pins:** 25 to 31.

### Task 7: Architecture, roadmap and repository state

**Commit:** `docs: mark add-adult-create done`

**Files:**

- `architecture.md:564`: "Nine routes", `members/add-adult` in the list; the entitlement sentence says each is guarded by `people.households`, and `members/add-adult` also by `people.directory`; the permission sentence adds add-adult to the routes needing both `people.manage` and `people.restricted.read`; one clause that add-adult creates and places the adult in one transaction.
- `docs/roadmap.md`: the `Add Adult create` row (`:175`) → `done`, citing this spec and plan; the snapshot (`:19-25`): last shipped `add-adult-create`, next chunk chosen by the chunk owner at this task (the reviewer asks before dispatch); the Phase 1 "Next is" line (`:99`) and the Next spec sentence (`:415`); open items: the staging check of this route for the next proof chunk; the `people.directory` / `people.households` mismatch of the existing Add adult button and `move-adult`; the name-only retry residual (spec owner decision 2).
- `AGENTS.md:9`: `Add Adult create` added to the done list; "Next is" updated. No other change.

**Rule it must not break:** `pnpm exec prettier --check .`; no decision text changes, so no ADR.

**Pins:** none.

## Dispatch order

1. Task 1 (its full gate needs Docker), then Task 2 (Docker), then Tasks 3 and 4 in one run (two commits; Docker in Task 4).
2. Checkpoint: pins 1 to 23 and pin 24's test by the reviewer, then the owner's check of the Task 4 diff. Then Tasks 5 and 6 in one run (two commits, admin only, full gate).
3. Task 7 after both.

## Definition of done (AGENTS.md §8)

- All seven tasks accepted by the reviewer agent, every pin in the table run by the reviewer through `pinrun.mjs` (pin 24 is a behaviour test, run with plain vitest), CI green on the pull request.
- The tenant-isolation tests touched (Tasks 2 and 4) are green.
- **Not done in this chunk:** the staging-hostname check (spec Out-of-band, §8 deviation accepted by the chunk owner).
- The PR body records: implementer Antigravity (Gemini 3.8 Flash High) and any fallback; reviewer agent Claude Opus 5.5; the owner's spec check (Sonnet 5.5, draft 2 → draft 3); the owner's plan and checkpoint checks with their models; the second-review line; the pins that are not pinned by design; the spec pointer corrections below.
- Session scratch cleaned up: no `docs/plans/*-report.md`; nothing under `.superpowers/` staged.

## Owner decisions

For the chunk owner, answered at plan approval:

1. **Seven tasks, one PR.** AGENTS.md §3 says to split a chunk that mixes a refactor with a feature or spans more than two modules. Task 5 is an enabling extraction (the form fields Task 6 reuses), pinned by an unchanged All Contacts suite, and the four packages ship one route and its screen that cannot be tested end to end apart; §3 leaves the call to the chunk owner. The PR body says so. Recommendation: keep.
2. **Checkpoint owner's check after Task 4** (all server and database work), on Sonnet 5.5, GPT or Grok, against the fixed Task 4 SHA. Tasks 5 and 6 start after it ends (revised from "alongside" after the owner's plan check, M2). Recommendation: keep.
3. **Pins run by the reviewer through `pinrun.mjs`,** the implementer writing patches only. Departs from AGENTS.md §4 Phase 2; recorded in the PR. Recommendation: keep.
4. **Deviation policy:** extra attempts, implementer changes and fix commits are recorded as deviations in the PR; cosmetic nits as PR notes.

Nothing here needs the project owner.

## Amendments during implementation

- **Implementer change (2026-11-18, chunk owner):** from Task 4c on, the implementer is Claude Sonnet 5.5 (a subagent with its own brief), not Antigravity. The second review must then avoid Sonnet as well as Opus and Gemini 3.8 Flash (GPT, Grok or Fable 5.2).
- **Task 4c** added by spec amendment A1.
- The local gate runs `turbo ... --concurrency=2` from Task 2 on (same coverage; this machine ran out of resources at full parallelism).

## Spec pointer corrections

- Spec Rules touched → Atomicity names "a partial mock of `@community-hub/db`" in the route integration suite. `apps/api` loads the built people package, so that mock cannot reach `addAdult`'s audit call there. The plan pins atomicity twice instead: in the people module with the `@community-hub/db` mock (DA, pin 10) and at the route with a `@community-hub/people` mock (IA, pin 23). The spec's weakening (catch inside the transaction) is pin 23.
- The spec says the atomicity test sits "beside its existing no-orphan-row cases". A file-wide mock cannot share that file, so both atomicity tests get their own files.

## Probe record

This plan has no Terraform assert, so no scratch probe is needed (AGENTS.md §4). No weakening edits a migration.
