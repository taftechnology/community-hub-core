# Spec: Identity primitives for operators — session kinds, email-code purposes, passkey RP ID and user verification

Slug: ops-identity-primitives
Status: approved (2026-10-22, Abdus Salam)
Architecture refs: §6.3, §11.1, §11.4 (`architecture.md:691-704`), §12.1, §12.2.1; AGENTS.md §1 rules 2, 3, 5; §3 (split rule), §6 Tenancy and data, §7

## Problem

Architecture §11.4 requires passkey-only sign-in for every `platform_*` role and forbids an email code from starting or recovering a platform session. The identity module cannot express the difference today:

- Sessions carry a user id only (`modules/core/identity/infrastructure/session.ts:43`). Nothing records what a session is for, so a tenant route could not refuse an operator session, or the reverse. Refresh always grants 30 days (`session.ts:10`).
- Email-code challenges are keyed by the address blind index only (`modules/core/identity/db/schema.ts:54-68`). `startEmailOtp` counts and supersedes every unconsumed row for the address, and `verifyEmailOtp` takes any unconsumed row (`email-otp.ts:302-315`, `:367-376`). A second use of email codes would share the rate cap with tenant sign-in and could be cancelled by it.
- Passkeys take one RP ID from the caller (`apps/api/src/auth-routes.ts:221,277,309,335`), but credentials and challenges do not record it (`schema.ts:70-101`). User verification is `preferred` and only user presence is checked (`passkey.ts:21,56,90,203`). Registration opens its own transaction (`passkey.ts:112`), and authentication mints a session without telling the caller who signed in.

This chunk adds those primitives without changing what any tenant user sees. It is the first of four ops-console chunks (P1).

## Decisions

| #   | Topic                    | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | By                    |
| --- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| P1  | Split                    | The ops console ships as four chunks, each its own spec, plan and PR: **`ops-identity-primitives`** (this: refactor, no tenant behaviour change), **`ops-operator-identity`** (grants, enrolment, operator sessions, operator events; `docs/specs/2026-10-22-ops-operator-identity.md`), **`ops-console-api`** (gate change for static files, ops routes, read-only directory, `ops-operator` one-off), **`ops-console-ui`** (`apps/ops`). A staging proof chunk follows the UI. The whole was estimated at 2,700–3,700 lines across more than two modules; AGENTS.md §3 says split, and says not to mix a refactor with a feature. | Developer, 2026-10-22 |
| P2  | Session kind             | `identity.sessions.kind` in (`tenant`, `operator`, `enrolment`), default `tenant`, and `absolute_expires_at`, required for `operator` and null otherwise (check constraint). `createSession` takes `kind` (default `tenant`) and, for `operator`, `absoluteExpiresAt`; it sets `refresh_expires_at` to the earlier of now + 30 days and `absolute_expires_at`. An `enrolment` session gets `refresh_expires_at = access_expires_at`.                                                                                                                                                                                                | Developer, 2026-10-22 |
| P3  | Kind checks, fail closed | `readSession` and `refreshSession` take an optional accepted-kinds list that **defaults to `["tenant"]`**. Their return types do not change. A new `readSessionWithKind` returns `{ userId, kind }` for later chunks. `refreshSession` refuses `enrolment` always, copies `kind` and `absolute_expires_at` to the successor, and never sets a refresh expiry later than `absolute_expires_at`. No caller in `apps/api` changes.                                                                                                                                                                                                     | Developer, 2026-10-22 |
| P4  | Email-code purpose       | `identity.otp_challenges.purpose` in (`sign_in`, `operator_enrolment`), default `sign_in`. `startEmailOtp` and `verifyEmailOtp` take an optional purpose (default `sign_in`). The rate-cap count, the supersede update and the verify select are all filtered by purpose, so the cap is per (address, purpose) and one purpose never consumes or cancels the other. Enrolment verification itself is written in `ops-operator-identity`.                                                                                                                                                                                            | Developer, 2026-10-22 |
| P5  | Passkey RP ID            | `passkey_credentials.rp_id` and `passkey_challenges.rp_id`. New rows always store the RP ID they were made for. Rows made before this chunk have null. Authentication matches a credential when `rp_id` equals the caller's RP ID, or when `rp_id` is null and the caller passes `acceptLegacy: true`. `acceptLegacy` defaults to `true`, so tenant callers, which pass no options, behave as today; operator code always passes `false`.                                                                                                                                                                                           | Developer, 2026-10-22 |
| P6  | User verification        | `passkey_challenges.user_verification` in (`preferred`, `required`), default `preferred`. Begin functions take an optional `userVerification` (default `preferred`). When a challenge says `required`, the options say `required`, and both registration and authentication finish reject authenticator data without the UV flag (`0x04`).                                                                                                                                                                                                                                                                                          | Developer, 2026-10-22 |
| P7  | Exclude existing         | Registration begin takes an optional `excludeExisting` (default `false`). When true, the options list the user's existing credential ids for that RP ID in `excludeCredentials`, so the same authenticator is not registered twice.                                                                                                                                                                                                                                                                                                                                                                                                 | Developer, 2026-10-22 |
| P8  | Hooks for later chunks   | Registration finish takes an optional `onStored(tx, { userId, credentialId })` run inside its transaction; if it throws, the credential is not stored. A new `verifyPasskeyAssertion` checks an assertion and returns `{ userId }` or null without minting a session; the existing `finishPasskeyAuthentication` becomes `verifyPasskeyAssertion` plus `createSession` and keeps its signature.                                                                                                                                                                                                                                     | Developer, 2026-10-22 |
| P9  | Shared HMAC helper       | The private `hmac` helpers in `email-otp.ts:266` and `session.ts:214` (label, NUL, message) move to one internal module, used by both. No change to any stored hash.                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Developer, 2026-10-22 |

