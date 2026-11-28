Spec: docs/specs/2026-11-26-two-factor-for-staff.md

# Two-factor for staff Implementation Plan

Slug: two-factor-for-staff
Status: approved (2026-11-26, Adnan Bin Hossen)

Amendment A5 (2026-11-27, approved by Adnan Bin Hossen): after Checkpoint 3 (Claude Haiku 5.5, APPROVE WITH NOTES, 0 High, 0 Medium, 6 Low) and the reviewer's browser check (Playwriter on Brave against a scratch API stub, passed), a fix commit C3 before Task 11, implemented by Claude Sonnet 5.5. L1: when the second step answers 429, the admin ends the pre-2FA session on the server (`POST /v1/auth/session/end`) before leaving the flow, as Cancel does. L5: axe assertions for the removal confirm dialog on Security, the no-passkey-in-this-browser state, and the passkey-setup path to the backup-codes screen. Accepted and recorded in the pull request: L2 (the steps are states of `/sign-in`, not routes; no reload, token in memory), L3 (a passkey-only second step opens on the choice rather than starting the passkey), L4 (Security's shorter passkey-not-saved message), L6 (the QR SVG insertion was probed with injected markup and carries none).

| 119 | A 429 at the second step ends the pre-2FA session | Leave without calling `session/end` | AT | a 429 at the second step ends the pre-2FA session on the server |

