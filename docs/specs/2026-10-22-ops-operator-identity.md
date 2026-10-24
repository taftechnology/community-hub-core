# Spec: Operator identity — grants, enrolment, operator sessions and the operator record

Slug: ops-operator-identity
Status: draft
Depends on: `docs/specs/2026-10-22-ops-identity-primitives.md` (merged in PR #58)
Architecture refs: §6.3, §8.5 (`architecture.md:484`), §11.1, §11.3, §11.4 (`architecture.md:691-704`), §12.1, §12.2.1, §19 Ops console (`architecture.md:1192-1201`); ADR 0009; AGENTS.md §1 rules 2, 3, 5, 8; §6 Tenancy and data, §7

## Problem

Architecture §11.4: every `platform_*` role signs in with a passkey; an email code cannot start or recover a platform session; each operator holds at least two passkeys. `PLATFORM_ROLE_KEYS` are reserved (`modules/core/access/domain/role.ts:20-24`, `:39-43`), but nothing grants them, and nothing can enrol an operator's passkeys or mint a session only an operator route accepts. `ops-identity-primitives` adds session kinds, email-code purposes, per-RP passkeys and required user verification. This chunk uses them to give the identity module the operator lifecycle, as tested module functions. Routes, the one-off task and the UI come in `ops-console-api` and `ops-console-ui`.

## Decisions

| #   | Topic                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                          | By                                          |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| O1  | Where the console lives   | `apps/ops` is a static bundle served by the regional service on the ops hostname (`ops-console-api`), so the page origin is `https://<ops hostname>` and the operator RP ID is the ops hostname. §8.5's "Not a separate app" is reworded to "not a separate service" in this chunk's PR.                                                                                                                          | Developer, 2026-10-22; **owner to confirm** |
| O2  | Who grants                | Only the owner, by the `ops-operator` one-off (built in `ops-console-api`, reusing the `provision-owner` secret name so no IAM change is needed). `grantOperator(userId, roleKeys[])` grants one or more of the three platform roles together. The user must already exist in `identity.users`. A grant opens a **24-hour enrolment window**. There is never a grant route.                                       | Developer, 2026-10-22; **owner to confirm** |
| O3  | Enrolment proof           | **Two factors**: an email code with purpose `operator_enrolment`, **and** an enrolment code that the one-off **generates** (at least 128 bits; 26 base32 characters) and writes only into the owner's secret, for the owner to hand to the operator outside the system. `grantOperator` refuses a code shorter than the floor and stores only its HMAC (shared helper, label `identity.operator_enrolment_code`). | Developer, 2026-10-22; **owner to confirm** |
| O4  | Code reuse                | The enrolment code is **not** single-use: it stays valid until the grant activates, is revoked, or the window ends, because an operator interrupted after the first passkey must verify again. Each email code is single-use (existing rule).                                                                                                                                                                     | Developer, 2026-10-22                       |
| O5  | Counting failures         | Enrolment verification loads the user's open grants' code hashes first, then one atomic update on the `operator_enrolment` challenge counts a failed attempt when **either** code is wrong and consumes the challenge at five attempts (the existing limit). Combined with the cap of five challenges per address and purpose per hour, a wrong enrolment code cannot be guessed (128 bits).                      | Developer, 2026-10-22                       |
| O6  | Email codes and operators | An email code never produces, refreshes or recovers an `operator` session. With O3 it produces only an `enrolment` session (15 minutes, no refresh), and only for a user with an open grant.                                                                                                                                                                                                                      | Architecture §11.4                          |
| O7  | Operator session          | Passkey sign-in mints an `operator` session: 15-minute access, refresh until **8 hours** after sign-in (`absolute_expires_at`), never extended.                                                                                                                                                                                                                                                                   | Developer, 2026-10-22; **owner to confirm** |
| O8  | Operator passkeys         | RP ID = ops hostname, user verification `required`, `excludeExisting` on, `acceptLegacy` off. "Two passkeys" is a count of two stored operator credentials. Attestation is `none` (`passkey.ts:55`), so it is **not** proof of two devices; excluding existing credentials stops the same authenticator registering twice through our page.                                                                       | Developer, 2026-10-22; **owner to confirm** |
| O9  | Activation                | Every open grant of the user activates when, inside the window, the user holds two operator credentials: either in the same transaction that stores the second credential (`onStored` hook), or at enrolment verification if two already exist (a new role for an existing operator). Activation revokes the enrolment session.                                                                                   | Developer, 2026-10-22                       |
| O10 | Re-granting               | `grantOperator` first revokes any of the user's grants that are unactivated and past their window, then inserts. An unrevoked grant for the same role that is active or still in its window makes it fail.                                                                                                                                                                                                        | Developer, 2026-10-22                       |
| O11 | Revocation                | `revokeOperator(userId)` revokes all of that user's grants and every `operator` and `enrolment` session, in one transaction. `readOperatorSession` also requires at least one active grant.                                                                                                                                                                                                                       | Developer, 2026-10-22                       |
| O12 | Operator record           | New append-only `identity.operator_events`. `sign_in_refused` is written only after a **valid signature** (a real operator credential whose user has no active grant), so an unauthenticated caller cannot write rows. Unknown or invalid assertions write nothing.                                                                                                                                               | Developer, 2026-10-22                       |
| O13 | No timing oracle          | `startOperatorEnrolment` does the same database work whether or not the address has an open grant: it always writes one `operator_enrolment` challenge and returns a mail only when a grant is open. The route in `ops-console-api` answers 204 before sending.                                                                                                                                                   | Developer, 2026-10-22                       |
| O14 | Lost passkeys (interim)   | Until §11.4's recovery by two `platform_security` people is built, an operator who loses passkeys is revoked and granted again by the owner alone. This is a single-person path and departs from §11.4 until then.                                                                                                                                                                                                | **Owner to decide**                         |

## Scope

In:

- Migration `0012` (expand only): `identity.operator_grants`, `identity.operator_events`, and their revokes.
- `modules/core/identity/infrastructure/operator.ts`: `grantOperator`, `revokeOperator`, `startOperatorEnrolment`, `verifyOperatorEnrolment`, `beginOperatorPasskeyRegistration` (needs an `enrolment` or `operator` session), `finishOperatorPasskeyRegistration`, `beginOperatorAuthentication`, `finishOperatorAuthentication`, `readOperatorSession`, `endOperatorSession`, `appendOperatorEvent`. All take the same `sql`, `kms`, `keyArn` and `now` inputs as the existing identity functions.
- `modules/core/identity/domain/platform-roles.ts`: the three role keys, duplicated from `modules/core/access/domain/role.ts:20-24` (identity must not import access), with a test in `modules/core/access` that the two lists are equal.
- `public/index.ts` exports.
- `architecture.md` §11.4: enrolment by email code plus owner-issued code inside an owner-granted window; operator passkeys bound to the ops hostname with user verification required; the interim lost-passkey path (O14). §8.5: "Not a separate app" → "not a separate service" (O1).
- `docs/roadmap.md` (last commit): this chunk **done**, next `ops-console-api`. `AGENTS.md` Repository state row: next chunk updated.

Out:

- Routes, gate, static serving, `apps/ops`, the `ops-operator` one-off, the runbook section, the Dockerfile.
- How `ops.directory.view` is evaluated; the directory read functions.
- Support grants, break-glass, two-person recovery.
- Terraform, DNS, IAM. Staging stays parked; no apply.

## Behaviour

Module behaviour; screens come in `ops-console-ui`. Every failure returns null or a typed error with no reason that distinguishes cases to a caller.

1. **Grant.** `grantOperator(userId, roleKeys, enrolmentCode)`: user must exist; each key one of the three; code at least the floor; O10 applies. Inserts one row per role with the same code hash and window. Appends `granted` per role.
2. **Start enrolment.** `startOperatorEnrolment(address)`: O13. Appends `enrolment_started` only when a grant is open.
3. **Verify enrolment.** `verifyOperatorEnrolment(address, emailCode, enrolmentCode)`: O5; the enrolment code must match an open grant of the user. Never creates a user. Success: if the user already holds two operator credentials, O9 activates and no session is returned; otherwise returns an `enrolment` session.
4. **Register.** Begin and finish with O8's options. Finish appends `passkey_registered` and, through `onStored`, activates per O9 and appends `activated`.
5. **Sign in.** Begin, then finish with `verifyPasskeyAssertion` (RP ID = ops hostname, `acceptLegacy: false`, UV required). Valid assertion and an active grant: `operator` session with `absolute_expires_at = now + 8 h`, `signed_in`. Valid assertion, no active grant: null, `sign_in_refused`. Invalid or unknown: null, no event.
6. **Read.** `readOperatorSession(accessToken)`: `readSessionWithKind` accepting only `operator`, plus at least one active grant; returns `{ userId, roles }`.
7. **Refresh.** `refreshSession` with accepted kinds `["operator"]` (primitives P3). The returned `expiresIn` is the stored access lifetime, so near `absolute_expires_at` it is below 900 seconds (`10e4fbd`); callers in `ops-console-api` and `ops-console-ui` use it and never assume 900.
8. **End.** `endOperatorSession` revokes the session and appends `signed_out`.
9. **Revoke.** O11. Appends `revoked`.

## Data

All in the `identity` schema: region-scoped, no `org_id`, no RLS (AGENTS.md §1 rule 2; architecture §6.3). Written by the identity role only.

| Table                            | Column                 | Type / rule                                                                                                                                        | Class      |
| -------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `identity.operator_grants` (new) | `id`                   | uuid pk                                                                                                                                            | `internal` |
|                                  | `user_id`              | uuid not null, references `identity.users`                                                                                                         | `internal` |
|                                  | `role_key`             | text not null, check in `platform_admin`, `platform_support`, `platform_security`                                                                  | `internal` |
|                                  | `enrolment_code_hash`  | bytea not null (HMAC, O3)                                                                                                                          | `internal` |
|                                  | `granted_at`           | timestamptz not null                                                                                                                               | `internal` |
|                                  | `enrolment_expires_at` | timestamptz not null                                                                                                                               | `internal` |
|                                  | `activated_at`         | timestamptz                                                                                                                                        | `internal` |
|                                  | `revoked_at`           | timestamptz                                                                                                                                        | `internal` |
|                                  | —                      | unique (`user_id`, `role_key`) where `revoked_at is null`; index on `user_id`                                                                      |            |
| `identity.operator_events` (new) | `id`                   | uuid pk                                                                                                                                            | `internal` |
|                                  | `user_id`              | uuid not null                                                                                                                                      | `internal` |
|                                  | `action`               | text not null, check in `granted`, `revoked`, `enrolment_started`, `passkey_registered`, `activated`, `signed_in`, `sign_in_refused`, `signed_out` | `internal` |
|                                  | `role_key`             | text, nullable (set for `granted`, `revoked`, `activated`)                                                                                         | `internal` |
|                                  | `request_id`           | text, nullable                                                                                                                                     | `internal` |
|                                  | `occurred_at`          | timestamptz not null                                                                                                                               | `internal` |

Encryption (§12.2.1): none, and none may be: SQL filters or compares every column. No personal data: `user_id` is pseudonymous; the address is looked up by the existing blind index and never stored; the enrolment code is stored only as an HMAC.

Grants: new identity tables inherit `SELECT, INSERT, UPDATE, DELETE` for the identity role from default privileges (`packages/db/drizzle/0000_schemas.sql:15`). The migration revokes, following `0002_rare_jimmy_woo.sql:40` and `0005_people_households.sql:185-197`: `UPDATE, DELETE, TRUNCATE` on `operator_events` and `DELETE, TRUNCATE` on `operator_grants`, from identity. The `platform` and `app` roles have no `identity` privileges (`modules/core/tenancy/infrastructure/implicit-organisation.integration.test.ts:195-215`).

Migration wave: one expand migration, `0012`. New tables only; the deployed service never touches them. No contract step. Rollback: unused tables can stay.

## Rules touched

**Authentication.** Each setting gets a must-fail test in the plan:

| #   | Setting                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `verifyOperatorEnrolment` never returns an `operator` session and never creates a user.                                                             |
| 2   | Enrolment fails with a correct email code and a wrong enrolment code; that counts one attempt; the challenge is consumed at five.                   |
| 3   | `grantOperator` refuses an enrolment code below the floor.                                                                                          |
| 4   | Enrolment fails after the window, after activation, and after revocation.                                                                           |
| 5   | Activation happens only with two operator credentials and only inside the window; one credential leaves the grant inactive.                         |
| 6   | Operator authentication refuses a tenant credential (null or auth-hostname `rp_id`) and an assertion without the UV flag.                           |
| 7   | Operator registration options carry `required` UV and the user's existing operator credential ids.                                                  |
| 8   | `readOperatorSession` refuses `tenant` and `enrolment` sessions, and a session whose user has no active grant.                                      |
| 9   | `revokeOperator` makes an existing operator session fail to read and to refresh.                                                                    |
| 10  | `startOperatorEnrolment` writes a challenge and returns no mail for an address with no open grant.                                                  |
| 11  | An invalid or unknown assertion writes no `operator_events` row.                                                                                    |
| 12  | The identity role cannot `UPDATE` or `DELETE` `operator_events`, nor `DELETE` `operator_grants`; the `platform` role cannot read `operator_grants`. |
| 13  | Identity's platform role list equals access's `PLATFORM_ROLE_KEYS`.                                                                                 |

**Permissions.** No permission key in this chunk. No tenant bundle changes (`packages/policy/src/decide.test.ts:41` keeps passing).

**Residency.** Unchanged; identity runs only in the regional service.

**Retention.** `operator_grants` and `operator_events` are kept indefinitely for now (operator access record). Revisit with audit retention.

**Logs.** No address, email code, enrolment code, credential id or token in a log line or error message.

## Contracts

No routes, events, permission keys or website keys. The identity manifest (`modules/core/identity/module.manifest.ts`, with `domain/manifest.test.ts`) classifies every new column in the Data table, in the same task as migration `0012`. Identity public API: the Scope functions, additions only. No caller edits elsewhere.

## Risks

- **Email becomes an operator back door.** Needs the 128-bit owner-delivered code as well as the mailbox, inside a 24-hour owner-opened window; email never yields an operator session. Pins 1–4.
- **Two passkeys on one device.** Mitigated, not prevented (O8). Owner to accept.
- **Session kinds confused.** Pin 8; the primitives defaults fail closed.
- **Event table abuse.** Rows only after a valid signature or an owner action (pin 11); append-only by grant (pin 12).
- **Size.** Estimated 450–550 source lines and 550–700 test lines, migration excluded. One module.

## Out-of-band

- **Owner decisions (Abdus):** O1 (§8.5 reading), O2 (grants by one-off only; 24-hour window), O3 (two-factor enrolment with a generated code), O7 (8-hour operator session), O8 (two passkeys is a credential count, not a device proof), O14 (single-owner interim recovery).
- **Architecture:** §11.4 and §8.5 edits in this PR (Scope). No ADR: within §11.4, reversible.
- **Second review:** authentication chunk; the owner's assistant runs the second fresh-context review when the PR opens (AGENTS.md §2).
- **Legal, subprocessor, cost:** none.
