Spec: docs/specs/2026-10-22-ops-operator-identity.md

# Operator identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The identity module can grant, enrol, activate, sign in, refresh, read, end, revoke and recover platform operators, as tested module functions, with every change to one user's operator state serialised on the user lock. No route, gate, UI, one-off or `apps/` change.

**Architecture:** One expand migration (`0012`) adds `identity.operator_grants` and `identity.operator_events` and revokes the privileges the spec names. `session.ts` gains a refresh check hook and an in-transaction session insert; `passkey.ts` gains a `beforeStore` hook. A new `operator.ts` holds the operator functions; two small domain files hold the platform role keys and enrolment code normalising.

Slug: ops-operator-identity
Status: draft

## Who does what

| Actor                     | Writes repo commits                             | Runs `terraform apply` | Puts secret values, runs AWS one-offs | Applies or merges |
| ------------------------- | ----------------------------------------------- | ---------------------- | ------------------------------------- | ----------------- |
| Implementer (Antigravity) | Yes — Tasks 1–9, only the files each task names | Never                  | Never                                 | Never             |
| Reviewer (fresh Claude)   | Never                                           | Never                  | Never                                 | Never             |
| Human owner (Abdus)       | Never during the run                            | Not needed             | Not needed                            | Merges the PR     |
| Developer (Adnan)         | Never during the run                            | Never                  | Never                                 | Never             |

The owner approves this plan after the independent assistant's check (AGENTS.md §2, §4).

## Global constraints

