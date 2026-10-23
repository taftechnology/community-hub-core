Spec: docs/specs/2026-10-22-ops-identity-primitives.md

# Identity primitives for operators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The identity module can mint and tell apart `tenant`, `operator` and `enrolment` sessions, keeps email-code challenges of different purposes apart, records the RP ID of every new passkey credential and challenge, and can require user verification. No tenant user sees any change. No route, gate, UI or `apps/api` source changes.

**Architecture:** One expand migration (`0011`) adds six columns, two check constraints and one index in the `identity` schema. `session.ts`, `email-otp.ts` and `passkey.ts` gain optional parameters whose defaults are today's behaviour. Two new exports (`readSessionWithKind`, `verifyPasskeyAssertion`) and one hook (`onStored`) are for `ops-operator-identity`. The duplicated HMAC helper moves to one internal file.

Slug: ops-identity-primitives
Status: approved (2026-10-22, Abdus Salam)

## Who does what

| Actor                     | Writes repo commits                             | Runs `terraform apply` | Puts secret values, runs AWS one-offs | Applies or merges |
| ------------------------- | ----------------------------------------------- | ---------------------- | ------------------------------------- | ----------------- |
| Implementer (Antigravity) | Yes — Tasks 1–8, only the files each task names | Never                  | Never                                 | Never             |
| Reviewer (fresh Claude)   | Never                                           | Never                  | Never                                 | Never             |
| Human owner (Abdus)       | Never during the run                            | Not needed             | Not needed                            | Merges the PR     |
| Developer (Adnan)         | Never during the run                            | Never                  | Never                                 | Never             |

The owner approves this plan after the independent assistant's check (AGENTS.md §2, §4).

## Global constraints

- The spec is approved and no task edits it. Refinements are listed in **Deviations from the spec** and repeated in the PR body.
- Work only in the worktree `C:\Recovered\Taftech\wt-ops-primitives` on branch `feat/2026-10-22-ops-identity-primitives`. Commit locally; never push.
- No agent runs `terraform`, `aws` or `docker push`. Runs start with no AWS credentials and pushes blocked.
- Staging stays parked. No task touches `infra/`, a Dockerfile, a workflow, `turbo.json`, `apps/`, any `package.json` dependency list, or a checker. No new dependency. The only migration is `0011` in Task 1.
- No account id, hostname, email address, secret, token or IP address in any commit. Tests use synthetic UUIDs, `example.test` addresses and RP IDs `auth.example.test` / `ops.example.test`.
- **Existing tests:** no existing assertion in `modules/core/identity` or `apps/api` is changed or removed. Tasks add new `it` blocks and new helpers only. If an existing assertion must change, stop and report.
- Only one run at a time uses the Docker test database (`packages/db/test/docker-compose.yml`).
- `apps/api` tests run against the built `@community-hub/identity`. After changing it, run `pnpm --filter @community-hub/identity build` before the `apps/api` tests.
- Time is injected (`now` inputs). No test sleeps or depends on timing.
- Integration tests share one database per run: insert rows with fresh ids and synthetic addresses, assert only on your own rows.
- **Known Windows exception:** `packages/db/src/generate.test.ts` fails on Windows with ENOENT (spawns `drizzle-kit` without the `.cmd` shim). It passes on Linux CI. Locally, `pnpm turbo run test lint typecheck --continue` must show that test as the **only** failure. Generate `0011` with `pnpm --filter @community-hub/db exec drizzle-kit generate --config drizzle.config.ts`.
- Before the PR: `pnpm test --force`, then `pnpm gate`, with only the exception above. LF line endings only.
- Second fresh-context review is required (authentication). The owner's assistant starts it when the PR opens.
- Session scratch (`.superpowers/`, `*-report.md`) is never committed. Reports go to `.superpowers/sdd/task-N-report.md`.

## Deviations from the spec (repeated in the PR body)

