Spec: docs/specs/2026-11-11-users-roles-people-details.md

# Users & Roles people details Implementation Plan

Slug: users-roles-people-details
Status: draft

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** a community admin opens Settings → Users & Roles and sees each user's name, sign-in email and phone, and each built-in role by its label, instead of ids and role keys. The sign-in email is decrypted only inside `core/identity`. A minor-linked user's details are never shown. Audit rows hold ids only.

**Architecture:**

- `packages/contracts/src/access.ts` gets `listUsersBody` and `listUsersResponse`.
- `modules/core/access` registers the audit action and purpose `access.users.listed`, the purpose `access.users.view`, and the error code `too_many`.
- `modules/core/identity` gets `readUserEmails`, a read-only decrypt of `identity.users.email` that never creates a key, exported from `public/index.ts`.
- `modules/core/people` gets `readLinkedContacts`, a batch read of linked persons. It opens the community key only when it decrypts a phone, never creates a key, and writes one `people.person.read` row. It is exported from `public/index.ts`.
- `apps/api/src/access-routes.ts` gets `POST /v1/access/users/list`, which follows the spec's nine-step order inside one app transaction and catches errors outside it.
- `apps/admin/src/users-roles.tsx` calls the route, reads the response with a hand-written reader, joins it by `userId`, and shows built-in role labels.
- The docs get the `architecture.md` §11.1 and §12.2.1 sentences, the roadmap (this row done, a new "User invitations" row, an open item, the snapshot), and `AGENTS.md` line 9.

## Who does what

- **Implementer:** Antigravity (Gemini), in this worktree on the chunk branch. It writes tests first, makes one commit per task, commits locally and never pushes. It runs one plan task per run, because this machine has 12 GB of RAM. It runs every row of the Security pins table that its task names and reports each failure.
- **Reviewer agent:** this session, on Claude Opus 5.5 for the whole chunk. Each task is reviewed by its diff. A fresh-context reviewer subagent on the same model runs the tests and re-runs at least one pin per task. Before any Review record is written, the reviewer agent checks the session transcript for the model it ran on.
- **Owner's check and second review:** the chunk owner runs these in a fresh session on Claude Sonnet 5.5, or on another model that is neither Opus 5.5 nor Gemini. This chunk is sensitive: it touches identity, tenancy, encryption, and children's data through the minor rule. The second review starts when the pull request opens, and the pull request does not merge until it is written.
- Only one run at a time uses the Docker test database.

## Checkpoints

- **After Task 3** (both module exports exist): the reviewer runs pins 5, 6, 10, 11, 13, 14 and 16 before Task 4 starts.
- **After Task 5** (the route exists and its integration suite is green): the reviewer runs pins 1 to 4, 7 to 9, 12, 15 and 18 before any admin work starts.
- **After Task 6** (the screen): the reviewer runs pins 17 and 19 before Task 7.

## Global constraints