## Scope

In:

- Migration `0011` (expand only), under Data, in `packages/db` with its snapshot; schema factory changes in `modules/core/identity/db/schema.ts`.
- `modules/core/identity/infrastructure/session.ts`, `email-otp.ts`, `passkey.ts`, and a new internal HMAC module, as P2–P9.
- `modules/core/identity/public/index.ts`: export `readSessionWithKind`, `verifyPasskeyAssertion`, and the new option types. `createSession` stays internal.
- Integration tests in `modules/core/identity/infrastructure/*.integration.test.ts`.
- `docs/roadmap.md` (last commit): the `ops-console` row becomes four rows plus the proof row (P1); this chunk **done**; snapshot "Next chunk" = `ops-operator-identity`. `AGENTS.md` Repository state row: next chunk name updated.

Out:

- Operator grants, enrolment, operator sessions in use, operator events: `ops-operator-identity`.
- Any route, gate or UI change; any edit to `apps/api` source.
- Tenant passkeys in the admin app.
- Terraform, DNS, IAM. Staging stays parked; no apply.

## Behaviour

No user-visible change. Every tenant route, sign-in screen and token keeps its current behaviour. After this chunk:

- Tenant email sign-in writes challenges with purpose `sign_in`, and new tenant passkeys store the auth hostname as RP ID.
- Nothing yet creates an `operator` or `enrolment` session or an `operator_enrolment` challenge; the new paths are exercised by tests only.
- The existing tenant integration tests in `modules/core/identity` and `apps/api` pass without edits to their assertions.

## Data

All in the `identity` schema: region-scoped, no `org_id`, no RLS (AGENTS.md §1 rule 2; architecture §6.3). Written by the identity role only; grants unchanged (no new table).

| Table                          | Column                | Type / rule                                                                    | Class      |
| ------------------------------ | --------------------- | ------------------------------------------------------------------------------ | ---------- |
| `identity.sessions`            | `kind`                | text not null default `'tenant'`, check in (`tenant`, `operator`, `enrolment`) | `internal` |
|                                | `absolute_expires_at` | timestamptz; check: not null when `kind = 'operator'`, null otherwise          | `internal` |
| `identity.otp_challenges`      | `purpose`             | text not null default `'sign_in'`, check in (`sign_in`, `operator_enrolment`)  | `internal` |
| `identity.passkey_credentials` | `rp_id`               | text, nullable (null = made before this chunk)                                 | `internal` |
| `identity.passkey_challenges`  | `rp_id`               | text, nullable, same rule                                                      | `internal` |
|                                | `user_verification`   | text not null default `'preferred'`, check in (`preferred`, `required`)        | `internal` |