- The spec is approved and no task edits it. Refinements are listed in **Deviations from the spec** and repeated in the PR body.
- Work only in the worktree `C:\Recovered\Taftech\wt-ops-operator` on branch `feat/2026-10-22-ops-operator-identity`. Commit locally; never push.
- No agent runs `terraform`, `aws` or `docker push`. Runs start with no AWS credentials and pushes blocked.
- Staging stays parked. No task touches `infra/`, `apps/`, a Dockerfile, a workflow, `turbo.json`, any `package.json`, a `tsconfig*.json`, an ESLint config, or a checker. No new dependency. The only migration is `0012` in Task 1.
- No account id, hostname, email address, secret, token or IP address in any commit. Tests use synthetic UUIDs, `example.test` addresses and RP IDs `auth.example.test` (tenant) and `ops.example.test` (ops). Enrolment codes in tests are synthetic base32 strings built in the test (for example `"A".repeat(26)` variants), never real-looking secrets.
- **Existing tests:** no existing assertion in `modules/core/identity`, `modules/core/access` or `apps/api` is changed or removed. Tasks add new `it` blocks, new test files and new helpers only. The reviewer checks `git diff origin/main -- '*.test.ts'` shows only added lines in existing test files. If an existing assertion must change, stop and report.
- **Test helpers:** the WebAuthn helpers needed by the operator tests (`clientData`, `coseKey`, `authenticatorData`, `encodeDer`, signing) are **copied** into the top of `operator.integration.test.ts`, not moved out of `passkey.integration.test.ts` and not put in a shared non-test file (any non-test `.ts` under `infrastructure/` ships in `dist`).
- **Identity key in tests:** every new integration `describe` follows the existing pattern (`session.integration.test.ts:439-457`): one `createLocalKmsPort()` for the file, `delete from identity.identity_keys` in `beforeAll`, so the file never depends on run order (the PR #60 lesson).
- Only one run at a time uses the Docker test database (`packages/db/test/docker-compose.yml`).
- `apps/api` tests run against the built `@community-hub/identity`. After changing it, run `pnpm --filter @community-hub/identity build` before the `apps/api` tests.
- Time is injected (`now` inputs).
- Integration tests share one database per run: insert rows with fresh ids and synthetic addresses, assert only on your own rows.
- **Cleanup of operator rows.** `operator_grants.user_id` references `identity.users`, and existing suites run `delete from identity.users` in `beforeAll` (`passkey.integration.test.ts:171`, `session.integration.test.ts:113,447,459`, `email-lookup.integration.test.ts:49`, `email-otp.integration.test.ts:83`). The identity role cannot delete operator rows (Task 1). So `operator.integration.test.ts` deletes `identity.operator_events` and `identity.operator_grants` rows over the owner connection (`createPlaintextDirectSql(runtime.productOnlyUrl)`) in `beforeAll` (leftovers from an aborted run) and in `afterAll`. No `ON DELETE CASCADE`. Every task that adds operator tests runs `pnpm --filter @community-hub/identity test` in full (all files, default order) before reporting.
- **Concurrency tests.** A test that waits for another session to block polls `pg_stat_activity` for that backend's `wait_event_type = 'Lock'` (any lock kind) **or** the awaited promise having settled, every 20 ms, with a hard cap of 5 s that fails with a clear message. Holders and paused transactions are released in `finally`, so a failed assertion never leaves a connection holding locks. No test asserts on elapsed time.
- **Known Windows exceptions:** `packages/db/src/generate.test.ts` fails on Windows with ENOENT (spawns `drizzle-kit` without the `.cmd` shim); occasional Windows-only load timeouts in `migrate.integration`, `plaintext-dist` and identity "forty parallel wrong guesses". They pass on Linux CI. Locally, any failure other than these is a real failure. Generate `0012` with `pnpm --filter @community-hub/db exec drizzle-kit generate --config drizzle.config.ts`.
- Before the PR: `pnpm test --force`, then `pnpm gate`, with only the exceptions above. LF line endings only.
- Second fresh-context review is required (authentication). The owner's assistant starts it when the PR opens.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed. Reports go to `.superpowers/sdd/task-N-report.md`.

## Shared definitions (used by Tasks 4–8)

- **Ops RP ID:** every operator function that touches passkeys or credentials takes `opsRpId: string`. An ops credential is a `identity.passkey_credentials` row with `rp_id = opsRpId`.
- **User lock:** internal `lockOperatorUser(tx, userId)` in `operator.ts`: `select pg_advisory_xact_lock(hashtextextended('operator:' || ${userId}::text, 0))`. Every operator transaction that reads-then-changes a user's grants, ops credentials or operator sessions calls it first. The only other advisory lock in these paths is the refresh family lock, always taken before it (spec Scope).
- **Open grant:** `revoked_at is null and activated_at is null and ${now} < enrolment_expires_at`. **Active grant:** `revoked_at is null and activated_at is not null`.
- **Enrolment window:** `ENROLMENT_WINDOW_MS = 24 * 60 * 60 * 1000`. **Operator session:** absolute expiry `now + 8 h`.
- **Events:** internal `appendOperatorEvent(tx, { userId, action, roleKey?, requestId?, now })` (deviation 12), in the same transaction as the change it records (the one exception is `enrolment_started`, deviation 13). `requestId` is stored only when it is a UUID (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`), else null (deviation 2). Every public operator function takes an optional `requestId`.
- **Errors:** `domain/error.ts` gains code `invalid_grant` (additive). Owner-run functions (`grantOperator`, `revokeOperator`, `recoverOperator`) throw `IdentityError("invalid_grant")` for every refusal, with no detail. Request-path functions return `null` (or `false`) with no reason, and rethrow only unexpected errors.
- **Enrolment code HMAC:** `hmac(bidx, "identity.operator_enrolment_code", utf8(normalised))`, where `bidx` is the `.bidx` half of `deriveIdentityEmailKeys` (the identity blind-index key).

## Deviations from the spec (repeated in the PR body)

1. **In-transaction session insert.** Sign-in (Behaviour 5) and enrolment verification (Behaviour 3) must create the session inside the locked transaction. `createSession` cannot run inside a transaction (its key setup may call `sql.begin`). `session.ts` gains an internal (not public) `createSessionInTransaction(tx, bidx, input)` that shares `createSession`'s expiry rules exactly; the caller derives the key before opening the transaction. `createSession`'s behaviour and signature are unchanged.
2. **`request_id` must be a UUID** to be stored (the request ids in `apps/api` are `newId()` UUIDs). Anything else is stored as null. This enforces "never an address or token" (O12).
3. **Owner-run refusals are one error code.** `invalid_grant` is added to `IdentityErrorCode` so `grantOperator` / `recoverOperator` / `revokeOperator` refusals are typed but give no reason.
4. **`verifyOperatorEnrolment` returns a tagged result:** `{ kind: "enrolment"; session: SessionTokens } | { kind: "activated" } | null`, so "activated, no session" (Behaviour 3) is distinguishable from failure without a reason for the failure.
5. **A malformed enrolment code at verification counts as a wrong code** (one attempt on the challenge), so the attempt counting in O5 cannot be sidestepped with a malformed value. A malformed email code (not eight digits) returns null without counting, as tenant verification does today.
6. **The pin 13 mirror test reads identity's source as text.** `modules/core/access/domain/boundaries.test.ts:26-34` forbids access importing identity. The access test reads `modules/core/identity/domain/platform-roles.ts` with `fs` and compares the quoted keys to `PLATFORM_ROLE_KEYS`.
7. **Some pins are held by two layers** (pins 4, 5b, 15, 16, 18c). Their weakening removes both layers, or the test uses a row or call shaped so that only one layer can refuse it; the implementer reports each layer's result (details in the pins table).
8. **A passkey finished after the enrolment window is not stored.** O9 says both "a credential stored after the window stays stored" and that finish "stores nothing unless ... the user still has an open or active grant". The owner's approval condition requires the second, and once the window ends an unactivated grant is neither open nor active, so nothing is stored. The plan follows the approval condition; the grant stays inactive either way.
9. **`endOperatorSession` revokes the session's whole refresh family**, not just the presented row, so a refresh that won a race with the end cannot leave a live successor. It reads the row's `refresh_family`, takes the family lock (`'family:' || family`, the same key as `refreshSession`), and revokes every unrevoked row of that family.
10. **Enrolment codes above 128 characters are refused** (O3 sets only a floor). It bounds the input the HMAC sees; a real code is 26–32 characters.
11. **Database consistency check on events.** `operator_events_role_key`: `role_key` is set exactly for `granted`, `revoked` and `activated`, as spec Data describes in words.
12. **`appendOperatorEvent` is internal**, not exported from `public/`. Spec Scope lists it with the module functions, but every event is written inside the transaction of the change it records, and an exported append would let a caller write events with no change behind them. Nothing outside the module needs it in this chunk.
13. **`enrolment_started` is written after a successful send**, in its own statement, so a mail failure (which deletes the challenge) leaves no event.

## Security pins

The implementer weakens the source once as described, sees the named test fail, restores the source, and reports the failure output in the task report. A weakened tree is never committed. All operator tests are in `modules/core/identity/infrastructure/operator.integration.test.ts` unless named otherwise.

| #   | Setting (spec pin)                                                       | Test that pins it (Task)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Weakening that must make it fail                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a  | Verify never returns an `operator` session (1)                           | "enrolment verification yields only an enrolment session" (T5): the session row's `kind` is `enrolment`, `absolute_expires_at` null, and `refreshSession` with all kinds returns null                                                                                                                                                                                                                                                                                                                                                                                                       | Create the session with `kind: "operator", absoluteExpiresAt: now + 8 h`                                                                                                                                                                                                          |
| 1b  | Verify never creates a user (1)                                          | "verification for an unknown address creates no user" (T5): `count(*)` of `identity.users` for that blind index stays 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Look the user up with `findOrCreateUserByKeys`                                                                                                                                                                                                                                    |
| 2   | Wrong enrolment code counts one attempt; consumed at five (2)            | "a wrong enrolment code with a right email code counts an attempt" (T5): attempts goes 0→1; after five such tries the challenge is consumed and even both right codes then fail                                                                                                                                                                                                                                                                                                                                                                                                             | Count a failed attempt only when the email code is wrong (drop the enrolment-code term from the `matched` expression)                                                                                                                                                             |
| 3a  | Code floor, base32 only, `=` refused (3)                                 | `domain/enrolment-code.test.ts` (T2): 25-char code refused; 26 accepted; `0`, `1`, `8`, `9`, `_` refused; `"…="` and `"=…"` refused; lower case, spaces and hyphens normalised. "grantOperator refuses malformed codes" (T4) for one case of each                                                                                                                                                                                                                                                                                                                                           | (i) floor 25; (ii) strip `=` before validating                                                                                                                                                                                                                                    |
| 3b  | No cleartext code stored, returned or logged (3)                         | "the enrolment code is stored only as an HMAC" (T4): the code's UTF-8 bytes and its normalised form appear in no column of the user's `operator_grants` or `operator_events` rows (checked with `position(... in ...)` on `bytea` and text), the return value contains no code, and a `console` spy sees no call containing it                                                                                                                                                                                                                                                              | Store `utf8(normalised)` in `enrolment_code_hash` instead of the HMAC                                                                                                                                                                                                             |
| 4   | Enrolment fails after window, activation, revocation (4)                 | "enrolment fails after the window / after activation / after revocation" (T5): three cases, each with a correct email code and enrolment code                                                                                                                                                                                                                                                                                                                                                                                                                                               | Two layers (deviation 7): drop the open-grant conditions (`activated_at is null`, `revoked_at is null`, `${now} < enrolment_expires_at`) from **both** the `enrolmentOk` select and the in-transaction re-select. Also run each layer alone and report that the other still holds |
| 5a  | Only ops credentials count (5)                                           | "two tenant passkeys and one ops passkey do not activate" (T6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Count the user's credentials without `rp_id = opsRpId`                                                                                                                                                                                                                            |
| 5b  | Second ops credential after the window does not activate (5)             | "a second ops passkey after the window is not stored and the grant stays inactive" (T6): one ops credential inside the window, then a second registration finished after `enrolment_expires_at` (enrolment session still unexpired): finish returns false, one ops credential exists, grant `activated_at` null (deviation 8). Also: one ops credential leaves the grant inactive                                                                                                                                                                                                           | Two layers: drop the window condition from both the `beforeStore` grant check and the activation `update`                                                                                                                                                                         |
| 6a  | Sign-in refuses tenant credentials (6)                                   | "operator sign-in refuses tenant credentials" (T7). The user holds an **active** operator grant. Case 1: a credential row with null `rp_id` (legacy) and an assertion built for the ops RP against an ops challenge. Case 2: an `auth.example.test` credential. Each asserts null, **no** `sign_in_refused` row and no session row, so the refusal is from the verify layer                                                                                                                                                                                                                 | Call `verifyPasskeyAssertion` with `acceptLegacy: true` (case 1 then signs in)                                                                                                                                                                                                    |
| 6b  | Sign-in refuses no UV (6)                                                | "operator sign-in refuses an assertion without UV" (T7). The user holds an active grant; asserts null, no `sign_in_refused` row, no session row                                                                                                                                                                                                                                                                                                                                                                                                                                             | Begin operator authentication with `userVerification: "preferred"`                                                                                                                                                                                                                |
| 7   | Registration options: required UV, existing ops ids (7)                  | "operator registration options require UV and exclude ops passkeys" (T6): one ops and one tenant credential exist; `excludeCredentials` lists only the ops one                                                                                                                                                                                                                                                                                                                                                                                                                              | (i) `excludeExisting: false`; (ii) `userVerification: "preferred"`                                                                                                                                                                                                                |
| 8   | Read refuses other kinds and no active grant (8)                         | "readOperatorSession refuses tenant, enrolment, and grantless sessions" (T8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | (i) kinds `["operator", "enrolment"]`; (ii) drop the active-grant condition                                                                                                                                                                                                       |
| 9   | Revoke vs refresh leaves no live successor (9)                           | "a refresh racing a revoke leaves no unrevoked operator session" (T8): pause the refresh at its successor insert (copy the whole `pauseOnSessionInsert` harness, `session.integration.test.ts:39-88`), start `revokeOperator`, then poll (concurrency rule in Global constraints) until revoke is waiting on **any** lock or has settled; release the refresh in a `finally`; await both; then `count(*)` of the user's unrevoked sessions is 0, and the successor (if minted) neither reads nor refreshes. Also the simple case: after revoke, the old session neither reads nor refreshes | Remove the user lock and grant check from `refreshOperatorSession`'s check (return `true`)                                                                                                                                                                                        |
| 10  | Enrolment start inserts before lookup, no mail without grant (10)        | "enrolment start for an address with no grant inserts a challenge and sends nothing" (T5): one `operator_enrolment` challenge row for the blind index; the capturing mail port saw no call; no `enrolment_started` event                                                                                                                                                                                                                                                                                                                                                                    | Look up the grant first and return before inserting when none is open                                                                                                                                                                                                             |
| 11  | Invalid or unknown assertions write no event (11)                        | "invalid and unknown assertions write no operator event" (T7): bad signature on a real ops credential, and an unknown credential id; `count(*)` of `operator_events` for the user unchanged                                                                                                                                                                                                                                                                                                                                                                                                 | Append `sign_in_refused` whenever `verifyPasskeyAssertion` returns null and the credential id matches a stored row                                                                                                                                                                |
| 12  | Append-only and no platform read (12)                                    | "operator tables privileges" (T1): as identity, `update` and `delete` on `operator_events` and `delete` on `operator_grants` fail with 42501; as platform, `select` on `operator_grants` fails with 42501; `has_table_privilege` checks for `TRUNCATE` are false                                                                                                                                                                                                                                                                                                                            | Delete the `REVOKE ... operator_events` line from `0012`, rebuild the test database                                                                                                                                                                                               |
| 13  | Role lists equal (13)                                                    | `modules/core/access/domain/platform-roles-mirror.test.ts` (T2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Add `"platform_extra"` to identity's list                                                                                                                                                                                                                                         |
| 14a | Sign-in mints `operator`, absolute + 8 h (14)                            | "operator sign-in mints an eight-hour operator session" (T7): row `kind = 'operator'`, `absolute_expires_at = now + 8 h` exactly; `signed_in` event                                                                                                                                                                                                                                                                                                                                                                                                                                         | `absoluteExpiresAt: now + 9 h`                                                                                                                                                                                                                                                    |
| 14b | Revoked mid sign-in: null, refused, no session (14)                      | "a revoke holding the user lock wins over sign-in" (T7): a direct connection opens a transaction, takes the user lock and sets the user's grants `revoked_at`; sign-in is started; the test polls until sign-in waits on any lock or has settled; the holder commits (in a `finally`); sign-in returns null, `sign_in_refused` is written, no session row for the user                                                                                                                                                                                                                      | Check the active grant before opening the transaction and create the session without the lock                                                                                                                                                                                     |
| 15  | Refresh refuses at or after `absolute_expires_at` (15)                   | "operator refresh refuses at the absolute expiry even if the row allows it" (T8): as superuser, set the session's `refresh_expires_at` past `absolute_expires_at`; refresh at `absolute_expires_at` and at `+1 s` returns null and mints nothing. (Without the superuser edit the primitives cap already refuses it; deviation 7)                                                                                                                                                                                                                                                           | Remove the `absoluteExpiresAt` comparison from the check                                                                                                                                                                                                                          |
| 16  | An `enrolment` session cannot refresh (16)                               | "an enrolment refresh token never refreshes" (T8): via `refreshOperatorSession` and via `refreshSession` with all three kinds. The failing assertion under the weakening is the direct `refreshSession` call; `refreshOperatorSession` still refuses through its null-`absolute_expires_at` check (a third layer)                                                                                                                                                                                                                                                                           | Wrapper kinds `["operator", "enrolment"]` **and** remove the explicit `enrolment` filter in `refreshSession` (deviation 7). Report each layer's result                                                                                                                            |
| 17  | Refresh refuses without an active grant (17)                             | "operator refresh refuses after the grant is revoked" (T8): grant revoked by direct update (sessions left unrevoked), refresh returns null, presented session unclaimed (`replaced_by` null)                                                                                                                                                                                                                                                                                                                                                                                                | Make the check skip the active-grant query                                                                                                                                                                                                                                        |
| 18a | Revoke deletes ops credentials only (18)                                 | "revoke deletes ops passkeys and keeps tenant passkeys" (T4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Remove the credential delete from revoke                                                                                                                                                                                                                                          |
| 18b | Grant with no active grant clears leftovers (18)                         | "a fresh grant clears ops passkeys left from an expired window" (T4); and "a grant beside an active grant keeps the user's ops passkeys" (T4)                                                                                                                                                                                                                                                                                                                                                                                                                                               | Remove the leftover delete from grant                                                                                                                                                                                                                                             |
| 18c | Re-grant needs two new passkeys (18)                                     | "after revoke and re-grant the grant activates only on two new ops passkeys" (T6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Two layers: remove the credential delete from revoke **and** the leftover delete from grant                                                                                                                                                                                       |
| 18d | Lock and re-check before the insert (18; O9)                             | "registration waits for the user lock before inserting" (T6): a direct connection holds the user lock and revokes the grant and sessions; finish is started; while it waits on the advisory lock, `pg_locks` shows **no** `RowExclusiveLock` on `identity.passkey_credentials` held by its backend; after the holder commits, finish returns false and no credential row exists                                                                                                                                                                                                             | Remove `beforeStore`; take the lock and re-check in `onStored` only                                                                                                                                                                                                               |
| 19  | Recovery is one transaction (19)                                         | "recovery writes revoked, recovery_regrant and granted together or not at all" (T4): success writes all three; with an `sql` proxy that throws on the `insert into identity.operator_grants` statement, recovery throws and the old grant, its events and the ops credentials are unchanged                                                                                                                                                                                                                                                                                                 | Run the revoke step in its own `sql.begin` before the grant step                                                                                                                                                                                                                  |
| T3a | `beforeStore` runs before the insert                                     | `passkey.integration.test.ts` "beforeStore runs before the credential exists" (T3): inside the hook, `count(*)` of the user's credentials through `tx` is 0; a throwing hook leaves no credential and the challenge unconsumed                                                                                                                                                                                                                                                                                                                                                              | Call `beforeStore` after the insert                                                                                                                                                                                                                                               |
| T3b | The refresh check runs before the claim                                  | `session.integration.test.ts` "a refusing refresh check leaves the session unclaimed" (T3): check returns false; row `replaced_by` and `revoked_at` null; no successor; the same token then refreshes without a check. The check receives the row's `user_id` and `absolute_expires_at`                                                                                                                                                                                                                                                                                                     | Run the check after the claim `update`                                                                                                                                                                                                                                            |
| 20  | Operator registration refuses a legacy challenge (O8 `acceptLegacy` off) | "operator registration refuses a null-RP challenge" (T6): a `register` challenge row inserted with null `rp_id` for the user, attestation built for the ops RP; finish returns false and no credential is stored                                                                                                                                                                                                                                                                                                                                                                            | Pass `acceptLegacy: true` to `finishPasskeyRegistration`                                                                                                                                                                                                                          |
| 21  | Ending a session ends its family (deviation 9)                           | "ending a session that was just refreshed leaves no live successor" (T8): refresh, then end with the **old** access token; the successor neither reads nor refreshes                                                                                                                                                                                                                                                                                                                                                                                                                        | Revoke only the row matching the access hash                                                                                                                                                                                                                                      |

Regression (not a weakening): the existing identity, access and `apps/api` suites pass with no change to existing assertions.

## Rollback

| Point        | Rollback                                                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before merge | Revert with new commits.                                                                                                                                                                                                                          |
| After merge  | Revert the merge. Migration `0012` only adds two tables; older code never touches them and they can stay. The `session.ts` and `passkey.ts` hooks are optional parameters whose absence is today's behaviour. No infrastructure or secret change. |

## Stop and ask (AGENTS.md §12)

Implementer, stop and report if:

- the plan or spec is wrong or ambiguous, or a test cannot be written as described;
- a migration other than `0012`, or a Dockerfile, workflow, Terraform, `turbo.json`, `package.json`, `tsconfig*.json`, ESLint config or checker change is needed;
- any file under `apps/` needs changing, or an existing test assertion needs changing;
- `drizzle-kit generate` produces anything besides the two tables, their checks and indexes;
- a concurrency test hangs or is order-dependent;
- the same step fails twice.

---

### Task 1: Operator tables, privileges and migration `0012`

**Files:**

- Modify: `modules/core/identity/db/schema.ts`, `modules/core/identity/db/schema.test.ts`
- Create: `packages/db/drizzle/0012_<generated name>.sql`, `packages/db/drizzle/meta/0012_snapshot.json`; modify `packages/db/drizzle/meta/_journal.json`
- Modify: `modules/core/identity/module.manifest.ts`, `modules/core/identity/domain/manifest.test.ts`
- Create: `modules/core/identity/infrastructure/operator.integration.test.ts` (privileges `describe` only, plus the shared runtime and role-URL helpers and the owner-connection cleanup of operator rows in `beforeAll` and `afterAll`; see Global constraints)

**Shape (spec Data):**

- `operator_grants`: `id` uuid pk; `user_id` uuid not null references `identity.users(id)`; `role_key` text not null, check `operator_grants_role_key` in (`platform_admin`, `platform_support`, `platform_security`); `enrolment_code_hash` bytea not null; `granted_at` timestamptz not null; `enrolment_expires_at` timestamptz not null; `activated_at` timestamptz; `revoked_at` timestamptz; unique index `operator_grants_user_role_live` on (`user_id`, `role_key`) where `revoked_at is null`; index `operator_grants_user_id_idx` on `user_id`.
- `operator_events`: `id` uuid pk; `user_id` uuid not null; `action` text not null, check `operator_events_action` in the nine actions of spec Data; `role_key` text; `request_id` text; `occurred_at` timestamptz not null; check `operator_events_role_key`: `role_key` is non-null exactly when `action` in (`granted`, `revoked`, `activated`).
- Appended by hand to the generated SQL, after the tables, each with `--> statement-breakpoint` (pattern `0002_rare_jimmy_woo.sql:40`):
  `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE identity.operator_events FROM identity;`
  `REVOKE DELETE, TRUNCATE ON TABLE identity.operator_grants FROM identity;`
- Manifest `dataClasses`: all 14 new columns as `internal` (`operator_grants.*`, `operator_events.*`), and the same entries in `manifest.test.ts`.

**Test first (RED):**

- `schema.test.ts` "migration 0012": contains both tables, every column, both checks plus the role-key consistency check, the partial unique index, the `user_id` index, and both `REVOKE` lines; contains no `DROP`, no `GRANT`, no `ALTER TABLE` on any existing table, no `org_id`, no `ROW LEVEL SECURITY`.
- `manifest.test.ts`: the expected object gains the 14 entries.
- `operator.integration.test.ts` "operator tables privileges" (pin 12). Also: the identity role can insert into both tables and update `operator_grants`; `operator_grants.role_key = 'member'` fails with 23514; an `operator_events` row with `action = 'signed_in'` and a `role_key` fails with 23514.

**Rule this must not break:** expand only; no existing table changes; identity tables stay without `org_id` and RLS (AGENTS.md §1 rule 2).

**Commit subject:** `feat(db): add operator grants and operator events`

- [ ] RED, generate, append the revokes, GREEN. Pin 12.
- [ ] `pnpm gate` (Windows exceptions only).

### Task 2: Platform role keys and enrolment code normalising

**Files:**

- Create: `modules/core/identity/domain/platform-roles.ts`, `modules/core/identity/domain/enrolment-code.ts`, `modules/core/identity/domain/enrolment-code.test.ts`
- Create: `modules/core/access/domain/platform-roles-mirror.test.ts`
- Modify: `modules/core/identity/domain/error.ts` (add `invalid_grant`)

**Shape:**

- `platform-roles.ts`: `export const PLATFORM_ROLE_KEYS = ["platform_admin", "platform_support", "platform_security"] as const;` and `export type PlatformRoleKey`, plus `isPlatformRoleKey(value: string)`. A comment says it mirrors `modules/core/access/domain/role.ts` and why it is duplicated (identity must not import access).
- `enrolment-code.ts`: `normaliseEnrolmentCode(input: string): string | null`: upper-case, remove spaces and hyphens; return null if the result contains any character outside `A-Z2-7` (so `=` is refused, never stripped) or is shorter than 26. Null above 128 characters (deviation 10). Pure, no I/O.
- Mirror test (deviation 6): reads the identity file as text, extracts the string literals inside the `PLATFORM_ROLE_KEYS` array with a regex, and expects them to equal `[...PLATFORM_ROLE_KEYS]` from `./role.js`. It must not contain the string `@community-hub/identity` (the boundaries test would fail).

**Test first (RED):** pin 3a cases for `normaliseEnrolmentCode`, including `"abcd efgh-ijkl mnop qrst uvwx yz"` → upper-case 26 chars accepted, and a 26-char code with one `=` refused; pin 13.

**Rule this must not break:** `modules/core/access` keeps importing nothing from identity (`boundaries.test.ts` stays green).

**Commit subject:** `feat(identity): add platform role keys and enrolment code rules`

- [ ] RED, GREEN. Pins 3a, 13.
- [ ] `pnpm gate`.

### Task 3: Hooks for the operator layer in `session.ts` and `passkey.ts`

**Files:**

- Modify: `modules/core/identity/infrastructure/session.ts`, `session.integration.test.ts`
- Modify: `modules/core/identity/infrastructure/passkey.ts`, `passkey.integration.test.ts`
- Modify: `modules/core/identity/public/index.ts` (export the two hook types only)

**Shape:**

- `refreshSession(..., { refreshToken, now, kinds?, check? })`, where `check?: (tx: TransactionSql, row: { userId: string; absoluteExpiresAt: Date | null }) => Promise<boolean>` (export the type as `RefreshCheck`). Inside the existing transaction, after the family lock (`session.ts:173-175`) and **before** the claim `update`: when `check` is given, `select user_id, absolute_expires_at from identity.sessions where refresh_hash = ${refreshHash} and kind = any(...)`; if a row is found, call `check`; if it returns false, return null from the transaction with no claim, no successor and no replay handling. No row: continue as today (the claim then fails as today). Without `check`, nothing changes.
- `createSessionInTransaction(tx: TransactionSql, bidx: webcrypto.CryptoKey, input: { userId, now, kind, absoluteExpiresAt? }): Promise<SessionTokens>`: internal export from `session.ts`, **not** from `public/` (deviation 1). Extract the kind validation and expiry computation of `createSession` (`session.ts:39-66`) into one private function used by both; mint the tokens with the given `bidx` (same HMAC labels as `mint`); insert with `tx`. `createSession` keeps its signature and results.
- `sessionAccessHash(sql, kms, keyArn, accessToken): Promise<Uint8Array | null>`: internal export returning the stored `access_hash` form of a token (null for a malformed token), so `operator.ts` can re-check a session row inside its own transaction.
- `finishPasskeyRegistration(..., { ..., beforeStore? })`, where `beforeStore?: (tx: TransactionSql, input: { userId: string }) => Promise<void>` (export as `PasskeyBeforeStore`): runs inside the existing `sql.begin` (`passkey.ts:152`) after the challenge consumption update succeeds and **before** the credential insert. If it throws, the transaction rolls back (the challenge stays unconsumed) and the error propagates. `onStored` is unchanged.

**Test first (RED):** pins T3a and T3b; plus: the check receives the row's `user_id` and `absolute_expires_at` (operator session) and null (tenant session); a check returning true behaves exactly like no check; `createSessionInTransaction` produces rows equal in kind and expiries to `createSession` for `tenant`, `enrolment` and `operator`, and refuses `operator` without an absolute expiry; tokens it returns read with `readSessionWithKind`.

**Rule this must not break:** tenant refresh, `createSession`, and tenant registration behave exactly as today; existing assertions untouched; the successor insert text stays `insert into identity.sessions` (the race harness depends on it).

**Commit subject:** `feat(identity): add refresh check and pre-store hooks`

- [ ] RED, GREEN. Pins T3a, T3b.
- [ ] Identity build, `apps/api` tests, `pnpm gate`.

### Task 4: Grant, revoke and recover

**Files:**

- Create: `modules/core/identity/infrastructure/operator.ts`
- Modify: `operator.integration.test.ts`, `modules/core/identity/public/index.ts`

**Shape (spec O2, O3, O10, O11, O14, O15; Behaviour 1, 9, 10):**

- `grantOperator(sql, kms, keyArn, { userId, roleKeys, enrolmentCode, opsRpId, now, requestId? }): Promise<{ grantIds: string[] }>`. Before any transaction: `roleKeys` non-empty, no duplicates, each `isPlatformRoleKey`; `normaliseEnrolmentCode` non-null; compute the HMAC. Then one transaction: user lock; user exists (else `invalid_grant`); `update` the user's grants that are unrevoked, unactivated and `enrolment_expires_at <= now` to `revoked_at = now` (append `revoked` per row); if the user then has **no active grant**, `delete` the user's ops credentials; if any requested role has an unrevoked grant (active or open), throw `invalid_grant`; insert one row per role with the same hash, `granted_at = now`, `enrolment_expires_at = now + 24 h`; append `granted` per role. Returns grant ids only.
- `revokeOperator(sql, { userId, opsRpId, now, requestId? }): Promise<void>`. One transaction: user lock; set `revoked_at = now` on every unrevoked grant (append `revoked` per row); revoke every unrevoked `operator` and `enrolment` session of the user; delete the user's ops credentials. Tenant sessions and tenant credentials are untouched. A user with nothing to revoke is not an error.
- `recoverOperator(sql, kms, keyArn, { userId, roleKeys, enrolmentCode, opsRpId, now, requestId? })`: same validation as grant before the transaction; then **one** transaction with one user lock: the revoke steps, append `recovery_regrant` (no role key), then the grant steps. Implement grant and revoke as internal `…InTransaction(tx, …)` steps shared by all three functions so the lock is taken once.
- Export the three functions from `public/`.

**Test first (RED):** pins 3a (grant level), 3b, 18a, 18b, 19; plus: grant to an unknown user throws `invalid_grant`; an unknown role key, an empty list and duplicates throw; a second grant for an open or active role throws and writes nothing; a grant for a role whose earlier grant expired unactivated succeeds and marks the old one revoked; two roles granted together share the hash and window; revoke revokes `operator` and `enrolment` sessions but not a `tenant` session of the same user; `granted` and `revoked` events carry the role key, `recovery_regrant` does not; a non-UUID `requestId` is stored as null.

**Rule this must not break:** no cleartext code anywhere; identity never imports access; the platform and app roles never read these tables.

**Commit subject:** `feat(identity): grant, revoke and recover operators`

- [ ] RED, GREEN. Pins 3a, 3b, 18a, 18b, 19.
- [ ] Identity build, `pnpm gate`.

### Task 5: Enrolment start and verification

**Files:**

- Modify: `modules/core/identity/infrastructure/operator.ts`, `operator.integration.test.ts`, `modules/core/identity/public/index.ts`
- Modify: `modules/core/identity/infrastructure/email-otp.ts` (export the three rate constants only; no behaviour change)

**Shape (spec O3–O6, O9, O13; Behaviour 2, 3):**

- `startOperatorEnrolment(sql, kms, keyArn, mail, { email, now, requestId? }): Promise<void>`: normalise the address (an invalid address returns without effect); derive keys and the blind index; one transaction with the same address lock, purpose-scoped rate cap, supersede and insert as `startEmailOtp` (`email-otp.ts:29-82`, purpose `operator_enrolment`; export `TEN_MINUTES_MS`, `HOUR_MS` and `CODES_PER_HOUR` from `email-otp.ts` as internal exports and import them, so the two caps cannot drift), followed **in that transaction** by the user and open-grant lookup by blind index, which decides whether to send. Over the cap: nothing inserted, nothing sent. With an open grant: after commit send the mail with the existing `OtpMail` port; a send failure deletes the challenge and rethrows, as `startEmailOtp` does; after a successful send append `enrolment_started` (deviation 13). Without one: no mail, no event. It does not call `startEmailOtp`.
- `verifyOperatorEnrolment(sql, kms, keyArn, { email, emailCode, enrolmentCode, opsRpId, now, requestId? })` returns the tagged result (deviation 4). Steps: invalid address or non-eight-digit email code → null. Derive keys; look up the user by blind index (never create). `enrolmentOk` = the normalised code is non-null **and** the user exists **and** an open grant of the user has that HMAC (one select). One atomic `update` on the user's address's live `operator_enrolment` challenge, shaped like `verifyEmailOtp` (`email-otp.ts:106-130`) but with `matched = code_hash = ${emailHash} and ${enrolmentOk}::boolean` (the cast is required; postgres.js sends the parameter untyped): a non-match increments attempts and consumes at five; a match consumes. Not matched → null. Matched → one transaction: user lock; re-select an open grant with that HMAC (gone → null); if the user holds two or more ops credentials, activate every open grant (append `activated` per role, revoke the user's `enrolment` sessions) and return `{ kind: "activated" }`; otherwise `createSessionInTransaction(tx, bidx, { kind: "enrolment" })` and return `{ kind: "enrolment", session }`.

**Test first (RED):** pins 1a, 1b, 2, 4, 10; plus: the right two codes give an enrolment session that reads with `readSessionWithKind(["enrolment"])` and not with the default `readSession`; a `sign_in` challenge for the same address is neither used nor consumed; a malformed enrolment code counts an attempt (deviation 5); an existing operator granted a new role with two ops credentials gets `{ kind: "activated" }` and the new grant becomes active; the same enrolment code works again after a first successful verification while the grant is open (O4) with a new email code.

**Rule this must not break:** an email code never yields an `operator` session (O6); `verifyEmailOtp` and `startEmailOtp` unchanged.

**Commit subject:** `feat(identity): enrol operators with an email code and an enrolment code`

- [ ] RED, GREEN. Pins 1a, 1b, 2, 4, 10.
- [ ] Identity build, `pnpm gate`.

### Task 6: Operator passkey registration and activation

**Files:**

- Modify: `modules/core/identity/infrastructure/operator.ts`, `operator.integration.test.ts`, `modules/core/identity/public/index.ts`

**Shape (spec O8, O9, O15; Behaviour 4):**

- `beginOperatorPasskeyRegistration(sql, kms, keyArn, { accessToken, opsRpId, now })`: `readSessionWithKind` with kinds `["enrolment", "operator"]`; null → null. The user must have an open grant (enrolment session) or an active grant (operator session), else null. Returns `beginPasskeyRegistration(sql, { userId, rpId: opsRpId, now, userVerification: "required", excludeExisting: true })`.
- `finishOperatorPasskeyRegistration(sql, kms, keyArn, { accessToken, opsRpId, now, clientDataJSON, attestationObject, requestId? }): Promise<boolean>`: resolve the session as in begin (null → false) and compute its access hash with `sessionAccessHash`. Call `finishPasskeyRegistration` with `rpId: opsRpId`, `acceptLegacy: false`, and:
  - `beforeStore(tx)`: user lock; the session row with that access hash is still unrevoked, unexpired, of kind `enrolment` or `operator`, for this user; and the user has an open or active grant (after the window an unactivated grant is neither, so nothing is stored; deviation 8). Otherwise throw an internal sentinel error.
  - `onStored(tx)`: append `passkey_registered`; count the user's ops credentials; at two or more, activate every open grant (`activated_at = now` where open, append `activated` per role) and, if any activated, revoke the user's `enrolment` sessions.
  - Return true on success; on the sentinel or `IdentityError("invalid_ceremony")` return false; rethrow anything else.

**Test first (RED):** pins 5a, 5b, 7, 18c, 18d, 20; plus: two ops passkeys inside the window activate every open grant of the user and revoke the enrolment session (it no longer reads); a revoked enrolment session cannot finish; an operator session can add a third ops passkey without changing grants; a tenant (`auth.example.test`) registration challenge cannot be finished through the operator function.

**Rule this must not break:** a registration begun before a revoke never leaves a credential after it (O9); tenant registration unchanged.

**Commit subject:** `feat(identity): register operator passkeys and activate grants`

- [ ] RED, GREEN. Pins 5a, 5b, 7, 18c, 18d, 20.
- [ ] Identity build, `pnpm gate`.

### Task 7: Operator sign-in

**Files:**

- Modify: `modules/core/identity/infrastructure/operator.ts`, `operator.integration.test.ts`, `modules/core/identity/public/index.ts`

**Shape (spec O7, O11, O12; Behaviour 5):**

- `beginOperatorAuthentication(sql, { opsRpId, now })`: `beginPasskeyAuthentication(sql, { rpId: opsRpId, now, userVerification: "required" })`.
- `finishOperatorAuthentication(sql, kms, keyArn, { opsRpId, now, credentialId, clientDataJSON, authenticatorData, signature, requestId? }): Promise<SessionTokens | null>`: `verifyPasskeyAssertion(sql, { rpId: opsRpId, acceptLegacy: false, … })`; null → null, no event. Derive the bidx key, then one transaction: user lock; active grant? yes → `createSessionInTransaction(tx, bidx, { userId, now, kind: "operator", absoluteExpiresAt: now + 8 h })`, append `signed_in`, return the tokens; no → append `sign_in_refused`, return null. Never calls `finishPasskeyAuthentication` or `verifyEmailOtp`.

**Test first (RED):** pins 6a, 6b, 11, 14a, 14b; plus: a valid assertion from a user with only an open (unactivated) grant returns null and writes `sign_in_refused`; the returned `expiresIn` is 900.

**Rule this must not break:** an unauthenticated caller cannot write an event row (O12); tenant sign-in unchanged.

**Commit subject:** `feat(identity): sign operators in with ops passkeys`

- [ ] RED, GREEN. Pins 6a, 6b, 11, 14a, 14b.
- [ ] Identity build, `pnpm gate`.

### Task 8: Read, refresh and end operator sessions

**Files:**

- Modify: `modules/core/identity/infrastructure/operator.ts`, `operator.integration.test.ts`, `modules/core/identity/public/index.ts`

**Shape (spec O7, O11; Behaviour 6–8):**

- `readOperatorSession(sql, kms, keyArn, { accessToken, now }): Promise<{ userId: string; roles: PlatformRoleKey[] } | null>`: `readSessionWithKind` with `["operator"]`, then the user's active grants' role keys (sorted); none → null.
- `refreshOperatorSession(sql, kms, keyArn, { refreshToken, now }): Promise<SessionTokens | null>`: `refreshSession` with `kinds: ["operator"]` and `check(tx, row)`: `row.absoluteExpiresAt` null or `now >= absoluteExpiresAt` → false; user lock; active grant exists → true, else false. The returned `expiresIn` is passed through unchanged.
- `endOperatorSession(sql, kms, keyArn, { accessToken, now, requestId? }): Promise<void>`: find the `operator` row by access hash, including a row already replaced by a refresh (none → return); one transaction: family lock on its `refresh_family`, revoke every unrevoked row of that family, append `signed_out` (deviation 9).

**Test first (RED):** pins 8, 9, 15, 16, 17, 21; plus: a refresh 10 minutes before `absolute_expires_at` returns `expiresIn` 600; an ended session neither reads nor refreshes and writes `signed_out`; `readOperatorSession` returns all active roles.

**Rule this must not break:** lock order family then user only; tenant refresh unchanged.

**Commit subject:** `feat(identity): read, refresh and end operator sessions`

- [ ] RED, GREEN. Pins 8, 9, 15, 16, 17, 21.
- [ ] Identity build, `apps/api` tests, `pnpm gate`.

### Task 9: Architecture, ADR and catalogue (last task on this branch)

**Files:**

- Modify: `architecture.md` §11.4 (`:701`): replace "Recovery of a lost passkey needs two `platform_security` people and writes an audit row." with: operators enrol with an email code plus an owner-issued enrolment code inside an owner-granted 24-hour window; operator passkeys are bound to the ops hostname with user verification required; revocation deletes the operator's ops passkeys; until two-person recovery by `platform_security` is built, the owner alone recovers an operator and each recovery writes a `recovery_regrant` record ([ADR 0015](docs/adr/0015-interim-operator-recovery.md), review by 2027-04-30). §8.5 (`:484`): "Not a separate app." → "Not a separate service." Keep the rest of each paragraph.
- Modify: `docs/adr/0015-interim-operator-recovery.md`: `Status: accepted` with the commit date.
- Modify: `docs/roadmap.md`: `ops-operator-identity` row (`:128`) **done** with the spec path; snapshot (`:24-25`) last shipped `ops-operator-identity`, next `ops-console-api`; `:99` and the next-chunk sentence (`:312`) name `ops-console-api`. Phase 0 counts do not change.
- Modify: `AGENTS.md` Repository state row: add `ops-operator-identity` to the done list; "Next is `ops-console-api`."

**Test first:** none (docs). `pnpm gate` (format).

**Commit subject:** `docs: record operator identity in architecture and roadmap`

- [ ] `rm -f docs/plans/*-report.md`; `git status --short` shows nothing from `.superpowers/` and nothing outside this task's files staged.
- [ ] `pnpm test --force`, then `pnpm gate` (Windows exceptions only).

## Definition of done (AGENTS.md §8)

- All nine tasks committed, each reviewed by diff with its security pins reported.
- `pnpm test --force` and `pnpm gate` green apart from the Windows exceptions; CI green on the PR.
- No file under `apps/`, `infra/` or `.github/` changed; no existing test assertion changed.
- Staging parked. Staging verification: none possible, since no route exists until `ops-console-api`; stated in the PR body.
- `architecture.md`, ADR 0015, roadmap and `AGENTS.md` updated in this PR, last.
- The PR body lists the implementer and reviewer configurations, the owner's check, the second-review line, **Deviations from the spec**, and the changed-line count (estimate about 600 source and 900 test lines, migration and snapshot excluded: over the ~800 aim, kept as one chunk because it is one module and the spec sized it so).
- No `docs/plans/*-report.md` on disk, and nothing under `.superpowers/` staged.

## Probe record

No Terraform in this chunk; no probe needed (AGENTS.md §4 Phase 2).