- **Branch:** `feat/2026-11-11-users-roles-people-details`, created from `origin/main` at `db67e5a` (PR #84 merged).
  - The spec is its first commit (`cf0a8ae`) and this plan is its second.
  - The plan stays `Status: draft` until the owner's assistant has read both on the branch. Then the chunk owner approves it.
- **Database:** no migration, no new table and no new grant. If a task finds it needs one, it stops and reports.
- **Dependencies:** none added. If a task finds it needs one, it stops and reports.
- **Workspace packages:** none added, so no Dockerfile or `image.test.ts` change.
- **Never disabled to get green:** a check, a lint rule, an axe rule, RLS, a test or a CI gate.
- **Fixtures** are synthetic. Names, emails and phones are invented. A string that looks like a secret is split, so scanners never match it.
- **No personal data** in URLs, logs, traces, errors or audit rows. Tests assert this by searching for each fixture's name, email and phone.
- **Untouched areas:**
  - Staging stays parked.
  - No Terraform, workflow, Dockerfile or `infra/` change.
  - `grants/list` and `/v1/access/capabilities` keep their responses, headers included. The shared `empty()` helper is not changed.
- **Build order:** `apps/api` tests import the built `dist` of these four packages: `@community-hub/contracts`, `@community-hub/identity`, `@community-hub/people` and `@community-hub/access`. Only `db/plaintext` and `crypto/testing` are aliased to source (`apps/api/vitest.integration.config.ts:9-20`). After Tasks 1 to 3, run `pnpm build` before the next package's tests. `apps/admin` does not depend on `contracts` (`apps/admin/package.json:13-15`).
- **Admin stale-response rules** apply to the new fetch:
  - a generation guard on every response, including after `json()`;
  - every guard pinned by a test that fails without it;
  - non-200 answers with JSON bodies covered;
  - a StrictMode render test;
  - no real waits;
  - exact call counts;
  - every stale-response and clearing test uses a user id that appears in both communities' directories, with different details in each. Otherwise the join by `userId` hides a stale write, and the test passes without the guard.
- **Local gate per task:** `pnpm gate`, after `pnpm install --frozen-lockfile` and `pnpm build` in a fresh worktree.
  - When a brief skips the full gate for memory, it still runs `pnpm exec prettier --check .` and `pnpm check:boundaries`.
  - Bypass the turbo cache (`--force`) when a test reads a file outside its package.
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
  - `cache-control: no-store` on every response of this route.
  - Error bodies are empty.
- **Response:** `{ phoneVisible, users: [{ userId, personId|null, name: { given, family }|null, email|null, phone|null, minor }] }`.
- **Order, inside one app transaction:**
  1. Load the directory and the caller's permissions.
  2. Check the permissions. On failure, deny with an audit row and return 403.
  3. Collect the user-id set.
  4. Check the cap. Over 500 is a 409 with no audit row.
  5. Read the linked persons.
  6. Decrypt phones only if the caller holds `people.view`. Write one `people.person.read` row for the persons whose phone was opened.
  7. Call `deps.checkout("identity", …)` from inside the transaction callback, with the user ids that are not minor-linked.
  8. Append `access.users.listed` with the listed user ids.
  9. Commit and respond.
- **Rollback:** any throw rolls back the whole transaction, so no audit row from a failed call commits.
- **Minors:** `minor: true` and a null name, email and phone. The id is never passed to the identity export, and the household key is never unwrapped.
- **Sort:**
  1. Rows with a name first, by family name, then given name.
  2. Then the rows without a name.
  3. Ties break on email, nulls last, then on user id.

  Comparisons use `localeCompare(…, "en-AU", { sensitivity: "base" })`.

- **No key creation on this path:** the identity, organisation and community keys are read only. A missing key gives 500.
- **The screen:**
  - It shows the sign-in email, not the person's email.
  - The User fields of the grant and link forms stay user-id inputs.
  - Built-in roles get labels from a static admin map.
- **Out of the chunk:** invitations, user pickers, last sign-in, search and filters, and any member or website surface.

## Security pins

The implementer runs each row named in its task once:

1. Weaken the source.
2. Watch the named test fail.
3. Restore the source.
4. Confirm the test is green again.
5. Report the failure output.

The weakened tree is never committed. The reviewer reads the weakening report, re-runs at least one row per task, and runs every row at its checkpoint.

- **Weakening a package that an `apps/*` test reads from `dist`:** run `pnpm --filter <package> build` after weakening, and again after restoring. This applies to pin 4 (the route half) and pin 8.
- **A database change** (pins 14 and 16) is made in the scratch tree only. Append the SQL to the newest product migration, `packages/db/drizzle/0018_wise_starfox.sql`, and restore with `git checkout -- packages/db/drizzle`. That file's last statement has no trailing `--> statement-breakpoint`, so append one before the new statement. Every vitest run recreates the test database (`packages/db/test/global-setup.ts:59-104`), so SQL typed into a running database does not survive.

| #   | Setting                                                              | Weakening                                                                                                                                                                                                                                                                                                                                           | Pinning test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Both `access.roles.view` and `access.users.view` are required        | (a) drop the `access.users.view` check; (b) drop the `access.roles.view` check                                                                                                                                                                                                                                                                      | `access-routes.test.ts`: a caller with `access.roles.view` only → 403; with `access.users.view` only → 403; with both → 200                                                                                                                                                                                                                                                                                                                                                                 |
| 2   | Phone needs `people.view`                                            | pass `includePhone: true` whatever the caller holds                                                                                                                                                                                                                                                                                                 | `access-routes.test.ts`: both view permissions without `people.view` → every `phone` null, `phoneVisible: false`, and `readLinkedContacts` called with `includePhone: false`                                                                                                                                                                                                                                                                                                                |
| 3   | A minor-linked user id never reaches the identity export             | pass every directory user id to `readUserEmails`                                                                                                                                                                                                                                                                                                    | `access-routes.test.ts`: the `readUserEmails` mock never receives the minor-linked id; the row has `minor: true` and null name, email and phone                                                                                                                                                                                                                                                                                                                                             |
| 4   | User ids come only from the scoped directory                         | make `listUsersBody` non-strict and union a body `userIds` field into the set (rebuild `@community-hub/contracts`)                                                                                                                                                                                                                                  | `access.test.ts` (contracts): a body with `userIds` is rejected; `access-routes.test.ts`: that body gets 400 and no export is called                                                                                                                                                                                                                                                                                                                                                        |
| 5   | AAD binds each row's own user id                                     | decrypt every row with the `rowId` of the first requested id                                                                                                                                                                                                                                                                                        | `user-emails.integration.test.ts`: two users read in reverse order return the right email each; a ciphertext copied onto another user's row fails to open                                                                                                                                                                                                                                                                                                                                   |
| 6   | `readLinkedContacts` writes `people.person.read` with the opened ids | remove the `appendAuditEvent` call                                                                                                                                                                                                                                                                                                                  | `linked-contacts.integration.test.ts`: one `people.person.read` row whose `target_ids` are exactly the persons whose phone was opened, with the given actor; none when no phone was opened                                                                                                                                                                                                                                                                                                  |
| 7   | A failed call commits no audit row                                   | (a) append `access.users.listed` before the identity call, in its own committed transaction; (b) catch the error inside the `transact` callback and return `empty(500)`                                                                                                                                                                             | `users-list.integration.test.ts`: a corrupted identity ciphertext for a user whose linked adult has a phone, called by a holder of `people.view`, gives an empty 500 with `no-store`, **no** `access.users.listed` row and **no** `people.person.read` row for that request id                                                                                                                                                                                                              |
| 8   | The denial purpose `access.users.view` is registered                 | remove `defineAuditPurpose("access.users.view")` (rebuild `@community-hub/access`)                                                                                                                                                                                                                                                                  | `users-list.integration.test.ts`: a caller whose only grant is a custom role holding `["access.roles.view"]` gets an empty 403, not a 500, and one `access.permission.denied` row with purpose `access.users.view` and target ids `[caller]`                                                                                                                                                                                                                                                |
| 9   | The cap is 500, checked before any read or decrypt                   | (a) raise it to 5,000; (b) move the check after `readLinkedContacts`                                                                                                                                                                                                                                                                                | `access-routes.test.ts`: 501 directory users → empty 409, with **neither** `readLinkedContacts` **nor** `readUserEmails` called and no audit append; 500 → 200. Only the `readLinkedContacts` assertion catches (b)                                                                                                                                                                                                                                                                         |
| 10  | The identity export never creates a key                              | call `ensureIdentityKey` before the read                                                                                                                                                                                                                                                                                                            | `user-emails.integration.test.ts`: delete **only** `identity.identity_keys` and keep the user rows. The `clearIdentity` helper at `email-lookup.integration.test.ts:45-52` deletes both, so it is not reused as is. A call with at least one existing user id throws. The assertions that catch the weakening are explicit: the table still has zero rows, and the counting port saw zero `generateDataKey` calls. "Throws" alone does not catch it                                         |
| 11  | The people export never creates an organisation or community key     | use the creating `openCommunityHkdf`                                                                                                                                                                                                                                                                                                                | `linked-contacts.integration.test.ts`, two fixtures: (i) the organisation key exists and the community key row is absent; (ii) both are absent. Each throws, leaves the `app.organisation_keys` and `app.community_keys` row counts unchanged, and makes zero `generateDataKey` calls. Only the row count catches (i)                                                                                                                                                                       |
| 12  | Empty error bodies and `no-store`                                    | (a) return `{ error: code }` on 403, 409 or 500; (b) drop the `noStore` wrapper                                                                                                                                                                                                                                                                     | `access-routes.test.ts`: 200, 400, 401, 403, 404 (foreign host), 409 and 500 each carry `cache-control: no-store`; every non-200 has a zero-length body; a `grants/list` 200 still has no `cache-control` header                                                                                                                                                                                                                                                                            |
| 13  | No encrypted column outside a select list (§1 rule 3)                | add `order by email` to the identity SQL, or `and phone is not null` to the people SQL                                                                                                                                                                                                                                                              | `user-emails.test.ts` and `linked-contacts.test.ts`: the SQL text names `email` or `phone` only between `select` and `from`                                                                                                                                                                                                                                                                                                                                                                 |
| 14  | Community isolation of persons                                       | in the scratch tree, both (a) delete `and community_id = current_setting('app.community_id')::uuid` from the `linked-contacts.ts` select, and (b) append to the newest migration: `ALTER POLICY community_isolation ON app.persons USING (org_id = current_setting('app.org_id')::uuid) WITH CHECK (org_id = current_setting('app.org_id')::uuid);` | (a) alone: `linked-contacts.test.ts` asserts the SQL text holds both the `org_id` and the `community_id` predicates. (a) and (b) together: `linked-contacts.integration.test.ts` drops a person in community 2 of the same organisation when read from community 1, and drops a person in organisation B. (b) alone leaves both green, because the explicit predicate still filters, and the report records that as expected                                                                |
| 15  | No field value, SQL text, hostname or stack in a log line            | (a) log `{ error: String(error) }` on 500; (b) log `{ error }` (the object)                                                                                                                                                                                                                                                                         | `access-routes.test.ts`: the forced failure's message carries a fixture email and `select email from identity.users`. Every `fields` value must be a primitive, which catches (b). Each call is rendered with `util.inspect` and must contain no fixture name, email or phone, no `select`, no `identity.`, no API hostname and no `at `, which catches (a)                                                                                                                                 |
| 16  | The `app` role has no `identity` privileges                          | in the scratch tree, append `GRANT USAGE ON SCHEMA identity TO app;` to the newest migration                                                                                                                                                                                                                                                        | `identity.integration.test.ts:104-122` (existing) fails on schema usage, then passes after the restore                                                                                                                                                                                                                                                                                                                                                                                      |
| 17  | The screen ignores a stale `users/list` response                     | (a) remove the check after `await post(...)`; (b) remove the check after `json()`; (c) remove the check in the `catch` for a rejected `json()`                                                                                                                                                                                                      | `users-roles.test.tsx`, one test per guard, each using a user id that appears in both communities' directories with different details: (a) the stale `Response`'s `json()` is a spy and is never called; (b) the stale response's `json()` is deferred and resolved after the switch, and the final assertion is on community 2's details for the shared user id; (c) a stale response whose `json()` rejects after the switch leaves no "Details unavailable" message on the new community |
| 18  | A successful call writes `access.users.listed`                       | remove the `access.users.listed` append                                                                                                                                                                                                                                                                                                             | `users-list.integration.test.ts`: one successful call writes exactly one `access.users.listed` row whose `target_ids` equal the listed user ids                                                                                                                                                                                                                                                                                                                                             |
| 19  | The users state is cleared on community change                       | drop the users-state reset from the slug effect                                                                                                                                                                                                                                                                                                     | `users-roles.test.tsx`: the same organisation-level user id appears in both communities' `grants/list` responses, with different names, emails and phones in the two `users/list` bodies. Community 1 loads fully. Then switch to community 2 with its `users/list` held pending (a deferred promise that is never resolved). While it is pending, community 2's row for that user id shows no community-1 name, email or phone                                                             |

## Rollback

Revert the pull request's merge commit. No migration, data or key is created, so nothing else needs undoing. Audit rows already written stay, because the audit log is append-only, and they hold ids only.

## Stop and ask (AGENTS.md §12)

The implementer stops and reports, without improvising, when:

- the plan is wrong or ambiguous, or the code does not match a pointer in it;
- a migration, grant, dependency, workspace package, Dockerfile, workflow or Terraform change looks necessary;
- a pin's weakening does not make its test fail, except the single-layer weakening (b) of pin 14, which is expected to stay green;
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
- new `modules/core/access/infrastructure/audit-registration.test.ts`, which imports `../public/index.js`. Vitest includes the `infrastructure/` folder (`modules/core/access/vitest.config.ts:21`) but not `public/`. `modules/core/identity/infrastructure/operator-exports.test.ts` is the precedent.

**Test first:**

- `listUsersBody` accepts `{ communitySlug }` and rejects an extra key such as `userIds` (pin 4).
- `listUsersResponse` accepts each null case in the spec's table and rejects an extra key at both levels.
- Once the public index is imported, these all return true:
  - `isAuditAction("access.users.listed")`;
  - `isAuditPurpose("access.users.listed")`;
  - `isAuditPurpose("access.users.view")`.
- `AccessErrorCode` includes `too_many`. The RED for this line is `pnpm typecheck`, because `AccessErrorCode` is a type union and the constructor stores any string at runtime. The runtime pin is Task 4's mapping of `too_many` to an empty 409.

**Rule it must not break:** `capabilitiesResponse` and `listGrantsBody` are unchanged.

**Pins run:** 4 (the contracts half).

### Task 2: `readUserEmails` in `core/identity`

**Commit:** `feat(identity): read sign-in emails for a set of users`

**Files:**

- `modules/core/identity/domain/error.ts`: new `IdentityErrorCode` `invalid_input`.
- new `modules/core/identity/infrastructure/user-emails.ts`
- new `modules/core/identity/infrastructure/user-emails.test.ts`
- new `modules/core/identity/infrastructure/user-emails.integration.test.ts`
- `modules/core/identity/public/index.ts`

**Shape:** `readUserEmails(sql, kms, keyArn, userIds): Promise<Map<string, string>>`. A `Map` keyed by user id, where spec:137 says `{ userId, email }[]`. The difference is by design, because the route joins by id.

1. If `userIds` is empty, return an empty map with no SQL and no KMS call.
2. Validate every id as a UUID, with at most 500 ids. Otherwise throw `IdentityError("invalid_input")`.
3. Read the existing `identity.identity_keys` row exactly as `email-lookup.ts:52-56` does, and throw if it is missing. Never call `ensureIdentityKey`.
4. Unwrap and derive as at `:58-59`.
5. Run `select id, email from identity.users where id = any($1::uuid[])`.
6. Decrypt each row with `decrypt` from `packages/crypto/src/encrypt.ts:40`. The AAD matches the encrypt call at `email-lookup.ts:114-123`:
   - tag `chub/field-identity/v1`;
   - label `identity.users.email`;
   - `rowId` is the row's own `id`;
   - region `au`.
7. Omit ids with no row. Never log or return a ciphertext.

**Test first:**

- **Unit:**
  - UUID and size validation.
  - An empty input makes no call.
  - The SQL text names `email` only in the select list (pin 13).
- **Integration** (Docker, with `createLocalKmsPort` wrapped in a counting port that counts both `decrypt` and `generateDataKey`):
  - Users created with `insertIdentityUserWithKeys` decrypt correctly.
  - Reading them in reverse order returns the right email each (pin 5).
  - A ciphertext copied onto another user's row throws (pin 5).
  - An unknown id is omitted.
  - With `identity.identity_keys` deleted (the `email-lookup.integration.test.ts:45-50` precedent), the call throws, creates no row and makes zero `generateDataKey` calls (pin 10).
  - One call makes exactly one KMS `decrypt`.

**Rule it must not break:** no module outside `core/identity` references `identity.*`. `identity.integration.test.ts:104-122` stays green (pin 16).

**Pins run:** 5, 10, 13 (the identity half), 16.

### Task 3: `readLinkedContacts` in `core/people`

**Commit:** `feat(people): read linked contacts in one batch`

**Files:**

- `modules/core/people/infrastructure/keys.ts`: a new non-creating `openExistingCommunityHkdf`.
  - It reuses `selectOrganisationKey` (`:59`), `selectCommunityKey` (`:68`) and the unwraps at `:127` and `:172`.
  - It throws when either key row is missing.
- new `modules/core/people/infrastructure/linked-contacts.ts`
- new `modules/core/people/infrastructure/linked-contacts.test.ts`
- new `modules/core/people/infrastructure/linked-contacts.integration.test.ts`
- `modules/core/people/public/index.ts`

**Shape:** `readLinkedContacts(tx, kms, keyArn, { personIds, includePhone, actorUserId })`. It returns a `Map` from person id to either `{ minor: true }` or `{ minor: false, given, family, phone: string|null }`.

1. If `personIds` is empty, return an empty map.
2. Validate the UUIDs, with at most 500 ids.
3. Run one select in the style of `roster-names.ts:93-115`:
   - columns `id, given_name, family_name, is_minor, phone`;
   - `where id = any($1::uuid[])`;
   - plus the org and community predicates.
4. Return minors with no field. Never select `household_id` or a `*_restricted` column, and never open a household key.
5. Open the community key only when `includePhone` is true and at least one adult has a phone. Then open it once with `openExistingCommunityHkdf`, and decrypt the phones as `person.ts:358` does. `openField` stays private: `linked-contacts.ts` keeps its own copy, as the four existing copies do (`person.ts:157`, `household.ts:141`, `life-event.ts:127`, `roster-names.ts:24`). The AAD is `{ tag: "chub/field/v1", label: "people.phone", rowId, communityId }`.
6. Then append one `people.person.read` row (in the style of `roster-names.ts:197-204`):
   - `actorKind: "user"`;
   - `actorId: actorUserId`;
   - `targetIds`: the persons whose phone was opened.
7. Drop ids that RLS hides.

**Test first:**

- **Unit:**
  - The SQL text names `phone` only in the select list (pin 13).
  - It names no `household_id` and no `_restricted` column.
  - It holds both predicates, matched as `org_id = current_setting('app.org_id')` and `community_id = current_setting('app.community_id')`, not only the column names (pin 14 (a)).
- **Integration fixtures:**
  - the scope helpers from `modules/core/people/infrastructure/roster-names.integration.test.ts:81-100`;
  - minors from `modules/core/access/infrastructure/restricted-read.integration.test.ts:135-151`;
  - adults with phones from `modules/core/people/infrastructure/person.integration.test.ts:104-127`;
  - a new counting port that counts both `decrypt` and `generateDataKey`. The `roster-names` port counts `decrypt` only.
- **Integration tests:**
  - An adult's names and phone are returned.
  - A minor returns `{ minor: true }` only. A wrapped `tx` records that no statement mentions `app.household_keys`.
  - `includePhone: false` makes zero KMS calls and writes no audit row.
  - The audit row's ids are exactly the opened persons, its actor is the given one, and it holds no fixture value (pin 6).
  - Pin 11's two fixtures. Fixture (i) deletes the community key row with the owner connection (`createPlaintextDirectSql(runtime.productOnlyUrl)`), in a community with no households, because the `app` role cannot delete it.
  - Persons in community 2 and in organisation B are dropped (pin 14).

**Rule it must not break:** `openPersonFieldKeys`, `readRosterNames` and `openCommunityHkdf` keep their behaviour, and their existing tests stay green.

**Pins run:** 6, 11, 13 (the people half), 14.

**Checkpoint after this task.**

### Task 4: The `users/list` route

**Commit:** `feat(api): list users with their contact details`

**Files:**

- `apps/api/src/access-routes.ts`
- `apps/api/src/access-routes.test.ts`
- `apps/api/src/index.test.ts`: the route count goes from 51 to 52 (`:814`), plus a marking row next to `grants/list`.
- new `apps/api/src/users-list.integration.test.ts`, with **one** happy-path test against Postgres, so the route meets a real database before its review. An owner with a linked adult and a phone lists themself with name, email and phone, and one `access.users.listed` row is written. Task 5 extends this file.

**Shape:** a new route beside `grants/list` (`access-routes.ts:386-421`). It reuses `sessionUser`, `communityScope`, `transact`, `loadDirectory`, `callerPermissions`, `deny` and `empty`.

- **Errors:**
  - The handler wraps its **whole body** in a `try/catch`: `sessionUser`, `communityScope` and `transact(...)`. The catch sits **outside** the transaction, as `household-routes.ts:236-268` does.
  - The catch covers every throw. Any throw that is not an `AccessError` becomes `noStore(empty(500))`. So does an `AccessError` that `statusFor` cannot map, which is unreachable today.
  - `deps.log` then records only `{ path, status, requestId, errorClass }`, and every value is a string. The `errorClass` rule copies the kernel's (`packages/kernel/src/request-handler.ts:20`, `:38-56`, where `describeThrown` is not exported):
    - an `Error` whose `name` matches `/^[A-Za-z][A-Za-z0-9_]{0,63}$/` gives that name;
    - any other `Error` gives `"Error"`;
    - a thrown value that is not an `Error` gives `"NonError"`.
  - The catch reads the request id from `getRequestContext()`, which throws outside `withRequest` (`packages/kernel/src/request.ts:51-56`). So the new tests run inside `withRequest`, as `household-routes.test.ts:200` does. Otherwise a throw there would escape without `no-store`.
  - `transact` keeps its existing behaviour (`access-routes.ts:346-362`): it returns an `AccessError` from inside the callback, so the transaction commits. The denial audit row depends on that. No new catch inside the callback may turn any other throw into a value.
  - The only `AccessError`s this route throws, `forbidden` from `deny` and `too_many`, come before step 5. So a committed `AccessError` never carries a `people.person.read` row.
- `too_many` joins the `CONFLICT` set (`:55-64`).
- `readLinkedContacts` is called with `includePhone` set to whether the caller holds `people.view`, and with `actorUserId: actor.userId`.
- **The identity export:**
  - It is called through `deps.checkout("identity", (sql) => readUserEmails(sql, deps.kms, deps.keyArn, ids))`, from inside the `transact` callback.
  - The checkout is skipped when no id is left, for example when the caller is the only user and is minor-linked.
- **Denials:** `deny` uses the purpose `access.users.view` when that is the missing permission, and `access.roles.view` otherwise.
- **Sorting** is a pure function, exported for its own unit test.
- **`no-store`:** every response of this route, whether 200, 400, 401, 403, 404, 409 or 500, passes through a local `noStore(response)` wrapper. The shared `empty()` is not changed.

**Test first** (mocked checkouts, following the pattern at `access-routes.test.ts:51-161`):

- Add `readUserEmails` to the identity mock (`:52-56`). Add a `vi.mock("@community-hub/people")` for `readLinkedContacts`. Every 200 body parses with `listUsersResponse`.
- The permission matrix (pin 1). The mocked `appendAuditEvent` receives purpose `access.users.view` for a caller who holds only `access.roles.view`, and `access.roles.view` for a caller who lacks both.
- The phone rule (pin 2). The `readLinkedContacts` mock returns a phone even when it is called with `includePhone: false`, so what the test checks is the route's own masking (`phone: null`, `phoneVisible: false`).
- Minor ids are never passed to `readUserEmails` (pin 3).
- `AccessError("too_many")` maps to an empty 409.
- A body with `userIds` gets 400 (pin 4).
- The cap at 500 and at 501. At 501, neither `readLinkedContacts` nor `readUserEmails` is called (pin 9).
- `no-store` and empty bodies on every status, and the unchanged `grants/list` headers (pin 12).
- A forced decrypt failure returns 500 through the outer catch, and so do a throw from the platform lookup in `communityScope` and a throw from `sessionUser`. Each has `no-store`.
- The log-capture test (pin 15) does not use the `JSON.stringify(logCalls)` check of `:850-877`, because an `Error` serialises to `{}`. Instead:
  - The forced failure is an `Error` whose message carries a fixture email and the text `select email from identity.users`.
  - Every logged `fields` value must be a primitive. The test fails on any object.
  - Each call is rendered with `util.inspect(call, { depth: null })` and searched for the fixture name, email and phone, `select`, `identity.`, the API hostname and `at `.
- The sort order, including null names, null emails and accented names.
- The test "registers eight tenant posts" (`:205`) becomes nine.

**Rule it must not break:** `grants/list` responses are unchanged, and its existing tests stay green without edits.

**Pins run:** 1, 2, 3, 4 (the route half), 9, 12, 15.

### Task 5: Integration suite for the route

**Commit:** `test(api): pin users list tenancy, audit and rollback`

**Files:** `apps/api/src/users-list.integration.test.ts`, extending the file Task 4 created. It reuses the harness of `access-flow.integration.test.ts`:

- the local KMS (`:132`);
- two communities in one organisation plus a second organisation (`:185-205`);
- users created through the OTP flow (`:216-230`);
- `bootstrapOwner` (`:232`);
- grants, links and custom roles created over HTTP.

Persons come from the people module's `createPerson` and `createHousehold`. A minor-linked user is inserted directly into `app.user_links` through the test's owner connection, because `linkUser` refuses it.

**Test first:**

- **Tenancy:**
  - A caller in organisation A never sees a user who belongs only to organisation B.
  - A caller in community 1 never sees a user who belongs only to community 2, except one with an organisation-level grant.
  - That organisation-level user, when linked only in community 2, shows a null `personId` in community 1.
- **Shared users:** a user who belongs to both organisations shows the same email in each.
- **Minors:** a minor-linked user returns nulls for every role, `community_admin` included.
- **Audit:** a successful call writes exactly one `access.users.listed` row with the listed user ids (pin 18), and one `people.person.read` row with the opened person ids. Neither holds a fixture value.
- **Rollback:** pin 7's corrupted-ciphertext case.
- **Denial:** pin 8's custom-role caller.
- **Edge cases:**
  - A user id with no identity row returns `email: null`.
  - When the caller is the only user, the list holds the caller.
  - `users/list` with `no-such-parish`, and with the second organisation's slug, answers the same empty 403 as `grants/list` (`:276-299`), with `no-store`.
  - With the community key row deleted through the owner connection, the route returns 500 and creates no key row.
  - The route cannot reach a missing identity key, because `readSession` creates the key first (`session.ts:475-477`). Pin 10 covers that at the export.
- **What the identity export received** can't be observed from here. Pins 3 and 4 cover it in the mocked suite.

**Rule it must not break:** this task changes no source file. If a test can pass only with a source change, the task stops and reports.

**Accepted risk:** these tests start green, because the route already exists. Their red step is the pins: 7, 8 and 18 are run here, against this suite. Task 4's happy-path test is the route's first real-database run.

**Pins run:** 7, 8, 18.

**Checkpoint after this task.**

### Task 6: The admin screen

**Commit:** `feat(admin): show names, emails and phones on Users & Roles`

**Files:**

- `apps/admin/src/users-roles.tsx`
- `apps/admin/src/users-roles.test.tsx`
- new `apps/admin/src/role-labels.ts`, with its test. It is a static map from built-in role key to label, covering every key in `access-routes.ts:41-53`.

**Shape:**

- **Fetching:**
  - Inside `load` (`users-roles.tsx:189-220`), after `grants/list` succeeds and its `permissions` include `access.users.view`, the screen posts `{ communitySlug }` to `/v1/access/users/list`.
  - Because the call sits in `load`, it also runs after every grant or link change, under the caller's `isCurrent`.
  - The generation guard at `:175` is checked in three places for this call:
    1. after `await post(...)`;
    2. after `json()`;
    3. in the `catch` for a rejected `json()`.

    The existing guard at `:204` already covers the stretch before the request is issued, because nothing awaits in between.
- **Clearing:** the users state is cleared wherever `directory` is cleared. That is in the slug effect (`:222-230`), so an organisation-level user never carries another community's name, email or phone, even while the new `users/list` is pending or after it fails. It is also cleared in `show("signed-out")` (`:180-187`). That second reset is memory hygiene only: after a 401 the page renders only "Sign in required", and the token never becomes non-null again in the same mount. So it cannot be observed and is not pinned. The reviewer checks it by reading the diff.
- **Reading the response:**
  - A hand-written `readUsers(body)`, in the style of `readDirectory`, checks every field.
  - A malformed body keeps the ids view and shows the retry message.
- **Rows:** joined by `userId`. The grants list and the user links list show:
  - name, then email, then phone, with the user id as secondary text;
  - "No contact linked" when `personId` is null;
  - "No sign-in account" when `email` is null and `minor` is false;
  - "Details hidden" when `minor` is true;
  - "—" for a missing phone when `phoneVisible` is true, and nothing in the phone slot when it is false. Spec:94's "—" assumes phones are visible.
- **Roles:** built-in roles render by label, custom roles by key.
- **Failures:** the ids view stays, and a message shows in its own state, not in `notice`, so a `users/list` 403 never shows "You cannot manage roles" (`:299`).
  - 409: "Too many users to show details".
  - 500, offline, "unavailable", or a malformed body: "Details unavailable. Try again."
  - 403: no message.

**Test first:**

- The current test at `:82-118` is replaced by a URL-keyed `fetch` mock and one test per state above.
- Three existing tests pass `access.users.view` in `permissions`: the tests at `:159` and `:179`, and the test at `:1020-1065` (permissions at `:1047`). They move to the URL-keyed mock with a valid `users/list` body. Their assertions do not change, including the third test's `li` count of 4 and its list-item class checks.
- A regression test, not a pin: a community switch while `grants/list` is pending gives exactly one `users/list` call, for the new community.
- A caller without `access.users.view` gets the ids view, and `users/list` is never called (exact call count).
- After a grant change, `users/list` is called again (exact count).
- The stale-response tests, one per guard position (pin 17).
- The clearing test (pin 19).
- A StrictMode render.
- Non-200 answers with JSON bodies.
- A malformed body.
- An axe check on the new rows.

**Rule it must not break:** no control renders that only 403s, and the grant and link forms keep their user-id input.

**Pins run:** 17, 19.

**Checkpoint after this task.**

### Task 7: Architecture, roadmap and AGENTS.md

**Commit:** `docs: mark users-roles-people-details done`

**Files:** `architecture.md`, `docs/roadmap.md`, `AGENTS.md`.

- **`architecture.md`:** two places get the same rule. They are `:667` (the §11.1 identity email bullet) and `:777` (the §12.2.1 `identity.users.email` row). The rule:
  - The sign-in email is decrypted only in `core/identity`, in the regional service, for the Users & Roles list.
  - Only for users in the caller's community directory, and never for a minor-linked user.
  - It is shown on screen only, never logged or audited.
  - No ADR (owner decision O2).
- **`docs/roadmap.md`:**
  - The row at `:171` becomes **done**, with the spec path.
  - A new Phase 2 row, **not started**: "User invitations". It covers user creation, invitations with the user's acceptance, and picking a user by name (owner decision O3). It also closes the grant-to-reveal gap (O1).
  - `## Open items` (`:298`) gains one item: grants and links accept any user id without consent, and "User invitations" closes that.
  - The snapshot at `:19-30`: last shipped `users-roles-people-details`, next chunk `Add Adult create` (`:172`).
  - `:99` and the "Next spec" section at `:394-396` say the same.
- **`AGENTS.md:9`** "Repository state": `Users & Roles people details` is done, and the next chunk is `Add Adult create`.

**Test first:** none, since this task is docs only. `pnpm exec prettier --check .` and `pnpm check:boundaries` pass.

**Rule it must not break:** no other row changes status, and no architecture decision other than O2's sentence changes.

## Definition of done (AGENTS.md §8)

- All seven tasks are accepted by the reviewer agent, every named pin has been run and reported, and CI is green on the pull request.
- The tenant-isolation tests (Tasks 3 and 5) are green.
- **Not done in this chunk:** the behaviour is not checked on the staging hostname, because staging stays parked. That check is deferred to the next proof chunk that unparks (spec default 9). The PR body records this as a §8 deviation.
- The PR body records the review configuration:
  - the implementer: Antigravity (Gemini);
  - the reviewer agent: Claude Opus 5.5, as checked in the transcript;
  - the owner's check, with its model and what it ran;
  - the second-review line.
- Session scratch is cleaned up: no `docs/plans/*-report.md`, and nothing under `.superpowers/` staged.

## Probe record

This plan has no Terraform assert, so no scratch probe is needed (AGENTS.md §4). The database weakenings for pins 14 and 16 are made in the scratch tree's newest migration file and restored with `git checkout -- packages/db/drizzle`. They are never typed into a running database, because every vitest run recreates it.

## Amendments after approval

None yet.
