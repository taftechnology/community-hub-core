Spec: docs/specs/2026-11-11-users-roles-people-details.md

# Users & Roles people details Implementation Plan

Slug: users-roles-people-details
Status: draft

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** a community admin opens Settings → Users & Roles and sees each user's name, sign-in email and phone, and each built-in role by its label, instead of ids and role keys. The sign-in email is decrypted only inside `core/identity`. A minor-linked user's details are never shown, and the only things written to audit are ids.

**Architecture:**

- `packages/contracts/src/access.ts` gets `listUsersBody` and `listUsersResponse`.
- `modules/core/access` registers the audit action and purpose `access.users.listed`, the purpose `access.users.view`, and the error code `too_many`.
- `modules/core/identity` gets `readUserEmails`, a read-only decrypt of `identity.users.email` that never creates a key, exported from `public/index.ts`.
- `modules/core/people` gets `readLinkedContacts`, a batch read of linked persons that opens the community key only when it decrypts a phone and never creates a key. It writes one `people.person.read` row. It is exported from `public/index.ts`.
- `apps/api/src/access-routes.ts` gets `POST /v1/access/users/list`, which follows the spec's nine-step order inside one app transaction.
- `apps/admin/src/users-roles.tsx` calls the route, joins the result by `userId`, and shows built-in role labels.
- The docs get the `architecture.md` §11.1 and §12.2.1 sentences, the roadmap (this row done, a new "User invitations" row, the snapshot), and `AGENTS.md` line 9.

## Who does what

- **Implementer:** Antigravity (Gemini), in this worktree on the chunk branch. It writes tests first, makes one commit per task, commits locally and never pushes. It runs one plan task per run, because this machine has 12 GB of RAM. It runs every row of the Security pins table that its task names (see that section) and reports each failure.
- **Reviewer agent:** this session, on Claude Opus 5.5 for the whole chunk. Each task is reviewed by its diff, with a fresh-context reviewer subagent on the same model that runs the tests and re-runs at least one pin per task. Before any Review record is written, the reviewer agent checks the model it ran on in the session transcript.
- **Owner's check and second review:** run by the chunk owner in a fresh session on Claude Sonnet 5.5, or on another model that is neither Opus 5.5 nor Gemini. This chunk is sensitive: identity, tenancy, encryption, and children's data through the minor rule. The second review starts when the pull request opens, and the pull request does not merge until that review is written.
- Only one run at a time uses the Docker test database.

## Checkpoints

- **After Task 3** (both module exports exist): the reviewer runs pins 5, 6, 10, 11, 13 and 14 before Task 4 starts.
- **After Task 5** (the route exists and its integration suite is green): the reviewer runs pins 1 to 4, 7 to 9, 12 and 15 before any admin work starts.

## Global constraints