Index: a new index on `otp_challenges (email_bidx, purpose)` for the purpose-filtered lookups. The existing `email_bidx` index stays (expand only).

Encryption (§12.2.1): none of these columns is encrypted, and none may be: SQL filters or compares every one. None holds personal data.

Migration wave: one expand migration, `0011`. Every new column is nullable or has a constant default, and the deployed service names its insert columns (`session.ts:185`, `passkey.ts:43,124,150`, `email-otp.ts:317`), so its writes stay valid and take the defaults. During a rolling deploy, an old task writing a `sign_in` challenge or a `tenant` session is correct. A tenant passkey registered by an old task during the deploy gets a null `rp_id` and still works through `acceptLegacy`. No contract step. Rollback: older code ignores the columns; they can stay.

## Rules touched

**Authentication.** Each setting gets a must-fail test in the plan:

| #   | Setting                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `readSession` with no options rejects an `operator` and an `enrolment` session.                                                                                             |
| 2   | `refreshSession` with no options refuses an `operator` and an `enrolment` refresh token; with `operator` accepted, it refuses `enrolment`.                                  |
| 3   | An `operator` session's refresh expiry is never later than `absolute_expires_at`, at creation and after each refresh; the successor keeps `kind` and `absolute_expires_at`. |
| 4   | The database rejects an `operator` session without `absolute_expires_at` and a `tenant` session with one.                                                                   |
| 5   | `startEmailOtp` for one purpose does not consume or count the other purpose's challenges; `verifyEmailOtp` for `sign_in` cannot consume an `operator_enrolment` challenge.  |
| 6   | Authentication rejects a credential whose `rp_id` differs from the caller's, and a null-`rp_id` credential when `acceptLegacy` is false.                                    |
| 7   | With `userVerification: "required"`, the options say `required`, and registration and authentication both reject authenticator data without the UV flag.                    |
| 8   | `excludeExisting` lists the user's credentials for that RP ID only.                                                                                                         |
| 9   | An `onStored` hook that throws leaves no credential row.                                                                                                                    |
| 10  | `verifyPasskeyAssertion` writes no session row.                                                                                                                             |

Regression: the existing identity and `apps/api` integration tests pass with no change to their assertions.

**Permissions, residency, retention:** unchanged.

**Logs.** No address, code, credential id or token in a log line or an error message (unchanged rule; no new log lines are added).

## Contracts

No routes, events, manifest keys or website keys. Identity public API: additions only (`readSessionWithKind`, `verifyPasskeyAssertion`, option types); existing exported functions keep their signatures, with new options optional and defaulting to today's behaviour. No caller edits in `apps/api` or other modules.

## Risks

- **Tenant sign-in regresses.** The refactor touches the tenant OTP, session and passkey paths. Every new option defaults to today's behaviour, the regression suites run unchanged, and the purpose filter is pinned (5).
- **Fail-open kind check.** Defaults are `["tenant"]`, so a caller that forgets the option is refused an operator session, not granted one (1, 2).
- **Legacy credentials.** Null `rp_id` is accepted only with `acceptLegacy`; operator code will pass false (6).
- **Size.** Estimated 350–450 source lines and 450–600 test lines, migration excluded. One module, refactor only.

## Out-of-band

- **Owner (Abdus):** P1's four-chunk split. Nothing else here is a product, cost or legal decision.
- **Architecture:** no decision changes in this chunk; §11.4 and §8.5 are updated in `ops-operator-identity`.
- **Second review:** this chunk touches authentication, so the owner's assistant runs the second fresh-context review when the PR opens (AGENTS.md §2).
- **Legal, subprocessor, cost:** none.