Amendment A4 (2026-11-27, approved by Adnan Bin Hossen): the Security page must know when a session is in a backup-code recovery window (spec Behaviour, Recovery window), and the factor-list answer had no field for it (Task 10's implementer stopped on this, as its brief required). Task 10 also adds `recoveryUntil` (an ISO time, or null) to `secondFactorListAnswer` in `packages/contracts/src/auth.ts`, to `listSecondFactors` in `modules/core/identity/infrastructure/second-factor.ts`, and to the list route in `apps/api/src/second-factor-routes.ts`, with a contract test and an API test.

| 118 | The list tells a recovery session | Always answer `recoveryUntil: null` | AR | the factor list reports the recovery window of a backup-code session |

Amendment A3 (2026-11-26, approved by Adnan Bin Hossen): after Checkpoint 2 (Claude Haiku 5.5, CHANGES NEEDED, 0 High, 2 Medium, 5 Low; no path to an admin session without two factors found), a fix commit C2 before Task 9, implemented by Claude Sonnet 5.5 (the implementer from Task 8 on). M1: removal answers 409 for the last factor and 404 for an unknown or another user's passkey, as spec Contracts say, instead of 401. M2: `finishPasskeyAuthentication` is tenant-only and no longer exported from `public/`; a `tenant` session cannot be created with a null `factor`. L1: refresh refuses a `tenant` row whose `factor` is null. L2: `ADMIN_ORIGIN` with an explicit port is refused at start-up, so the origin check is exact. Accepted and recorded in the pull request: L3 (TOTP confirm has no failure counter; the key belongs to the session that started setup, and D-4 accepts that an account with no factor can be claimed) and L4 (passkey registration consumes its challenge before the `2fa:` lock; the re-checks under the lock keep it safe). L5 was a false alarm (every name ends in `example.test`).

| 111 | Passkey second step counts attempts | Skip `consumeSessionAttempt` in `verifySecondStepPasskey` | PK | a passkey second step counts an attempt before checking and stops at five |
| 112 | Passkey checks share the hourly limit | Skip the hourly check in `verifySecondStepPasskey` | PK | refuses a passkey second step after ten wrong answers in an hour |
| 113 | Removing the last factor answers 409 | Map the last-factor refusal to 401 | AR | removing the last factor answers 409 |
| 114 | Removing an unknown passkey answers 404 | Map the unknown-passkey refusal to 401 | AR | removing another user's passkey answers 404 |
| 115 | Refresh refuses a factor-less staff session | Drop the factor check from the refresh lookup | SE | refuses to refresh a tenant session with no factor |
| 116 | `ADMIN_ORIGIN` without a port | Accept an explicit port | EN | refuses an ADMIN_ORIGIN with an explicit port |
| 117 | Passkey sign-in is tenant-only | Restore a non-tenant branch that creates a session | PK | finishPasskeyAuthentication creates only factor-bearing tenant sessions |

Amendment A2 (2026-11-26, approved by Adnan Bin Hossen): after Checkpoint 1 (Claude Haiku 5.5, APPROVE WITH NOTES, 0 High, 2 Medium, 4 Low), a fix commit C1 before Task 6. M1: `hasSecondFactor` with no admin rpId counts every user-verified passkey, and `adminRpId` is a required argument of the second-factor functions, so a pre-2FA session can never set up a factor for a passkey-only user (pin 109). M2: the service refuses a `tenant` session whose `factor` is null, as the spec requires, without waiting for Task 8's `readSession` check (pin 110). L2: the notice dependency of `confirmTotpSetup` is required. L4: tests for removing one's own non-counting passkey, backup codes with `0`, `1`, `8` or `9`, and TOTP input that is not six digits. L1 stays in Task 8; L3 (two helpers with no production caller) is not applied.

| 109 | No-rpId factor check fails closed | Return false without `adminRpId` | SF | a pre-2FA session cannot set up TOTP for a passkey-only user when no rp id is passed |
| 110 | Service refuses a factor-less staff session | Drop the `factor` check in `readActiveSessionInTx` | SM | the second-factor service refuses a tenant session with no factor |

Amendment A1 (2026-11-26, approved by Adnan Bin Hossen): Task 1 also edits `packages/db/drizzle.schema.ts` to export the three new identity tables (drizzle-kit reads only that file's exports, `packages/db/drizzle.config.ts:5`, and `generate.test.ts` re-runs it in CI); `totp_credentials.last_used_step` is `bigint` in number mode, like `passkey_credentials.sign_count`; pin 10's note is corrected. Found by the Task 1 implementer, which stopped as the brief requires.

Revision 3 (2026-11-26) applied the delta plan check (Claude Haiku 5.5, NOT READY, 6 High, 9 Medium, 6 Low). All applied: pins 26, 27, 40, 86, 96 redesigned or moved; pin 93 removed (the `required` challenge row already guards the route; pin 66 covers `requireUvFlag`); the pre-2FA setup check lives in the service, which now takes the caller's session; the notice port's deviation from spec line 140 is stated; the billing and invitations expression is written out.

Revision 2 (2026-11-26) applied the fresh-context plan check (Claude Haiku 5.5, NOT READY, 7 High, 13 Medium, 12 Low). All applied. H1: the notice is a separate port, `SecondFactorNotice`, so no existing `OtpMail` fake changes. H2 and H3: the route-level passkey switch moves to Task 8 with every affected test, found by grep and listed. H7 and M8: race pins become lock pins with a blocking proof. M13: billing and invitations keep today's admin origin. L11 needs no change.

> **For agentic workers:** use superpowers:subagent-driven-development, test-driven-development inside each task, and verification-before-completion before reporting. One task = one commit. Reports go to `.superpowers/sdd/task-N-report.md`, never `docs/plans/` and never a commit.

**Goal:** An email code gives only a restricted pre-2FA session. Staff reach the admin after a TOTP code, a user-verified passkey of their own, or a backup code; a user-verified passkey sign-in counts as both factors. Every user without a factor sets one up first and gets ten backup codes. Settings → Security manages factors behind a fresh check, and a backup-code sign-in opens a 10-minute recovery window. Tenant passkeys move to the admin origin. ADR 0022 is the design record.

**Architecture:**

- `packages/db`: migration `0024` (three identity tables, six new columns, the widened `sessions` kind check, the append-only grant) and its tests.
- `modules/core/identity`: schema, manifest, TOTP and backup-code domain, session changes, the second-factor service, passkey changes, the `SecondFactorNotice` port.
- `packages/contracts`: auth bodies and answers.
- `apps/api`: env, `AuthDeps`, the routes, the cut-over, the SES notice adapter.
- `apps/admin`: sign-in second step and setup, passkey sign-in, backup codes, Settings → Security.
- `infra/modules/aws-ingress`: `ADMIN_ORIGIN` without the billing condition.
- `architecture.md`, `docs/adr/0022-*.md`, `docs/adr/0017-*.md`, `docs/runbooks/apply-staging-au.md`, `docs/roadmap.md`, `AGENTS.md`.

Eleven tasks, one more than AGENTS.md §3's guide: the cut-over (Task 8) must land in one commit, and the documents come last.

## Who does what

- **Implementer:** Antigravity on **Gemini 4 Hydrogen xhigh** (`agy --model gemini-4-hydrogen-xhigh`), in `C:\Recovered\Taftech\wt-two-factor` on the chunk branch. Fallback when it is out of quota or fails twice: Claude Sonnet 5.5. Each model used is named in the task report.
  - Tests first, one commit per task, commits locally, never pushes. One plan task per run.
  - For every Security pins row its task names, it writes the weakening as a `.patch` under `.superpowers/sdd/pins/` (with `git diff --output`, UTF-8, LF) and a row in `.superpowers/sdd/pins/manifest.json` (the `pinrun.mjs` format, with a `"build"` list where the pin weakens a package another package's test reads through `dist`). It checks that each hunk header names the right function. The reviewer runs them. This departs from AGENTS.md §4 Phase 2, as in the last five chunks, because the reviewer re-runs every pin anyway.
  - Every test result it claims points to a log it wrote with `tee` under `.superpowers/sdd/task-N-logs/`, UTF-8. A claim without a log counts as not run.
  - It starts with no AWS credentials; pushes are blocked by the push URL and the pre-push hook.
- **Reviewer agent:** this session, on Claude Opus 5.5 for the whole chunk. Each task is reviewed by its diff, the named tests re-run, and every named pin run through `pinrun.mjs`.
- **Owner's checks and second review:** the chunk owner runs them in a fresh session on a model that is not Opus, Gemini or Sonnet (if the fallback ran). The spec and plan checks ran on Claude Haiku 5.5.
- **Docker test database:** one run at a time. Tasks 1 and 3 to 8 need it, as does any full local gate. `pinrun` never runs while an implementer is editing the tree.

## Checkpoints

- **After Task 5** (migration, domain, sessions, second-factor service): pins 1 to 63; an owner's check of `git diff <plan-sha>..<task-5-sha>`. Task 6 starts after that check.
- **After Task 8** (passkeys, env, Terraform, routes, cut-over): pins 64 to 98 except 93 (removed) and 96 (admin); `index.test.ts`, `auth-flow.integration.test.ts`, `access-flow.integration.test.ts`, `invitations.integration.test.ts`, `users-list.integration.test.ts`, `billing-guard.integration.test.ts` and `image.test.ts` re-run; `terraform test` in `infra/modules/aws-ingress`; an owner's check of `git diff <task-5-sha>..<task-8-sha>`.
- **After Task 10** (admin): pins 96 and 99 to 108; `sign-in.test.tsx`, `second-factor.test.tsx` and `security.test.tsx` five times green; a browser check at 1280px and 375px, light and dark: email sign-in to setup, the QR, the backup codes screen, the second step, a backup-code sign-in and its recovery window, Security, passkey sign-in with a platform authenticator, an invited user reaching the accept screen. Screenshots for the pull request, with no code, key or QR visible in them (each code and the QR blurred).

## Global constraints

- **Branch:** `feat/2026-11-26-two-factor-for-staff`, from `origin/main` at `75900af`. The spec is its first commit (`8141ae9`), this plan its second.
- **Migration:** one file, `0024`. Until the pull request merges, later tasks may edit `0024`'s hand SQL (and regenerate its snapshot); each such edit is named in that task's report. `0023` and earlier are not edited. If `drizzle-kit generate` fails with the known Windows ENOENT, the snapshot and journal entry are written by hand from `0023_snapshot.json`, and the report says so.
- **Untouched:** people, households, life events, groups, access, billing, entitlements, tenancy, policy and engagement source; `app` tables, policies, roles and functions; `packages/db/sql/bootstrap.sql` and the four roles; workflows; the Dockerfile; `infra/` except `infra/modules/aws-ingress/main.tf` and its test; the ops console and operator flows (`operator.ts` calls stay as they are); the `OtpMail` port and its fakes.
- **Dependencies:** `qrcode` and `@types/qrcode` in `apps/admin` only (Task 9). Exact versions and the licence read from each package's own `package.json` go in the report. No other dependency, workspace package, permission, entitlement or event.
- **Never disabled to get green:** a check, a lint rule (no `eslint-disable`), an axe rule other than the repo's existing `color-contrast` exclusion, RLS, a test or a CI gate. No `@ts-ignore` or `@ts-expect-error`.
- **Fixtures** are synthetic: `example.test` addresses, invented names, the RFC 6238 test key (`12345678901234567890` as ASCII) and keys generated in the test. No TOTP key, backup code or `otpauth` link in a committed file other than the RFC test key.
- **No personal data or secret** in logs, error bodies, URLs, audit rows or test snapshots: no code, TOTP key, `otpauth` link, backup code or email address. Error bodies stay empty.
- **Lock order:** `'2fa:' || user_id`, then `family:`, everywhere a path takes both. `endSession` takes only `family:` and never waits for `2fa:`, so no advisory-lock cycle forms. `endOtherSessions` and `endSession` can still meet on session row locks; Postgres then aborts one with a deadlock error, the route answers 500 with an empty body, and the user retries. Accepted: both are rare user actions on one account.
- **Sessions inside a lock:** a session created under `lockSecondFactor` is inserted with `createSessionInTransaction` in the same `sql.begin`, with the blind-index key resolved before the transaction opens (no pool call inside it).
- **Clock:** TOTP steps use one injected `now` per request (the routes' `deps.now()`); tests fix it. Database expiry columns compare against that `now`, as `session.ts` does.
- **Build order:** `apps/api` imports the built `dist` of `@community-hub/contracts`, `@community-hub/identity` and `@community-hub/db`. After changing one, run `pnpm --filter <pkg> build` before the dependent tests. Pins that weaken a package read through `dist` list it in `"build"`.
- **Local gate per task:** `pnpm format && pnpm lint && pnpm typecheck && pnpm exec turbo run test --continue --force --concurrency=1; pnpm check:boundaries`, teed, and the turbo summary read for any failure other than the allowed ones. Task 7 also runs `terraform fmt -check -recursive`, `terraform validate` and `terraform test` in `infra/modules/aws-ingress` (in a copy outside the repo if `init` needs to touch the lock file, which it must not change).
- **Allowed failures on this Windows machine,** and only these: `packages/db/src/generate.test.ts` drizzle ENOENT; the `image-publish` symlink EPERM; the `migrate.integration` and `plaintext-dist` timeouts; the identity `tsbuildinfo.test` 5 s timing flake.
- **Lock pins.** A test that pins a lock holds `lockSecondFactor` for the same user in its own open transaction, starts the call under test, proves it is waiting by querying `pg_locks` for an advisory lock with `granted = false` on the same key (`hashtextextended('2fa:' || user_id::text, 0)`, split into `classid`/`objid`), then releases and asserts the end state. Never sleeps. No pin depends on a race happening by chance.
- **Thrown errors as assertions:** every call a pin may turn into a throw is wrapped in `await expect(...).resolves` or `.rejects.toMatchObject({ code: ... })`, and a "refused" test asserts the rows are unchanged. No bare `rejects.toThrow()`.
- **Admin tests:** no real waits; exact fetch call counts; each new section repeated five times green before the task is reported.
- **Line endings:** LF.

## Decisions fixed by the spec (do not reopen)

1. An email code is never a second factor. An email code alone gives a `second_factor` session: 15 minutes, no refresh, accepted only by the pre-2FA routes and session end.
2. A `tenant` session needs `factor` set: `passkey_uv`, `otp_totp`, `otp_passkey` or `otp_backup_code`. A `tenant` row with `factor` null is refused.
3. A user-verified tenant passkey (rpId the admin host, `user_verified` true, UV flag in the assertion) signs in alone. Pre-chunk passkeys never count and are never listed.
4. Backup codes: ten, 12 characters of RFC 4648 base32, single use, sign-in recovery only, never a fresh factor. A backup-code sign-in opens a 10-minute recovery window for: replace or set up the app, add a passkey, remove a passkey while a non-backup factor stays, make new codes. The recovery session never passes a fresh check.
5. Fresh check: TOTP or user-verified passkey of the same user within 5 minutes, for adding, removing and new codes. The first setup does not set it.
6. Limits: 5 attempts per pre-2FA session, counted before comparing; the fifth wrong answer revokes the session in the same transaction (spec: "At five, the session ends"). 10 wrong answers per user per hour across the second step and the fresh check. On an admin session the fresh check stops at 5 with 429 and the session stays.
7. Outside a recovery window, replacing the app, making new codes and removing a factor end the user's other `tenant` and `second_factor` sessions. Inside a recovery window every allowed action does, adding a passkey included (spec Behaviour, Recovery window). `operator` and `enrolment` sessions are never touched.
8. No admin reset, no `app` change, ADR 0004's four roles unchanged.
9. The migration is expand only; the old image keeps working during the deploy (D-5).
10. The new image is deployed before the Terraform change.

## Plan additions to the spec

- **Caller's session.** Every second-factor service function takes the caller's session id and, under `lockSecondFactor`, reads that row (`kind`, `user_id`, `fresh_factor_at`, `recovery_until`, `second_factor_attempts`, `revoked_at`). The rules that depend on the caller live there: a `second_factor` caller may set up a factor only when the user has no confirmed factor (pins 32, 33, 77, 78); an admin caller needs a fresh factor or a recovery window; a recovery caller never passes a fresh check. The tenant passkey registration wrapper in `second-factor.ts` (Task 6) applies the same rule before calling `beginPasskeyRegistration` and `finishPasskeyRegistration`.
- **Lock helper.** `lockSecondFactor(tx, userId)` in `modules/core/identity/infrastructure/second-factor-lock.ts` takes `pg_advisory_xact_lock(hashtextextended('2fa:' || user_id::text, 0))`. Every path in spec Data "Lock" calls it first.
- **Refresh.** The locate query in `refreshSession` (`session.ts:250-255`) also returns `user_id` and `kind`. For a `tenant` row, the transaction takes `lockSecondFactor` before the family lock; operator refreshes do not. Replacing the app, making new codes and removing a factor end other sessions under the same lock (decision 7), so a refresh that waited finds its row revoked and refuses. No extra column.
- **Re-check before insert.** The second step and the first setup re-check, under the lock, that the TOTP row is still confirmed or the passkey row still present, then insert the admin session with `createSessionInTransaction` and revoke the pre-2FA row in the same transaction.
- **TOTP replacement.** Start writes `pending_secret`; confirm, under the lock, moves it to `secret`, sets `confirmed_at` and `last_used_step`, and ends other sessions. A new start replaces an unconfirmed `pending_secret`.
- **Attempts on admin sessions.** The fresh check uses `sessions.second_factor_attempts` on the admin session; at 5 it answers 429 and the session stays. Each wrong fresh answer also writes `verify_failed`, so it counts toward the hourly 10.
- **Notice port.** A new port `SecondFactorNotice { send({ to, kind }): Promise<void> }` in `modules/core/identity/domain/second-factor-notice.ts`, with `rejectingSecondFactorNotice`, and an SES adapter `apps/api/src/mail/ses-second-factor-notice.ts` that reuses the SES client set-up of `ses-otp-mail.ts`. `OtpMail` and its fakes do not change. **This deviates from spec line 140** (which adds `sendNotice` to `OtpMail`): a method on `OtpMail` would break 17 `implements OtpMail` test classes and two object-literal fakes. Same shape, own port; the pull request description says so. `AuthDeps` and the second-factor routes' deps gain `notice: SecondFactorNotice`, wired in `index.ts` beside `mail` (`:283`); Task 8 updates the `AuthDeps` literal in `auth-routes.test.ts:44`. Kinds: `totp_set_up`, `totp_removed`, `passkey_added`, `passkey_removed`, `backup_codes_made`. The template says what changed and when, and "If this wasn't you, contact your organisation's owner." No address, code or device detail.
- **Passkey inputs.** `passkey.ts` functions gain explicit tenant-only inputs, all defaulting to today's behaviour: `requireUvFlag` (finish paths refuse a missing UV flag whatever the challenge row says, `:133`, `:270`), `requireUserVerified` (lookups add `and user_verified`, `:238-242`, `:260`), `challengeUserId` (the challenge is created with that `user_id` and looked up by it instead of `user_id is null`, `:208-209`, `:253-256`), and `expectedUserId` (the credential's user is compared before the challenge is consumed or `sign_count` written). `finishPasskeyAuthentication` (`:317-336`) becomes one `sql.begin`: verify, `lockSecondFactor`, re-check the credential row, `createSessionInTransaction`. The first-factor passkey path uses the existing store hooks (`:170-185`) to write the backup codes and the admin session in the registration's transaction; Task 6 builds and tests that path at function level and Task 8 wires it to the route. `factor = passkey_uv` and `fresh_factor_at` are set only when `requireUvFlag` is true. The second-step and fresh passkey checks are their own functions (`verifySecondStepPasskey`, `verifyFreshPasskey`) and do not reuse `finishPasskeyAuthentication`.
- **Where the route switch happens.** Task 6 changes functions only; the routes keep calling them as today, so the gate stays green. Task 8 switches the routes to the admin origin and the tenant inputs, together with the tests that drive them.
- **Admin origin for billing and invitations.** `index.ts` keeps passing billing (`:266-274`) and invitations (`:384-392`) an admin origin only when the billing secret is set, exactly as today: those routes answer as they do now with `ADMIN_ORIGIN` alone (`invitation-routes.ts:214-219`, `billing-routes.ts:240`, `:301`). Only `AuthDeps.adminOrigin` takes `ADMIN_ORIGIN` whenever it is present. In `index.ts:271` and `:389` the expression becomes `adminOrigin: env.BILLING_SECRET_ARN === undefined ? undefined : env.ADMIN_ORIGIN`.
- **`passkeysAvailable`.** True when `AuthDeps.adminOrigin` is set.
- **Contracts.** `packages/contracts/src/auth.ts` gains the bodies and answers in spec Contracts; every answer schema is `.strict()`.
- **Route names.** Pre-2FA and fresh routes live in `apps/api/src/second-factor-routes.ts` (new), registered from `productionRoutes` (`apps/api/src/index.ts:399`) beside `authRoutes`, surface `tenant`, billing `exempt`, auth hostname.
- **Test helpers.** Three, so every caller has one:
  - HTTP: `apps/api/src/test-support/second-factor.ts` (new), `signInWithTotp(fetch, email)`, enrols a generated TOTP key on first use and completes the second step, returning admin tokens.
  - In process, for `apps/api` tests that call identity functions directly: the same file, `signInWithTotpInProcess(sql, kms, keyArn, email, now)`, through the identity public exports.
  - Identity's own tests: `modules/core/identity/infrastructure/second-factor.fixture.ts` (new, excluded from the build like other test files), the same function on the infrastructure modules.
- **Tests that move in Task 8,** found with `rg -l "verifyEmailOtp\(|email-otp/verify|passkey/(register|authenticate)|createSession\(|into identity.sessions" apps modules packages --glob "*.test.ts*"`. The plan check found these, and the report lists the final set with its grep output:
  - `apps/api/src`: `access-flow`, `add-adult-atomicity`, `auth-flow`, `billing-flow`, `billing-guard`, `engagement-routes`, `entitlement-flow`, `family-routes`, `household-routes`, `invitations`, `life-event-routes`, `ops-flow`, `people-delete-routes`, `people-routes`, `provision-owner`, `users-list` (`*.integration.test.ts`), and `auth-routes.test.ts`, `index.test.ts`, `gate.test.ts`, `server.test.ts` where they sign in.
  - `modules/core/identity/infrastructure`: `email-otp.integration.test.ts`, `session.integration.test.ts` (tenant `createSession` calls gain `factor`), `passkey.integration.test.ts` (tenant fixtures gain the UV flag `0x45`, admin rpId and origin), `operator.integration.test.ts` (tenant `createSession` calls gain `factor`).
  - `apps/admin/src`: `sign-in.test.tsx`, `accept-invitation.test.tsx`.
  - `apps/ops/src`: `enrol.test.tsx`, `no-injected-style.test.tsx`, `sign-in.test.tsx` match only through mocked `/v1/ops/passkey/register` URLs and are unchanged; the report lists them as matched and unchanged so the set is closed.
  - Each moved test keeps its assertions. A test that must change an assertion says why in the report.
- **End states of the lock pins** (spec tests 6 and 18): pin 29 also asserts that two parallel right answers on one pre-2FA session give one admin session; pin 39 that two first setups from two pre-2FA sessions give one factor; pin 56 that two parallel removals leave one factor; pin 76 that a removal racing a passkey sign-in leaves no live session with the removed passkey.
- **Recovery and other sessions.** Decision 7 follows spec Behaviour "Recovery window" (every action in it ends other sessions, adding a passkey included); spec Behaviour "Settings → Security" lists only the actions outside recovery. The pull request description records this reading.
- **Kind check name.** The new constraint is `sessions_kind_v2`; `sessions_kind` is dropped after it in the same migration, and `schema.ts:135` takes the new name.
- **Admin routes.** `/sign-in` keeps the email form and adds the second-step, setup and backup-codes steps as in-app states of the same route (no reload, so the invite token in `invite-token.ts` survives). `/settings/security` is new, linked from the Settings group in `nav.tsx`, after Users & Roles.
- **Terraform position.** The unconditional `ADMIN_ORIGIN` list sits after the mail and SES lists and before the billing list (`main.tf:496-498`), so the billing run's "last two entries" assert and the `staging_image_set` list (where it is last) both hold. Probe on 2026-11-26: 26 of 26 runs pass with the change; with the old line, `admin_origin_without_billing` and `staging_image_set` fail.

## Security pins

Each row is a weakening the implementer writes as a patch and the reviewer runs through `node ~/.claude/crew/bin/pinrun.mjs .superpowers/sdd/pins/manifest.json --only <id>`. The weakened run must fail **on an assertion** in the named test; the restored run must pass. The weakened tree is never committed.

Files: **MG** = `packages/db/test/two-factor-migration.integration.test.ts` (new); **MF** = `modules/core/identity/domain/manifest.test.ts`; **TO** = `modules/core/identity/domain/totp.test.ts` (new); **BC** = `modules/core/identity/domain/backup-code.test.ts` (new); **SE** = `modules/core/identity/infrastructure/session.integration.test.ts`; **SF** = `modules/core/identity/infrastructure/second-factor.integration.test.ts` (new); **SM** = `modules/core/identity/infrastructure/second-factor-manage.integration.test.ts` (new); **PK** = `modules/core/identity/infrastructure/passkey.integration.test.ts`; **OP** = `modules/core/identity/infrastructure/operator.integration.test.ts`; **EN** = `apps/api/src/env.test.ts`; **IX** = `apps/api/src/index.test.ts`; **TF** = `infra/modules/aws-ingress/tests/ingress.tftest.hcl` (run with `terraform test`, not `pinrun`); **CT** = `packages/contracts/src/auth.test.ts`; **AR** = `apps/api/src/second-factor-routes.integration.test.ts` (new); **RW** = `apps/api/src/second-factor-gate.integration.test.ts` (new); **AS** = `apps/admin/src/sign-in.test.tsx`; **AT** = `apps/admin/src/second-factor.test.tsx` (new); **AY** = `apps/admin/src/security.test.tsx` (new).

| #   | Setting                                          | Weakening                                           | File | Test that must fail (exact `it` title)                                                                                                                                        |
| --- | ------------------------------------------------ | --------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `sessions` kind check                            | Drop `sessions_kind_v2`                             | MG   | refuses a session kind outside the four                                                                                                                                       |
| 2   | `second_factor_attempts` 0..5                    | Drop the check                                      | MG   | refuses second_factor_attempts above five                                                                                                                                     |
| 3   | `factor` values                                  | Drop the check                                      | MG   | refuses an unknown factor value                                                                                                                                               |
| 4   | `second_factor_events` append-only               | Drop the `REVOKE`                                   | MG   | the identity role cannot update or delete second factor events                                                                                                                |
| 5   | One TOTP row per user                            | Drop the unique                                     | MG   | refuses a second TOTP row for one user                                                                                                                                        |
| 6   | Backup code unique per user                      | Drop the unique                                     | MG   | refuses a duplicate backup code hash for one user                                                                                                                             |
| 7   | Old image inserts still work                     | `sessions.factor` `NOT NULL`                        | MG   | the session, refresh and passkey inserts on main still succeed                                                                                                                |
| 8   | `user_verified` defaults false                   | Default true                                        | MG   | an existing passkey row reads user_verified false                                                                                                                             |
| 9   | Event check list                                 | Drop the check                                      | MG   | refuses an unknown second factor event                                                                                                                                        |
| 10  | Every new column classified                      | Remove `totp_credentials.secret` from `dataClasses` | MF   | declares every identity column and nothing else (it compares the manifest with an inline expected list, so both are edited in Task 1)                                         |
| 11  | RFC 6238 SHA1                                    | HMAC-SHA256                                         | TO   | matches the RFC 6238 SHA1 vectors truncated to six digits                                                                                                                     |
| 12  | One step either side                             | Accept two steps                                    | TO   | accepts one step either side and refuses two                                                                                                                                  |
| 13  | Leading zeros kept                               | Drop the zero padding                               | TO   | keeps leading zeros                                                                                                                                                           |
| 14  | `otpauth` label and issuer only                  | Add the user id to the label                        | TO   | builds the otpauth link with issuer and label Community Hub only                                                                                                              |
| 15  | Backup code format                               | 8 characters                                        | BC   | makes ten twelve-character base32 codes                                                                                                                                       |
| 16  | Backup code normalisation                        | Drop upper-casing                                   | BC   | accepts lower case, spaces and dashes                                                                                                                                         |
| 17  | `second_factor` not refreshable                  | Let refresh accept the kind                         | SE   | refuses to refresh a second_factor session                                                                                                                                    |
| 18  | No refresh lifetime                              | 30-day refresh expiry                               | SE   | gives a second_factor session no refresh lifetime                                                                                                                             |
| 19  | Refresh carries `factor`                         | Omit it from the successor                          | SE   | carries the factor to the refresh successor                                                                                                                                   |
| 20  | Refresh drops fresh and recovery                 | Carry both                                          | SE   | does not carry fresh_factor_at or recovery_until on refresh                                                                                                                   |
| 21  | Sign-out ends a pre-2FA session                  | `endSession` tenant only                            | SE   | sign-out ends a second_factor session                                                                                                                                         |
| 22  | `endOtherSessions` scope                         | Revoke every kind                                   | SE   | endOtherSessions leaves operator, enrolment and the current session                                                                                                           |
| 23  | Default kinds exclude `second_factor`            | Add it to the default                               | SE   | readSession refuses a second_factor session by default                                                                                                                        |
| 24  | Tenant refresh takes the `2fa:` lock             | Drop `lockSecondFactor` from refresh                | SE   | a tenant refresh waits for the second factor lock                                                                                                                             |
| 25  | TOTP step replay                                 | Drop the compare-and-set                            | SF   | refuses the same TOTP step twice                                                                                                                                              |
| 26  | Attempt counted before compare                   | Compare first and count wrong answers only          | SF   | a right answer after five wrong ones is refused                                                                                                                               |
| 27  | The fifth wrong answer ends the session          | Skip the revoke at five                             | SF   | the fifth wrong answer revokes the pre-2FA session                                                                                                                            |
| 28  | 10 per user per hour                             | Drop the hourly check                               | SF   | refuses the second step after ten wrong answers in an hour                                                                                                                    |
| 29  | Second step takes the lock                       | Drop `lockSecondFactor` there                       | SF   | the second step waits for the second factor lock                                                                                                                              |
| 30  | Backup code single use                           | Drop `used_at is null`                              | SF   | a backup code works once                                                                                                                                                      |
| 31  | Backup code: recovery, not fresh                 | Set `fresh_factor_at`                               | SF   | a backup-code sign-in sets a ten-minute recovery window and no fresh factor                                                                                                   |
| 32  | No pre-2FA TOTP setup with a factor (start)      | Drop the check on start                             | SF   | refuses TOTP start from a pre-2FA session when the user has a factor                                                                                                          |
| 33  | No pre-2FA TOTP setup with a factor (confirm)    | Drop the check on confirm                           | SF   | refuses TOTP confirm from a pre-2FA session when the user has a factor                                                                                                        |
| 34  | Unconfirmed TOTP is not a factor                 | Count it                                            | SF   | an unconfirmed TOTP is not a factor                                                                                                                                           |
| 35  | First setup is not fresh                         | Set `fresh_factor_at`                               | SF   | the first setup from a pre-2FA session sets no fresh factor                                                                                                                   |
| 36  | Identical wrong answers                          | Distinct error codes                                | SF   | a wrong code, a wrong backup code and a missing factor give the same error                                                                                                    |
| 37  | TOTP secret encrypted                            | Store the plaintext                                 | SF   | stores the TOTP secret encrypted                                                                                                                                              |
| 38  | Pending secret has its own label                 | Same label as `secret`                              | SF   | a pending secret does not decrypt as the secret                                                                                                                               |
| 39  | TOTP confirm takes the lock                      | Drop `lockSecondFactor` in confirm                  | SF   | TOTP confirm waits for the second factor lock                                                                                                                                 |
| 40  | A pre-2FA session ends at its second step        | Skip revoking the pre-2FA row                       | SF   | a pre-2FA session cannot take an unused backup code after its second step                                                                                                     |
| 41  | Factor recorded                                  | Leave `factor` null                                 | SF   | the second step records the factor on the admin session                                                                                                                       |
| 42  | Secret returned only at setup                    | Return `secret` from the factor list                | SF   | the factor list never returns a TOTP secret                                                                                                                                   |
| 43  | Fresh needed for changes                         | Drop the fresh check                                | SM   | refuses factor changes without a fresh check                                                                                                                                  |
| 44  | Fresh lasts 5 minutes                            | 15 minutes                                          | SM   | refuses factor changes five minutes after the fresh check                                                                                                                     |
| 45  | Recovery session never fresh                     | Let the fresh route accept it                       | SM   | a recovery session cannot pass a fresh check with a factor set up in it                                                                                                       |
| 46  | Recovery window 10 minutes                       | Drop the expiry                                     | SM   | the recovery window ends after ten minutes                                                                                                                                    |
| 47  | Recovery: no app removal                         | Allow it                                            | SM   | a recovery session cannot remove the authenticator app                                                                                                                        |
| 48  | Last factor; backup codes don't count            | Count backup codes                                  | SM   | refuses removing the last factor even with backup codes left                                                                                                                  |
| 49  | Recovery passkey removal keeps a factor          | Drop the check                                      | SM   | a recovery session cannot remove the last non-backup factor                                                                                                                   |
| 50  | Replace ends other sessions                      | Skip `endOtherSessions`                             | SM   | replacing the app ends the user's other admin sessions                                                                                                                        |
| 51  | New codes end other sessions                     | Skip `endOtherSessions`                             | SM   | making new backup codes ends the user's other admin sessions                                                                                                                  |
| 52  | Removal ends other sessions                      | Skip `endOtherSessions`                             | SM   | removing a factor ends the user's other admin sessions                                                                                                                        |
| 53  | Recovery: adding a passkey ends other sessions   | Skip it for add in recovery                         | SM   | adding a passkey in a recovery window ends the user's other admin sessions                                                                                                    |
| 54  | Old codes stop working                           | Keep the old rows                                   | SM   | old backup codes stop working after new ones are made                                                                                                                         |
| 55  | App removal deletes the secret                   | Null `confirmed_at` only                            | SM   | removing the app deletes its secret                                                                                                                                           |
| 56  | Removal takes the lock                           | Drop `lockSecondFactor` in removal                  | SM   | removing a factor waits for the second factor lock                                                                                                                            |
| 57  | Notice only after commit                         | Send before the last check                          | SM   | sends no notice for a refused change                                                                                                                                          |
| 58  | Notice failure logs the kind only                | Log the address                                     | SM   | a failed notice logs the kind only                                                                                                                                            |
| 59  | Notice per kind                                  | Skip the notice on new codes                        | SM   | sends one notice for each change kind                                                                                                                                         |
| 60  | Fresh limit per admin session                    | Drop the fresh counter                              | SM   | the sixth wrong fresh answer in one admin session is refused and the session stays                                                                                            |
| 61  | Fresh failures count hourly                      | Skip `verify_failed` on fresh                       | SM   | wrong fresh answers in two admin sessions count toward the hourly limit                                                                                                       |
| 62  | Pre-chunk passkeys not listed                    | List every passkey row                              | SM   | the factor list leaves out passkeys from before this chunk                                                                                                                    |
| 63  | Removal by another user's id                     | Look the passkey up by id only                      | SM   | removing another user's passkey id answers as unknown and changes nothing                                                                                                     |
| 64  | Tenant registration needs UV                     | `requireUvFlag` ignored                             | PK   | refuses a tenant registration without the UV flag on a preferred challenge and saves nothing                                                                                  |
| 65  | `user_verified` stored                           | Omit it from the insert                             | PK   | a tenant registration stores user_verified                                                                                                                                    |
| 66  | Tenant assertion needs UV                        | `requireUvFlag` ignored                             | PK   | refuses a tenant assertion without UV even on a preferred challenge                                                                                                           |
| 67  | Tenant lookup needs `user_verified`              | `requireUserVerified` ignored                       | PK   | refuses a tenant passkey whose user_verified is false                                                                                                                         |
| 68  | No legacy credentials                            | `acceptLegacy: true`                                | PK   | refuses a passkey with no rp id on tenant routes                                                                                                                              |
| 69  | Ops credential refused on tenant                 | Drop the rp id filter                               | PK   | refuses an ops passkey on the tenant sign-in (the assertion is signed with the ops key over the admin origin and the admin rpId hash, so only the rp id filter can refuse it) |
| 70  | Ops unaffected                                   | `requireUserVerified` on every call                 | OP   | an operator passkey with user_verified false still signs in to ops                                                                                                            |
| 71  | Second-step user check before consume            | Compare after consuming                             | PK   | a passkey of another user as the second step leaves its sign count and the challenge unconsumed                                                                               |
| 72  | Second-step challenge bound to the user          | `challengeUserId` ignored                           | PK   | a second-step challenge is bound to the session user                                                                                                                          |
| 73  | Fresh passkey of the same user only              | `expectedUserId` ignored on fresh                   | PK   | a passkey of another user cannot pass the fresh check                                                                                                                         |
| 74  | Origin is `ADMIN_ORIGIN`                         | Accept the auth host origin                         | PK   | refuses a tenant ceremony from another origin                                                                                                                                 |
| 75  | Passkey sign-in records `passkey_uv` and fresh   | Leave both null                                     | PK   | a passkey sign-in records passkey_uv and a fresh factor                                                                                                                       |
| 76  | Passkey sign-in takes the lock                   | Drop `lockSecondFactor` in passkey sign-in          | PK   | a passkey sign-in waits for the second factor lock                                                                                                                            |
| 77  | No pre-2FA passkey setup with a factor (options) | Drop the check on options                           | PK   | refuses passkey register options from a pre-2FA session when the user has a factor                                                                                            |
| 78  | No pre-2FA passkey setup with a factor (verify)  | Drop the check on verify                            | PK   | refuses passkey register verify from a pre-2FA session when the user has a factor                                                                                             |
| 79  | Admin host distinct                              | Drop it from the distinct set                       | EN   | refuses an ADMIN_ORIGIN whose host equals another service hostname                                                                                                            |
| 80  | Billing alone refused                            | Drop the pairing                                    | EN   | refuses BILLING_SECRET_ARN without ADMIN_ORIGIN                                                                                                                               |
| 81  | `https` origin, no path                          | Accept `http`                                       | EN   | refuses an ADMIN_ORIGIN that is not an https origin                                                                                                                           |
| 82  | Billing and invitations keep today's origin      | Pass `ADMIN_ORIGIN` to them always                  | IX   | with ADMIN_ORIGIN and no billing secret, invitation create and checkout answer 503                                                                                            |
| 83  | `ADMIN_ORIGIN` without billing                   | Restore the billing condition                       | TF   | run `admin_origin_without_billing`                                                                                                                                            |
| 84  | Every session route refuses pre-2FA              | Default kinds include `second_factor`               | RW   | every session route refuses a second_factor token (walks `productionRoutes`; a route on no list fails)                                                                        |
| 85  | Cut-over in `readSession`                        | Drop the `factor` check                             | RW   | a tenant session with no factor is refused                                                                                                                                    |
| 86  | Cut-over in `readSessionWithKind`                | Drop the `factor` check there                       | SE   | readSessionWithKind with the tenant kind refuses a session with no factor                                                                                                     |
| 87  | Verify gives pre-2FA only                        | Return a tenant session and refresh token           | AR   | an email-code sign-in returns a second_factor session and no refresh token                                                                                                    |
| 88  | `no-store` on secrets and codes                  | Drop the header                                     | AR   | answers carrying a secret or backup codes are no-store                                                                                                                        |
| 89  | Empty refusal bodies                             | Add a message                                       | AR   | refusals have empty bodies                                                                                                                                                    |
| 90  | Nothing secret in logs                           | Log the request body on error                       | AR   | no code, secret, otpauth link or email reaches the logs when a second-factor route fails                                                                                      |
| 91  | Passkey routes need `ADMIN_ORIGIN`               | Fall back to the auth host                          | AR   | tenant passkey routes answer 404 without ADMIN_ORIGIN                                                                                                                         |
| 92  | Security routes refuse pre-2FA                   | Accept a pre-2FA token there                        | AR   | Security routes refuse a second_factor token                                                                                                                                  |
| 94  | Routes use the admin rpId                        | Pass the auth host                                  | AR   | the passkey routes use the admin origin's host as rp id                                                                                                                       |
| 95  | `passkeysAvailable`                              | Always true                                         | AR   | verify reports passkeys unavailable without ADMIN_ORIGIN                                                                                                                      |
| 96  | Cancel ends the pre-2FA session                  | Drop the session-end call on Cancel                 | AT   | Cancel ends the pre-2FA session on the server                                                                                                                                 |
| 97  | Verify answer is strict                          | Allow an extra `refreshToken`                       | CT   | the email-code verify answer rejects a payload with a refresh token                                                                                                           |
| 98  | Answers carry no secret outside setup            | Allow `secret` in the factor list schema            | CT   | the factor list answer rejects a payload with a secret                                                                                                                        |
| 99  | Pre-2FA token never stored                       | Store it with `storeAccessToken`                    | AS   | keeps the pre-2FA token out of session storage                                                                                                                                |
| 100 | Admin token only after the second step           | Store on the pre-2FA answer                         | AT   | stores the admin token only after the second step                                                                                                                             |
| 101 | Invite token survives                            | Clear it on setup                                   | AT   | an invited user reaches the accept screen after setup                                                                                                                         |
| 102 | Codes saved before Continue                      | Enable Continue at once                             | AT   | Continue stays disabled until the codes are saved                                                                                                                             |
| 103 | QR as inline SVG                                 | Render an `img` with a data URL                     | AT   | draws the QR as inline SVG                                                                                                                                                    |
| 104 | Passkey button hidden when unavailable           | Always show it                                      | AS   | hides the passkey button when passkeys are not available                                                                                                                      |
| 105 | Fresh check before a change                      | Skip the confirm step                               | AY   | asks to confirm before removing a factor                                                                                                                                      |
| 106 | Recovery offers only allowed actions             | Show app removal in recovery                        | AY   | a recovery session offers no app removal                                                                                                                                      |
| 107 | Security shows no secret                         | Render the secret from the list answer              | AY   | the Security page never shows a TOTP key, even when the answer carries one                                                                                                    |
| 108 | Only the offered methods                         | Show every method                                   | AT   | the second step offers only the methods in the verify answer                                                                                                                  |

**Positive tests, not pins:** "a factor set up in recovery passes a fresh check after a new sign-in" (SM); "an invited user lands on the accept screen" and "a user without an invitation lands on /settings/users" (AT, spec test 20). They prove the D-3 and D-4 behaviour; they have no weakening.

**Not pinned, read by the reviewer instead:** the constant-time compare in TOTP and backup codes (`timingSafeEqual` on equal-length buffers); the randomness source (`crypto.getRandomValues` / `randomBytes`, never `Math.random`); the atomic `update … where second_factor_attempts < 5` (every second step already runs under the `2fa:` lock, so a read-then-write weakening cannot be made to fail; pins 26, 27 and 29 cover the behaviour); `requireUvFlag` at the route level (the route's challenge row says `required`, which already refuses a missing UV flag; pin 66 pins `requireUvFlag` itself); WebAuthn with a real platform authenticator and an authenticator-app QR scan (manual, Checkpoint 3); SES delivery of the notice (adapter unit test only).

## Tasks

### Task 1: Migration `0024`, schema and manifest

**Files:** `modules/core/identity/db/schema.ts`; `packages/db/drizzle.schema.ts` (export `totpCredentials`, `backupCodes`, `secondFactorEvents` beside the other identity tables, `:46-56`); `packages/db/drizzle/0024_*.sql`, `packages/db/drizzle/meta/0024_snapshot.json`, `packages/db/drizzle/meta/_journal.json`; `modules/core/identity/module.manifest.ts`; `modules/core/identity/domain/manifest.test.ts`; MG (new).

- [ ] Write MG first: pins 1 to 9, plus the expected tables, columns, defaults and the widened check; spec test 19 (the `insert` statements copied from `session.ts:428-459`, `:316-330` and `passkey.ts:172-182` on `main` run after `0024`).
- [ ] Add the three tables, the four session columns (`factor`, `fresh_factor_at`, `recovery_until`, `second_factor_attempts`) and the two passkey columns to the schema factory; generate `0024`; `last_used_step` is `bigint({ mode: "number" })`; hand SQL: `sessions_kind_v2` added, then `sessions_kind` dropped; `REVOKE UPDATE, DELETE, TRUNCATE` on `second_factor_events` from `identity` (as `0012_polite_bloodstrike.sql:28-30`).
- [ ] Add every new column to `dataClasses` and the manifest test (pin 10).
- [ ] Gate.

**Must not break:** expand only; `app` untouched; the schema file imports no values from `@community-hub/db`.

### Task 2: TOTP and backup-code domain

**Files:** `modules/core/identity/domain/totp.ts`, `backup-code.ts` (new) and TO, BC (new).

- [ ] TO first: pins 11 to 14, base32 encode and decode of the 20-byte key.
- [ ] BC first: pins 15 and 16, ten distinct codes.
- [ ] `node:crypto` only: `createHmac("sha1")`, `timingSafeEqual`, `randomBytes`. Functions take `now` and return the matched step.
- [ ] Gate.

**Must not break:** no dependency; no I/O.

### Task 3: Sessions

**Files:** `modules/core/identity/infrastructure/session.ts`, `second-factor-lock.ts` (new); SE.

- [ ] SE first: pins 17 to 24.
- [ ] `SessionKind` gains `second_factor` (`:14`); the guard (`:61`) and `computeSessionExpiries` (`:72-74` pattern) handle it; `createSession`, `createSessionInTransaction`, `insertSession` take optional `factor`, `freshFactorAt`, `recoveryUntil`; refresh returns `user_id` and `kind` from the locate query, takes `lockSecondFactor` for `tenant` rows before the family lock, carries `factor` and not the other two; `endSession` accepts `second_factor`; `endOtherSessions(tx, userId, keepSessionId)`; `lockSecondFactor`.
- [ ] `readSession` does **not** yet refuse a null `factor` (Task 8 does), so the gate stays green.
- [ ] Gate.

**Must not break:** operator refresh and absolute expiry (`:307-310`); the family lock and replay revoke.

### Task 4: Second-factor service: TOTP, backup codes, second step, limits

**Files:** `modules/core/identity/infrastructure/second-factor.ts`, `second-factor.fixture.ts` (new), `modules/core/identity/public/index.ts`; SF (new).

- [ ] SF first: pins 25 to 42. Every function takes the caller's session (Plan additions).
- [ ] TOTP start, confirm (first and replacement), second step by TOTP or backup code, backup-code generate and consume, the factor list, the session counter and the hourly limit, the recovery window on a backup-code sign-in. Every function takes `lockSecondFactor` first and follows "Sessions inside a lock". Encryption as spec Data (`email-lookup.ts:114-122` pattern).
- [ ] Export what Task 8 needs from `public/`.
- [ ] Gate.

**Must not break:** the email-code and passkey sign-ins still give `tenant` sessions until Task 8.

### Task 5: Second-factor service: fresh check, recovery, removal, notices

**Files:** `second-factor.ts`; `modules/core/identity/domain/second-factor-notice.ts` (new); `apps/api/src/mail/ses-second-factor-notice.ts` and its test (new); SM (new).

- [ ] SM first: pins 43 to 63 and the first positive test.
- [ ] Fresh check by TOTP (passkey in Task 6) with its per-session and hourly limits; recovery-window rules; removal with the last-factor rule and the caller's-own-id lookup; `endOtherSessions` per decision 7; the `SecondFactorNotice` port, `rejectingSecondFactorNotice` and the SES adapter; the address from `readUserEmails`; send after commit, log the kind only on failure.
- [ ] **Checkpoint 1** after this task.

**Must not break:** `OtpMail` and every fake of it are unchanged.

### Task 6: Passkeys (functions only)

**Files:** `modules/core/identity/infrastructure/passkey.ts`, `second-factor.ts` (fresh passkey); PK; OP.

- [ ] PK and OP first: pins 64 to 78. The tests call the functions with the tenant inputs and an admin-origin rpId directly; pins 77 and 78 go through the tenant registration wrapper with a `second_factor` session.
- [ ] The inputs in Plan additions "Passkey inputs", each defaulting to today's behaviour; `user_verified` stored on insert; `passkey_uv` sign-in sets `factor` and `fresh_factor_at` under the lock in one transaction; second-step and fresh passkey functions; passkey registration from a pre-2FA session (no factor) and from an admin session (fresh or recovery).
- [ ] Routes and their tests are unchanged in this task.
- [ ] Gate.

**Must not break:** ops sign-in, enrolment and recovery tests unchanged; `auth-flow.integration.test.ts` passkey cases still pass through the unchanged routes.

### Task 7: Env, wiring and Terraform

**Files:** `apps/api/src/env.ts`, EN; `apps/api/src/index.ts` (wiring only), IX; `apps/api/src/auth-routes.ts` (`AuthDeps` field only); `infra/modules/aws-ingress/main.tf`, TF.

- [ ] EN first: pins 79 to 81, `ADMIN_ORIGIN` alone accepted. The existing "only ADMIN_ORIGIN" refusal case at `env.test.ts:233-234` flips to accepted, named in the report.
- [ ] IX first: pin 82.
- [ ] `env.ts`: split the pairing (`:174-177`), set `ADMIN_ORIGIN` whenever present (`:230-233`), the admin host in the distinct set (`:184-192`). `index.ts`: `AuthDeps.adminOrigin` from `ADMIN_ORIGIN`; billing and invitations get it only with the billing secret.
- [ ] TF first: the `staging_image_set` exact environment list gains `ADMIN_ORIGIN` last; a new run `admin_origin_without_billing` (copy of `mail_variables_into_task` without the mail variables) asserting `ADMIN_ORIGIN` equals `https://admin.communityhub-staging.net` and `BILLING_SECRET_ARN` is absent (pin 83).
- [ ] `main.tf:498`: as Plan additions "Terraform position".
- [ ] Gate, plus `terraform fmt`, `validate`, `test` in `infra/modules/aws-ingress`. The lock file does not change.

**Must not break:** the billing run; the CORS `allow_origins` assert; invitations' and billing's 503 answers without the billing secret.

### Task 8: Contracts, routes and the cut-over

**Files:** `packages/contracts/src/auth.ts`, CT; `apps/api/src/second-factor-routes.ts` (new), `auth-routes.ts`, `index.ts`; `modules/core/identity/infrastructure/email-otp.ts`, `session.ts` (the `factor` check); `apps/api/src/test-support/second-factor.ts` (new); AR, RW (new); every test in Plan additions "Tests that move in Task 8".

- [ ] CT, AR and RW first: pins 84, 85, 87 to 92, 94, 95, 97, 98; spec tests 1 to 3 and 14. Pin 86 is added to SE in this task.
- [ ] `verifyEmailOtp` returns a `second_factor` session; `tokens()` omits the refresh token for it; `readSession` and `readSessionWithKind` refuse a `tenant` row with `factor` null; `factor` becomes required in `createSession` for `tenant`.
- [ ] Routes per spec Contracts; passkey routes use the admin origin and the tenant inputs; `no-store` on answers carrying a secret or codes; empty refusal bodies; 404 for passkey routes without `adminOrigin`.
- [ ] Move every listed test to a helper; each keeps its assertions.
- [ ] Gate. **Checkpoint 2** after this task.

**Must not break:** invitations acceptance; billing guard; the ops routes; every route's surface and billing marking.

### Task 9: Admin sign-in, second step, setup and backup codes

**Files:** `apps/admin/package.json`, `pnpm-lock.yaml` (`qrcode`, `@types/qrcode`); `apps/admin/src/sign-in.tsx`, AS; `apps/admin/src/second-factor.tsx` (new), AT; `apps/admin/src/accept-invitation.test.tsx`; `apps/admin/src/test-support/`.

- [ ] AS and AT first: pins 96, 99 to 104 and 108, and both positive tests; axe on each new step.
- [ ] Email step, then second step or setup as in-app states; passkey sign-in button (hidden without WebAuthn or when `passkeysAvailable` is false); QR as inline SVG markup from `qrcode`'s SVG output; key text in groups of four; backup codes with Copy and the "saved" tick; the pre-2FA token in component state; the admin token stored only after the second step; Cancel ends the pre-2FA session.
- [ ] Gate.

**Must not break:** the CSP (`infra/modules/aws-admin-static/main.tf:3`) unchanged; the accept-invitation flow.

### Task 10: Settings → Security

**Files:** `apps/admin/src/security.tsx` (new), AY; `apps/admin/src/shell.tsx` (route), `nav.tsx` (link), `nav.test.tsx`.

- [ ] AY first: pins 105 to 107; the list, fresh-check prompt, recovery-window actions, last-factor message, two-or-fewer-codes warning; axe.
- [ ] Gate. **Checkpoint 3** (browser check) after this task.

**Must not break:** the frozen nav order: Security is a child of Settings after Users & Roles.

### Task 11: Documents, runbook and roadmap

**Files:** `docs/adr/0022-second-factor-for-staff.md` (new); `docs/adr/0017-childrens-data-access.md` (status note on point 6 only); `architecture.md` §11.1 and §26 Q20; `docs/runbooks/apply-staging-au.md` (every step in spec Out-of-band "Runbook", and the apply order: new image, then Terraform); `docs/roadmap.md` (`Two-factor for staff` done, snapshot, Q20, new row `Staff 2FA recovery` with the admin-issued setup code for imported accounts, gated before client import, the frozen nav row 16 gaining Security under Settings, and the `Life events: Laravel parity` wording: the count column goes on the Family Records list only); `AGENTS.md` repository-state line.

- [ ] Prettier and the docs checks in the gate. No test.
- [ ] `rm -f docs/plans/*-report.md` and `git status --short` show no scratch.

**Must not break:** ADR 0017's other points; nothing in §1.

## Rollback

Revert the merge. The new tables, columns and check are unused by the old code, and the migration rewrites no data, so `0024` can stay. If the Terraform change was applied, the old image refuses to start with `ADMIN_ORIGIN` and no billing secret: revert `main.tf:498` and apply before rolling back the image. Users who set up a factor keep the rows; the old code ignores them.