- **Branch:** `feat/2026-11-11-users-roles-people-details`, created from `origin/main` at `db67e5a` (PR #84 merged). The spec is its first commit (`cf0a8ae`) and this plan is its second. The plan stays `Status: draft` until the owner's assistant has read both on the branch. Then the chunk owner approves it.
- **Database:** no migration, no new table, no new grant. If a task finds it needs one, it stops and reports.
- **Dependencies:** none added. If a task finds it needs one, it stops and reports.
- **Workspace packages:** none added, so there is no Dockerfile or `image.test.ts` change.
- **Never disabled to get green:** a check, a lint rule, an axe rule, RLS, a test or a CI gate.
- **Fixtures** are synthetic. Names, emails and phones are invented. A string that looks like a secret is split, so scanners never match it.
- **No personal data** in URLs, logs, traces, errors or audit rows. Tests assert this by searching for each fixture's name, email and phone.
- **Untouched areas:** staging stays parked. No Terraform, workflow, Dockerfile or `infra/` change. `grants/list` and `/v1/access/capabilities` keep their responses byte for byte.
- **Build order:** `apps/api` and `apps/admin` tests import the built `dist` of `@community-hub/contracts`, `@community-hub/identity`, `@community-hub/people` and `@community-hub/access`. After Tasks 1 to 3, run `pnpm build` before the next package's tests.
- **Admin stale-response rules** apply to the new fetch:
  - a generation guard on every response, including after `json()`;
  - every guard pinned by a test that fails without it;
  - non-200 answers with JSON bodies covered;
  - a StrictMode render test;
  - no real waits;
  - exact call counts.
- **Local gate per task:** `pnpm gate`, after `pnpm install --frozen-lockfile` and `pnpm build` in a fresh worktree. When a brief skips the full gate for memory, it still runs `pnpm exec prettier --check .` and `pnpm check:boundaries`. Bypass the turbo cache (`--force`) when a test reads a file outside its package.
- **Allowed failures on this Windows machine,** and only these:
  - `packages/db/src/generate.test.ts` drizzle ENOENT;
  - the `image-publish` symlink EPERM;
  - the `migrate.integration` and `plaintext-dist` timeouts.

## Decisions fixed by the spec (do not reopen)

- **Route:** `POST /v1/access/users/list`.
  - Tenant surface, `billing: "read"`.
  - Body `{ communitySlug }`, strict.
  - Needs `access.roles.view` **and** `access.users.view`. A phone also needs `people.view`.
  - No entitlement gate.
  - `cache-control: no-store` on every response.
  - Error bodies are empty.
- **Response:** `{ phoneVisible, users: [{ userId, personId|null, name: { given, family }|null, email|null, phone|null, minor }] }`.
- **Order, inside one app transaction:**
  1. Load the directory and the caller's permissions.
  2. Check the permissions. On failure, deny with an audit row and return 403.
  3. Collect the user-id set.
  4. Check the cap. Over 500 is a 409 with no audit row.
  5. Read the linked persons.
  6. Decrypt phones only with `people.view`, writing one `people.person.read` row for the persons whose phone was opened.
  7. Call `deps.checkout("identity", …)` from inside the transaction callback, with the user ids that are not minor-linked.
  8. Append `access.users.listed` with the listed user ids.
  9. Commit and respond.

  Any throw rolls back the whole transaction.

- **Minors:** `minor: true`, and the name, email and phone are all null. The id is never passed to the identity export, and the household key is never unwrapped.
- **Sort:**
  1. Named rows first, by family name, then given name.
  2. Unnamed rows after them.
  3. Ties break on email, with nulls last, and then on user id.

  Comparisons use `localeCompare(…, "en-AU", { sensitivity: "base" })`.

- **No key creation on this path:** the identity key, the organisation key and the community key are read only. A missing key gives 500.
- **The screen:** shows the sign-in email, not the person's email. The User fields of the grant and link forms stay user-id inputs. Built-in roles get labels from a static admin map.
- **Out of the chunk:** invitations, user pickers, last sign-in, search and filters, any member or website surface.

## Security pins

The implementer runs each row named in its task once. It weakens the source, sees the named test fail, restores the source, and reports the failure output. The weakened tree is never committed. The reviewer reads the weakening report and re-runs at least one row per task, and every row at its checkpoint.

| #   | Setting                                                              | Weakening                                                                                                 | Pinning test                                                                                                                                                                 |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Both `access.roles.view` and `access.users.view` are required        | (a) drop the `access.users.view` check; (b) drop the `access.roles.view` check                            | `access-routes.test.ts`: a caller with `access.roles.view` only → 403; a caller with `access.users.view` only → 403; both → 200                                              |
| 2   | Phone needs `people.view`                                            | pass `includePhone: true` whatever the caller holds                                                       | `access-routes.test.ts`: both view permissions without `people.view` → every `phone` null, `phoneVisible: false`, and `readLinkedContacts` called with `includePhone: false` |
| 3   | A minor-linked user id never reaches the identity export             | pass every directory user id to `readUserEmails`                                                          | `access-routes.test.ts`: the `readUserEmails` mock never receives the minor-linked id; the response row has `minor: true` and null name, email and phone                     |
| 4   | User ids come only from the scoped directory                         | make `listUsersBody` non-strict and union a body `userIds` field into the set                             | `access.test.ts` (contracts): a body with `userIds` is rejected; `access-routes.test.ts`: that body gets 400 and no export is called                                         |
| 5   | AAD binds each row's own user id                                     | decrypt every row with `rowId` of the first requested id                                                  | `user-emails.integration.test.ts`: two users read in reverse order return the right email each; a ciphertext copied onto another user's row fails to open                    |
| 6   | `readLinkedContacts` writes `people.person.read` with the opened ids | remove the `appendAuditEvent` call                                                                        | `linked-contacts.integration.test.ts`: one `people.person.read` row whose `target_ids` are exactly the persons whose phone was opened; none when no phone was opened         |
| 7   | `access.users.listed` is the last write, and a failure rolls it back | append `access.users.listed` before the identity call, in its own committed transaction                   | `users-list.integration.test.ts`: a corrupted identity ciphertext gives an empty 500 and no `access.users.listed` row                                                        |
| 8   | The denial purpose `access.users.view` is registered                 | remove `defineAuditPurpose("access.users.view")`                                                          | `users-list.integration.test.ts`: a caller without `access.users.view` gets an empty 403, not a 500, and an `access.permission.denied` row exists                            |
| 9   | The cap is 500, checked before any read or decrypt                   | (a) raise it to 5,000; (b) move the check after `readLinkedContacts`                                      | `access-routes.test.ts`: 501 directory users → empty 409, no export called, no audit append; 500 → 200                                                                       |
| 10  | The identity export never creates a key                              | call `ensureIdentityKey` before the read                                                                  | `user-emails.integration.test.ts`: with no `identity_keys` row → throws, still zero rows, and the counting KMS port saw zero `generateDataKey` calls                         |
| 11  | The people export never creates an organisation or community key     | use the creating `openCommunityHkdf`                                                                      | `linked-contacts.integration.test.ts`: with no community key row → throws, no key row created, zero `generateDataKey` calls                                                  |
| 12  | Empty error bodies and `no-store`                                    | (a) return `{ error: code }` on 403, 409 or 500; (b) drop the header                                      | `access-routes.test.ts`: every status has a zero-length body and `cache-control: no-store`                                                                                   |
| 13  | No encrypted column outside a select list (§1 rule 3)                | add `order by email` to the identity SQL, or `and phone is not null` to the people SQL                    | `user-emails.test.ts` and `linked-contacts.test.ts`: the SQL text names `email` or `phone` only between `select` and `from`                                                  |
| 14  | Community isolation of persons and links                             | in a scratch DB only, alter the `app.persons` policy to drop its `community_id` term before the test runs | `linked-contacts.integration.test.ts`: a person in community 2 of the same organisation is dropped when read from community 1; a person in organisation B is dropped         |
| 15  | No field value, SQL text, hostname or stack in a log line            | log the caught error object on 500                                                                        | `access-routes.test.ts`: the captured log calls during a success and a forced decrypt failure contain no fixture name, email, phone, `select`, or `at `                      |
| 16  | The `app` role has no `identity` privileges                          | in a scratch DB only, run `GRANT USAGE ON SCHEMA identity TO app` before the test runs                    | `identity.integration.test.ts:104-122` (existing, kept green)                                                                                                                |
| 17  | The screen ignores a stale `users/list` response                     | remove the generation check after the `users/list` `json()`                                               | `users-roles.test.tsx`: switching community while the first `users/list` is pending never renders the first community's names                                                |

## Rollback

Revert the pull request's merge commit. No migration, no data and no key are created, so nothing else needs undoing. Audit rows already written stay, as the audit log is append-only. They hold ids only.

## Stop and ask (AGENTS.md §12)

The implementer stops and reports, without improvising, when:

- the plan is wrong or ambiguous, or the code does not match a pointer in it;
- a migration, grant, dependency, workspace package, Dockerfile, workflow or Terraform change looks necessary;
- a pin's weakening does not make its test fail;
- the same step fails twice;
- anything would put personal data in a log, an error, a URL or an audit row;
- a secret, token or account identifier appears in any file or output.

### Task 1: Contracts, audit registration and the `too_many` code

**Commit:** `feat(access): add the users list contract and audit names`

**Files:**

- `packages/contracts/src/access.ts`
- `packages/contracts/src/access.test.ts`
- `modules/core/access/public/index.ts`
- `modules/core/access/domain/error.ts`
- one registration test beside the access public index (new file `modules/core/access/public/registration.test.ts`)

**Test first:**

- `listUsersBody` accepts `{ communitySlug }` and rejects an extra key such as `userIds` (pin 4).
- `listUsersResponse` accepts each null case from the spec's table and rejects an extra key at both levels.
- `isAuditAction("access.users.listed")`, `isAuditPurpose("access.users.listed")` and `isAuditPurpose("access.users.view")` are true once the public index is imported.
- `AccessErrorCode` includes `too_many`.

**Rule it must not break:** `capabilitiesResponse` and `listGrantsBody` are unchanged.

**Pins run:** 4 (the contracts half).

### Task 2: `readUserEmails` in `core/identity`

**Commit:** `feat(identity): read sign-in emails for a set of users`

**Files:**

- new `modules/core/identity/infrastructure/user-emails.ts`
- new `modules/core/identity/infrastructure/user-emails.test.ts`
- new `modules/core/identity/infrastructure/user-emails.integration.test.ts`
- `modules/core/identity/public/index.ts`

**Shape:** `readUserEmails(sql, kms, keyArn, userIds): Promise<Map<string, string>>`.

1. Validate every id as a UUID, and allow at most 500 ids. Otherwise throw `IdentityError`.
2. Read the existing `identity.identity_keys` row exactly as `email-lookup.ts:52-56` does. Throw if it is missing. Never call `ensureIdentityKey`.
3. Unwrap and derive as at `:58-59`.
4. Run `select id, email from identity.users where id = any($1::uuid[])`.
5. Decrypt each row with `decrypt` from `packages/crypto/src/encrypt.ts:40`. The AAD is the encrypt call's: tag `chub/field-identity/v1`, label `identity.users.email`, `rowId` the row's own `id`, region `au`.
6. Omit ids with no row. Never log or return a ciphertext.

**Test first:**

- **Unit:** UUID and size validation; the SQL text names `email` only in the select list (pin 13).
- **Integration** (Docker, `createLocalKmsPort` wrapped in a counting port that counts `decrypt` and `generateDataKey`):
  - users created with `insertIdentityUserWithKeys` decrypt correctly;
  - reverse order returns the right email each (pin 5);
  - a ciphertext copied onto another user's row throws (pin 5);
  - an unknown id is omitted;
  - with no key row, the call throws, creates no row and makes zero `generateDataKey` calls (pin 10);
  - one call makes exactly one KMS `decrypt`.

**Rule it must not break:** no module outside `core/identity` references `identity.*`. `identity.integration.test.ts:104-122` stays green (pin 16).

**Pins run:** 5, 10, 13 (identity half), 16.

### Task 3: `readLinkedContacts` in `core/people`

**Commit:** `feat(people): read linked contacts in one batch`

**Files:**

- `modules/core/people/infrastructure/keys.ts`: a new non-creating `openExistingCommunityHkdf`, reusing `selectOrganisationKey` (`:59`) and `selectCommunityKey` (`:68`) and the unwrap at `:127` and `:172`. It throws when either row is missing.
- new `modules/core/people/infrastructure/linked-contacts.ts`
- new `modules/core/people/infrastructure/linked-contacts.test.ts`
- new `modules/core/people/infrastructure/linked-contacts.integration.test.ts`
- `modules/core/people/public/index.ts`

**Shape:** `readLinkedContacts(tx, kms, keyArn, { personIds, includePhone })` returns a `Map` from person id to `{ minor: true }` or `{ minor: false, given, family, phone: string|null }`.

1. Validate UUIDs and allow at most 500 ids.
2. Run one select in the style of `roster-names.ts:93-115`: `id, given_name, family_name, is_minor, phone where id = any($1::uuid[])`, plus the org and community predicates.
3. Return minors with no field, and never open a household key for them.
4. Only when `includePhone` is true and at least one adult has a phone: open the community key once with `openExistingCommunityHkdf` and decrypt the phones as `person.ts:358` does.
5. Then append one `people.person.read` row (`roster-names.ts:197-204` style) whose `targetIds` are the persons whose phone was opened.
6. Drop ids that RLS hides.

**Test first:**

- **Unit:** the SQL text names `phone` only in the select list (pin 13).
- **Integration** (fixtures from `roster-names.integration.test.ts:49-100`, `restricted-read.integration.test.ts:135-151`, `person.integration.test.ts:104-127`):
  - an adult's names and phone are returned;
  - a minor returns `{ minor: true }` only, and the counting KMS port shows no extra `decrypt` for a household key;
  - `includePhone: false` makes zero KMS calls and writes no audit row;
  - the audit row's ids are exactly the opened persons and contain no fixture value (pin 6);
  - with no community key row, the call throws, creates nothing and makes zero `generateDataKey` calls (pin 11);
  - persons in community 2 and in organisation B are dropped (pin 14).

**Rule it must not break:** `openPersonFieldKeys`, `readRosterNames` and `openCommunityHkdf` keep their behaviour. Their existing tests stay green.

**Pins run:** 6, 11, 13 (people half), 14.

**Checkpoint after this task.**

### Task 4: The `users/list` route

**Commit:** `feat(api): list users with their contact details`

**Files:**

- `apps/api/src/access-routes.ts`
- `apps/api/src/access-routes.test.ts`
- `apps/api/src/index.test.ts`: route count 51 → 52, plus the marking row next to `grants/list`.

**Shape:** a new route beside `grants/list` (`access-routes.ts:386-421`), reusing `sessionUser`, `communityScope`, `transact`, `loadDirectory`, `callerPermissions`, `deny` and `empty`.

- `too_many` joins the `CONFLICT` set (`:55-64`).
- The identity export is called through `deps.checkout("identity", (sql) => readUserEmails(sql, deps.kms, deps.keyArn, ids))` from inside the `transact` callback.
- `deny` uses the purpose `access.users.view` when that is the missing permission, and `access.roles.view` otherwise.
- Sorting is a pure function, exported for its own unit test.
- Every response, success and error alike, sets `cache-control: no-store`.

**Test first** (mocked checkouts, the `access-routes.test.ts:51-161` pattern):

- the permission matrix (pin 1);
- the phone rule (pin 2);
- minor ids never passed to `readUserEmails` (pin 3);
- a body with `userIds` gets 400 (pin 4);
- the cap at 500 and 501 (pin 9);
- empty bodies and `no-store` on 200, 400, 403, 404 (foreign host), 409 and 500 (pin 12);
- the log-capture test in the style of `:850-877` (pin 15);
- the sort order, including null names, null emails and accented names;
- "registers eight tenant posts" (`:205`) becomes nine.

**Rule it must not break:** `grants/list` responses are unchanged. Its existing tests stay green without edits.

**Pins run:** 1, 2, 3, 4 (route half), 9, 12, 15.

### Task 5: Integration suite for the route

**Commit:** `test(api): pin users list tenancy, audit and rollback`

**Files:** new `apps/api/src/users-list.integration.test.ts`, which reuses the harness of `access-flow.integration.test.ts`: the local KMS (`:132`), two communities in one organisation plus a second organisation (`:185-205`), users via the OTP flow (`:216-230`), `bootstrapOwner` (`:232`), and grants and links over HTTP. Persons come from the people module's `createPerson` and `createHousehold`. A minor-linked user is inserted directly into `app.user_links` by the test's owner connection, because `linkUser` refuses it.

**Test first:**

- An organisation A caller never sees an organisation B-only user.
- A community 1 caller never sees a community 2-only user, except one with an organisation-level grant. That user shows "no link" (null `personId`) in community 1 when linked only in community 2.
- A user who belongs to both organisations shows the same email in each.
- A minor-linked user returns nulls for every role, `community_admin` included.
- A successful call writes exactly one `access.users.listed` row with the listed user ids, and one `people.person.read` row with the opened person ids. Neither holds a fixture value.
- A corrupted identity ciphertext gives an empty 500 and no `access.users.listed` row (pin 7).
- A caller without `access.users.view` gets an empty 403 and an `access.permission.denied` row (pin 8).
- A user id with no identity row returns `email: null`.

**Rule it must not break:** this task changes no source file. If a test can only pass with a source change, the task stops and reports.

**Pins run:** 7, 8.

**Checkpoint after this task.**

### Task 6: The admin screen

**Commit:** `feat(admin): show names, emails and phones on Users & Roles`

**Files:**

- `apps/admin/src/users-roles.tsx`
- `apps/admin/src/users-roles.test.tsx`
- new `apps/admin/src/role-labels.ts`: the static map of built-in role key to label, for every key in `access-routes.ts:41-53`, and its test.

**Shape:**

- After `grants/list` succeeds and its `permissions` include `access.users.view`, the screen posts `{ communitySlug }` to `/v1/access/users/list`.
- It joins the result by `userId` and renders, in the grants list and the user links list:
  - name, email, then phone;
  - the user id as secondary text;
  - "No contact linked" when `personId` is null;
  - "No sign-in account" when `email` is null and `minor` is false;
  - "Details hidden" when `minor` is true;
  - "—" for a missing phone when `phoneVisible` is true, and nothing in the phone slot when it is false.
- Built-in roles render by label. Custom roles render by key.
- On 403, 409, 500 or "unavailable", the ids view stays and a fixed message shows. The 409 message is "Too many users to show details".
- The generation guard at `:175` covers the new response, after `json()` too.

**Test first:**

- The current test at `:82-118` is replaced by a URL-keyed `fetch` mock and one test per state above.
- A caller without `access.users.view` gets the ids view, and `users/list` is never called (exact call count).
- The stale-response test (pin 17).
- A StrictMode render.
- Non-200 answers with JSON bodies.
- An axe check on the new rows.

**Rule it must not break:** no control renders that only 403s. Grant and link forms keep their user-id input.

**Pins run:** 17.

### Task 7: Architecture, roadmap and AGENTS.md

**Commit:** `docs: mark users-roles-people-details done`

**Files:** `architecture.md`, `docs/roadmap.md`, `AGENTS.md`.

- `architecture.md:667` (§11.1 identity email bullet) and `:777` (§12.2.1 `identity.users.email` row): the sign-in email is decrypted only in `core/identity`, in the regional service, for the Users & Roles list. It is decrypted only for users in the caller's community directory, and never for a minor-linked user. Display only, never logged or audited. No ADR (owner decision O2).
- `docs/roadmap.md`:
  - The row at `:171` becomes **done**, with the spec path.
  - A new Phase 2 row, **not started**, "User invitations": user creation, invitations with the user's acceptance, and picking a user by name. Owner decision O3. It also closes the grant-to-reveal gap (O1).
  - An open item: grants and links accept any user id without consent, and "User invitations" closes it.
  - The snapshot at `:19-30`: last shipped `users-roles-people-details`, and the next chunk as the chunk owner names it before this task runs.
  - `:99` and the "Next spec" section at `:394-396` say the same.
- `AGENTS.md:9` "Repository state": this chunk is done, and the next chunk is named.

**Test first:** none (docs). `pnpm exec prettier --check .` and `pnpm check:boundaries` pass.

**Rule it must not break:** no other row changes status. No architecture decision other than O2's sentence changes.

## Definition of done (AGENTS.md §8)

- All seven tasks are accepted by the reviewer agent, every named pin has been run and reported, and CI is green on the pull request.
- Tenant-isolation tests (Tasks 3 and 5) are green.
- **Not done in this chunk:** checking the behaviour on the staging hostname. Staging stays parked, and the check is deferred to the next proof chunk that unparks (spec default 9). The PR body records this as a §8 deviation.
- The PR body records:
  - implementer: Antigravity (Gemini);
  - reviewer agent: Claude Opus 5.5, as checked in the transcript;
  - the owner's check, with its model and what it ran;
  - the second-review line.
- Session scratch is cleaned up: no `docs/plans/*-report.md`, and nothing under `.superpowers/` staged.

## Probe record

No Terraform assert is in this plan, so no scratch probe is required (AGENTS.md §4). The pins that need a scratch DB (14, 16) change only the local Docker test database. They are reverted by recreating it.

## Amendments after approval

None yet.