1. **`acceptLegacy` also applies to registration.** Spec P5 names it for authentication. A registration challenge written by an old task during a rolling deploy has a null `rp_id`, so registration finish also takes `acceptLegacy` (default `true`) and accepts a null-`rp_id` challenge only then.
2. **User verification is read from the challenge row**, not from a finish-time argument. Finish requires the UV flag when the stored challenge says `required`, so a caller cannot relax it at finish.
3. **`readSessionWithKind` takes a required `kinds` list** (no default), so later callers must say which kinds they accept.
4. **Options type widened.** `PasskeyRegistrationOptions.authenticatorSelection.userVerification` becomes `"preferred" | "required"` and gains optional `excludeCredentials`; `PasskeyAuthenticationOptions` gains optional `userVerification`. `apps/api/src/auth-routes.ts:226-235,314-315` copies named fields only, so the JSON sent to tenants does not change.
5. **Operator access tokens are capped too (needs the owner's approval of this plan).** Spec P2 caps only the refresh expiry. Without more, an operator access token minted within 15 minutes of `absolute_expires_at` would still read after it. For `operator`, `access_expires_at` is `least(now + 15 min, absolute_expires_at)` at creation and on every refresh, and `createSession` refuses an `absoluteExpiresAt` that is not after `now`. Tenant and enrolment sessions are unchanged. If the owner declines, the 15-minute overrun is recorded in the spec's Risks instead.

## Security pins

The implementer weakens the source once as described, sees the named test fail, restores the source, and reports the failure output in the task report. A weakened tree is never committed.

| #   | Setting (spec pin)                                                         | Test that pins it (Task)                                                                                                                                                                                     | Weakening that must make it fail                                                                     |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 1   | `readSession` default rejects `operator`, `enrolment` (1)                  | `session.integration.test.ts` "readSession refuses operator and enrolment sessions by default" (T3)                                                                                                          | Drop the `kind = any(...)` condition from the `readSession` select                                   |
| 2   | `refreshSession` default refuses `operator`, `enrolment` (2)               | `session.integration.test.ts` "refreshSession refuses other kinds by default" (T3): returns null, and the operator session's row and family are untouched (it still refreshes with `kinds: ["operator"]`)    | Drop the kind condition from the locate select and the claim update                                  |
| 2b  | `enrolment` never refreshes, even if accepted (2)                          | `session.integration.test.ts` "refreshSession refuses enrolment even when listed" (T3): refresh at `now + 1 min`, with `["enrolment"]` and with all three kinds, after a same-time `tenant` refresh succeeds | Remove the explicit `enrolment` refusal                                                              |
| 3a  | Operator refresh expiry ≤ `absolute_expires_at` at creation (3)            | `session.integration.test.ts` "operator refresh never passes the absolute expiry" (T3)                                                                                                                       | In `createSession`, set the operator refresh expiry to `now + REFRESH_MS` (JS, `session.ts:182-183`) |
| 3b  | …and after refresh (3)                                                     | same test: two refreshes, then a third refresh after `absolute_expires_at` returns null                                                                                                                      | Copy `absolute_expires_at` to the successor but set its refresh expiry to `now + REFRESH_MS`         |
| 3c  | Operator access token ends at `absolute_expires_at` (deviation 5)          | `session.integration.test.ts` "operator access ends at the absolute expiry" (T3): created 5 min before, unreadable 1 min after                                                                               | Set operator access expiry to `now + ACCESS_MS` without the `least`                                  |
| 4   | DB rejects operator without, tenant with, `absolute_expires_at` (4)        | `session.integration.test.ts` "the sessions check constraint" (T1), inserting as the identity role                                                                                                           | Delete the check constraint from `0011` and the schema, rebuild the test database                    |
| 5a  | Start of one purpose never consumes the other (5)                          | `email-otp.integration.test.ts` "a sign-in start leaves an enrolment challenge open" (T4)                                                                                                                    | Drop the purpose condition from the supersede `update`                                               |
| 5b  | Cap is per (address, purpose) (5)                                          | `email-otp.integration.test.ts` "five enrolment starts do not use the sign-in cap" (T4)                                                                                                                      | Drop the purpose condition from the `count(*)`                                                       |
| 5c  | `sign_in` verify cannot consume an `operator_enrolment` challenge (5)      | `email-otp.integration.test.ts` "sign-in verify ignores enrolment challenges" (T4)                                                                                                                           | Drop the purpose condition from the verify sub-select                                                |
| 6a  | Other-RP credential rejected (6)                                           | `passkey.integration.test.ts` "authentication refuses a credential for another RP ID" (T5)                                                                                                                   | Drop the `rp_id` condition from the credential select                                                |
| 6b  | Null-`rp_id` credential rejected when `acceptLegacy` is false (6)          | `passkey.integration.test.ts` "a legacy credential needs acceptLegacy" (T5): challenge has a non-null `rp_id`, only the credential is legacy                                                                 | Treat `acceptLegacy` as always true in the credential select                                         |
| 6c  | Null-`rp_id` challenge rejected when `acceptLegacy` is false (deviation 1) | `passkey.integration.test.ts` "a legacy challenge needs acceptLegacy" (T5), for registration and for authentication                                                                                          | Treat `acceptLegacy` as always true in the challenge lookups                                         |
| 6d  | Challenge for another RP rejected                                          | `passkey.integration.test.ts` "a challenge begun for another RP ID is refused" (T5): challenge begun at RP A; client data, origin and authenticator data all built for RP B                                  | Drop the `rp_id` condition from the challenge lookup                                                 |
| 7a  | Required UV in options (7)                                                 | `passkey.integration.test.ts` "required user verification is in the options" (T6)                                                                                                                            | Hard-code `"preferred"` in the options                                                               |
| 7b  | Registration rejects missing UV when required (7)                          | `passkey.integration.test.ts` "registration without UV fails when required" (T6)                                                                                                                             | Remove the UV check from registration finish                                                         |
| 7c  | Authentication rejects missing UV when required (7)                        | `passkey.integration.test.ts` "authentication without UV fails when required" (T6)                                                                                                                           | Remove the UV check from authentication finish                                                       |
| 8   | `excludeExisting` lists only that RP ID's credentials (8)                  | `passkey.integration.test.ts` "excludeExisting lists this RP ID only" (T6)                                                                                                                                   | Drop the `rp_id` condition from the exclude query                                                    |
| 9   | A throwing `onStored` leaves no credential (9)                             | `passkey.integration.test.ts` "onStored failure rolls back the credential" (T7)                                                                                                                              | Call `onStored` after the transaction commits                                                        |
| 10  | `verifyPasskeyAssertion` writes no session (10)                            | `passkey.integration.test.ts` "verifyPasskeyAssertion mints nothing" (T7): `count(*)` of the user's `identity.sessions` rows is unchanged                                                                    | Insert an `identity.sessions` row for the user inside `verifyPasskeyAssertion`                       |
| 11  | Shared HMAC output unchanged                                               | `hmac.test.ts` known-answer vectors (T2), captured from the current helpers before the move                                                                                                                  | Change the separator byte in the shared helper                                                       |

Regression (not a weakening): the existing identity and `apps/api` suites pass with no change to existing assertions. The reviewer checks `git diff origin/main -- '*.test.ts'` shows only added lines in existing test files.

## Rollback

| Point        | Rollback                                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before merge | Revert with new commits.                                                                                                                                                                                        |
| After merge  | Revert the merge. Migration `0011` is additive: older code ignores the columns, the defaults keep its inserts valid, and nothing writes `operator` or `enrolment` rows yet. No infrastructure or secret change. |

## Stop and ask (AGENTS.md §12)

Implementer, stop and report if:

- the plan or spec is wrong or ambiguous;
- a migration other than `0011`, or a Dockerfile, workflow, Terraform, `turbo.json`, `package.json` dependency or checker change is needed;
- any file under `apps/` needs changing, or an existing test assertion needs changing;
- `drizzle-kit generate` produces anything besides the columns, checks and index in Task 1;
- the same step fails twice.

---

### Task 1: Columns, checks and migration `0011`

**Files:**

- Modify: `modules/core/identity/db/schema.ts`, `modules/core/identity/db/schema.test.ts`
- Create: `packages/db/drizzle/0011_<generated name>.sql`, `packages/db/drizzle/meta/0011_snapshot.json`; modify `packages/db/drizzle/meta/_journal.json`
- Modify: `modules/core/identity/infrastructure/session.integration.test.ts` (new `describe` for the constraint only)

**Shape (spec Data):**

- `sessions`: `kind` text not null default `'tenant'`, check `sessions_kind` in (`tenant`, `operator`, `enrolment`); `absolute_expires_at` timestamptz; check `sessions_absolute_expiry`: `(kind = 'operator') = (absolute_expires_at is not null)`.
- `otp_challenges`: `purpose` text not null default `'sign_in'`, check `otp_challenges_purpose` in (`sign_in`, `operator_enrolment`); index `otp_challenges_email_bidx_purpose_idx` on (`email_bidx`, `purpose`).
- `passkey_credentials`: `rp_id` text.
- `passkey_challenges`: `rp_id` text; `user_verification` text not null default `'preferred'`, check `passkey_challenges_user_verification` in (`preferred`, `required`).

**Test first (RED):**

- `schema.test.ts`: text checks on `0011` (tolerant of whitespace and column qualification): it contains each column, check and index above; it contains no `DROP`, no `GRANT`, no `REVOKE`, and no `ALTER COLUMN ... TYPE`. The existing `not.toContain("DEFAULT")` check reads only the `identity.users` migration and is untouched.
- `session.integration.test.ts` "the sessions check constraint": as the identity role, inserting an `operator` row without `absolute_expires_at` fails with 23514; a `tenant` row with it fails with 23514; a row with `kind = 'admin'` fails (pin 4).

**Rule this must not break:** expand only; existing inserts that omit the new columns still succeed (the existing session, OTP and passkey suites stay green).

**Commit subject:** `feat(db): add session kinds, code purposes and passkey RP IDs`

- [ ] RED, generate, GREEN. Pin 4.
- [ ] `pnpm gate` (Windows exception only).

### Task 2: One HMAC helper

**Files:**

- Create: `modules/core/identity/infrastructure/hmac.ts`, `hmac.test.ts`
- Modify: `modules/core/identity/infrastructure/email-otp.ts`, `session.ts` (delete their private `hmac`, import the shared one)

**Shape:** `hmac(key, label, message)` with the existing construction (`email-otp.ts:27-41`, `session.ts:214-226`: label bytes, a NUL byte, then the message). Keep the OTP helper's guard that rejects a label containing NUL (`email-otp.ts:32-34`); the session helper lacks it and gains it harmlessly. Internal only; not exported from `public/`. (The spec cites the OTP helper at `email-otp.ts:266`; it is at `:27`.)

**Test first (RED):** before moving anything, compute known-answer vectors with a throwaway scratch copy of the **current** private helpers (outside the repo or in `.superpowers/`, never committed), for the labels `identity.otp`, `identity.access`, `identity.refresh` and one synthetic key. Commit only the literal outputs in `hmac.test.ts` (pin 11), plus a test that a label containing NUL is rejected. It fails because `hmac.ts` does not exist.

**Rule this must not break:** every stored hash keeps its value; the existing OTP and session suites pass unchanged.

**Commit subject:** `refactor(identity): share one HMAC helper`

- [ ] RED, GREEN. Pin 11.
- [ ] `pnpm gate`.

### Task 3: Session kinds and the absolute expiry

**Files:**

- Modify: `modules/core/identity/infrastructure/session.ts`, `session.integration.test.ts`, `modules/core/identity/public/index.ts`

**Shape (spec P2, P3):**

- `export type SessionKind = "tenant" | "operator" | "enrolment"`.
- `createSession(sql, kms, keyArn, { userId, now, kind?, absoluteExpiresAt? })`: `kind` defaults to `tenant`. `operator` requires an `absoluteExpiresAt` later than `now` (throw `IdentityError` otherwise); others must not pass it. For `operator`: access expiry = earlier of `now + ACCESS_MS` and `absoluteExpiresAt` (deviation 5); refresh expiry = earlier of `now + REFRESH_MS` and `absoluteExpiresAt`. `enrolment`: refresh expiry = access expiry. `tenant`: as today. These are computed in JS where expiry is computed today (`session.ts:182-183`).
- `readSession(sql, kms, keyArn, { accessToken, now, kinds? })`: `kinds` defaults to `["tenant"]`; the select adds `and kind = any(${sql.array(kinds)})`. An empty list matches nothing. Return type unchanged.
- `readSessionWithKind(sql, kms, keyArn, { accessToken, now, kinds })`: same query, returns `{ userId, kind }`. Export it and `SessionKind` from `public/`.
- `refreshSession(sql, kms, keyArn, { refreshToken, now, kinds? })`: `kinds` defaults to `["tenant"]`. The kind condition goes on **both** the locate select (`session.ts:79-83`) and the claim update (`:96-104`), so a refused kind returns null before any state change and never reaches the replay branch (`:123-135`). `enrolment` is refused explicitly even if listed. The successor copies `kind` and `absolute_expires_at`; for `operator` its access and refresh expiries are capped as in `createSession`. Keep the successor insert text `insert into identity.sessions` so the `pauseOnSessionInsert` race harness (`session.integration.test.ts:45-70`) still matches. Reuse detection and family revoke are unchanged.

**Test first (RED):** new `it` blocks for pins 1, 2, 2b, 3a, 3b, 3c; plus: a tenant session created with no options reads, refreshes and carries `kind = 'tenant'` in the row; `readSessionWithKind` returns the kind; `createSession` throws for `operator` without `absoluteExpiresAt` and with one not after `now`. Tests that call `createSession` import it from `../infrastructure/session.js`; it stays out of `public/`.

**Rule this must not break:** tenant sessions behave exactly as today; existing `session.integration.test.ts` assertions untouched.

**Commit subject:** `feat(identity): tell session kinds apart and cap operator refresh`

- [ ] RED, GREEN. Pins 1, 2, 2b, 3a, 3b, 3c.
- [ ] `pnpm --filter @community-hub/identity build`, then the `apps/api` tests; `pnpm gate`.

### Task 4: Email-code purposes

**Files:**

- Modify: `modules/core/identity/infrastructure/email-otp.ts`, `email-otp.integration.test.ts`, `modules/core/identity/public/index.ts` (export `OtpPurpose`)

**Shape (spec P4):**

- `export type OtpPurpose = "sign_in" | "operator_enrolment"`.
- `startEmailOtp(..., { email, now, purpose? })`, default `sign_in`: the `count(*)` (`email-otp.ts:63-68`), the supersede `update` (`:72-76`) and the `insert` (`:77-80`) all carry the purpose. The advisory lock key stays per address.
- `verifyEmailOtp(..., { email, code, now })` keeps its signature and only ever consumes `sign_in` challenges (the sub-select at `:128-135` adds `and purpose = 'sign_in'`). It stays **one** update statement: `expectOneUpdateReturning` (`email-otp.integration.test.ts:50-55`) depends on that. Enrolment verification is written in `ops-operator-identity`.

**Test first (RED):** pins 5a, 5b, 5c. 5a runs both ways: a `sign_in` start leaves an `operator_enrolment` challenge open, and an `operator_enrolment` start leaves a `sign_in` challenge open. Rows for the `operator_enrolment` purpose are written through `startEmailOtp` with that purpose and a capturing fake mail port.

**Rule this must not break:** tenant start and verify behave as today; the per-address cap of five per hour still holds for `sign_in`.

**Commit subject:** `feat(identity): keep email-code purposes apart`

- [ ] RED, GREEN. Pins 5a, 5b, 5c.
- [ ] Identity build, `apps/api` tests, `pnpm gate`.

### Task 5: Passkey RP ID on credentials and challenges

**Files:**

- Modify: `modules/core/identity/infrastructure/passkey.ts`, `passkey.integration.test.ts`

**Shape (spec P5; deviation 1):**

- Begin registration and begin authentication write `rp_id = input.rpId` on the challenge (`passkey.ts:42-45`, `:149-152`).
- Finish registration and finish authentication take `acceptLegacy?: boolean` (default `true`). The challenge lookup adds `and (rp_id = ${rpId} or (rp_id is null and ${acceptLegacy}))`. Registration stores `rp_id = input.rpId` on the credential (`:124`). The authentication credential select adds the same condition on the credential's `rp_id`.

**Test first (RED):** pins 6a, 6b, 6c, 6d; plus: a tenant registration with no options stores the RP ID; a legacy credential (row inserted with null `rp_id`) still authenticates with no options; a legacy challenge (null `rp_id`) is accepted with no options. For 6a, the credential is stored with `rp_id = ops.example.test` and then authenticated at `auth.example.test` with a valid signature, origin `https://auth.example.test`, the auth RP hash and a challenge begun at the auth RP, so only the credential's `rp_id` condition can refuse it. 6d builds everything for RP B against a challenge begun at RP A, so only the challenge's `rp_id` condition can refuse it. The existing `authenticatorData` helper (`passkey.integration.test.ts:82-100`) supports both.

**Rule this must not break:** tenant passkey flows unchanged; the RP ID hash and origin checks (`passkey.ts:93,206,249`) untouched.

**Commit subject:** `feat(identity): record the RP ID of passkeys and their challenges`

- [ ] RED, GREEN. Pins 6a, 6b, 6c, 6d.
- [ ] Identity build, `apps/api` tests, `pnpm gate`.

### Task 6: Required user verification and excluding existing credentials

**Files:**

- Modify: `modules/core/identity/infrastructure/passkey.ts`, `passkey.integration.test.ts`

**Shape (spec P6, P7; deviations 2, 4):**

- `const UV = 0x04`.
- `beginPasskeyRegistration(sql, { userId, rpId, now, userVerification?, excludeExisting? })`: stores `user_verification` on the challenge; options carry it in `authenticatorSelection.userVerification`; when `excludeExisting`, options carry `excludeCredentials: [{ type: "public-key", id }]` for the user's credentials whose `rp_id` equals `rpId`.
- `beginPasskeyAuthentication(sql, { rpId, now, userVerification? })`: stores it; options carry `userVerification` only when `required`.
- Both finishes select `user_verification` with the challenge and, when `required`, reject authenticator data without the UV flag, the same way they reject a missing UP flag today.

**Test first (RED):** pins 7a, 7b, 7c, 8; plus positive controls: the same ceremonies with the UV flag (`0x04`) set succeed when `required`, and without it succeed when `preferred`; with no options, options and finish behave as today. The existing assertion at `passkey.integration.test.ts:204` must still hold.

**Rule this must not break:** default options are byte-for-byte the current shape apart from the widened type.

**Commit subject:** `feat(identity): require user verification when asked`

- [ ] RED, GREEN. Pins 7a, 7b, 7c, 8.
- [ ] Identity build, `apps/api` tests, `pnpm gate`.

### Task 7: `onStored` and `verifyPasskeyAssertion`

**Files:**

- Modify: `modules/core/identity/infrastructure/passkey.ts`, `passkey.integration.test.ts`, `modules/core/identity/public/index.ts`

**Shape (spec P8):**

- `finishPasskeyRegistration(..., { ..., onStored? })`: `onStored(tx: TransactionSql, { userId, credentialId })` runs inside the existing `sql.begin` (`passkey.ts:112`) after the credential insert; if it throws, the transaction rolls back (including the challenge consumption at `:113-119`, so the challenge stays usable until it expires) and the error propagates. Export the hook type.
- `verifyPasskeyAssertion(sql, { rpId, now, credentialId, clientDataJSON, authenticatorData, signature, acceptLegacy? })` returns `{ userId } | null`: everything `finishPasskeyAuthentication` does today except `createSession`, including challenge consumption and the sign-count update. `finishPasskeyAuthentication` becomes `verifyPasskeyAssertion` then `createSession`, same signature and result.
- Export `verifyPasskeyAssertion` and the option types from `public/`.

**Test first (RED):** pins 9 (also asserting the challenge is still unconsumed), 10; plus: `onStored` sees the new credential inside the transaction; `verifyPasskeyAssertion` returns the user id and consumes the challenge (a replay fails).

**Rule this must not break:** `finishPasskeyAuthentication` results unchanged for every existing case.

**Commit subject:** `feat(identity): expose passkey assertion checks and a registration hook`

- [ ] RED, GREEN. Pins 9, 10.
- [ ] Identity build, `apps/api` tests, `pnpm gate`.

### Task 8: Catalogue (last task on this branch)

**Files:**

- Modify: `docs/roadmap.md`: replace the `ops-console` row (`:127`) with five rows: `ops-identity-primitives` **done** (spec path), `ops-operator-identity`, `ops-console-api`, `ops-console-ui`, `ops-console-proof`, each **not started** with a one-line What from spec P1. Snapshot (`:24-25`): last shipped `ops-identity-primitives`, next `ops-operator-identity`. Update `:99` and the Next spec sentence (`:313`) to name `ops-operator-identity`. Phase 0 counts (roadmap `:26`, `AGENTS.md:9`) do not change: the new rows are Phase 1.
- Modify: `AGENTS.md` Repository state row: "Next is `ops-operator-identity`."

**Test first:** none (docs). `pnpm gate` (format).

**Commit subject:** `docs(roadmap): mark the identity primitives done`

- [ ] `rm -f docs/plans/*-report.md`; `git status --short` shows nothing from `.superpowers/` and nothing outside this task's files staged.
- [ ] `pnpm test --force`, then `pnpm gate` (Windows exception only).

## Definition of done (AGENTS.md §8)

- All eight tasks committed, each reviewed by diff with its security pins reported.
- `pnpm test --force` and `pnpm gate` green apart from the Windows exception; CI green on the PR.
- No file under `apps/`, `infra/` or `.github/` changed; no existing test assertion changed.
- Staging parked. Staging verification: none possible, since nothing user-visible changes; stated in the PR body.
- Roadmap and `AGENTS.md` updated in this PR, last. No `architecture.md` change (spec Out-of-band).
- The PR body lists the implementer and reviewer configurations, the owner's check, the second-review line, **Deviations from the spec**, and the changed-line count (estimated about 370 source and 700 test lines, migration and snapshot excluded: over the ~800 aim, kept as one chunk because it is one module and one refactor).
- No `docs/plans/*-report.md` on disk, and nothing under `.superpowers/` staged.

## Probe record

No Terraform in this chunk; no probe needed (AGENTS.md §4 Phase 2).
